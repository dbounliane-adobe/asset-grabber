"use strict";

/* ------------------------------------------------------------------ *
 *  Asset Grabber — popup.js  (moteur basé sur les appels réseau)
 *
 *  Deux sources fusionnées :
 *   1) Resource Timing de la page (performance.getEntriesByType) — instantané
 *   2) Trafic enregistré par le service worker via webRequest — le plus complet
 * ------------------------------------------------------------------ */

/* -------------------------- thème -------------------------- *
 * Lu en synchrone (localStorage) avant le premier rendu pour éviter un flash.
 * Sans choix manuel, suit le thème du système.                               */
const THEME_KEY = "theme";
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
function savedTheme() { try { return localStorage.getItem(THEME_KEY); } catch { return null; } }
function applyTheme() {
  const t = savedTheme() || (darkMQ.matches ? "dark" : "light");
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById("themeBtn");
  if (btn) {
    const label = t === "dark" ? "Passer en thème clair" : "Passer en thème sombre";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  applyTheme();
}
applyTheme();
darkMQ.addEventListener("change", () => { if (!savedTheme()) applyTheme(); });

const el = {
  url: document.getElementById("urlInput"),
  scan: document.getElementById("scanBtn"),
  record: document.getElementById("recordBtn"),
  recLabel: document.getElementById("recLabel"),
  recInfo: document.getElementById("recInfo"),
  reload: document.getElementById("reloadBtn"),
  status: document.getElementById("statusChip"),
  toolbar: document.getElementById("toolbar"),
  filters: document.getElementById("filters"),
  selectAll: document.getElementById("selectAllBtn"),
  grid: document.getElementById("grid"),
  empty: document.getElementById("emptyState"),
  footer: document.getElementById("footer"),
  folder: document.getElementById("folderInput"),
  png: document.getElementById("pngToggle"),
  download: document.getElementById("downloadBtn"),
  selCount: document.getElementById("selCount"),
  toast: document.getElementById("toast"),
};

const CATEGORIES = [
  { key: "all", label: "Tout" },
  { key: "image", label: "Images" },
  { key: "svg", label: "SVG" },
  { key: "css", label: "CSS" },
  { key: "js", label: "JS" },
  { key: "font", label: "Polices" },
  { key: "media", label: "Média" },
  { key: "data", label: "Données" },
  { key: "other", label: "Autres" },
];
const RANK = { image: 0, svg: 1, media: 2, font: 3, css: 4, js: 5, data: 6, other: 7 };

let assets = [];
const selected = new Set();
// Types visibles ; ensemble vide = « Tout ». Persisté dans chrome.storage.local.
let activeTypes = new Set();
let savedFolder = ""; // dossier mémorisé ; vide = nom d'hôte de l'onglet
let toPng = true;     // WebP/AVIF convertis en PNG au téléchargement
let recording = false;
let tabId = null;
let tabTitle = "";

/* -------------------------- init -------------------------- */
init();
async function init() {
  await loadSettings();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      tabId = tab.id;
      tabTitle = tab.title || "";
      if (tab.url && /^https?:/.test(tab.url)) {
        el.url.value = tab.url;
        el.folder.value = savedFolder || safeFolder(new URL(tab.url).hostname);
      } else { el.folder.value = savedFolder || "assets"; }
      const st = await bg({ cmd: "state" });
      recording = !!(st && st.recording);
      updateRecUI(st && st.count);
    }
  } catch { el.folder.value = savedFolder || "assets"; }

  el.scan.addEventListener("click", () => runScan(false));
  el.url.addEventListener("keydown", (e) => { if (e.key === "Enter") runScan(false); });
  el.record.addEventListener("click", toggleRecord);
  el.reload.addEventListener("click", reloadAndRecord);
  el.selectAll.addEventListener("click", () => setAllVisible(!allVisibleSelected()));
  el.download.addEventListener("click", runDownload);
  document.getElementById("themeBtn").addEventListener("click", toggleTheme);
  chrome.runtime.onMessage.addListener(onHlsProgress);
  el.png.checked = toPng;
  el.png.addEventListener("change", () => { toPng = el.png.checked; saveSettings(); if (assets.length) render(); });
  el.folder.addEventListener("input", () => { savedFolder = safeFolder(el.folder.value.trim()); saveSettings(); });

  // scan auto à l'ouverture (pages web uniquement ; chrome://, etc. ne sont pas scriptables)
  if (tabId != null && /^https?:/.test(el.url.value)) runScan(true);
}

/* -------------------------- réglages -------------------------- */
async function loadSettings() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings && Array.isArray(settings.types)) activeTypes = new Set(settings.types);
    if (settings && typeof settings.folder === "string") savedFolder = settings.folder;
    if (settings && typeof settings.toPng === "boolean") toPng = settings.toPng;
  } catch (_) {}
}
function saveSettings() {
  chrome.storage.local.set({ settings: { types: [...activeTypes], folder: savedFolder, toPng } }).catch(() => {});
}
function isVisible(a) { return activeTypes.size === 0 || activeTypes.has(a.type); }
function toggleFilter(key) {
  if (key === "all") activeTypes.clear();
  else if (activeTypes.has(key)) activeTypes.delete(key);
  else activeTypes.add(key);
  saveSettings();
  render();
}

/* -------------------------- enregistrement -------------------------- */
async function toggleRecord() {
  recording = !recording;
  await bg({ cmd: recording ? "start" : "stop" });
  updateRecUI();
  if (recording) toast("Enregistrement en cours — recharge ou scrolle la page, puis Scanner.", "ok");
}

async function reloadAndRecord() {
  if (tabId == null) return toast("Aucun onglet actif.", "err");
  await bg({ cmd: "reset" });
  await bg({ cmd: "start" });
  recording = true; updateRecUI(0);
  setStatus("busy", "chargement…");
  try {
    const tab = await chrome.tabs.get(tabId);
    const field = el.url.value.trim();
    if (field && normalize(field) !== normalize(tab.url)) {
      await chrome.tabs.update(tabId, { url: field });
    } else {
      await chrome.tabs.reload(tabId);
    }
    await waitForComplete(tabId);
    await sleep(900);
    await runScan(true);
  } catch (e) {
    setStatus("error", "échec");
    toast("Rechargement impossible : " + (e.message || e), "err");
  }
}

function updateRecUI(count) {
  el.record.classList.toggle("on", recording);
  el.recLabel.textContent = recording ? "Enregistrement…" : "Enregistrer le trafic";
  if (typeof count === "number") el.recInfo.textContent = count ? count + " requêtes captées" : "";
}

/* -------------------------- scan -------------------------- */
async function runScan(skipNav) {
  if (tabId == null) return toast("Aucun onglet actif.", "err");
  const field = el.url.value.trim();

  setStatus("busy", "scan…");
  el.scan.disabled = true;
  assets = []; selected.clear();

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!skipNav && field && normalize(field) !== normalize(tab.url || "")) {
      setStatus("busy", "chargement…");
      await chrome.tabs.update(tabId, { url: field });
      await waitForComplete(tabId);
      await sleep(800);
    }

    // 1) Resource Timing + <video>/<audio> de chaque frame (iframes de lecteurs inclus)
    let perf = [];
    let res = null;
    try {
      res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectNetworkInPage });
    } catch (_) {
      try { res = await chrome.scripting.executeScript({ target: { tabId }, func: collectNetworkInPage }); } catch (_) {}
    }
    (res || []).forEach((r) => { if (r && Array.isArray(r.result)) perf.push(...r.result); });

    // 2) trafic enregistré par le service worker
    let rec = [];
    const st = await bg({ cmd: "state" });
    if (st) { rec = st.items || []; updateRecUI(st.count); }

    const merged = mergeItems(rec, perf);
    assets = normalizeAssets(merged);

    if (!assets.length) {
      setStatus("done", "0 asset");
      render();
      return toast("Aucun appel réseau détecté. Essaie « Recharger + enregistrer ».", "err");
    }
    setStatus("done", assets.length + " assets");
    render();
    setAllVisible(true);
  } catch (e) {
    setStatus("error", "échec");
    toast("Scan impossible : " + (e.message || e), "err");
  } finally {
    el.scan.disabled = false;
  }
}

/* --- lecteur Resource Timing injecté dans la page (autonome) --- */
function collectNetworkInPage() {
  const out = [];
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    out.push({ url: location.href, resourceType: null, initiator: "navigation", size: (nav && nav.transferSize) || 0 });
  } catch (_) {}
  let entries = [];
  try { entries = performance.getEntriesByType("resource"); } catch (_) {}
  for (const e of entries) {
    out.push({
      url: e.name,
      resourceType: null,
      initiator: e.initiatorType || "other",
      size: e.transferSize || e.encodedBodySize || 0,
    });
  }
  // médias du DOM (src direct, pas les blob: des lecteurs MSE)
  try {
    document.querySelectorAll("video, audio, source").forEach((m) => {
      const u = m.currentSrc || m.src;
      if (u && /^https?:/i.test(u)) out.push({ url: u, resourceType: "media", initiator: "video", size: 0 });
    });
  } catch (_) {}
  return out;
}

/* -------------------------- fusion & normalisation -------------------------- */
function mergeItems(recorded, perf) {
  const map = new Map();
  for (const r of recorded) map.set(r.url, Object.assign({}, r));
  for (const p of perf) {
    if (map.has(p.url)) {
      const m = map.get(p.url);
      if (!m.size && p.size) m.size = p.size;
      if (!m.initiator && p.initiator) m.initiator = p.initiator;
    } else {
      map.set(p.url, Object.assign({}, p));
    }
  }
  return [...map.values()];
}

function normalizeAssets(items) {
  const list = [];
  for (const it of items) {
    if (!it || !it.url) continue;
    if (/^(blob|chrome|chrome-extension|about):/i.test(it.url)) continue;
    if (isSegment(it)) continue; // morceaux de flux : inutiles seuls, la playlist suffit
    const stream = streamKind(it);
    const type = stream ? "media" : typeFor(it);
    const name = fileNameFromUrl(it.url, type);
    const ext = (name.split(".").pop() || "").toLowerCase();
    list.push({
      id: list.length + "|" + it.url.slice(0, 80),
      url: it.url, type, name, ext, stream,
      size: it.size || 0, mime: it.mime || "",
      w: 0, h: 0,
    });
  }
  // flux vidéo en tête : c'est ce qu'on cherche quand il y en a
  const rank = (a) => (a.stream === "hls" ? -2 : a.stream ? -1 : RANK[a.type] ?? 9);
  list.sort((a, b) => rank(a) - rank(b) || b.size - a.size);
  return list;
}

function urlPath(u) { try { return new URL(u).pathname; } catch { return ""; } }
function streamKind(it) {
  const p = urlPath(it.url), mime = it.mime || "";
  if (/\.m3u8$/i.test(p) || /mpegurl/i.test(mime)) return "hls";
  if (/\.mpd$/i.test(p) || /dash\+xml/i.test(mime)) return "dash";
  return null;
}
/* segment de flux : .ts/.m4s, MIME dédié, ou nom numéroté (même règle que background.js) */
function isSegment(it) {
  const p = urlPath(it.url), mime = it.mime || "";
  if (/\.(m4s|m4f|cmfv|cmfa)$/i.test(p)) return true;
  if (/\.ts$/i.test(p) && !/typescript|javascript/i.test(mime) && it.initiator !== "script" && it.resourceType !== "script") return true;
  if (/^(video\/mp2t|video\/iso\.segment|audio\/iso\.segment)$/i.test(mime)) return true;
  return /(?:^|[\/_.-])(?:seg|segment|chunk|frag|fragment)[-_]?\d+[^\/]*$/i.test(p) && (streamish(it));
}
function streamish(it) {
  const mime = it.mime || "";
  return /^(video|audio)\//i.test(mime) || it.resourceType === "media" ||
    /\.(mp4|m4a|m4v|aac|ts|webm|mp3)$/i.test(urlPath(it.url));
}

function typeFor(it) {
  const byExt = guessType(it.url, null);
  if (byExt) return byExt;
  const mime = it.mime || "";
  if (mime.startsWith("image/")) return mime.includes("svg") ? "svg" : "image";
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return "media";
  if (mime.includes("font")) return "font";
  if (mime.includes("css")) return "css";
  if (mime.includes("javascript") || mime.includes("ecmascript")) return "js";
  if (mime.includes("json") || (mime.includes("xml") && !mime.includes("svg"))) return "data";
  const rtMap = { image: "image", imageset: "image", stylesheet: "css", script: "js",
    font: "font", media: "media", xmlhttprequest: "data", websocket: "data",
    main_frame: "other", sub_frame: "other", ping: "other", object: "other", other: "other" };
  if (it.resourceType && rtMap[it.resourceType]) return rtMap[it.resourceType];
  const initMap = { img: "image", image: "image", script: "js", link: "other", css: "other",
    xmlhttprequest: "data", fetch: "data", beacon: "data", video: "media", audio: "media",
    iframe: "other", navigation: "other", other: "other" };
  if (it.initiator && initMap[it.initiator]) return initMap[it.initiator];
  return "other";
}

/* -------------------------- rendu -------------------------- */
function render() {
  const has = assets.length > 0;
  el.toolbar.hidden = !has;
  el.footer.hidden = !has;
  el.empty.style.display = has ? "none" : "";
  if (!has) { el.grid.querySelectorAll(".card").forEach((c) => c.remove()); return; }

  const counts = {};
  assets.forEach((a) => { counts[a.type] = (counts[a.type] || 0) + 1; });
  counts.all = assets.length;
  el.filters.innerHTML = "";
  CATEGORIES.forEach((cat) => {
    const on = cat.key === "all" ? activeTypes.size === 0 : activeTypes.has(cat.key);
    // un filtre actif reste visible même à 0, sinon la grille vide serait inexpliquée
    if (cat.key !== "all" && !counts[cat.key] && !on) return;
    const b = document.createElement("button");
    b.className = "filter" + (on ? " active" : "");
    b.setAttribute("aria-pressed", on);
    b.innerHTML = cat.label + ' <span class="fcount">' + (counts[cat.key] || 0) + "</span>";
    b.addEventListener("click", () => toggleFilter(cat.key));
    el.filters.appendChild(b);
  });

  el.grid.querySelectorAll(".card").forEach((c) => c.remove());
  const frag = document.createDocumentFragment();
  assets.filter(isVisible).forEach((a) => frag.appendChild(buildCard(a)));
  el.grid.appendChild(frag);
  updateSelectionUI();
}

function buildCard(a) {
  const card = document.createElement("div");
  card.className = "card" + (selected.has(a.id) ? " selected" : "");
  card.dataset.id = a.id;

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (a.type === "image" || a.type === "svg") {
    const img = document.createElement("img");
    img.loading = "lazy"; img.src = a.url; img.alt = "";
    img.addEventListener("load", () => {
      if (img.naturalWidth) {
        a.w = img.naturalWidth; a.h = img.naturalHeight;
        const d = card.querySelector(".dims");
        if (d && !a.size) d.textContent = a.w + " × " + a.h;
      }
    });
    img.addEventListener("error", () => { // remplace l'aperçu seul : garder la coche et le badge
      const g = document.createElement("span");
      g.className = "glyph";
      g.textContent = a.ext ? "." + a.ext : "?";
      img.replaceWith(g);
    });
    thumb.appendChild(img);
  } else {
    const g = document.createElement("span");
    g.className = "glyph";
    g.textContent = a.stream ? a.stream.toUpperCase()
      : { css: "CSS", js: "JS", font: "Aa", media: "▶", data: "{ }", other: "•••" }[a.type] || "?";
    thumb.appendChild(g);
  }

  const tick = document.createElement("div");
  tick.className = "tick";
  tick.innerHTML = '<svg viewBox="0 0 12 12" fill="none"><path d="M2 6.2 4.7 9 10 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  thumb.appendChild(tick);

  const badge = document.createElement("span");
  badge.className = "type-badge";
  badge.textContent = toPng && convertible(a) ? (/^(webp|avif)$/.test(a.ext) ? a.ext : "") + "→png" : a.ext || a.type;
  thumb.appendChild(badge);

  const meta = document.createElement("div");
  meta.className = "meta";
  const fn = document.createElement("div");
  fn.className = "fname"; fn.textContent = a.name; fn.title = a.url;
  const dims = document.createElement("div");
  dims.className = "dims";
  // un flux : la taille de la playlist ne dit rien, on dit ce qu'on obtiendra
  if (a.stream === "hls") { dims.textContent = "Flux vidéo → fichier unique"; }
  else if (a.stream === "dash") { dims.textContent = "Flux DASH (manifeste seul)"; }
  else if (a.size) { dims.innerHTML = '<span class="size">' + humanSize(a.size) + "</span>"; }
  else { dims.textContent = a.type.toUpperCase(); }
  meta.appendChild(fn); meta.appendChild(dims);

  card.appendChild(thumb); card.appendChild(meta);
  card.addEventListener("click", () => toggle(a.id, card));
  return card;
}

/* -------------------------- sélection -------------------------- */
function toggle(id, card) {
  if (selected.has(id)) { selected.delete(id); card.classList.remove("selected"); }
  else { selected.add(id); card.classList.add("selected"); }
  updateSelectionUI();
}
function allVisibleSelected() {
  const vis = assets.filter(isVisible);
  return vis.length > 0 && vis.every((a) => selected.has(a.id));
}
function setAllVisible(state) {
  assets.filter(isVisible).forEach((a) => state ? selected.add(a.id) : selected.delete(a.id));
  el.grid.querySelectorAll(".card").forEach((c) => c.classList.toggle("selected", selected.has(c.dataset.id)));
  updateSelectionUI();
}
function updateSelectionUI() {
  el.selCount.textContent = selected.size;
  el.download.disabled = selected.size === 0;
  const all = allVisibleSelected();
  el.selectAll.textContent = all ? "Tout décocher" : "Tout cocher";
  el.selectAll.disabled = !assets.some(isVisible);
}

/* -------------------------- téléchargement -------------------------- */
async function runDownload() {
  const folder = safeFolder(el.folder.value.trim()) || "assets";
  const chosen = assets.filter((a) => selected.has(a.id));
  if (!chosen.length) return;

  el.download.disabled = true;
  setStatus("busy", "téléch.…");
  const used = new Map();
  let ok = 0, fail = 0, streams = 0, pngs = 0;

  for (const a of chosen) {
    if (a.stream === "hls") {
      // assemblé en arrière-plan (document offscreen) : continue si le popup se ferme
      let base = hlsBaseName(a);
      const n = used.get(base) || 0;
      used.set(base, n + 1);
      if (n > 0) base += "-" + n;
      const r = await bg({ cmd: "hls", job: { id: a.id, url: a.url, name: base, filename: folder + "/" + base } });
      if (r && r.ok) streams++; else fail++;
      continue;
    }
    let name = a.name || "asset";
    const ext = (name.match(/(\.[^.]+)$/) || [""])[0];
    let base = ext ? name.slice(0, -ext.length) : name;
    const n = used.get(a.name) || 0;
    if (n > 0) { name = base + "-" + n + ext; base += "-" + n; }
    used.set(a.name, n + 1);
    if (toPng && convertible(a)) {
      // décodé puis réencodé en PNG hors du popup ; le vrai format est lu dans les octets
      const r = await bg({ cmd: "image", job: { url: a.url, filename: folder + "/" + base, origName: folder + "/" + name } });
      if (r && r.ok) { ok++; if (r.converted) pngs++; } else fail++;
      continue;
    }
    try {
      await chrome.downloads.download({
        url: a.url, filename: folder + "/" + name,
        conflictAction: "uniquify", saveAs: false,
      });
      ok++;
    } catch (_) { fail++; }
  }

  if (streams) setStatus("busy", "vidéo…"); else setStatus("done", ok + " ok");
  const parts = [];
  if (ok) parts.push(ok + " fichier(s)" + (pngs ? " dont " + pngs + " converti(s) en PNG" : ""));
  if (streams) parts.push(streams + " vidéo(s) en cours d'assemblage");
  toast((parts.join(" + ") || "Rien") + " → Téléchargements/" + folder + (fail ? " · " + fail + " échec(s)" : ""),
        fail ? "err" : "ok");
  el.download.disabled = false;
}

/* WebP/AVIF probable : extension, MIME, ou paramètre d'URL (ex. ?format=webply) */
function convertible(a) {
  if (a.type !== "image") return false;
  return /^(webp|avif)$/.test(a.ext) || /image\/(webp|avif)/i.test(a.mime) ||
    /[?&][^=&]+=(webp|avif)\w*(&|$)/i.test(a.url);
}

/* nom de la vidéo : nom de la playlist, ou titre de l'onglet si générique (master, index…) */
function hlsBaseName(a) {
  const base = a.name.replace(/\.m3u8$/i, "");
  const generic = /^(master|index|playlist|manifest|prog_index|chunklist.*|main|video|stream|media|mono|stereo|hls.*|\d+p?)$/i;
  if (generic.test(base) && tabTitle) return sanitize(tabTitle).replace(/_+/g, "_").slice(0, 80);
  return base;
}

function onHlsProgress(msg) {
  if (!msg || msg.target !== "popup" || msg.cmd !== "hlsProgress") return;
  if (msg.phase === "manifest") setStatus("busy", "vidéo…");
  else if (msg.phase === "remux") setStatus("busy", "conversion MP4…");
  else if (msg.phase === "segments") setStatus("busy", "vidéo " + Math.round((msg.done / msg.total) * 100) + " %");
  else if (msg.phase === "done") {
    setStatus("done", "vidéo ok");
    let t = "Vidéo « " + msg.name + " » enregistrée";
    if (msg.files > 1) t += " (image et son en 2 fichiers)";
    if (msg.live) t += " · direct : seule la partie actuelle";
    if (msg.keptTs) t += " · gardée en .ts (codec non convertible en MP4, lisible avec VLC)";
    toast(t, "ok");
  } else if (msg.phase === "error") {
    setStatus("error", "vidéo échec");
    toast("Vidéo « " + msg.name + " » : " + msg.error, "err");
  }
}

/* -------------------------- helpers -------------------------- */
function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ tabId }, msg), (r) => {
      if (chrome.runtime.lastError) resolve(null); else resolve(r);
    });
  });
}
function waitForComplete(id, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const to = setTimeout(finish, timeout);
    function listener(tid, info) { if (tid === id && info.status === "complete") finish(); }
    function finish() { if (done) return; done = true; clearTimeout(to); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guessType(url, fallback) {
  const clean = url.split("?")[0].split("#")[0];
  const ext = (clean.split(".").pop() || "").toLowerCase();
  const map = {
    jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
    avif: "image", bmp: "image", ico: "image", svg: "svg",
    css: "css", js: "js", mjs: "js",
    woff: "font", woff2: "font", ttf: "font", otf: "font", eot: "font",
    mp4: "media", webm: "media", ogv: "media", mp3: "media", wav: "media",
    m4v: "media", mkv: "media", opus: "media", oga: "media", m3u8: "media", mpd: "media",
    mov: "media", m4a: "media", aac: "media", flac: "media", ogg: "media",
    json: "data", xml: "data",
    pdf: "other", zip: "other", txt: "other", wasm: "other",
  };
  return map[ext] || fallback;
}
function fileNameFromUrl(u, type) {
  try {
    const url = new URL(u);
    let name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || url.hostname);
    name = name.split("?")[0];
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
      const e = { image: "img", svg: "svg", css: "css", js: "js", font: "woff", media: "bin", data: "json", other: "bin" }[type];
      if (e) name += "." + e;
    }
    return sanitize(name);
  } catch { return "asset"; }
}
function humanSize(b) {
  if (b < 1024) return b + " o";
  if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + " Ko";
  return (b / 1048576).toFixed(1) + " Mo";
}
function sanitize(n) { return n.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 120) || "asset"; }
function safeFolder(n) { return (n || "").replace(/[\\:*?"<>|]+/g, "_").replace(/^\.+/, "").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").slice(0, 120); }
function normalize(u) { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, ""); } catch { return u; } }

function setStatus(kind, text) { el.status.className = "chip chip--" + kind; el.status.textContent = text; }
let toastTimer;
function toast(msg, kind) {
  el.toast.textContent = msg;
  el.toast.className = "toast" + (kind ? " " + kind : "");
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4600);
}
