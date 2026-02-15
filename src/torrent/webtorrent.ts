import fs from "fs-extra";
import MemoryStore from "memory-chunk-store";
import os from "os";
import path from "path";
import WebTorrent, { Torrent } from "webtorrent";
import { getReadableDuration } from "../utils/file.js";

interface FileInfo {
  name: string;
  path: string;
  size: number;
  url?: string;
}

interface ActiveFileInfo extends FileInfo {
  progress: number;
  downloaded: number;
}

export interface TorrentInfo {
  name: string;
  infoHash: string;
  size: number;
  files: FileInfo[];
}

interface ActiveTorrentInfo extends TorrentInfo {
  progress: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  openStreams: number;
  files: ActiveFileInfo[];
}

const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), "torrent-stream-server");

const KEEP_DOWNLOADED_FILES = process.env.KEEP_DOWNLOADED_FILES
  ? process.env.KEEP_DOWNLOADED_FILES === "true"
  : false;

if (!KEEP_DOWNLOADED_FILES) fs.emptyDirSync(DOWNLOAD_DIR);

const MAX_CONNS_PER_TORRENT = Number(process.env.MAX_CONNS_PER_TORRENT) || 50;

const DOWNLOAD_SPEED_LIMIT =
  Number(process.env.DOWNLOAD_SPEED_LIMIT) || 20 * 1024 * 1024;

const UPLOAD_SPEED_LIMIT =
  Number(process.env.UPLOAD_SPEED_LIMIT) || 1 * 1024 * 1024;

const SEED_TIME = Number(process.env.SEED_TIME) || 60 * 1000;

const TORRENT_TIMEOUT = Number(process.env.TORRENT_TIMEOUT) || 5 * 1000;

const infoClient = new WebTorrent();

const streamClient = new WebTorrent({
  // @ts-ignore
  downloadLimit: DOWNLOAD_SPEED_LIMIT,
  uploadLimit: UPLOAD_SPEED_LIMIT,
  maxConns: MAX_CONNS_PER_TORRENT,
  // @ts-ignore
  verify: false,
});

streamClient.on("torrent", (torrent) => {
  console.log(`Added torrent: ${torrent.name}`);
});

streamClient.on("error", (error) => {
  if (typeof error === "string") {
    console.error(`Error: ${error}`);
  } else {
    if (error.message.startsWith("Cannot add duplicate torrent")) return;
    console.error(`Error: ${error.message}`);
  }
});

infoClient.on("error", () => {});

const launchTime = Date.now();

export const getStats = () => {
  const streamCount = openStreams.size > 0 
    ? [...openStreams.values()].reduce((a, b) => a + b, 0) 
    : 0;

  return {
    uptime: getReadableDuration(Date.now() - launchTime),
    openStreams: streamCount,
    downloadSpeed: streamClient.downloadSpeed || 0,
    uploadSpeed: streamClient.uploadSpeed || 0,
    activeTorrents: streamClient.torrents.map((torrent) => ({
      name: torrent.name || "Unknown",
      infoHash: torrent.infoHash || "",
      size: torrent.length || 0,
      progress: torrent.progress || 0,
      downloaded: torrent.downloaded || 0,
      uploaded: torrent.uploaded || 0,
      downloadSpeed: torrent.downloadSpeed || 0,
      uploadSpeed: torrent.uploadSpeed || 0,
      peers: torrent.numPeers || 0,
      openStreams: openStreams.get(torrent.infoHash) || 0,
      files: torrent.files.map((file) => ({
        name: file.name || "",
        path: file.path || "",
        size: file.length || 0,
        progress: file.progress || 0,
        downloaded: file.downloaded || 0,
      })),
    })),
  };
};


export const getOrAddTorrent = (uri: string) =>
  new Promise<Torrent | undefined>((resolve) => {
    const torrent = streamClient.add(
      uri,
      {
        path: DOWNLOAD_DIR,
        destroyStoreOnDestroy: !KEEP_DOWNLOADED_FILES,
        // @ts-ignore
        deselect: true,
      },
      (torrent) => {
        clearTimeout(timeout);
        resolve(torrent);
      }
    );

    const timeout = setTimeout(() => {
      torrent.destroy();
      resolve(undefined);
    }, TORRENT_TIMEOUT);
  });

export const getFile = (torrent: Torrent, pathStr: string) =>
  torrent.files.find((file) => file.path === pathStr);

export const getTorrentInfo = async (uri: string) => {
  const getInfo = (torrent: Torrent): TorrentInfo => ({
    name: torrent.name,
    infoHash: torrent.infoHash,
    size: torrent.length,
    files: torrent.files.map((file) => ({
      name: file.name,
      path: file.path,
      size: file.length,
    })),
  });

  return await new Promise<TorrentInfo | undefined>((resolve) => {
    const torrent = infoClient.add(
      uri,
      { store: MemoryStore, destroyStoreOnDestroy: true },
      (torrent) => {
        clearTimeout(timeout);
        const info = getInfo(torrent);
        console.log(`Fetched info: ${info.name}`);
        torrent.destroy();
        resolve(info);
      }
    );

    const timeout = setTimeout(() => {
      torrent.destroy();
      resolve(undefined);
    }, TORRENT_TIMEOUT);
  });
};

const timeouts = new Map<string, NodeJS.Timeout>();
const openStreams = new Map<string, number>();

export const streamOpened = (hash: string, fileName: string) => {
  console.log(`Stream opened: ${fileName}`);
  const count = openStreams.get(hash) || 0;
  openStreams.set(hash, count + 1);

  const timeout = timeouts.get(hash);
  if (timeout) {
    clearTimeout(timeout);
    timeouts.delete(hash);
  }
};

export const streamClosed = (hash: string, fileName: string) => {
  console.log(`Stream closed: ${fileName}`);
  const count = openStreams.get(hash) || 1;
  openStreams.set(hash, count - 1);

  if (count > 1) return;
  openStreams.delete(hash);

  let timeout = timeouts.get(hash);
  if (timeout) return;

  timeout = setTimeout(async () => {
    const torrent = await streamClient.get(hash);
    // @ts-ignore
    torrent?.destroy(undefined, () => {
      console.log(`Removed torrent: ${torrent.name}`);
      timeouts.delete(hash);
    });
  }, SEED_TIME);

  timeouts.set(hash, timeout);
};

export const removeTorrent = async (infoHash: string) => {
  const torrent: any = streamClient.get(infoHash);
  if (!torrent) return false;

  // Prefer the client API (most compatible)
  await new Promise<void>((resolve) => {
    // destroyStore will delete files if the store supports it (per WebTorrent docs)
    // @ts-ignore
    streamClient.remove(infoHash, { destroyStore: !KEEP_DOWNLOADED_FILES }, () => resolve());
  });

  // Fallback: if it still exists and has destroy()
  if (typeof torrent.destroy === "function") {
    // @ts-ignore
    torrent.destroy({ destroyStore: !KEEP_DOWNLOADED_FILES }, () => {});
  }

  return true;
};

// Add near openStreams/timeouts
const openFileStreams = new Map<string, Map<string, number>>();

// Call when a specific file stream opens
export const fileStreamOpened = (hash: string, filePath: string) => {
  const perTorrent = openFileStreams.get(hash) || new Map<string, number>();
  const cur = perTorrent.get(filePath) || 0;
  perTorrent.set(filePath, cur + 1);
  openFileStreams.set(hash, perTorrent);
};

// Call when a specific file stream closes
export const fileStreamClosed = (hash: string, filePath: string) => {
  const perTorrent = openFileStreams.get(hash);
  if (!perTorrent) return;
  const cur = perTorrent.get(filePath) || 0;
  if (cur <= 1) perTorrent.delete(filePath);
  else perTorrent.set(filePath, cur - 1);
  if (perTorrent.size === 0) openFileStreams.delete(hash);
};

// Snapshot which files are currently being streamed for this torrent
export const getOpenFilePaths = (hash: string) => {
  const perTorrent = openFileStreams.get(hash);
  return perTorrent ? [...perTorrent.keys()] : [];
};
