"use strict";

/* ------------------------------------------------------------------ *
 *  Asset Grabber — tsmux.js
 *  MPEG-TS (H.264 + AAC) → MP4 classique (ftyp + mdat + moov), lisible
 *  par QuickTime / AVFoundation, sans réencodage.
 *  TsMux.toMp4(segments: Uint8Array[]) → { parts: Uint8Array[], audioOnly } | null
 *  null = codec non pris en charge (HEVC, AC-3, MP3…) : garder le .ts.
 * ------------------------------------------------------------------ */

const TsMux = (() => {
  const H264 = 0x1b, AAC = 0x0f, ID3 = 0x15, PRIVATE = 0x06;
  const AV_TYPES = new Set([0x01, 0x02, 0x03, 0x04, 0x0f, 0x10, 0x11, 0x1b, 0x24, 0x42, 0x81, 0x87, 0xea]);
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const TS = 90000;     // horloge MPEG-TS
  const MOVIE_TS = 1000; // échelle de temps du film (ms)

  /* ============================ démultiplexage ============================ */
  function demux(segments) {
    let pmtPid = -1, vPid = -1, aPid = -1, ok = true;
    const acc = {};               // pid -> { chunks, len }
    const vPes = [], aPes = [];
    const flush = (pid) => {
      const st = acc[pid];
      if (!st || !st.len) return;
      const pes = parsePes(join(st.chunks, st.len));
      st.chunks = []; st.len = 0;
      if (pes) (pid === vPid ? vPes : aPes).push(pes);
    };

    for (const b of segments) {
      for (let i = 0; i + 188 <= b.length; i += 188) {
        if (b[i] !== 0x47) { // resynchronisation
          const j = b.indexOf(0x47, i + 1);
          if (j < 0) break;
          i = j - 188;
          continue;
        }
        const pusi = b[i + 1] & 0x40;
        const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
        const afc = (b[i + 3] >> 4) & 3;
        if (!(afc & 1)) continue;
        let p = i + 4;
        if (afc === 3) p += 1 + b[p];
        if (p >= i + 188) continue;

        if (pid === 0) {
          if (pusi && pmtPid < 0) pmtPid = parsePat(b, p + 1 + b[p]);
          continue;
        }
        if (pid === pmtPid) {
          if (pusi && vPid < 0 && aPid < 0) {
            const r = parsePmt(b, p + 1 + b[p]);
            vPid = r.v; aPid = r.a; ok = r.ok;
          }
          continue;
        }
        if (pid !== vPid && pid !== aPid) continue;
        if (pusi) flush(pid);
        const st = acc[pid] || (acc[pid] = { chunks: [], len: 0 });
        if (!pusi && !st.len) continue; // PES commencé avant le début
        const c = b.subarray(p, i + 188);
        st.chunks.push(c); st.len += c.length;
      }
    }
    flush(vPid); flush(aPid);
    return { ok: ok && (vPid >= 0 || aPid >= 0), vPes, aPes };
  }

  function parsePat(b, p) {
    const end = p + 3 + (((b[p + 1] & 0x0f) << 8) | b[p + 2]) - 4;
    for (let q = p + 8; q + 4 <= end; q += 4) {
      if ((b[q] << 8) | b[q + 1]) return ((b[q + 2] & 0x1f) << 8) | b[q + 3];
    }
    return -1;
  }

  function parsePmt(b, p) {
    const end = p + 3 + (((b[p + 1] & 0x0f) << 8) | b[p + 2]) - 4;
    let q = p + 12 + (((b[p + 10] & 0x0f) << 8) | b[p + 11]);
    let v = -1, a = -1, other = false, priv = false;
    while (q + 5 <= end) {
      const type = b[q], pid = ((b[q + 1] & 0x1f) << 8) | b[q + 2];
      if (type === H264 && v < 0) v = pid;
      else if (type === AAC && a < 0) a = pid;
      else if (type === PRIVATE) priv = true;         // souvent AC-3, parfois ID3/sous-titres
      else if (type !== ID3 && AV_TYPES.has(type)) other = true;
      q += 5 + (((b[q + 3] & 0x0f) << 8) | b[q + 4]);
    }
    // refuser plutôt que perdre une piste : codec inconnu, ou privé sans AAC
    return { v, a, ok: !other && !(priv && a < 0) };
  }

  function parsePes(b) {
    if (b.length < 9 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1) return null;
    const flags = b[7] >> 6, start = 9 + b[8];
    if (start > b.length) return null;
    const pts = flags & 2 ? readTs(b, 9) : null;
    const dts = flags === 3 ? readTs(b, 14) : pts;
    return { pts, dts, data: b.subarray(start) };
  }

  // horodatage 33 bits (multiplications : dépasse les entiers 32 bits)
  const readTs = (b, o) =>
    (b[o] & 0x0e) * 536870912 + b[o + 1] * 4194304 + (b[o + 2] >> 1) * 32768 + b[o + 3] * 128 + (b[o + 4] >> 1);

  // gère le rebouclage de l'horloge 33 bits
  function unwrapper() {
    let last = null, offset = 0;
    return (t) => {
      if (t == null) return null;
      t += offset;
      if (last != null && t < last - 4294967296) { offset += 8589934592; t += 8589934592; }
      last = t;
      return t;
    };
  }

  /* ============================ vidéo H.264 ============================ */
  function videoTrack(pesList) {
    const fix = unwrapper();
    let sps = null, pps = null;
    const samples = [];
    for (const pes of pesList) {
      const nals = splitNals(pes.data);
      const keep = [];
      let key = false;
      for (const n of nals) {
        const t = n[0] & 0x1f;
        if (t === 7) { if (!sps) sps = n; continue; }
        if (t === 8) { if (!pps) pps = n; continue; }
        if (t === 9) continue; // délimiteur d'unité d'accès
        if (t === 5) key = true;
        keep.push(n);
      }
      if (pes.pts == null && samples.length) { // suite de l'unité précédente
        const s = samples[samples.length - 1];
        s.nals.push(...keep); s.key = s.key || key;
        continue;
      }
      if (!keep.length || pes.pts == null) continue;
      const pts = fix(pes.pts), dts = Math.min(fix(pes.dts), pts);
      samples.push({ pts, dts, key, nals: keep });
    }
    if (!sps || !pps || !samples.length) return null;

    // AVCC : chaque NAL précédée de sa longueur sur 4 octets
    for (const s of samples) {
      s.parts = [];
      s.size = 0;
      for (const n of s.nals) { s.parts.push(u32(n.length), n); s.size += 4 + n.length; }
      delete s.nals;
    }
    timeline(samples, 3600);
    const dim = spsSize(sps);
    return {
      kind: "vide", timescale: TS, samples, width: dim.w, height: dim.h,
      start: samples.reduce((m, s) => Math.min(m, s.pts), Infinity), firstDts: samples[0].dts,
      entry: avc1(dim.w, dim.h, avcC(sps, pps)),
    };
  }

  // durées = écarts de DTS ; écart aberrant (discontinuité) → durée habituelle
  function timeline(samples, fallback) {
    let typical = fallback;
    for (let i = 0; i < samples.length; i++) {
      const d = i + 1 < samples.length ? samples[i + 1].dts - samples[i].dts : typical;
      samples[i].dur = d > 0 && d < 10 * TS ? d : typical;
      typical = samples[i].dur;
      samples[i].cts = Math.max(0, samples[i].pts - samples[i].dts);
    }
  }

  function splitNals(b) {
    const out = [];
    let i = 0, start = -1;
    while (i + 2 < b.length) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
        if (start >= 0) out.push(trimZeros(b.subarray(start, i)));
        i += 3; start = i;
      } else i++;
    }
    if (start >= 0 && start < b.length) out.push(trimZeros(b.subarray(start)));
    return out.filter((n) => n.length);
  }
  function trimZeros(n) {
    let e = n.length;
    while (e > 0 && n[e - 1] === 0) e--;
    return n.subarray(0, e);
  }

  function spsSize(sps) {
    const r = bitReader(unescape(sps.subarray(1)));
    const profile = r.u(8); r.u(16); r.ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = r.ue();
      if (chroma === 3) r.u(1);
      r.ue(); r.ue(); r.u(1);
      if (r.u(1)) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (!r.u(1)) continue;
          let last = 8, next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    r.ue();
    const poc = r.ue();
    if (poc === 0) r.ue();
    else if (poc === 1) { r.u(1); r.se(); r.se(); for (let n = r.ue(); n > 0; n--) r.se(); }
    r.ue(); r.u(1);
    const wMbs = r.ue() + 1, hMaps = r.ue() + 1, frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);
    r.u(1);
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    const cx = chroma === 0 || chroma === 3 ? 1 : 2;
    const cy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return { w: wMbs * 16 - (cl + cr) * cx, h: (2 - frameMbsOnly) * hMaps * 16 - (ct + cb) * cy };
  }
  function unescape(b) { // retire les octets d'émulation 00 00 03
    const out = [];
    for (let i = 0; i < b.length; i++) {
      if (i >= 2 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) continue;
      out.push(b[i]);
    }
    return Uint8Array.from(out);
  }
  function bitReader(b) {
    let pos = 0;
    const bit = () => { const v = (b[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return v; };
    const u = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
    const ue = () => { let z = 0; while (!bit() && z < 32) z++; return 2 ** z - 1 + u(z); };
    const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
    return { u, ue, se };
  }

  /* ============================ audio AAC (ADTS) ============================ */
  function audioTrack(pesList) {
    const fix = unwrapper();
    const samples = [];
    let cfg = null, start = null, carry = null;
    for (const pes of pesList) {
      if (start == null && pes.pts != null) start = fix(pes.pts);
      let b = carry ? join([carry, pes.data], carry.length + pes.data.length) : pes.data;
      carry = null;
      let o = 0;
      while (o + 7 <= b.length) {
        if (b[o] !== 0xff || (b[o + 1] & 0xf0) !== 0xf0) { o++; continue; }
        const len = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | (b[o + 5] >> 5);
        const hdr = b[o + 1] & 1 ? 7 : 9;
        if (len < hdr) { o++; continue; }
        if (o + len > b.length) break; // trame à cheval sur le PES suivant
        if (!cfg) {
          cfg = { profile: (b[o + 2] >> 6) + 1, sfi: (b[o + 2] >> 2) & 0xf, ch: ((b[o + 2] & 1) << 2) | (b[o + 3] >> 6) };
        }
        const frame = b.subarray(o + hdr, o + len);
        samples.push({ parts: [frame], size: frame.length, dur: 1024, cts: 0, key: true });
        o += len;
      }
      if (o < b.length) carry = b.slice(o);
    }
    if (!cfg || !samples.length || cfg.sfi >= RATES.length) return null;
    const rate = RATES[cfg.sfi];
    const asc = Uint8Array.of((cfg.profile << 3) | (cfg.sfi >> 1), ((cfg.sfi & 1) << 7) | (cfg.ch << 3));
    return {
      kind: "soun", timescale: rate, samples,
      start: start == null ? 0 : start, firstDts: start == null ? 0 : start,
      entry: mp4a(cfg.ch || 2, rate, asc),
    };
  }

  /* ============================ écriture MP4 ============================ */
  function toMp4(segments) {
    const d = demux(segments);
    if (!d.ok) return null;
    const tracks = [];
    if (d.vPes.length) { const v = videoTrack(d.vPes); if (!v) return null; tracks.push(v); }
    if (d.aPes.length) { const a = audioTrack(d.aPes); if (!a) return null; tracks.push(a); }
    if (!tracks.length) return null;

    // départ commun (en 90 kHz) pour garder la synchro image/son
    const t0 = Math.min(...tracks.map((t) => t.start));
    tracks.forEach((t, i) => {
      t.id = i + 1;
      t.mediaDur = t.samples.reduce((n, s) => n + s.dur, 0);
      t.delay = Math.round(((t.start - t0) / TS) * MOVIE_TS);
      t.movieDur = Math.round((t.mediaDur / t.timescale) * MOVIE_TS);
      t.mediaStart = t.kind === "vide" ? t.start - t.firstDts : 0; // décalage de composition initial
      t.chunks = [];
    });

    // entrelacement : morceaux d'environ 1 s par piste
    const order = [];
    const cursor = tracks.map(() => 0);
    for (let sec = 1; cursor.some((c, i) => c < tracks[i].samples.length); sec++) {
      tracks.forEach((t, i) => {
        const chunk = { first: cursor[i], count: 0, size: 0 };
        let time = sampleTime(t, cursor[i]);
        while (cursor[i] < t.samples.length && time < sec * t.timescale) {
          const s = t.samples[cursor[i]++];
          chunk.count++; chunk.size += s.size; time += s.dur;
        }
        if (chunk.count) { t.chunks.push(chunk); order.push([t, chunk]); }
      });
    }

    const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
    const dataSize = order.reduce((n, [, c]) => n + c.size, 0);
    const large = dataSize + 16 > 0xffffffff;
    const mdatHdr = large ? cat(u32(1), ascii("mdat"), u64(dataSize + 16)) : cat(u32(dataSize + 8), ascii("mdat"));
    let off = ftyp.length + mdatHdr.length;
    const data = [];
    for (const [t, c] of order) {
      c.offset = off;
      for (let k = c.first; k < c.first + c.count; k++) data.push(...t.samples[k].parts);
      off += c.size;
    }
    const co64 = off > 0xffffffff;
    const moov = box("moov", mvhd(tracks), ...tracks.map((t) => trak(t, co64)));
    return { parts: [ftyp, mdatHdr, ...data, moov], audioOnly: !tracks.some((t) => t.kind === "vide") };
  }

  // temps de décodage du n-ième échantillon (cache incrémental)
  function sampleTime(t, n) {
    if (!t._tc) t._tc = { n: 0, time: 0 };
    while (t._tc.n < n) t._tc.time += t.samples[t._tc.n++].dur;
    return t._tc.time;
  }

  function mvhd(tracks) {
    const dur = Math.max(...tracks.map((t) => t.delay + t.movieDur));
    return fullbox("mvhd", 0, 0, u32(0), u32(0), u32(MOVIE_TS), u32(dur), u32(0x00010000), u16(0x0100),
      zeros(10), matrix(), zeros(24), u32(tracks.length + 1));
  }

  function trak(t, co64) {
    const video = t.kind === "vide";
    const tkhd = fullbox("tkhd", 0, 3, u32(0), u32(0), u32(t.id), u32(0), u32(t.delay + t.movieDur), zeros(8),
      u16(0), u16(0), u16(video ? 0 : 0x0100), u16(0), matrix(),
      u32(video ? t.width * 65536 : 0), u32(video ? t.height * 65536 : 0));
    const edits = [];
    if (t.delay > 0) edits.push(cat(u32(t.delay), i32(-1), u32(0x00010000)));
    edits.push(cat(u32(t.movieDur), i32(t.mediaStart), u32(0x00010000)));
    const edts = box("edts", fullbox("elst", 0, 0, u32(edits.length), ...edits));
    const mdhd = fullbox("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(t.mediaDur), u16(0x55c4), u16(0));
    const hdlr = fullbox("hdlr", 0, 0, u32(0), ascii(t.kind), zeros(12),
      ascii(video ? "VideoHandler" : "SoundHandler"), Uint8Array.of(0));
    const mhd = video ? fullbox("vmhd", 0, 1, zeros(8)) : fullbox("smhd", 0, 0, zeros(4));
    const dinf = box("dinf", fullbox("dref", 0, 0, u32(1), fullbox("url ", 0, 1)));
    const stbl = box("stbl", fullbox("stsd", 0, 0, u32(1), t.entry), stts(t), ...(video ? [ctts(t), stss(t)] : []),
      stsc(t), stsz(t), stco(t, co64));
    return box("trak", tkhd, edts, box("mdia", mdhd, hdlr, box("minf", mhd, dinf, stbl)));
  }

  const runs = (vals) => {
    const out = [];
    for (const v of vals) {
      if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++;
      else out.push([1, v]);
    }
    return out;
  };
  const table = (type, rows) => fullbox(type, 0, 0, u32(rows.length), ...rows.map(([n, v]) => cat(u32(n), u32(v))));
  const stts = (t) => table("stts", runs(t.samples.map((s) => s.dur)));
  const ctts = (t) => table("ctts", runs(t.samples.map((s) => s.cts)));
  function stss(t) {
    const keys = [];
    t.samples.forEach((s, i) => { if (s.key) keys.push(u32(i + 1)); });
    return fullbox("stss", 0, 0, u32(keys.length), ...keys);
  }
  function stsc(t) {
    const rows = [];
    t.chunks.forEach((c, i) => {
      if (!rows.length || rows[rows.length - 1][1] !== c.count) rows.push([i + 1, c.count]);
    });
    return fullbox("stsc", 0, 0, u32(rows.length), ...rows.map(([f, n]) => cat(u32(f), u32(n), u32(1))));
  }
  const stsz = (t) => fullbox("stsz", 0, 0, u32(0), u32(t.samples.length), ...t.samples.map((s) => u32(s.size)));
  const stco = (t, co64) => co64
    ? fullbox("co64", 0, 0, u32(t.chunks.length), ...t.chunks.map((c) => u64(c.offset)))
    : fullbox("stco", 0, 0, u32(t.chunks.length), ...t.chunks.map((c) => u32(c.offset)));

  function avcC(sps, pps) {
    return box("avcC", Uint8Array.of(1, sps[1], sps[2], sps[3], 0xff, 0xe1), u16(sps.length), sps,
      Uint8Array.of(1), u16(pps.length), pps);
  }
  function avc1(w, h, avcc) {
    const name = new Uint8Array(32);
    return box("avc1", zeros(6), u16(1), zeros(16), u16(w), u16(h), u32(0x00480000), u32(0x00480000),
      u32(0), u16(1), name, u16(0x18), u16(0xffff), avcc);
  }
  function mp4a(ch, rate, asc) {
    const dsi = cat(Uint8Array.of(0x05, asc.length), asc);
    const dcd = cat(Uint8Array.of(0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0), u32(0), u32(0), dsi);
    const sl = Uint8Array.of(0x06, 1, 0x02);
    const es = cat(Uint8Array.of(0x03, 3 + dcd.length + sl.length), u16(1), Uint8Array.of(0), dcd, sl);
    return box("mp4a", zeros(6), u16(1), zeros(8), u16(ch), u16(16), u16(0), u16(0),
      u32(rate * 65536 >>> 0), fullbox("esds", 0, 0, es));
  }

  /* ============================ octets ============================ */
  function cat(...arrs) {
    const n = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }
  function join(chunks, len) {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  const box = (type, ...p) => { const body = cat(...p); return cat(u32(body.length + 8), ascii(type), body); };
  const fullbox = (type, v, flags, ...p) => box(type, Uint8Array.of(v, flags >> 16, (flags >> 8) & 0xff, flags & 0xff), ...p);
  const u16 = (n) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
  const u32 = (n) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const i32 = (n) => u32(n >>> 0);
  const u64 = (n) => cat(u32(Math.floor(n / 4294967296)), u32(n >>> 0));
  const zeros = (n) => new Uint8Array(n);
  const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const matrix = () => cat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

  return { toMp4 };
})();
