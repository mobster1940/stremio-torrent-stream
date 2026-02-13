import { Router } from "express";

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

export const router = Router();

/** HTML stats UI */
router.get("/stats", (req, res) => {
  res.type("html").send(STATS_HTML);
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

router.get("/stream/:torrentUri/:filePath", async (req, res) => {
  const { torrentUri, filePath } = req.params;

  const torrent = await getOrAddTorrent(torrentUri);
  if (!torrent) return res.status(500).send("Failed to add torrent");

  const file = getFile(torrent, filePath);
  if (!file) return res.status(404).send("File not found");

  const mime = getStreamingMimeType(file.name);
  const range = req.headers.range;

  const NO_DATA_TIMEOUT_MS = 15000;
  const AHEAD_BYTES = 60 * 1024 * 1024; // Pre-fetch 60MB ahead (approx 30s-1m of 4K/1080p)
  const hash = torrent.infoHash;

  // Helper: Convert file bytes to torrent piece indices and prioritize them
  const prioritize = (startByte: number, endByte: number) => {
    // @ts-ignore
    if (!torrent.pieceLength || !file.offset) return;
    
    // @ts-ignore
    const fileOffset = file.offset; // Where this file starts in the full torrent
    const startP = Math.floor((fileOffset + startByte) / torrent.pieceLength);
    const endP = Math.floor((fileOffset + endByte) / torrent.pieceLength);

    // Critical = High priority (download immediately)
    // We critical the immediate stream + the lookahead buffer
    // @ts-ignore
    torrent.critical(startP, endP);
  };

  const pipeWithCleanup = (readable: any) => {
    let noDataTimeout: NodeJS.Timeout | undefined = setTimeout(() => {
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

  // Manage selections (ensure we don't download the whole pack)
  const openPaths = getOpenFilePaths(hash);
  const safeToRescope =
    openPaths.length === 0 || (openPaths.length === 1 && openPaths[0] === file.path);

  if (safeToRescope) {
    try {
      torrent.files.forEach((f: any) => {
        if (typeof f.deselect === "function") f.deselect();
      });
      // Select the whole file to keep it "interested"
      if (typeof (file as any).select === "function") (file as any).select();
    } catch {}
  } else {
    try {
      if (typeof (file as any).select === "function") (file as any).select();
    } catch {}
  }

  // --- No Range (Serve Full File) ---
  if (!range) {
    res.writeHead(200, {
      "Content-Length": file.length,
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });

    try {
      // Prioritize the first 60MB for fast start
      prioritize(0, Math.min(file.length - 1, AHEAD_BYTES));
      
      const readable = file.createReadStream();
      pipeWithCleanup(readable);
    } catch {
      res.status(500).end();
    }
    return;
  }

  // --- Range Request ---
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
    // 1. Prioritize the REQUESTED range (immediate need)
    prioritize(start, safeEnd);

    // 2. Prioritize the AHEAD buffer (next 60MB) so it's ready when playback gets there
    const aheadStart = safeEnd + 1;
    const aheadEnd = Math.min(file.length - 1, aheadStart + AHEAD_BYTES);
    if (aheadStart < aheadEnd) {
      prioritize(aheadStart, aheadEnd);
    }

    const readable = file.createReadStream({ start, end: safeEnd });
    pipeWithCleanup(readable);
  } catch {
    res.status(500).end();
  }
});


const STATS_HTML =
  '<!doctype html>' +
  '<html>' +
  '<head>' +
  '  <meta charset="utf-8" />' +
  '  <meta name="viewport" content="width=device-width,initial-scale=1" />' +
  '  <title>Torrent Stats</title>' +
  '  <style>' +
  '    body { font-family: system-ui, Arial, sans-serif; margin: 20px; background:#0b0f14; color:#e8eef6; }' +
  '    .row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }' +
  '    .card { background:#111824; border:1px solid #1d2a3a; border-radius:12px; padding:14px; margin:12px 0; }' +
  '    table { width:100%; border-collapse: collapse; }' +
  '    th, td { text-align:left; padding:8px; border-bottom:1px solid #1d2a3a; vertical-align:top; }' +
  '    th { color:#a9b7c6; font-weight:600; }' +
  '    .muted { color:#a9b7c6; }' +
  '    button { background:#1f6feb; color:white; border:0; padding:8px 10px; border-radius:10px; cursor:pointer; }' +
  '    button.danger { background:#d73a49; }' +
  '    button.secondary { background:#2d333b; }' +
  '    button:disabled { opacity:.6; cursor:not-allowed; }' +
  '    input { padding:8px 10px; border-radius:10px; border:1px solid #1d2a3a; background:#0b0f14; color:#e8eef6; }' +
  '    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }' +
  '    summary { cursor: pointer; }' +
  '  </style>' +
  '</head>' +
  '<body>' +
  '  <h1>Stats</h1>' +
  '' +
  '  <div class="card">' +
  '    <div class="row">' +
  '      <div><div class="muted">Uptime</div><div id="uptime">-</div></div>' +
  '      <div><div class="muted">Open streams</div><div id="openStreams">-</div></div>' +
  '      <div><div class="muted">Down</div><div id="dl">-</div></div>' +
  '      <div><div class="muted">Up</div><div id="ul">-</div></div>' +
  '      <div style="margin-left:auto" class="row">' +
  '        <button class="secondary" id="refreshBtn">Refresh</button>' +
  '        <label class="muted">Auto</label>' +
  '        <input id="autoMs" type="number" value="2000" style="width:100px" />' +
  '      </div>' +
  '    </div>' +
  '  </div>' +
  '' +
  '  <div class="card">' +
  '    <div class="row">' +
  '      <input id="filter" placeholder="Filter torrents..." style="flex:1" />' +
  '    </div>' +
  '  </div>' +
  '' +
  '  <div id="torrents"></div>' +
  '' +
  '<script>' +
  '(function(){' +
  '  function el(id){ return document.getElementById(id); }' +
  '' +
  '  function fmtBytes(n){' +
  '    if (!isFinite(n)) return "-";' +
  '    var u = ["B","KB","MB","GB","TB"];' +
  '    var i = 0;' +
  '    while (n >= 1024 && i < u.length-1) { n = n/1024; i++; }' +
  '    return (i === 0 ? n.toFixed(0) : n.toFixed(2)) + " " + u[i];' +
  '  }' +
  '' +
  '  function api(method, url){' +
  '    return fetch(url, { method: method }).then(function(res){' +
  '      if (!res.ok) return res.text().then(function(t){ throw new Error(t); });' +
  '      return res.json();' +
  '    });' +
  '  }' +
  '' +
  '  function torrentCard(t){' +
  '    var files = (t.files || []).slice(0, 6).map(function(f){' +
  '      return "<tr>" +' +
  '        "<td>" + (f.name || "") + "</td>" +' +
  '        "<td class=\\"mono\\">" + fmtBytes(f.size || 0) + "</td>" +' +
  '        "<td>" + Math.round((f.progress || 0) * 100) + "%</td>" +' +
  '      "</tr>";' +
  '    }).join("");' +
  '' +
  '    var filesHint = ((t.files || []).length > 6) ? "<div class=\\"muted\\">Showing first 6 files</div>" : "";' +
  '' +
  '    var selText = "-";' +
  '    if (t.selectedFiles && t.selectedFiles.length) {' +
  '      var sf = t.selectedFiles[0];' +
  '      selText = (sf.name || sf.path || "Selected") +' +
  '        " • " + Math.round((sf.progress || 0) * 100) + "%"' +
  '        + " • " + fmtBytes(sf.downloaded || 0) + " / " + fmtBytes(sf.size || 0);' +
  '    }' +
  '' +
  '    return "" +' +
  '      "<div class=\\"card\\">" +' +
  '        "<div class=\\"row\\">" +' +
  '          "<div style=\\"flex:1\\">" +' +
  '            "<div><strong>" + (t.name || "") + "</strong></div>" +' +
  '            "<div class=\\"muted mono\\">" + (t.infoHash || "") + "</div>" +' +
  '          "</div>" +' +
  '          "<div><div class=\\"muted\\">Progress (torrent)</div><div>" + Math.round((t.progress || 0) * 100) + "%</div></div>" +' +
  '          "<div style=\\"min-width:260px\\"><div class=\\"muted\\">Progress (selected file)</div><div class=\\"mono\\" style=\\"white-space:nowrap; overflow:hidden; text-overflow:ellipsis\\">" + selText + "</div></div>" +' +
  '          "<div><div class=\\"muted\\">Downloaded</div><div>" + fmtBytes(t.downloaded || 0) + "</div></div>" +' +
  '          "<div><div class=\\"muted\\">Speed</div><div>↓ " + fmtBytes(t.downloadSpeed || 0) + "/s • ↑ " + fmtBytes(t.uploadSpeed || 0) + "/s</div></div>" +' +
  '          "<div><div class=\\"muted\\">Peers</div><div>" + (t.peers == null ? "-" : t.peers) + "</div></div>" +' +
  '          "<div><div class=\\"muted\\">Streams</div><div>" + (t.openStreams == null ? 0 : t.openStreams) + "</div></div>" +' +
  '          "<button class=\\"danger\\" onclick=\\"window.__deleteTorrent(\\\'" + (t.infoHash || "") + "\\\')\\">Delete</button>" +' +
  '        "</div>" +' +
  '' +
  '        "<details data-hash=\\"" + (t.infoHash || "") + "\\" style=\\"margin-top:10px\\">" +' +
  '          "<summary class=\\"muted\\">Files</summary>" +' +
  '          "<table>" +' +
  '            "<thead><tr><th>Name</th><th>Size</th><th>Progress</th></tr></thead>" +' +
  '            "<tbody>" + (files || "<tr><td colspan=\\"3\\" class=\\"muted\\">No files</td></tr>") + "</tbody>" +' +
  '          "</table>" +' +
  '          filesHint +' +
  '        "</details>" +' +
  '      "</div>";' +
  '  }' +
  '' +
  '  function getOpenDetails(){' +
  '    var nodes = document.querySelectorAll("details[data-hash][open]");' +
  '    var set = {};' +
  '    for (var i=0; i<nodes.length; i++) {' +
  '      var h = nodes[i].getAttribute("data-hash");' +
  '      if (h) set[h] = true;' +
  '    }' +
  '    return set;' +
  '  }' +
  '' +
  '  function restoreOpenDetails(openSet){' +
  '    for (var hash in openSet) {' +
  '      if (!openSet.hasOwnProperty(hash)) continue;' +
  '      var d = document.querySelector("details[data-hash=\\"" + hash + "\\"]");' +
  '      if (d) d.open = true;' +
  '    }' +
  '  }' +
  '' +
  '  function refresh(){' +
  '    var openSet = getOpenDetails();' +
  '    return api("GET", "/api/stats").then(function(data){' +
  '      el("uptime").textContent = data.uptime || "-";' +
  '      el("openStreams").textContent = (data.openStreams == null ? "-" : data.openStreams);' +
  '      el("dl").textContent = fmtBytes(data.downloadSpeed || 0) + "/s";' +
  '      el("ul").textContent = fmtBytes(data.uploadSpeed || 0) + "/s";' +
  '' +
  '      var q = (el("filter").value || "").toLowerCase().trim();' +
  '      var list = (data.activeTorrents || []).filter(function(t){' +
  '        if (!q) return true;' +
  '        var n = (t.name || "").toLowerCase();' +
  '        var h = (t.infoHash || "").toLowerCase();' +
  '        return n.indexOf(q) !== -1 || h.indexOf(q) !== -1;' +
  '      }).sort(function(a,b){' +
  '        return (b.downloadSpeed || 0) - (a.downloadSpeed || 0);' +
  '      });' +
  '' +
  '      el("torrents").innerHTML = list.length ? list.map(torrentCard).join("") : "<div class=\\"muted\\">No active torrents</div>";' +
  '      restoreOpenDetails(openSet);' +
  '    }).catch(function(err){' +
  '      el("torrents").innerHTML = "<div class=\\"muted\\">Error: " + (err && err.message ? err.message : err) + "</div>";' +
  '    });' +
  '  }' +
  '' +
  '  window.__deleteTorrent = function(hash){' +
  '    if (!hash) return;' +
  '    if (!confirm("Delete torrent?")) return;' +
  '    api("DELETE", "/api/torrents/" + encodeURIComponent(hash)).then(function(){ refresh(); });' +
  '  };' +
  '' +
  '  el("refreshBtn").addEventListener("click", function(){ refresh(); });' +
  '  el("filter").addEventListener("input", function(){ refresh(); });' +
  '' +
  '  var timer = null;' +
  '  function setAuto(){' +
  '    if (timer) clearInterval(timer);' +
  '    var ms = Math.max(500, Number(el("autoMs").value) || 2000);' +
  '    timer = setInterval(function(){ refresh(); }, ms);' +
  '  }' +
  '  el("autoMs").addEventListener("change", setAuto);' +
  '' +
  '  setAuto();' +
  '  refresh();' +
  '})();' +
  '</script>' +
  '</body>' +
  '</html>';
