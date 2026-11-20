"use strict";

/* ------------------------------------------------------------------ *
 *  Asset Grabber — offscreen.js
 *  Assemble un flux HLS (.m3u8) en un seul fichier :
 *   playlist maître → meilleure variante (+ piste audio séparée éventuelle)
 *   → segments (TS ou fMP4, AES-128 déchiffré) → TS remuxé en MP4 (tsmux.js)
 *   → Blob → téléchargement.
 *  Tourne dans un document offscreen : continue si le popup se ferme.
 * ------------------------------------------------------------------ */

const CONCURRENCY = 6;
const RETRIES = 3;
const REVOKE_AFTER_MS = 30 * 60 * 1000; // filet de sécurité si le SW perd la trace

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "offscreen") return false;
  if (msg.cmd === "hls") {
    runHls(msg.job).catch((e) => notify(msg.job, { phase: "error", error: String((e && e.message) || e) }));
    reply({ ok: true });
  } else if (msg.cmd === "image") {
    runImage(msg.job).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
    return true; // réponse asynchrone
  } else if (msg.cmd === "revoke") {
    URL.revokeObjectURL(msg.url);
    reply({ ok: true });
  }
  return false;
});

function notify(job, extra) {
  chrome.runtime.sendMessage(Object.assign({ target: "popup", cmd: "hlsProgress", id: job.id, name: job.name }, extra))
    .catch(() => {}); // popup fermé : personne n'écoute
}

/* -------------------------- images → PNG -------------------------- */
async function runImage(job) {
  const r = await fetchRetry(job.url, {});
  const buf = new Uint8Array(await r.arrayBuffer());
  const kind = sniffImage(buf);
  let blob, filename;
  if (kind) {
    const bmp = await createImageBitmap(new Blob([buf], { type: "image/" + kind }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    blob = await c.convertToBlob({ type: "image/png" });
    filename = job.filename + ".png";
  } else { // pas du WebP/AVIF finalement : fichier d'origine intact
    blob = new Blob([buf], { type: (r.headers.get("content-type") || "").split(";")[0] });
    filename = job.origName;
  }
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "saveBlob", url, filename });
  if (!s || !s.ok) throw new Error((s && s.error) || "téléchargement refusé");
  return { ok: true, converted: !!kind };
}

/* format réel d'après la signature (l'extension ment parfois : .png?format=webply) */
function sniffImage(b) {
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 16) return null;
  if (tag(0) === "RIFF" && tag(8) === "WEBP") return "webp";
  if (tag(4) === "ftyp") { // marque principale ou compatible (mif1 + avif…)
    const end = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
    for (let o = 8; o + 4 <= end; o += 4) if (/^avi[fs]$/.test(tag(o))) return "avif";
  }
  return null;
}

/* -------------------------- orchestration -------------------------- */
async function runHls(job) {
  notify(job, { phase: "manifest" });
  let { text, url } = await fetchText(job.url);
  if (!/^\s*#EXTM3U/.test(text)) throw new Error("ce n'est pas une playlist HLS");

  let audioUrl = null;
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const master = parseMaster(text, url);
    if (!master.variants.length) throw new Error("aucune variante dans la playlist");
    const best = master.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (best.audio) {
      const a = pickAudio(master.media, best.audio);
      if (a) audioUrl = a.uri;
    }
    ({ text, url } = await fetchText(best.uri));
  }

  const tracks = [{ suffix: "", audio: false, pl: parseMedia(text, url) }];
  if (audioUrl) {
    const r = await fetchText(audioUrl);
    tracks.push({ suffix: "-audio", audio: true, pl: parseMedia(r.text, r.url) });
  }

  const total = tracks.reduce((n, t) => n + t.pl.segments.length, 0);
  if (!total) throw new Error("playlist vide");
  let done = 0;
  const tick = () => {
    done++;
    if (done === total || done % 5 === 0) notify(job, { phase: "segments", done, total });
  };

  let keptTs = false;
  for (const t of tracks) {
    let parts = await assemble(t.pl, tick);
    const fmp4 = t.pl.segments.some((s) => s.map);
    let ext = fmp4 ? (t.audio ? ".m4a" : ".mp4") : segExt(t.pl);
    if (ext === ".ts") {
      notify(job, { phase: "remux" });
      let mp4 = null;
      try { mp4 = TsMux.toMp4(parts); } catch (_) {}
      if (mp4) { parts = mp4.parts; ext = mp4.audioOnly ? ".m4a" : ".mp4"; }
      else keptTs = true;
    }
    const mime = { ".mp4": "video/mp4", ".m4a": "audio/mp4", ".ts": "video/mp2t" }[ext] || "application/octet-stream";
    const blob = new Blob(parts, { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(blobUrl), REVOKE_AFTER_MS);
    const r = await chrome.runtime.sendMessage({
      target: "bg", cmd: "saveBlob", url: blobUrl, filename: job.filename + t.suffix + ext,
    });
    if (!r || !r.ok) throw new Error("téléchargement refusé : " + ((r && r.error) || "inconnu"));
  }

  notify(job, { phase: "done", files: tracks.length, live: tracks.some((t) => !t.pl.ended), keptTs });
}

function segExt(pl) {
  const first = pl.segments[0] && new URL(pl.segments[0].uri).pathname.toLowerCase();
  if (first && /\.(aac|mp3|ac3|ec3)$/.test(first)) return first.slice(first.lastIndexOf("."));
  return ".ts";
}

/* -------------------------- parsing -------------------------- */
function attrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const abs = (u, base) => new URL(u, base).href;

function parseMaster(text, base) {
  const L = lines(text);
  const variants = [], media = [];
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (l.startsWith("#EXT-X-STREAM-INF:")) {
      const a = attrs(l.slice(18));
      let j = i + 1;
      while (j < L.length && L[j].startsWith("#")) j++;
      if (j < L.length) variants.push({ bandwidth: +a.BANDWIDTH || 0, audio: a.AUDIO || null, uri: abs(L[j], base) });
      i = j;
    } else if (l.startsWith("#EXT-X-MEDIA:")) {
      const a = attrs(l.slice(13));
      media.push({ type: a.TYPE, group: a["GROUP-ID"], def: a.DEFAULT === "YES", uri: a.URI ? abs(a.URI, base) : null });
    }
  }
  return { variants, media };
}

function pickAudio(media, group) {
  const c = media.filter((m) => m.type === "AUDIO" && m.group === group && m.uri);
  return c.find((m) => m.def) || c[0] || null;
}

function parseMedia(text, base) {
  let seq = 0, key = null, map = null, ended = false, range = null, lastEnd = 0;
  const segments = [];
  for (const l of lines(text)) {
    if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) seq = parseInt(l.slice(22), 10) || 0;
    else if (l.startsWith("#EXT-X-KEY:")) {
      const a = attrs(l.slice(11));
      if (a.METHOD === "NONE") key = null;
      else if (a.METHOD === "AES-128") key = { uri: abs(a.URI, base), iv: a.IV || null };
      else throw new Error("flux protégé (" + a.METHOD + ", DRM) : non téléchargeable");
    } else if (l.startsWith("#EXT-X-MAP:")) {
      const a = attrs(l.slice(11));
      map = { uri: abs(a.URI, base), range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null };
    } else if (l.startsWith("#EXT-X-BYTERANGE:")) range = l.slice(17);
    else if (l === "#EXT-X-ENDLIST") ended = true;
    else if (!l.startsWith("#")) {
      const r = range ? parseRange(range, lastEnd) : null;
      if (r) lastEnd = r.end + 1;
      segments.push({ uri: abs(l, base), key, map, range: r, seq: seq + segments.length });
      range = null;
    }
  }
  return { segments, ended };
}

function parseRange(s, prevEnd) {
  const [len, off] = s.split("@").map((n) => parseInt(n, 10));
  const start = Number.isFinite(off) ? off : prevEnd;
  return { start, end: start + len - 1 };
}

/* -------------------------- téléchargement -------------------------- */
async function assemble(pl, tick) {
  const keys = new Map();
  const getKey = (uri) => {
    if (!keys.has(uri)) {
      keys.set(uri, fetchBytes(uri).then((raw) => crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"])));
    }
    return keys.get(uri);
  };

  const data = await pool(pl.segments, CONCURRENCY, async (s) => {
    let bytes = await fetchBytes(s.uri, s.range);
    if (s.key) {
      const k = await getKey(s.key.uri);
      bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivFor(s) }, k, bytes));
    }
    tick();
    return bytes;
  });

  // insère le segment d'init (EXT-X-MAP) à chaque changement
  const maps = new Map();
  const parts = [];
  let prev = null;
  for (let i = 0; i < pl.segments.length; i++) {
    const m = pl.segments[i].map;
    if (m && m !== prev) {
      const id = m.uri + (m.range ? "@" + m.range.start : "");
      if (!maps.has(id)) maps.set(id, await fetchBytes(m.uri, m.range));
      parts.push(maps.get(id));
      prev = m;
    }
    parts.push(data[i]);
  }
  return parts;
}

function ivFor(s) {
  const iv = new Uint8Array(16);
  if (s.key.iv) {
    const hex = s.key.iv.replace(/^0x/i, "").padStart(32, "0");
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, s.seq); // numéro de séquence, big-endian
  }
  return iv;
}

async function fetchText(url) {
  const r = await fetchRetry(url, {});
  return { text: await r.text(), url: r.url || url };
}

async function fetchBytes(url, range) {
  const headers = range ? { Range: "bytes=" + range.start + "-" + range.end } : {};
  const r = await fetchRetry(url, { headers });
  let buf = new Uint8Array(await r.arrayBuffer());
  if (range && r.status === 200) buf = buf.slice(range.start, range.end + 1); // Range ignoré par le serveur
  return buf;
}

async function fetchRetry(url, opts) {
  let err;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const r = await fetch(url, Object.assign({ credentials: "include" }, opts));
      if (r.ok) return r;
      err = new Error("HTTP " + r.status + " sur " + new URL(url).pathname.split("/").pop());
      if (r.status === 403 || r.status === 404) break;
    } catch (e) { err = e; }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  throw err;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
