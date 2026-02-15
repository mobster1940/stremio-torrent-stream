import { Router } from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { searchTorrents } from "./torrent/search.js";
import {
  getFile,
  getOrAddTorrent,
  getStats,
  getTorrentInfo,
  removeTorrent,
  streamClosed,
  streamOpened,
  fileStreamOpened,
  fileStreamClosed,
  getOpenFilePaths,
} from "./torrent/webtorrent.js";
import { getStreamingMimeType } from "./utils/file.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const router = Router();

router.get("/stats", (req, res) => {
  try {
    // Runtime: this will resolve to dist/stats.html next to router.js
    const statsPath = join(__dirname, "stats.html");
    const html = readFileSync(statsPath, "utf-8");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.type("html").send(html);
  } catch (err) {
    console.error("Failed to load stats.html:", err);
    res.status(500).send("Failed to load stats page");
  }
});

/** JSON stats for UI */
router.get("/api/stats", (req, res) => {
  res.json(getStats());
});

/** Delete torrent */
router.delete("/api/torrents/:infoHash", async (req, res) => {
  const ok = await removeTorrent(req.params.infoHash);
  res.status(ok ? 200 : 404).json({ ok });
});

/** Existing endpoints */
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

// ✅ Helper: Prioritize pieces for a byte range (fixes buffering issues)
function prioritizeRange(
  torrent: any,
  file: any,
  startByte: number,
  endByte: number
) {
  try {
    const pieceLength = torrent.pieceLength;
    if (!pieceLength) return;

    const fileStartPiece = file._startPiece ?? 0;
    const startPiece = fileStartPiece + Math.floor(startByte / pieceLength);
    const endPiece = fileStartPiece + Math.floor(endByte / pieceLength);

    if (typeof torrent.critical === "function") {
      torrent.critical(startPiece, endPiece);
    }
  } catch (err) {
    console.warn("Failed to prioritize range:", err);
  }
}

/** Stream endpoint (Range + piece selection + safe cleanup) */
router.get("/stream/:torrentUri/:filePath", async (req, res) => {
  const { torrentUri, filePath } = req.params;
  const torrent = await getOrAddTorrent(torrentUri);
  if (!torrent) return res.status(500).send("Failed to add torrent");

  const file = getFile(torrent, filePath);
  if (!file) return res.status(404).send("File not found");

  const mime = getStreamingMimeType(file.name);
  const range = req.headers.range;
  const NO_DATA_TIMEOUT_MS = 30000;
  const hash = torrent.infoHash;

  const pipeWithCleanup = (readable: any) => {
    let noDataTimeout: NodeJS.Timeout | undefined = setTimeout(() => {
      console.warn(`Stream timeout: no data for ${NO_DATA_TIMEOUT_MS}ms`);
      res.destroy();
    }, NO_DATA_TIMEOUT_MS);

    const cleanup = () => {
      if (noDataTimeout) clearTimeout(noDataTimeout);
      noDataTimeout = undefined;
      readable.destroy();
      fileStreamClosed(hash, file.path);
      streamClosed(hash, file.name);
    };

    fileStreamOpened(hash, file.path);
    streamOpened(hash, file.name);

    res.on("close", cleanup);

    readable.on("data", () => {
      if (noDataTimeout) clearTimeout(noDataTimeout);
      noDataTimeout = undefined;
    });

    readable.on("error", (err: any) => {
      console.error("Stream error:", err);
      cleanup();
    });

    readable.pipe(res);
  };

  const openPaths = getOpenFilePaths(hash);
  const safeToRescope =
    openPaths.length === 0 ||
    (openPaths.length === 1 && openPaths[0] === file.path);

  if (safeToRescope) {
    try {
      torrent.files.forEach((f: any) => {
        if (typeof f.deselect === "function") f.deselect();
      });
      if (typeof (file as any).select === "function") (file as any).select();
    } catch {}
  } else {
    try {
      if (typeof (file as any).select === "function") (file as any).select();
    } catch {}
  }

  if (!range) {
    prioritizeRange(
      torrent,
      file,
      0,
      Math.min(file.length - 1, 10 * 1024 * 1024)
    );

    res.writeHead(200, {
      "Content-Length": file.length,
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });

    try {
      const readable = file.createReadStream();
      pipeWithCleanup(readable);
    } catch {
      res.status(500).end();
    }
    return;
  }

  const m = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!m) {
    res.writeHead(416, { "Content-Range": `bytes */${file.length}` });
    return res.end();
  }

  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : file.length - 1;

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    start >= file.length
  ) {
    res.writeHead(416, { "Content-Range": `bytes */${file.length}` });
    return res.end();
  }

  const safeEnd = Math.min(end, file.length - 1);

  prioritizeRange(
    torrent,
    file,
    start,
    Math.min(safeEnd, start + 10 * 1024 * 1024)
  );

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${safeEnd}/${file.length}`,
    "Accept-Ranges": "bytes",
    "Content-Length": safeEnd - start + 1,
    "Content-Type": mime,
    "Cache-Control": "no-cache",
  });

  try {
    const readable = file.createReadStream({ start, end: safeEnd });
    pipeWithCleanup(readable);
  } catch {
    res.status(500).end();
  }
});
