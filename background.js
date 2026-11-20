"use strict";

/* ------------------------------------------------------------------ *
 *  Asset Grabber — background.js (service worker)
 *  - Enregistrement complet du trafic par onglet quand il est actif.
 *  - Capture passive permanente des vidéos/audio et playlists HLS/DASH
 *    (y compris chargées en XHR/fetch ou dans des iframes), remise à
 *    zéro à chaque navigation principale.
 *  - Relais vers le document offscreen qui assemble les flux HLS.
 * ------------------------------------------------------------------ */

let sessions = {};          // tabId -> { recording, items: {url: {...}}, media: {url: {...}} }
let saveTimer = null;

// réhydrate l'état si le service worker a été relancé
chrome.storage.session.get("agSessions").then((d) => {
  if (d && d.agSessions && Object.keys(sessions).length === 0) sessions = d.agSessions;
}).catch(() => {});

function ensure(tabId) {
  if (!sessions[tabId]) sessions[tabId] = { recording: false, items: {}, media: {} };
  if (!sessions[tabId].media) sessions[tabId].media = {};
  return sessions[tabId];
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.session.set({ agSessions: sessions }).catch(() => {});
  }, 800);
}

const MAX_ITEMS = 5000;
const MAX_MEDIA = 500;
const SKIP = /^(chrome|chrome-extension|about|blob|data|ws|wss|edge):/i;
const MEDIA_EXT = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|ogv|mp3|m4a|aac|flac|wav|ogg|oga|opus)$/i;

/* segment d'un flux (inutile seul) : .ts/.m4s, MIME dédié, ou nom numéroté */
function isSegment(url, mime) {
  let path = "";
  try { path = new URL(url).pathname; } catch (_) {}
  if (/\.(m4s|m4f|cmfv|cmfa)$/i.test(path)) return true;
  if (/\.ts$/i.test(path) && !/typescript|javascript/i.test(mime)) return true;
  if (/^(video\/mp2t|video\/iso\.segment|audio\/iso\.segment)$/i.test(mime)) return true;
  return /(?:^|[\/_.-])(?:seg|segment|chunk|frag|fragment)[-_]?\d+[^\/]*$/i.test(path);
}
function isMedia(url, type, mime) {
  if (isSegment(url, mime)) return false;
  if (type === "media" || /^(video|audio)\//i.test(mime) || /mpegurl|dash\+xml/i.test(mime)) return true;
  try { return MEDIA_EXT.test(new URL(url).pathname); } catch (_) { return false; }
}

chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    if (d.tabId < 0 || SKIP.test(d.url)) return;
    const s = ensure(d.tabId);
    if (d.type === "main_frame") { s.media = {}; scheduleSave(); }

    const h = {};
    (d.responseHeaders || []).forEach((x) => { h[x.name.toLowerCase()] = x.value; });
    const mime = (h["content-type"] || "").split(";")[0].trim();
    // requête partielle (Range) : la taille totale est dans Content-Range
    const total = /\/(\d+)\s*$/.exec(h["content-range"] || "");
    const size = (total && +total[1]) || parseInt(h["content-length"] || "", 10) || 0;
    const item = { url: d.url, resourceType: d.type, mime, size, status: d.statusCode || 0, fromNet: true };

    if (s.recording && (s.items[d.url] || Object.keys(s.items).length < MAX_ITEMS)) {
      s.items[d.url] = item;
    } else if (isMedia(d.url, d.type, mime) && (s.media[d.url] || Object.keys(s.media).length < MAX_MEDIA)) {
      s.media[d.url] = item;
    } else return;
    scheduleSave();
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

/* -------------------------- offscreen (HLS) -------------------------- */
let creating = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Assemble HLS stream segments and convert WebP/AVIF images to PNG for download",
    }).finally(() => { creating = null; });
  }
  await creating;
}

const blobDownloads = new Map(); // downloadId -> blob URL à libérer
chrome.downloads.onChanged.addListener((d) => {
  if (!d.state || !blobDownloads.has(d.id)) return;
  if (d.state.current === "complete" || d.state.current === "interrupted") {
    chrome.runtime.sendMessage({ target: "offscreen", cmd: "revoke", url: blobDownloads.get(d.id) }).catch(() => {});
    blobDownloads.delete(d.id);
  }
});

/* -------------------------- messages -------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || (msg.target && msg.target !== "bg")) return false; // destiné au popup / offscreen
  const tabId = msg.tabId;
  switch (msg.cmd) {
    case "start":
      ensure(tabId).recording = true; scheduleSave(); reply({ ok: true }); break;
    case "stop":
      ensure(tabId).recording = false; scheduleSave(); reply({ ok: true }); break;
    case "reset": {
      const wasRec = !!(sessions[tabId] && sessions[tabId].recording);
      sessions[tabId] = { recording: wasRec, items: {}, media: {} };
      scheduleSave(); reply({ ok: true }); break;
    }
    case "state": {
      const s = ensure(tabId);
      reply({
        recording: !!s.recording,
        count: Object.keys(s.items).length,
        items: Object.values(Object.assign({}, s.media, s.items)),
      });
      break;
    }
    case "hls":
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ target: "offscreen", cmd: "hls", job: msg.job }))
        .then(() => reply({ ok: true }))
        .catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
      break;
    case "image":
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ target: "offscreen", cmd: "image", job: msg.job }))
        .then((r) => reply(r || { ok: false, error: "pas de réponse" }))
        .catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
      break;
    case "saveBlob":
      chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: "uniquify", saveAs: false })
        .then((id) => { blobDownloads.set(id, msg.url); reply({ ok: true, id }); })
        .catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
      break;
    default:
      reply({ ok: false });
  }
  return true; // réponse asynchrone possible
});

chrome.tabs.onRemoved.addListener((id) => { delete sessions[id]; scheduleSave(); });
