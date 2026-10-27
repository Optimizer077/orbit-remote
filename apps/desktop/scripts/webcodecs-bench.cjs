'use strict';
// D11 spike: measure Electron's WebCodecs H.264 encode/decode on this machine.
// Synthetic content only. No screen capture, no network. Prints one JSON object to stdout.
//
//   npx electron scripts/webcodecs-bench.cjs [--size 1920x1080,3024x1898] [--frames 240] [--fps 60]
//     [--bitrate 8000000] [--keyint 120] [--content text,video] [--codecs baseline,main,high]
//     [--stream <annexb file> [--codec avc1.xxxxxx]] [--no-software] [--dump <dir>] [--out <file>]
//
// See README-webcodecs-bench.md for the field meanings.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session, protocol } = require('electron');

// WebCodecs needs a secure context; data: pages are not one. Serve the page from a private secure scheme.
const SCHEME = 'orbit-bench';
if (protocol) protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);

function parseArgs(argv) {
  const i = argv.findIndex((a) => /webcodecs-bench\.cjs$/i.test(a));
  const args = i >= 0 ? argv.slice(i + 1) : argv.slice(2);
  const o = {
    sizes: ['1920x1080', '3024x1898'], frames: 240, fps: 60, bitrate: 8_000_000, keyint: 120,
    content: ['text', 'video'], codecs: ['baseline', 'main', 'high'], stream: null, codec: null,
    software: true, dump: null, out: null, timeoutS: 900, warmup: 10,
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const v = () => { const x = args[++k]; if (x === undefined) throw new Error(`missing value for ${a}`); return x; };
    switch (a) {
      case '--size': case '--sizes': o.sizes = v().split(','); break;
      case '--frames': o.frames = Number(v()); break;
      case '--fps': o.fps = Number(v()); break;
      case '--bitrate': o.bitrate = Number(v()); break;
      case '--keyint': o.keyint = Number(v()); break;
      case '--content': o.content = v().split(','); break;
      case '--codecs': o.codecs = v().split(','); break;
      case '--stream': o.stream = path.resolve(v()); break;
      case '--codec': o.codec = v(); break;
      case '--no-software': o.software = false; break;
      case '--dump': o.dump = path.resolve(v()); break;
      case '--out': o.out = path.resolve(v()); break;
      case '--timeout': o.timeoutS = Number(v()); break;
      case '--warmup': o.warmup = Number(v()); break;
      default: if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    }
  }
  for (const s of o.sizes) if (!/^\d+x\d+$/.test(s)) throw new Error(`bad --size ${s}`);
  if (!(o.frames > 0 && o.fps > 0 && o.bitrate > 0)) throw new Error('frames, fps and bitrate must be > 0');
  return o;
}

// ---------------------------------------------------------------------------
// Everything in benchPage runs inside the sandboxed page (no Node). It is injected with
// executeJavaScript(`(${benchPage})(opts)`) and must stay self-contained.
// ---------------------------------------------------------------------------
async function benchPage(opts) {
  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
  const log = (m) => console.log('[bench] ' + m);
  const stats = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
    return { n: s.length, median: r2(q(0.5)), p95: r2(q(0.95)), max: r2(s[s.length - 1]), mean: r2(s.reduce((a, b) => a + b, 0) / s.length) };
  };

  // H.264 level from macroblocks per frame and per second (Table A-1).
  function levelHex(w, h, fps) {
    const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
    const rate = mbs * fps;
    const L = [[30, 1620, 40500], [31, 3600, 108000], [32, 5120, 216000], [40, 8192, 245760], [41, 8192, 245760],
      [42, 8704, 522240], [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600]];
    for (const [l, fs, r] of L) if (mbs <= fs && rate <= r) return l.toString(16).toUpperCase().padStart(2, '0');
    return '34';
  }
  const PROFILES = { baseline: '42E0', main: '4D40', high: '6400' };
  function codecString(name, w, h, fps) {
    if (/^avc1\./i.test(name)) return name;
    const p = PROFILES[name];
    if (!p) throw new Error('unknown codec name ' + name);
    return 'avc1.' + p + levelHex(w, h, fps);
  }

  // ---------- synthetic frames ----------
  function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function makeSource(kind, w, h) {
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d', { alpha: false });
    const sc = h / 1080;
    if (kind === 'text') {
      // A tall "document" of glyph-like rectangles, scrolled 3 px/frame, plus a blinking caret and a line being typed.
      const docH = h * 2;
      const doc = new OffscreenCanvas(w, docH);
      const d = doc.getContext('2d', { alpha: false });
      d.fillStyle = '#ffffff'; d.fillRect(0, 0, w, docH);
      const rnd = mulberry32(1234);
      const lineH = Math.max(12, Math.round(22 * sc)), glyphH = Math.max(6, Math.round(11 * sc)), margin = Math.round(60 * sc);
      for (let y = Math.round(20 * sc); y + lineH < docH; y += lineH) {
        if (rnd() < 0.12) continue; // blank line
        let x = margin + (rnd() < 0.3 ? Math.round(32 * sc) : 0);
        const end = w - margin - rnd() * w * 0.35;
        d.fillStyle = rnd() < 0.1 ? '#1a56db' : '#1f2328';
        while (x < end) {
          const word = 2 + Math.floor(rnd() * 9);
          for (let c = 0; c < word && x < end; c++) {
            const gw = Math.max(2, Math.round((4 + rnd() * 6) * sc));
            const tall = rnd() < 0.25 ? Math.round(4 * sc) : 0;
            d.fillRect(x, y + (glyphH - tall) - glyphH + lineH - glyphH - 4, gw, glyphH + tall);
            x += gw + Math.max(1, Math.round(2 * sc));
          }
          x += Math.round(7 * sc);
        }
      }
      return (i) => {
        const off = (i * 3) % docH;
        const first = Math.min(h, docH - off);
        ctx.drawImage(doc, 0, off, w, first, 0, 0, w, first);
        if (first < h) ctx.drawImage(doc, 0, 0, w, h - first, 0, first, w, h - first);
        // typed line: grows by one glyph per frame
        const ty = h - Math.round(80 * sc);
        ctx.fillStyle = '#f6f8fa'; ctx.fillRect(0, ty - 8, w, lineH + 16);
        ctx.fillStyle = '#1f2328';
        const n = i % 180;
        let x = margin;
        for (let c = 0; c < n; c++) { ctx.fillRect(x, ty, Math.round(6 * sc), glyphH); x += Math.round(9 * sc) + (c % 7 === 6 ? Math.round(7 * sc) : 0); }
        if ((i >> 4) % 2 === 0) ctx.fillRect(x + 2, ty - 3, Math.max(2, Math.round(2 * sc)), glyphH + 6);
        return cv;
      };
    }
    // "video": moving gradient + moving soft blobs
    return (i) => {
      const t = i / 60;
      const g = ctx.createLinearGradient(0, 0, w * (0.5 + 0.5 * Math.cos(t * 0.7)), h * (0.5 + 0.5 * Math.sin(t * 0.9)));
      g.addColorStop(0, `hsl(${(i * 2) % 360},70%,45%)`);
      g.addColorStop(0.5, `hsl(${(i * 2 + 120) % 360},60%,55%)`);
      g.addColorStop(1, `hsl(${(i * 2 + 240) % 360},70%,35%)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      for (let b = 0; b < 6; b++) {
        const cx = w * (0.5 + 0.4 * Math.sin(t * (0.6 + b * 0.17) + b));
        const cy = h * (0.5 + 0.4 * Math.cos(t * (0.5 + b * 0.13) + b * 2));
        const rad = (80 + 40 * b) * sc;
        const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        rg.addColorStop(0, `hsla(${(b * 60 + i) % 360},90%,70%,0.9)`); rg.addColorStop(1, 'hsla(0,0%,100%,0)');
        ctx.fillStyle = rg; ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      }
      return cv;
    };
  }

  // ---------- encode ----------
  async function encodeSeq(content, w, h, codec, accel) {
    const cfg = { codec, width: w, height: h, bitrate: opts.bitrate, framerate: opts.fps, hardwareAcceleration: accel, latencyMode: 'realtime', avc: { format: 'annexb' } };
    const sup = await VideoEncoder.isConfigSupported(cfg).catch((e) => ({ supported: false, error: String(e) }));
    if (!sup.supported) return { supported: false, accel, error: sup.error || null };
    const chunks = [], lat = [], gen = [], submit = new Map();
    let err = null, decoderConfig = null, waits = 0;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        const t = now(); const s = submit.get(chunk.timestamp); if (s != null) lat.push([chunks.length, t - s]);
        if (meta && meta.decoderConfig && !decoderConfig) decoderConfig = { codec: meta.decoderConfig.codec, codedWidth: meta.decoderConfig.codedWidth, codedHeight: meta.decoderConfig.codedHeight };
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data });
      },
      error: (e) => { err = String(e); },
    });
    try { enc.configure(cfg); } catch (e) { return { supported: true, accel, error: 'configure: ' + e }; }
    const draw = makeSource(content, w, h);
    const t0 = now();
    for (let i = 0; i < opts.frames && !err; i++) {
      await sleep(t0 + (i * 1000) / opts.fps - now());
      while (enc.encodeQueueSize > 4 && !err) { waits++; await sleep(1); }
      const g0 = now();
      const ts = Math.round((i * 1e6) / opts.fps);
      const vf = new VideoFrame(draw(i), { timestamp: ts, duration: Math.round(1e6 / opts.fps) });
      gen.push(now() - g0);
      submit.set(ts, now());
      try { enc.encode(vf, { keyFrame: i === 0 || (opts.keyint > 0 && i % opts.keyint === 0) }); } catch (e) { err = 'encode: ' + e; }
      vf.close();
    }
    try { if (!err) await enc.flush(); } catch (e) { err = err || 'flush: ' + e; }
    const wall = now() - t0;
    try { enc.close(); } catch { /* already closed after error */ }
    const sizes = chunks.map((c) => c.data.byteLength);
    const keySizes = chunks.filter((c) => c.type === 'key').map((c) => c.data.byteLength);
    const deltaSizes = chunks.filter((c) => c.type !== 'key').map((c) => c.data.byteLength);
    const total = sizes.reduce((a, b) => a + b, 0);
    return {
      supported: true, accel, codecRequested: codec, decoderConfig, error: err,
      framesIn: opts.frames, chunksOut: chunks.length, keyframes: keySizes.length, queueWaits: waits,
      firstOutputMs: lat.length ? r2(lat[0][1]) : null,
      encodeLatencyMs: stats(lat.filter(([i]) => i >= opts.warmup).map(([, v]) => v)), frameGenMs: stats(gen),
      bytesPerFrame: { mean: Math.round(total / Math.max(1, chunks.length)), key: stats(keySizes), delta: stats(deltaSizes) },
      actualKbps: Math.round((total * 8) / ((chunks.length / opts.fps) * 1000)),
      wallSec: r2(wall / 1000), chunks,
    };
  }

  // ---------- Annex-B parsing (--stream) ----------
  function splitNals(buf) {
    const nals = []; let i = 0, start = -1;
    const n = buf.length;
    while (i + 2 < n) {
      if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && i + 3 < n && buf[i + 3] === 1))) {
        const sc = buf[i + 2] === 1 ? 3 : 4;
        if (start >= 0) nals.push([start, i]);
        i += sc; start = i;
      } else i++;
    }
    if (start >= 0) nals.push([start, n]);
    return nals.filter(([s, e]) => e > s);
  }
  function accessUnits(buf, fps) {
    const nals = splitNals(buf);
    const aus = []; let cur = null;
    const flush = () => { if (cur && cur.parts.length) aus.push(cur); cur = null; };
    let sps = null;
    for (const [s, e] of nals) {
      const type = buf[s] & 0x1f;
      const vcl = type === 1 || type === 5;
      if (type === 7 && !sps) sps = buf.subarray(s, Math.min(e, s + 4));
      const firstMb0 = vcl && e > s + 1 && (buf[s + 1] & 0x80) !== 0;
      if (cur && cur.hasVcl && (type === 9 || type === 7 || type === 8 || type === 6 || (vcl && firstMb0))) flush();
      if (!cur) cur = { parts: [], hasVcl: false, key: false };
      cur.parts.push([s, e]);
      if (vcl) cur.hasVcl = true;
      if (type === 5) cur.key = true;
    }
    flush();
    const chunks = aus.map((au, i) => {
      const len = au.parts.reduce((a, [s, e]) => a + 4 + (e - s), 0);
      const data = new Uint8Array(len); let o = 0;
      for (const [s, e] of au.parts) { data.set([0, 0, 0, 1], o); o += 4; data.set(buf.subarray(s, e), o); o += e - s; }
      return { type: au.key ? 'key' : 'delta', timestamp: Math.round((i * 1e6) / fps), data };
    });
    const codecFromSps = sps && sps.length >= 4 ? 'avc1.' + [sps[1], sps[2], sps[3]].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('') : null;
    return { chunks, codecFromSps };
  }

  // ---------- decode ----------
  const vis = document.getElementById('c');
  function makeDrawer(kind, w, h) {
    if (kind === 'none') return { draw: () => {} };
    vis.width = w; vis.height = h;
    if (kind === 'canvas2d') {
      const c = document.createElement('canvas'); c.width = w; c.height = h; document.body.appendChild(c);
      const ctx = c.getContext('2d', { alpha: false, desynchronized: true });
      return { draw: (f) => ctx.drawImage(f, 0, 0, w, h), dispose: () => c.remove() };
    }
    const c = document.createElement('canvas'); c.width = w; c.height = h; document.body.appendChild(c);
    const gl = c.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, desynchronized: true });
    if (!gl) return { draw: () => { throw new Error('webgl2 unavailable'); } };
    const vs = '#version 300 es\nin vec2 p; out vec2 uv; void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.,1.); }';
    const fsrc = '#version 300 es\nprecision mediump float; in vec2 uv; uniform sampler2D t; out vec4 o; void main(){ o = texture(t, uv); }';
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsrc)); gl.linkProgram(prog); gl.useProgram(prog);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.viewport(0, 0, w, h);
    const px = new Uint8Array(4);
    return {
      draw: (f) => { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); },
      sync: () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px),
      dispose: () => c.remove(),
    };
  }

  async function decodePass(chunks, codec, accel, mode, drawKind, w, h) {
    const cfg = { codec, hardwareAcceleration: accel, optimizeForLatency: true };
    const sup = await VideoDecoder.isConfigSupported(cfg).catch((e) => ({ supported: false, error: String(e) }));
    if (!sup.supported) return { supported: false };
    const drawer = makeDrawer(drawKind, w, h);
    const submit = new Map(), lat = [], drawMs = [], syncMs = [];
    let out = 0, err = null, frameInfo = null, lastOut = 0;
    const dec = new VideoDecoder({
      output: (f) => {
        const t = now(); lastOut = t;
        const s = submit.get(f.timestamp); if (s != null) lat.push([out, t - s]);
        out++;
        if (!frameInfo) {
          frameInfo = { format: f.format, codedWidth: f.codedWidth, codedHeight: f.codedHeight, displayWidth: f.displayWidth, displayHeight: f.displayHeight,
            colorSpace: f.colorSpace && f.colorSpace.toJSON ? f.colorSpace.toJSON() : null };
        }
        try {
          const d0 = now(); drawer.draw(f); if (out > opts.warmup) drawMs.push(now() - d0);
          if (drawer.sync) { const s0 = now(); drawer.sync(); if (out > opts.warmup) syncMs.push(now() - s0); }
        } catch (e) { err = err || 'draw: ' + e; }
        f.close();
      },
      error: (e) => { err = err || String(e); },
    });
    try { dec.configure(cfg); } catch (e) { drawer.dispose && drawer.dispose(); return { supported: true, error: 'configure: ' + e }; }
    const t0 = now(); let submitted = 0;
    for (let i = 0; i < chunks.length && !err && dec.state === 'configured'; i++) {
      const c = chunks[i];
      if (mode === 'paced') await sleep(t0 + (i * 1000) / opts.fps - now());
      else while (dec.decodeQueueSize >= 4 && !err) await new Promise((r) => { dec.addEventListener('dequeue', r, { once: true }); setTimeout(r, 50); });
      submit.set(c.timestamp, now());
      try { dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, data: c.data })); submitted++; } catch (e) { err = 'decode: ' + e; }
    }
    try { if (dec.state === 'configured') await dec.flush(); } catch (e) { err = err || 'flush: ' + e; }
    const wall = (mode === 'paced' ? now() : lastOut) - t0;
    try { dec.close(); } catch { /* closed by error */ }
    drawer.dispose && drawer.dispose();
    const res = {
      supported: true, mode, draw: drawKind, submitted, output: out, dropped: submitted - out, error: err, frameInfo,
      fps: r2(out / (wall / 1000)),
    };
    res.firstOutputMs = lat.length ? r2(lat[0][1]) : null;
    if (mode === 'paced') res.decodeLatencyMs = stats(lat.filter(([i]) => i >= opts.warmup).map(([, v]) => v));
    if (drawKind !== 'none') res.drawMs = stats(drawMs);
    if (syncMs.length) res.drawSyncMs = stats(syncMs);
    return res;
  }

  function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function concat(chunks) { const n = chunks.reduce((a, c) => a + c.data.byteLength, 0); const o = new Uint8Array(n); let p = 0; for (const c of chunks) { o.set(c.data, p); p += c.data.byteLength; } return o; }

  async function decodeSuite(chunks, codec, w, h) {
    const hw = {}, sw = {};
    log(`decode ${codec} ${w}x${h} hw paced canvas2d`); hw.pacedCanvas2d = await decodePass(chunks, codec, 'prefer-hardware', 'paced', 'canvas2d', w, h);
    if (hw.pacedCanvas2d.supported) {
      log('decode hw paced webgl'); hw.pacedWebgl = await decodePass(chunks, codec, 'prefer-hardware', 'paced', 'webgl', w, h);
      log('decode hw max canvas2d'); hw.maxCanvas2d = await decodePass(chunks, codec, 'prefer-hardware', 'max', 'canvas2d', w, h);
      log('decode hw max no-draw'); hw.maxNoDraw = await decodePass(chunks, codec, 'prefer-hardware', 'max', 'none', w, h);
    }
    if (opts.software) {
      log('decode sw paced canvas2d'); sw.pacedCanvas2d = await decodePass(chunks, codec, 'prefer-software', 'paced', 'canvas2d', w, h);
      if (sw.pacedCanvas2d.supported) { log('decode sw max no-draw'); sw.maxNoDraw = await decodePass(chunks, codec, 'prefer-software', 'max', 'none', w, h); }
    }
    return { hardware: hw, software: sw };
  }

  function verdict(dec) {
    const p = dec.hardware && dec.hardware.pacedCanvas2d;
    if (!p || !p.supported || !p.decodeLatencyMs) return { hardwareDecode: false };
    return {
      hardwareDecode: true,
      keepsUpAtTargetFps: p.dropped === 0 && !p.error && p.fps >= opts.fps * 0.95,
      medianLatencyUnder10ms: p.decodeLatencyMs.median < 10,
      p95LatencyUnder10ms: p.decodeLatencyMs.p95 < 10,
      maxFpsNoDraw: dec.hardware.maxNoDraw ? dec.hardware.maxNoDraw.fps : null,
    };
  }

  // ---------- run ----------
  const result = { support: {}, runs: [], dumps: [] };
  const sizes = opts.stream ? [] : opts.sizes.map((s) => s.split('x').map(Number));
  for (const [w, h] of sizes) {
    const key = `${w}x${h}`; result.support[key] = { decoder: {}, encoder: {} };
    for (const name of opts.codecs) {
      const codec = codecString(name, w, h, opts.fps);
      const dsup = {}, esup = {};
      for (const accel of ['prefer-hardware', 'prefer-software']) {
        dsup[accel] = (await VideoDecoder.isConfigSupported({ codec, hardwareAcceleration: accel, optimizeForLatency: true, codedWidth: w, codedHeight: h }).catch(() => ({ supported: false }))).supported;
        esup[accel] = (await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: opts.bitrate, framerate: opts.fps, hardwareAcceleration: accel, latencyMode: 'realtime', avc: { format: 'annexb' } }).catch(() => ({ supported: false }))).supported;
      }
      result.support[key].decoder[codec] = dsup; result.support[key].encoder[codec] = esup;
    }
  }
  for (const [w, h] of sizes) {
    for (const name of opts.codecs) {
      const codec = codecString(name, w, h, opts.fps);
      for (const content of opts.content) {
        log(`encode ${content} ${w}x${h} ${codec}`);
        let enc = await encodeSeq(content, w, h, codec, 'prefer-hardware');
        if (!enc.supported || enc.error || !enc.chunks || !enc.chunks.length) {
          const hwEnc = { ...enc, chunks: undefined };
          log('hardware encode unavailable, trying software');
          enc = await encodeSeq(content, w, h, codec, 'prefer-software');
          enc.hardwareAttempt = hwEnc;
        }
        const run = { source: 'synthetic', content, size: `${w}x${h}`, codec, encode: { ...enc, chunks: undefined } };
        if (enc.chunks && enc.chunks.length && !enc.error) {
          const dcodec = (enc.decoderConfig && enc.decoderConfig.codec) || codec;
          run.decode = await decodeSuite(enc.chunks, dcodec, w, h);
          run.verdict = verdict(run.decode);
          if (opts.dump) result.dumps.push({ name: `${content}-${w}x${h}-${codec}`, codec: dcodec, width: w, height: h, fps: opts.fps, frames: enc.chunks.length, b64: b64(concat(enc.chunks)) });
        } else run.decode = null;
        result.runs.push(run);
      }
    }
  }
  if (opts.stream) {
    const bin = Uint8Array.from(atob(opts.streamB64), (c) => c.charCodeAt(0));
    const { chunks, codecFromSps } = accessUnits(bin, opts.fps);
    const codec = opts.codec || codecFromSps;
    const run = { source: 'stream', file: opts.streamName, bytes: bin.length, accessUnits: chunks.length, keyframes: chunks.filter((c) => c.type === 'key').length, codec, codecFromSps };
    if (!codec || !chunks.length || chunks[0].type !== 'key') run.error = 'stream must start with an IDR access unit and carry an SPS (or pass --codec)';
    else {
      // Probe the size with one keyframe so the drawers get the right canvas size.
      let probe = null;
      const pd = new VideoDecoder({ output: (f) => { probe = probe || [f.displayWidth, f.displayHeight]; f.close(); }, error: () => {} });
      pd.configure({ codec, optimizeForLatency: true });
      pd.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: chunks[0].data }));
      await pd.flush().catch(() => {}); try { pd.close(); } catch { /* ignore */ }
      const [w, h] = probe || [1920, 1080];
      run.size = `${w}x${h}`;
      run.support = {};
      for (const accel of ['prefer-hardware', 'prefer-software']) run.support[accel] = (await VideoDecoder.isConfigSupported({ codec, hardwareAcceleration: accel, optimizeForLatency: true }).catch(() => ({ supported: false }))).supported;
      run.decode = await decodeSuite(chunks, codec, w, h);
      run.verdict = verdict(run.decode);
    }
    result.runs.push(run);
  }

  // Flat summary rows, one per decode run (hardware paced canvas2d is the headline number).
  result.summary = result.runs.map((r) => {
    const p = r.decode && r.decode.hardware && r.decode.hardware.pacedCanvas2d;
    const s = r.decode && r.decode.software && r.decode.software.pacedCanvas2d;
    return {
      source: r.source, content: r.content || null, size: r.size, codec: r.codec,
      encAccel: r.encode ? r.encode.accel : null, encMedMs: r.encode && r.encode.encodeLatencyMs ? r.encode.encodeLatencyMs.median : null,
      encP95Ms: r.encode && r.encode.encodeLatencyMs ? r.encode.encodeLatencyMs.p95 : null,
      bytesPerFrame: r.encode && r.encode.bytesPerFrame ? r.encode.bytesPerFrame.mean : null, actualKbps: r.encode ? r.encode.actualKbps : null,
      hwDecMedMs: p && p.decodeLatencyMs ? p.decodeLatencyMs.median : null, hwDecP95Ms: p && p.decodeLatencyMs ? p.decodeLatencyMs.p95 : null,
      hwPacedFps: p ? p.fps : null, hwDropped: p ? p.dropped : null, draw2dMedMs: p && p.drawMs ? p.drawMs.median : null,
      webglSyncMedMs: r.decode && r.decode.hardware.pacedWebgl && r.decode.hardware.pacedWebgl.drawSyncMs ? r.decode.hardware.pacedWebgl.drawSyncMs.median : null,
      hwMaxFps2d: r.decode && r.decode.hardware.maxCanvas2d ? r.decode.hardware.maxCanvas2d.fps : null,
      hwMaxFpsNoDraw: r.decode && r.decode.hardware.maxNoDraw ? r.decode.hardware.maxNoDraw.fps : null,
      swDecMedMs: s && s.decodeLatencyMs ? s.decodeLatencyMs.median : null, swDecP95Ms: s && s.decodeLatencyMs ? s.decodeLatencyMs.p95 : null,
      swMaxFpsNoDraw: r.decode && r.decode.software.maxNoDraw ? r.decode.software.maxNoDraw.fps : null,
      frameFormat: p && p.frameInfo ? p.frameInfo.format : null,
    };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Main process
// ---------------------------------------------------------------------------
const PAGE_URL = SCHEME + '://page/index.html';
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";
const PAGE_HTML = (
  '<!doctype html><meta charset="utf-8"><title>webcodecs-bench</title><body style="margin:0;background:#000"><canvas id="c" width="16" height="16"></canvas></body>');

async function main() {
  let opts;
  try { opts = parseArgs(process.argv); } catch (e) { process.stderr.write(`webcodecs-bench: ${e.message}\n`); app.exit(2); return; }
  const timer = setTimeout(() => { process.stderr.write('webcodecs-bench: timeout\n'); app.exit(3); }, opts.timeoutS * 1000);

  const pageOpts = { frames: opts.frames, fps: opts.fps, bitrate: opts.bitrate, keyint: opts.keyint, content: opts.content, codecs: opts.codecs,
    sizes: opts.sizes, software: opts.software, warmup: opts.warmup, dump: !!opts.dump, codec: opts.codec, stream: !!opts.stream };
  if (opts.stream) {
    pageOpts.streamB64 = fs.readFileSync(opts.stream).toString('base64');
    pageOpts.streamName = path.basename(opts.stream);
    if (!opts.codec) {
      const side = [opts.stream.replace(/\.[^.\\/]+$/, '.json'), opts.stream + '.json'].find((p) => fs.existsSync(p));
      if (side) { try { const j = JSON.parse(fs.readFileSync(side, 'utf8')); if (typeof j.codec === 'string') pageOpts.codec = j.codec; } catch { /* use SPS */ } }
    }
  }

  // In-memory session; every request other than the bench page itself is refused (no network).
  const ses = session.fromPartition('webcodecs-bench-' + process.pid, { cache: false });
  ses.protocol.handle(SCHEME, () => new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP } }));
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: d.url !== PAGE_URL }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const win = new BrowserWindow({
    show: false, width: 640, height: 400,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true, spellcheck: false },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (e) => { const m = e.message ?? ''; if (m.startsWith('[bench]')) process.stderr.write(m + '\n'); });
  const processEvents = [];
  app.on('child-process-gone', (_e, d) => processEvents.push({ type: d.type, reason: d.reason, exitCode: d.exitCode }));
  app.on('render-process-gone', (_e, _wc, d) => processEvents.push({ type: 'renderer', reason: d.reason, exitCode: d.exitCode }));
  await win.loadURL(PAGE_URL);
  try { await app.getGPUInfo('complete'); } catch { /* starts the GPU process; details not needed */ }

  const gpuFeatureStatus = app.getGPUFeatureStatus();
  let gpuDevices = null;
  try { const info = await app.getGPUInfo('basic'); gpuDevices = (info.gpuDevice || []).map((g) => ({ vendorId: g.vendorId, deviceId: g.deviceId, active: g.active, driverVendor: g.driverVendor, driverVersion: g.driverVersion })); } catch { /* not available */ }

  const started = new Date().toISOString();
  let page, error = null;
  try {
    page = await win.webContents.executeJavaScript(`(${benchPage.toString()})(${JSON.stringify(pageOpts)})`, true);
  } catch (e) { error = String(e && e.message || e); }

  const out = {
    tool: 'webcodecs-bench', version: 1, startedAt: started, finishedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, osRelease: require('node:os').release(),
    electron: process.versions.electron, chrome: process.versions.chrome,
    gpu: {
      featureStatus: { video_decode: gpuFeatureStatus.video_decode, video_encode: gpuFeatureStatus.video_encode, gpu_compositing: gpuFeatureStatus.gpu_compositing,
        '2d_canvas': gpuFeatureStatus['2d_canvas'], webgl2: gpuFeatureStatus.webgl2 },
      devices: gpuDevices,
    },
    processEvents,
    options: { ...pageOpts, streamB64: undefined, stream: opts.stream ? path.basename(opts.stream) : null, dump: opts.dump ? true : false },
    error,
    ...(page ? { support: page.support, summary: page.summary, runs: page.runs } : {}),
  };

  if (opts.dump && page && page.dumps.length) {
    fs.mkdirSync(opts.dump, { recursive: true });
    out.dumped = [];
    for (const d of page.dumps) {
      const file = path.join(opts.dump, d.name.replace(/[^A-Za-z0-9._-]/g, '_') + '.h264');
      fs.writeFileSync(file, Buffer.from(d.b64, 'base64'));
      fs.writeFileSync(file.replace(/\.h264$/, '.json'), JSON.stringify({ codec: d.codec, width: d.width, height: d.height, fps: d.fps, frames: d.frames, format: 'annexb', synthetic: true }, null, 2));
      out.dumped.push(file);
    }
  }

  const json = JSON.stringify(out, null, 2);
  if (opts.out) { fs.mkdirSync(path.dirname(opts.out), { recursive: true }); fs.writeFileSync(opts.out, json); }
  clearTimeout(timer);
  process.stdout.write(json + '\n', () => app.exit(error ? 1 : 0));
}

if (!app) {
  process.stderr.write('webcodecs-bench: run it with Electron (npx electron scripts/webcodecs-bench.cjs) and unset ELECTRON_RUN_AS_NODE.\n');
  process.exit(2);
}
app.whenReady().then(main).catch((e) => { process.stderr.write(`webcodecs-bench: ${e && e.stack || e}\n`); app.exit(1); });
app.on('window-all-closed', () => {});
