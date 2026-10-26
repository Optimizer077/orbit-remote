'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const crypto = require('node:crypto');
const { OrbitController } = require('./controller.cjs');

// In-memory model of the W1 host contract (src/Orbit.Host/FrameQuality.cs). No sockets, no native input.
const permissions = { view: true, control: true, clipboard: false, files: false, power: false };
const primary = { id: 'primary', name: 'Primary', left: 0, top: 0, width: 1920, height: 1080, primary: true };
const secondary = { id: 'secondary', name: 'Secondary', left: -1280, top: 0, width: 1280, height: 720, primary: false };
const httpError = status => Object.assign(new Error(status === 410 ? 'Session ended by host.' : 'Mock remote HTTP ' + status), { status });

async function scenario({ canConditionalFrames = true, canScaleFrames = true, intercept } = {}) {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  controller.connections.push({ id: 'paired-device', name: 'Test computer', permissions });
  const calls = [];
  const remoteSessions = new Map();
  const content = new Map([['primary', 1], ['secondary', 1]]); // Bump to change a monitor's pixels.
  let sequence = 0;
  const tagFor = (remoteId, monitor, scale) => '"orbit-frame-v1-' + crypto.createHash('sha256')
    .update([remoteId, monitor.id, monitor.left, monitor.top, monitor.width, monitor.height, scale, content.get(monitor.id)].join('|'))
    .digest('hex').toUpperCase() + '"';
  controller.remote = async (_device, route, options = {}) => {
    const url = new URL(route, 'https://fixture.invalid');
    const call = { route, pathname: url.pathname, monitorId: url.searchParams.get('monitorId'), scale: url.searchParams.get('scale'),
      validator: options.headers?.['if-none-match'] ?? null, method: options.method || 'GET', body: options.body };
    calls.push(call);
    const override = intercept ? await intercept(call) : undefined;
    if (override !== undefined) return override;
    if (route === '/api/info') return { json: { platform: { monitors: [primary, secondary], canScaleFrames, canConditionalFrames }, permissions } };
    if (route === '/api/sessions' && call.method === 'POST') {
      const id = 'remote-' + ++sequence;
      remoteSessions.set(id, options.body.monitorId === 'secondary' ? secondary : primary);
      return { json: { id, permissions, resumeEpoch: 'test-resume-epoch' } };
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(frame|input|release-inputs))?$/.exec(url.pathname);
    if (!match) throw new Error('Unexpected mock route: ' + route);
    if (call.method === 'DELETE') { remoteSessions.delete(match[1]); return {}; }
    if (match[2] === 'frame') {
      const sessionMonitor = remoteSessions.get(match[1]);
      if (!sessionMonitor) throw httpError(404);
      const monitor = call.monitorId === null ? sessionMonitor : [primary, secondary].find(m => m.id === call.monitorId);
      if (!monitor) throw httpError(400);
      // Encoded-only (Mac/Linux) hosts ignore scale and validators; count any as a client contract violation.
      const scale = canScaleFrames && call.scale !== null ? Math.min(1, Math.max(0.33, Number(call.scale))) : 1;
      const encodedWidth = Math.max(1, Math.round(monitor.width * scale));
      const encodedHeight = Math.max(1, Math.round(monitor.height * scale));
      const tag = canConditionalFrames ? tagFor(match[1], monitor, scale) : undefined;
      const headers = { 'x-orbit-width': String(monitor.width), 'x-orbit-height': String(monitor.height),
        'x-orbit-left': String(monitor.left), 'x-orbit-top': String(monitor.top),
        'x-orbit-encoded-width': String(encodedWidth), 'x-orbit-encoded-height': String(encodedHeight), 'x-orbit-scale': String(scale),
        ...(tag ? { etag: tag } : {}) };
      if (tag && call.validator === tag) return { status: 304, headers, buffer: Buffer.alloc(0) };
      return { status: 200, headers, buffer: Buffer.from(`png:${monitor.id}:v${content.get(monitor.id)}:${encodedWidth}x${encodedHeight}`) };
    }
    if (match[2] === 'input' || match[2] === 'release-inputs') return {};
    throw new Error('Unexpected mock operation: ' + route);
  };
  const { sessionId } = await controller.invoke('session.start', { deviceId: 'paired-device' });
  const frameCalls = () => calls.filter(c => c.pathname.endsWith('/frame'));
  return { controller, sessionId, calls, remoteSessions, content, frameCalls,
    frame: (extra = {}) => controller.invoke('session.frame', { sessionId, ...extra }),
    input: (event, monitorId) => controller.invoke('session.input', { sessionId, event, ...(monitorId === undefined ? {} : { monitorId }) }),
    lastFrameCall: () => frameCalls().at(-1),
    inputs: () => calls.filter(c => c.route.endsWith('/input')),
    creations: () => calls.filter(c => c.route === '/api/sessions' && c.method === 'POST') };
}

test('an unchanged screen reuses the cached frame and geometry without a body', async () => {
  const h = await scenario();
  const first = await h.frame({ monitorId: 'primary' });
  assert.equal(h.lastFrameCall().validator, null, 'the first frame of a slot is never conditional');
  assert.equal(first.unchanged, false);
  assert.ok(first.bytes > 0);
  const again = await h.frame({ monitorId: 'primary' });
  assert.match(h.lastFrameCall().validator, /^"orbit-frame-v1-[0-9A-F]{64}"$/);
  assert.equal(again.unchanged, true);
  assert.equal(again.bytes, 0);
  assert.equal(again.dataUrl, first.dataUrl, 'the previously decoded image is returned unchanged');
  for (const name of ['width', 'height', 'left', 'top', 'encodedWidth', 'encodedHeight', 'scale']) assert.equal(again[name], first[name], name);
  await h.input({ type: 'pointer.move', x: 1, y: 1 }, 'primary');
  assert.deepEqual([h.inputs().at(-1).body.x, h.inputs().at(-1).body.y], [primary.width - 1, primary.height - 1]);
  h.content.set('primary', 2);
  const changed = await h.frame({ monitorId: 'primary' });
  assert.equal(changed.unchanged, false);
  assert.notEqual(changed.dataUrl, first.dataUrl, 'changed pixels always produce the new image');
});

test('each monitor slot only ever revalidates its own image and geometry', async () => {
  const h = await scenario();
  const primaryFrame = await h.frame({ monitorId: 'primary' });
  const primaryTag = (await h.frame({ monitorId: 'primary' }), h.lastFrameCall().validator);
  const second = await h.frame({ monitorId: 'secondary' });
  assert.equal(h.lastFrameCall().validator, null, 'switching monitors never sends another monitor validator');
  assert.equal(second.unchanged, false);
  assert.deepEqual([second.width, second.left], [secondary.width, secondary.left]);
  const secondAgain = await h.frame({ monitorId: 'secondary' });
  const secondaryTag = h.lastFrameCall().validator;
  assert.ok(secondaryTag && secondaryTag !== primaryTag);
  assert.equal(secondAgain.unchanged, true);
  assert.deepEqual([secondAgain.width, secondAgain.left], [secondary.width, secondary.left]);
  const back = await h.frame({ monitorId: 'primary' });
  assert.equal(h.lastFrameCall().validator, primaryTag);
  assert.equal(back.dataUrl, primaryFrame.dataUrl, 'a reused frame is the same slot image, not the last image shown');
  assert.deepEqual([back.width, back.left], [primary.width, primary.left]);
  assert.ok(h.frameCalls().every(c => c.validator === null || c.validator === (c.monitorId === 'primary' ? primaryTag : secondaryTag)));
  await h.input({ type: 'pointer.move', x: 0, y: 0 }, 'secondary');
  assert.equal(h.inputs().at(-1).body.x, secondary.left);
});

test('session renewal drops every slot cache before the next frame', async () => {
  let failNext = false;
  const h = await scenario({ intercept: call => {
    if (failNext && call.pathname === '/api/sessions/remote-1/frame') { failNext = false; h.remoteSessions.delete('remote-1'); throw httpError(404); }
  } });
  await h.frame({ monitorId: 'primary' });
  await h.frame({ monitorId: 'secondary' });
  failNext = true;
  const renewed = await h.frame({ monitorId: 'primary' });
  assert.equal(h.creations().length, 2);
  assert.match(h.lastFrameCall().route, /remote-2/);
  assert.equal(h.lastFrameCall().validator, null, 'the renewed session starts without a validator');
  assert.equal(renewed.unchanged, false);
  await h.frame({ monitorId: 'secondary' });
  assert.equal(h.lastFrameCall().validator, null, 'other monitor slots were dropped by the renewal too');
  assert.ok(h.frameCalls().filter(c => c.route.includes('remote-2')).every(c => c.validator === null || !h.frameCalls()
    .filter(old => old.route.includes('remote-1')).some(old => old.validator === c.validator)), 'no old-session validator is reused');
});

test('changing scale drops the cache and scale is reported separately from physical geometry', async () => {
  const h = await scenario();
  await h.frame({ monitorId: 'primary' });
  const half = await h.frame({ monitorId: 'primary', scale: 0.5 });
  assert.equal(h.lastFrameCall().scale, '0.5');
  assert.equal(h.lastFrameCall().validator, null, 'a full-scale validator is never sent for a half-scale frame');
  assert.deepEqual([half.width, half.height, half.encodedWidth, half.encodedHeight, half.scale], [1920, 1080, 960, 540, 0.5]);
  const halfAgain = await h.frame({ monitorId: 'primary', scale: 0.5 });
  assert.equal(halfAgain.unchanged, true);
  assert.equal(halfAgain.encodedWidth, 960);
  await h.frame({ monitorId: 'primary' });
  assert.equal(h.lastFrameCall().scale, null, 'full scale omits the parameter');
  assert.equal(h.lastFrameCall().validator, null, 'returning to full scale starts fresh');
});

test('scale is sent only when supported and below 1, clamped on the client', async () => {
  const h = await scenario();
  await h.frame({ scale: 1 });
  assert.equal(h.lastFrameCall().scale, null);
  await h.frame({ scale: 0.1 });
  assert.equal(h.lastFrameCall().scale, '0.33');
  await h.frame({ scale: 5 });
  assert.equal(h.lastFrameCall().scale, null);
  await assert.rejects(h.frame({ scale: 'half' }), /Invalid frame scale/);
  await assert.rejects(h.frame({ scale: Number.NaN }), /Invalid frame scale/);
  const noScale = await scenario({ canScaleFrames: false });
  const frame = await noScale.frame({ scale: 0.5 });
  assert.equal(noScale.lastFrameCall().scale, null, 'a host without scaling never receives the parameter');
  assert.deepEqual([frame.scale, frame.encodedWidth, frame.width], [1, primary.width, primary.width]);
});

test('Mac/Linux hosts without conditional frames never receive If-None-Match', async () => {
  const h = await scenario({ canConditionalFrames: false, canScaleFrames: false });
  for (let i = 0; i < 3; i++) {
    const frame = await h.frame({ scale: 0.5 });
    assert.equal(frame.unchanged, false);
    assert.ok(frame.bytes > 0);
    assert.equal(frame.scale, 1);
  }
  assert.ok(h.frameCalls().every(c => c.validator === null && c.scale === null));
});

test('a validator echoed by a host that never advertised conditional frames is ignored', async () => {
  const h = await scenario({ canConditionalFrames: false, intercept: call => {
    if (call.pathname.endsWith('/frame')) return { status: 200, headers: { 'x-orbit-width': '1920', 'x-orbit-height': '1080', etag: '"x"' }, buffer: Buffer.from('p') };
  } });
  await h.frame();
  await h.frame();
  assert.ok(h.frameCalls().every(c => c.validator === null));
});

test('unsolicited or inconsistent 304 replies are rejected and never reuse stale geometry', async () => {
  let mode = null;
  const h = await scenario({ intercept: call => {
    if (!call.pathname.endsWith('/frame') || !mode) return;
    const reply = mode; mode = null;
    return reply(call);
  } });
  mode = () => ({ status: 304, headers: {}, buffer: Buffer.alloc(0) });
  await assert.rejects(h.frame({ monitorId: 'primary' }), /unexpected unchanged-screen/);
  await h.frame({ monitorId: 'primary' });
  mode = call => ({ status: 304, buffer: Buffer.alloc(0), headers: { etag: call.validator, 'x-orbit-width': '640', 'x-orbit-height': '480',
    'x-orbit-left': '5000', 'x-orbit-top': '0' } });
  await assert.rejects(h.frame({ monitorId: 'primary' }), /unexpected unchanged-screen/);
  await h.frame({ monitorId: 'primary' });
  assert.equal(h.lastFrameCall().validator, null, 'a rejected 304 drops the slot cache');
  mode = () => ({ status: 304, buffer: Buffer.alloc(0), headers: { etag: '"orbit-frame-v1-other"' } });
  await assert.rejects(h.frame({ monitorId: 'primary' }), /unexpected unchanged-screen/, 'a 304 for a different validator is refused');
});

test('401 drops the slot cache and 410 stays terminal with a cached frame', async () => {
  let failure = null;
  const h = await scenario({ intercept: call => {
    if (call.pathname.endsWith('/frame') && failure) { const status = failure; failure = null; throw httpError(status); }
  } });
  await h.frame();
  failure = 401;
  await assert.rejects(h.frame(), error => error.status === 401);
  await h.frame();
  assert.equal(h.lastFrameCall().validator, null, 'after 401 the next frame is unconditional');
  failure = 410;
  await assert.rejects(h.frame(), error => error.status === 410);
  assert.equal(h.controller.sessions.size, 0);
  await assert.rejects(h.frame(), /ended/);
  assert.equal(h.creations().length, 1, '410 never renews');
});

test('pointer input uses physical geometry when the frame is downscaled, including after a 304', async () => {
  const h = await scenario();
  const half = await h.frame({ scale: 0.5 });
  assert.equal(half.encodedWidth, 960);
  await h.input({ type: 'pointer.move', x: 1, y: 1 });
  assert.deepEqual([h.inputs().at(-1).body.x, h.inputs().at(-1).body.y], [primary.width - 1, primary.height - 1]);
  const reused = await h.frame({ scale: 0.5 });
  assert.equal(reused.unchanged, true);
  await h.input({ type: 'pointer.move', x: 0.5, y: 0.5 });
  assert.deepEqual([h.inputs().at(-1).body.x, h.inputs().at(-1).body.y], [Math.round(0.5 * 1919), Math.round(0.5 * 1079)]);
});
