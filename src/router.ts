import { Router } from "express";
import { searchTorrents } from "./torrent/search.js";
import {
  getFile,
  getOrAddTorrent,
  getStats,
  getTorrentInfo,
  streamClosed,
  streamOpened,
} from "./torrent/webtorrent.js";
import { getStreamingMimeType } from "./utils/file.js";

export const router = Router();

router.get("/stats", (req, res) => {
  const stats = getStats();
  res.json(stats);
});

router.get("/torrents/:query", async (req, res) => {
  const { query } = req.params;
  const torrents = await searchTorrents(query);
  res.json(torrents);
});

router.post("/torrents/:query", async (req, res) => {
  const { query } = req.params;
  const options = req.body;
  const torrents = await searchTorrents(query, options);
  res.json(torrents);
});

router.get("/torrent/:torrentUri", async (req, res) => {
  const { torrentUri } = req.params;
  const torrent = await getTorrentInfo(torrentUri);

  if (!torrent) return res.status(500).send("Failed to get torrent");

  torrent.files.forEach((file) => {
    file.url = [
      `${req.protocol}://${req.get("host")}`,
      "stream",
      encodeURIComponent(torrentUri),
      encodeURIComponent(file.path),
    ].join("/");
  });

  res.json(torrent);
});

router.get("/stream/:torrentUri/:filePath", async (req, res) => {
  const { torrentUri, filePath } = req.params;

  const torrent = await getOrAddTorrent(torrentUri);
  if (!torrent) return res.status(500).send("Failed to add torrent");

  const file = getFile(torrent, filePath);
  if (!file) return res.status(404).send("File not found");

  const mime = getStreamingMimeType(file.name);
  const range = req.headers.range;

  const AHEAD_BYTES = 32 * 1024 * 1024; // 32MB
  const NO_DATA_TIMEOUT_MS = 15000;

  // Helper: start piping and handle disconnects safely
  const pipeWithCleanup = (readable: any) => {
    let noDataTimeout: NodeJS.Timeout | undefined = setTimeout(() => {
      // No bytes came through -> kill socket so player retries.
      res.destroy();
    }, NO_DATA_TIMEOUT_MS);

    const cleanup = () => {
      if (noDataTimeout) clearTimeout(noDataTimeout);
      noDataTimeout = undefined;
      readable.destroy();
      streamClosed(torrent.infoHash, file.name);
    };

    streamOpened(torrent.infoHash, file.name);

    res.on("close", cleanup);
    res.on("finish", cleanup);

    readable.on("data", () => {
      if (noDataTimeout) clearTimeout(noDataTimeout);
      noDataTimeout = undefined;
    });

    readable.on("error", () => {
      cleanup();
    });

    readable.pipe(res);
  };

  // No Range header => return full file with 200
  if (!range) {
    res.writeHead(200, {
      "Content-Length": file.length,
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });

    try {
      // @ts-ignore
      file.select?.(); // ensure it keeps downloading
      const readable = file.createReadStream();
      pipeWithCleanup(readable);
    } catch {
      res.status(500).end();
    }
    return;
  }

  // Range support: bytes=start-end
  const m = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!m) {
    res.writeHead(416, { "Content-Range": `bytes */${file.length}` });
    return res.end();
  }

  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : file.length - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= file.length) {
    res.writeHead(416, { "Content-Range": `bytes */${file.length}` });
    return res.end();
  }

  const safeEnd = Math.min(end, file.length - 1);

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${safeEnd}/${file.length}`,
    "Accept-Ranges": "bytes",
    "Content-Length": safeEnd - start + 1,
    "Content-Type": mime,
    "Cache-Control": "no-cache",
  });

  try {
    // Prioritize exactly what was requested (seek/rewind)
    // @ts-ignore
    file.select?.(start, safeEnd);

    // Keep a buffer ahead selected to avoid mid-playback stalls
    const aheadStart = Math.min(file.length - 1, safeEnd + 1);
    const aheadEnd = Math.min(file.length - 1, safeEnd + AHEAD_BYTES);
    if (aheadStart < aheadEnd) {
      // @ts-ignore
      file.select?.(aheadStart, aheadEnd);
    }

    const readable = file.createReadStream({ start, end: safeEnd });
    pipeWithCleanup(readable);
  } catch {
    res.status(500).end();
  }
});
