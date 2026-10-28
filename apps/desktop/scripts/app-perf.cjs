'use strict';
// Desktop-app performance probe: the production renderer bundle, a generated host bridge and headless Chromium.
// No Electron, no native host, no network, no screen capture, no input. Generated fixture data only.
//
//   node scripts/app-perf.cjs [--port 7040] [--runs 7] [--idle-runs 3] [--idle 60] [--soak 300]
//     [--only bundle,startup,renders,switch,idle,soak] [--incoming] [--idle-page Activity] [--dist dir] [--label name] [--out file.json]
//
// Measures, with the same fixture every time:
//   bundle   production build sizes (raw and gzip), initial versus lazy JS
//   startup  first contentful paint and "Overview interactive" (a Connect button enabled, no skeletons), per fresh context
//   renders  React commits and rendered components per status poll whose data did not change (and one that did)
//   switch   sidebar page switch: click -> React commit -> style and layout (forced), per page
//   idle     main-thread busy time, layouts and bridge calls over --idle seconds on Overview, visible and then hidden
//   soak     heap, DOM nodes, listeners and live timers before/after --soak seconds of fast polling and page switches
// Prints one JSON summary (median, min, max per metric) to stdout; progress goes to stderr.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const PORT = Number(option('--port', process.env.ORBIT_PERF_PORT || 7040));
const RUNS = Number(option('--runs', 7)), IDLE_RUNS = Number(option('--idle-runs', 3));
const IDLE_SECONDS = Number(option('--idle', 60)), SOAK_SECONDS = Number(option('--soak', 300));
const ONLY = new Set(option('--only', 'bundle,startup,renders,switch,idle,soak').split(','));
const LABEL = option('--label', ''), OUT = option('--out');
// --incoming: another computer is viewing this one, so the app polls on its faster cadence and shows the viewed banner.
const INCOMING = args.includes('--incoming');
// --idle-page: the sidebar page the idle measurement sits on (Overview by default; Activity renders the most rows).
const IDLE_PAGE = option('--idle-page', 'Overview');
const APP_DIR = path.resolve(__dirname, '..');
const log = message => process.stderr.write(`app-perf: ${message}\n`);

const stats = values => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const round = x => Math.round(x * 100) / 100;
  return { median: round(v[Math.floor((v.length - 1) / 2)]), min: round(v[0]), max: round(v[v.length - 1]), n: v.length };
};

// ---------- Generated bridge, installed before any page script (must be self-contained) ----------
function installFixture({ incomingSession }) {
  const counts = {}, replies = {}, latestReplyStart = {}, incoming = new Set(), windowListeners = new Set(), cleanupListeners = new Set(), fullscreenListeners = new Set();
  let pending = 0, windowState = { paused: false, reason: null, revision: 0 }, dataRevision = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const grants = { view: true, control: true, clipboard: true, files: false, power: false };
  const devices = Array.from({ length: 12 }, (_, i) => ({
    id: `generated-${i}`, name: `Generated computer ${i + 1}`, platform: ['windows', 'darwin', 'linux'][i % 3],
    address: i < 8 ? `https://127.0.0.1:${4000 + i}` : undefined, online: i % 4 !== 3, direction: i < 8 ? 'outgoing' : 'incoming',
    fingerprint: 'AB'.repeat(32), pairedAt: '2026-10-01T09:00:00Z', permissions: { ...grants },
  }));
  const audit = Array.from({ length: 500 }, (_, i) => ({ id: `a${i}`, timestamp: new Date(Date.UTC(2026, 9, 27, 12, 0, 0) - i * 600000).toISOString(),
    action: ['session.started', 'session.ended', 'device.paired', 'settings.changed'][i % 4], deviceName: `Generated computer ${(i % 12) + 1}`, detail: 'Generated entry' }));
  const status = {
    host: { id: 'generated-host', name: 'Generated host', platform: 'windows', version: '0.1.0', online: true, testMode: false, fingerprint: 'CD'.repeat(32),
      tailscale: { available: true, connected: true, ip: '100.64.0.1', dnsName: 'generated', state: 'connected' } },
    capabilities: { capture: true, input: true, clipboard: true, files: true, power: true },
    settings: { hostName: 'Generated host', allowControl: true, allowClipboard: true, allowFiles: false, allowPower: false, listenPort: 47832 },
    sessions: incomingSession ? [{ id: 'generated-incoming', deviceId: 'generated-8', deviceName: 'Generated computer 9', direction: 'incoming', startedAt: '2026-10-27T12:00:00Z', permissions: { view: true, control: false } }] : [],
  };
  const runtime = { supervisor: { state: 'running', restartsLeft: 3 }, identity: { expiresAt: '2027-10-01T00:00:00Z', daysRemaining: 340, warning: false, expired: false } };
  const respond = action => {
    switch (action) {
      case 'status': return status;
      case 'devices': return devices;
      case 'audit': return audit;
      case 'host.runtime': return runtime;
      case 'window.state': return windowState;
      case 'window.fullscreen.get': return { fullscreen: false, revision: 0 };
      case 'session.cleanup.list': return { revision: 0, entries: [] };
      default: return { error: { message: `Generated bridge does not support ${action}.` } };
    }
  };
  window.orbit = {
    async invoke(action) {
      counts[action] = (counts[action] || 0) + 1; pending++; const started = performance.now();
      try { await new Promise(resolve => setTimeout(resolve, 2)); const reply = clone(respond(action)); replies[action] = (replies[action] || 0) + 1; latestReplyStart[action] = Math.max(latestReplyStart[action] ?? -Infinity, started); return reply; }
      finally { pending--; }
    },
    onIncomingChanged(callback) { incoming.add(callback); return () => incoming.delete(callback); },
    onWindowState(callback) { windowListeners.add(callback); return () => windowListeners.delete(callback); },
    onCleanupChanged(callback) { cleanupListeners.add(callback); return () => cleanupListeners.delete(callback); },
    onFullscreenState(callback) { fullscreenListeners.add(callback); return () => fullscreenListeners.delete(callback); },
  };

  // Live timers, so a leak shows as a growing count.
  const intervals = new Set(), timeouts = new Set();
  const [setI, clearI, setT, clearT] = [window.setInterval, window.clearInterval, window.setTimeout, window.clearTimeout];
  window.setInterval = function (handler, ms, ...rest) { const id = setI.call(window, handler, ms, ...rest); intervals.add(id); return id; };
  window.clearInterval = function (id) { intervals.delete(id); return clearI.call(window, id); };
  window.setTimeout = function (handler, ms, ...rest) {
    const id = setT.call(window, function (...a) { timeouts.delete(id); return typeof handler === 'function' ? handler.apply(this, a) : undefined; }, ms, ...rest);
    timeouts.add(id); return id;
  };
  window.clearTimeout = function (id) { timeouts.delete(id); return clearT.call(window, id); };

  // React commits and rendered components, read from the devtools hook React calls in production builds too.
  const renders = { commits: 0, components: 0, byName: {} };
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const walk = fiber => {
    for (const stack = [fiber]; stack.length;) {
      const node = stack.pop(), prev = node.alternate;
      if (COMPONENT_TAGS.has(node.tag) && (!prev || (node.flags & 1))) {
        renders.components++;
        const name = node.type?.displayName || node.type?.name || node.type?.type?.name || 'anonymous';
        renders.byName[name] = (renders.byName[name] || 0) + 1;
      }
      if (prev && node.child === prev.child) continue;
      for (let child = node.child; child; child = child.sibling) stack.push(child);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject() { return 1; }, checkDCE() {}, on() {}, off() {}, sub() { return () => {}; }, emit() {},
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) { renders.commits++; walk(root.current); },
  };

  const marks = {};
  const observer = new MutationObserver(() => {
    if (marks.overview || !document.querySelector('button[aria-label^="Connect to "]:not([disabled])') || document.querySelector('.ov-skeleton-stack')) return;
    marks.overview = performance.now(); observer.disconnect();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true });

  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.__perf = {
    counts: () => ({ ...counts }), replies: () => ({ ...replies }),
    // Only the newest request start per action is kept, so the probe adds no per-reply memory to the soak.
    repliedSince: (action, since) => (latestReplyStart[action] ?? -Infinity) >= since, marks, renders: () => ({ commits: renders.commits, components: renders.components, byName: { ...renders.byName } }),
    live: () => ({ intervals: intervals.size, timeouts: timeouts.size, incomingListeners: incoming.size, windowListeners: windowListeners.size, cleanupListeners: cleanupListeners.size, fullscreenListeners: fullscreenListeners.size }),
    async settled() { for (let i = 0; i < 200 && pending; i++) await new Promise(resolve => setT.call(window, resolve, 5)); await frames(); await new Promise(resolve => setT.call(window, resolve, 20)); await frames(); },
    poll() { for (const callback of [...incoming]) callback(); },
    setHidden(paused) { windowState = { paused, reason: paused ? 'minimized' : null, revision: windowState.revision + 1 }; for (const callback of [...windowListeners]) callback({ ...windowState }); },
    change() {
      dataRevision++;
      devices[0].online = !devices[0].online;
      audit.unshift({ id: `n${dataRevision}`, timestamp: new Date().toISOString(), action: 'session.started', deviceName: 'Generated computer 1', detail: 'Generated entry' });
      audit.length = 500;
    },
  };
}

// ---------- Build and serve ----------
async function buildBundle(outDir, prebuilt) {
  if (!prebuilt) {
    const { build } = await import(pathToFileURL(require.resolve('vite', { paths: [APP_DIR] })).href);
    await build({ configFile: path.join(APP_DIR, 'vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  }
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  const initial = new Set([...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map(m => m[1]));
  const files = fs.readdirSync(path.join(outDir, 'assets')).map(name => {
    const data = fs.readFileSync(path.join(outDir, 'assets', name));
    return { name, bytes: data.length, gzip: zlib.gzipSync(data, { level: 9 }).length, initial: initial.has(`assets/${name}`) };
  });
  const sum = (list, key) => list.reduce((total, file) => total + file[key], 0);
  const js = files.filter(f => f.name.endsWith('.js')), css = files.filter(f => f.name.endsWith('.css'));
  const initialJs = js.filter(f => f.initial);
  return { files, jsBytes: sum(js, 'bytes'), jsGzip: sum(js, 'gzip'), initialJsBytes: sum(initialJs, 'bytes'), initialJsGzip: sum(initialJs, 'gzip'),
    lazyJsBytes: sum(js.filter(f => !f.initial), 'bytes'), cssBytes: sum(css, 'bytes'), cssGzip: sum(css, 'gzip') };
}

function serve(root) {
  const base = path.resolve(root);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    let name;
    try { name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html'; }
    catch { res.writeHead(400); res.end(); return; }
    const file = path.resolve(base, name), inside = path.relative(base, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', () => resolve(server)); });
}

// ---------- Page helpers ----------
const BASE = `http://127.0.0.1:${PORT}/index.html`;
async function openApp(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'no-preference' });
  await context.addInitScript(installFixture, { incomingSession: INCOMING });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const started = Date.now();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__perf.marks.overview, null, { timeout: 30000 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  return { context, page, cdp, errors, wallMs: Date.now() - started };
}
const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
const gc = async cdp => { await cdp.send('HeapProfiler.enable'); for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage'); };
const delta = (a, b) => Object.fromEntries(Object.keys(b).map(k => [k, (b[k] || 0) - (a[k] || 0)]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startup(browser) {
  const runs = [];
  for (let run = 0; run < RUNS; run++) {
    const app = await openApp(browser);
    const value = await app.page.evaluate(() => {
      const paint = performance.getEntriesByName('first-contentful-paint')[0];
      const nav = performance.getEntriesByType('navigation')[0];
      return { fcp: paint?.startTime, domContentLoaded: nav?.domContentLoadedEventEnd, overviewInteractive: window.__perf.marks.overview };
    });
    await sleep(500); await gc(app.cdp);
    const m = await metrics(app.cdp);
    runs.push({ ...value, heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, commitsToInteractive: (await app.page.evaluate(() => window.__perf.renders().commits)) });
    await app.context.close();
    log(`startup run ${run + 1}/${RUNS}: fcp ${Math.round(value.fcp)} ms, overview ${Math.round(value.overviewInteractive)} ms`);
  }
  return { runs, fcpMs: stats(runs.map(r => r.fcp)), overviewInteractiveMs: stats(runs.map(r => r.overviewInteractive)),
    heapMB: stats(runs.map(r => r.heapMB)), commitsToInteractive: stats(runs.map(r => r.commitsToInteractive)) };
}

async function rendersPerPoll(browser) {
  const app = await openApp(browser);
  await sleep(1000); await app.page.evaluate(() => window.__perf.settled());
  const measure = () => app.page.evaluate(async () => {
    const before = window.__perf.renders(), calls = window.__perf.counts().status || 0;
    window.__perf.poll(); await window.__perf.settled();
    const after = window.__perf.renders();
    const byName = Object.fromEntries(Object.entries(after.byName).map(([k, v]) => [k, v - (before.byName[k] || 0)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8));
    return { commits: after.commits - before.commits, components: after.components - before.components, statusCalls: (window.__perf.counts().status || 0) - calls, byName };
  });
  const unchanged = [];
  for (let i = 0; i < 10; i++) unchanged.push(await measure());
  await app.page.evaluate(() => window.__perf.change());
  const changed = await measure();
  await app.context.close();
  log(`renders: unchanged poll ${unchanged[0].commits} commits / ${unchanged[0].components} components; changed poll ${changed.commits} / ${changed.components}`);
  return { unchanged: { commits: stats(unchanged.map(r => r.commits)), components: stats(unchanged.map(r => r.components)), sample: unchanged[0] }, changed, errors: app.errors };
}

const PAGES = ['Devices', 'Connections', 'Activity', 'Settings', 'Overview'];
async function pageSwitch(browser) {
  const app = await openApp(browser);
  await sleep(500);
  const results = Object.fromEntries(PAGES.map(p => [p, []]));
  for (let round = 0; round < Math.max(5, RUNS); round++) for (const label of PAGES) {
    results[label].push(await app.page.evaluate(async label => {
      const button = [...document.querySelectorAll('nav[aria-label="Main navigation"] button')].find(b => b.textContent.includes(label));
      // React flushes a discrete click update in a microtask queued during click(); awaiting once runs after it.
      const t0 = performance.now(); button.click(); await Promise.resolve(); const committed = performance.now();
      void document.body.offsetHeight; const laidOut = performance.now();
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      return { commitMs: committed - t0, layoutMs: laidOut - t0, frameMs: performance.now() - t0 };
    }, label));
    await sleep(50);
  }
  await app.context.close();
  return Object.fromEntries(PAGES.map(p => [p, { commitMs: stats(results[p].map(r => r.commitMs)), layoutMs: stats(results[p].map(r => r.layoutMs)) }]));
}

async function idle(browser) {
  const runs = [];
  for (let run = 0; run < IDLE_RUNS; run++) {
    const app = await openApp(browser);
    await app.page.evaluate(label => [...document.querySelectorAll('nav[aria-label="Main navigation"] button')].find(b => b.textContent.includes(label)).click(), IDLE_PAGE);
    await sleep(2000);
    const observe = async () => {
      const m0 = await metrics(app.cdp), c0 = await app.page.evaluate(() => ({ counts: window.__perf.counts(), renders: window.__perf.renders() }));
      await sleep(IDLE_SECONDS * 1000);
      const m1 = await metrics(app.cdp), c1 = await app.page.evaluate(() => ({ counts: window.__perf.counts(), renders: window.__perf.renders() }));
      const d = delta(m0, m1), calls = delta(c0.counts, c1.counts);
      return { taskMs: d.TaskDuration * 1000, scriptMs: d.ScriptDuration * 1000, styleMs: d.RecalcStyleDuration * 1000, layoutMs: d.LayoutDuration * 1000,
        layouts: d.LayoutCount, styleRecalcs: d.RecalcStyleCount, bridgeCalls: Object.values(calls).reduce((a, b) => a + b, 0), statusCalls: calls.status || 0,
        commits: c1.renders.commits - c0.renders.commits, components: c1.renders.components - c0.renders.components };
    };
    const visible = await observe();
    await app.page.evaluate(() => window.__perf.setHidden(true));
    await sleep(200);
    const hidden = await observe();
    // Restore: how soon does a reply to a status request started after the restore arrive? null if none within 20 s.
    // Replies to requests sent before the restore don't count.
    const restoreMs = await app.page.evaluate(async () => {
      const t0 = performance.now();
      window.__perf.setHidden(false);
      while (!window.__perf.repliedSince('status', t0) && performance.now() - t0 < 20000) await new Promise(resolve => setTimeout(resolve, 5));
      return window.__perf.repliedSince('status', t0) ? performance.now() - t0 : null;
    });
    runs.push({ visible, hidden, restoreMs });
    await app.context.close();
    log(`idle run ${run + 1}/${IDLE_RUNS}: visible task ${Math.round(visible.taskMs)} ms / ${visible.bridgeCalls} calls; hidden task ${Math.round(hidden.taskMs)} ms / ${hidden.bridgeCalls} calls; restore ${restoreMs === null ? 'no reply' : `${Math.round(restoreMs)} ms`}`);
  }
  const pick = (which, key) => stats(runs.map(r => r[which][key]));
  const keys = ['taskMs', 'scriptMs', 'styleMs', 'layoutMs', 'layouts', 'bridgeCalls', 'statusCalls', 'commits', 'components'];
  return { seconds: IDLE_SECONDS, page: IDLE_PAGE, visible: Object.fromEntries(keys.map(k => [k, pick('visible', k)])), hidden: Object.fromEntries(keys.map(k => [k, pick('hidden', k)])),
    statusAfterRestoreMs: stats(runs.map(r => r.restoreMs).filter(ms => ms !== null)), restoreWithoutReply: runs.filter(r => r.restoreMs === null).length };
}

async function soak(browser) {
  const app = await openApp(browser);
  await sleep(1000);
  const sample = async () => { await gc(app.cdp); const m = await metrics(app.cdp); return { heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, listeners: m.JSEventListeners, ...(await app.page.evaluate(() => window.__perf.live())) }; };
  const start = await sample();
  const end = Date.now() + SOAK_SECONDS * 1000;
  let polls = 0;
  while (Date.now() < end) {
    await app.page.evaluate(async index => {
      if (index % 8 === 0) window.__perf.change();
      window.__perf.poll(); await window.__perf.settled();
      if (index % 20 === 0) {
        const pages = ['Devices', 'Connections', 'Activity', 'Settings', 'Overview'];
        [...document.querySelectorAll('nav[aria-label="Main navigation"] button')].find(b => b.textContent.includes(pages[(index / 20) % 5]))?.click();
      }
    }, polls++);
    await sleep(200);
  }
  // Finish on Overview, like the start sample.
  await app.page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Main navigation"] button')].find(b => b.textContent.includes('Overview')).click());
  await sleep(500);
  const finish = await sample();
  await app.context.close();
  log(`soak: ${polls} polls; heap ${start.heapMB.toFixed(2)} -> ${finish.heapMB.toFixed(2)} MB; nodes ${start.nodes} -> ${finish.nodes}; intervals ${start.intervals} -> ${finish.intervals}`);
  return { seconds: SOAK_SECONDS, polls, start, finish, growth: delta(start, finish), errors: app.errors };
}

(async () => {
  // --dist <dir>: measure an existing production build (for example one kept from a baseline commit) instead of building.
  const prebuilt = option('--dist');
  const outDir = prebuilt ? path.resolve(prebuilt) : fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-app-perf-'));
  let server, browser;
  const summary = { label: LABEL, incoming: INCOMING, date: new Date().toISOString(), node: process.version };
  try {
    log(prebuilt ? `measuring ${outDir}` : 'building renderer');
    summary.bundle = await buildBundle(outDir, prebuilt);
    log(`bundle: initial JS ${summary.bundle.initialJsBytes} B (${summary.bundle.initialJsGzip} B gzip), lazy JS ${summary.bundle.lazyJsBytes} B, CSS ${summary.bundle.cssBytes} B`);
    if ([...ONLY].some(k => k !== 'bundle')) {
      server = await serve(outDir);
      browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
      summary.chromium = browser.version();
      if (ONLY.has('startup')) summary.startup = await startup(browser);
      if (ONLY.has('renders')) summary.renders = await rendersPerPoll(browser);
      if (ONLY.has('switch')) summary.pageSwitch = await pageSwitch(browser);
      if (ONLY.has('idle')) summary.idle = await idle(browser);
      if (ONLY.has('soak')) summary.soak = await soak(browser);
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) server.close();
    if (!prebuilt) fs.rmSync(outDir, { recursive: true, force: true });
  }
  const text = JSON.stringify(summary, null, 2);
  if (OUT) fs.writeFileSync(OUT, text);
  console.log(text);
  // Compact view on stderr: one line per metric, "median [min..max] (n)".
  const flat = (value, prefix = '') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    if ('median' in value && 'n' in value) return [`${prefix.padEnd(48)} ${value.median} [${value.min}..${value.max}] (n=${value.n})`];
    return Object.entries(value).flatMap(([key, child]) => key === 'runs' || key === 'files' || key === 'byName' ? []
      : typeof child === 'number' ? [`${(prefix + key).padEnd(48)} ${Math.round(child * 100) / 100}`] : flat(child, `${prefix}${key}.`));
  };
  log(`summary ${LABEL}\n${flat(summary).join('\n')}`);
})().catch(error => { console.error(error); process.exit(1); });
