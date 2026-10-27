'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { OrbitController } = require('./controller.cjs');

// In-memory model of the W1 host contract (src/Orbit.Host/FrameQuality.cs). No sockets, no native input.
const permissions = { view: true, control: true, clipboard: false, files: false, power: false };
const primary = { id: 'primary', name: 'Primary', left: 0, top: 0, width: 1920, height: 1080, primary: true };
const secondary = { id: 'secondary', name: 'Secondary', left: -1280, top: 0, width: 1280, height: 720, primary: false };
const httpError = status => Object.assign(new Error(status === 410 ? 'Session ended by host.' : 'Mock remote HTTP ' + status), { status });

async function scenario({ canConditionalFrames = true, canScaleFrames = true, canJpegFrames = false, intercept } = {}) {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  controller.connections.push({ id: 'paired-device', name: 'Test computer', permissions });
  const calls = [];
  const remoteSessions = new Map();
  const content = new Map([['primary', 1], ['secondary', 1]]); // Bump to change a monitor's pixels.
  let sequence = 0;
  const tagFor = (remoteId, monitor, scale, format, quality) => '"orbit-frame-v1-' + crypto.createHash('sha256')
    .update([remoteId, monitor.id, monitor.left, monitor.top, monitor.width, monitor.height, scale, format, quality, content.get(monitor.id)].join('|'))
    .digest('hex').toUpperCase() + '"';
  controller.remote = async (_device, route, options = {}) => {
    const url = new URL(route, 'https://fixture.invalid');
    const call = { route, pathname: url.pathname, monitorId: url.searchParams.get('monitorId'), scale: url.searchParams.get('scale'),
      format: url.searchParams.get('format'), quality: url.searchParams.get('quality'),
      validator: options.headers?.['if-none-match'] ?? null, method: options.method || 'GET', body: options.body };
    calls.push(call);
    const override = intercept ? await intercept(call) : undefined;
    if (override !== undefined) return override;
    if (route === '/api/info') return { json: { platform: { monitors: [primary, secondary], canScaleFrames, canConditionalFrames, canJpegFrames }, permissions } };
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
      const tag = canConditionalFrames ? tagFor(match[1], monitor, scale, call.format, call.quality) : undefined;
      const headers = { 'content-type': call.format === 'jpeg' ? 'image/jpeg' : 'image/png', 'x-orbit-width': String(monitor.width), 'x-orbit-height': String(monitor.height),
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

for (const transition of ['open', 'config']) for (const status of [200, 304]) {
  test(`a late ${status} image after video ${transition} cannot restore old cache or input geometry`, async t => {
    let held = false, resolveImage, entered, callHeld, feed;
    const image = new Promise(resolve => { resolveImage = resolve; });
    const waiting = new Promise(resolve => { entered = resolve; });
    const h = await scenario({ intercept: call => {
      if (call.pathname.endsWith('/stream/control')) return {};
      if (held && call.pathname.endsWith('/frame') && call.monitorId === 'primary') { callHeld = call; entered(); return image; }
    } });
    t.after(() => h.controller.videoStreams.shutdown());
    await h.frame({ monitorId: 'primary' }); await h.frame({ monitorId: 'secondary' });
    const session = h.controller.sessions.get(h.sessionId), secondaryCache = session.frameSlots.get('secondary').cache;
    h.controller.getIdentity = async () => ({});
    h.controller.videoStreams.openRemote = async (_device, _identity, _route, options) => {
      feed = options.onData; let reject;
      const done = new Promise((_ok, fail) => { reject = fail; }); done.catch(() => {});
      return { done, resume() {}, abort() { reject(new Error('closed')); } };
    };
    const port = new EventEmitter(); port.postMessage = () => {}; port.start = () => {};
    let closed = false; port.close = () => { if (!closed) { closed = true; port.emit('close'); } };
    const openVideo = async () => {
      h.controller.videoStreams.open({ sessionId: h.sessionId, monitorId: 'primary' }, port, 1);
      await new Promise(resolve => setImmediate(resolve));
    };
    if (transition === 'config') await openVideo();
    held = true; const oldImage = h.frame({ monitorId: 'primary' });
    // Attach rejection observation before allowing a transport result to settle.
    const rejected = assert.rejects(oldImage, /Screen delivery changed/);
    await waiting;
    if (transition === 'open') await openVideo();
    const wire = (type, value, sequence, keyframe = false) => {
      const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
      const header = Buffer.alloc(24); header[0] = type; header[1] = keyframe ? 1 : 0;
      header.writeUInt32LE(bytes.length, 4); header.writeUInt32LE(sequence, 8); header.writeBigUInt64LE(BigInt(sequence), 16);
      return Buffer.concat([header, bytes]);
    };
    const config = { codec: 'avc1.4D4028', width: 1280, height: 720, codedWidth: 1280, codedHeight: 720,
      physicalWidth: 1280, physicalHeight: 720, physicalLeft: 300, physicalTop: -500, scale: 1, fps: 60, monitorId: 'primary' };
    port.emit('message', { data: { type: 'credit', count: 1 } }); feed(wire(1, config, 0));
    port.emit('message', { data: { type: 'credit', count: 1 } }); feed(wire(2, Uint8Array.of(0,0,0,1,0x65,1), 1, true));
    port.emit('message', { data: { type: 'presented', sequence: 1, decodeMs: .4, drawMs: .1 } });
    const videoGeometry = session.frameSlots.get('primary').frame;
    assert.deepEqual(videoGeometry, { width: 1280, height: 720, left: 300, top: -500 });
    resolveImage({ status, headers: { 'content-type': 'image/png', 'x-orbit-width': '1920', 'x-orbit-height': '1080',
      'x-orbit-left': '0', 'x-orbit-top': '0', 'x-orbit-encoded-width': '1920', 'x-orbit-encoded-height': '1080',
      ...(callHeld.validator ? { etag: callHeld.validator } : {}) }, buffer: status === 304 ? Buffer.alloc(0) : Buffer.from('old-png') });
    await rejected;
    assert.equal(session.frameSlots.get('primary').frame, videoGeometry);
    assert.equal(session.frameSlots.get('primary').cache, null);
    assert.equal(session.frameSlots.get('secondary').cache, secondaryCache, 'a different monitor retains its own representation');
    await h.input({ type: 'pointer.move', x: 1, y: 1 }, 'primary');
    assert.deepEqual([h.inputs().at(-1).body.x, h.inputs().at(-1).body.y], [1579, 219]);
  });
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
  assert.equal(again.data, undefined, 'an idle poll does not clone the cached image across IPC');
  assert.ok(Buffer.isBuffer(first.data));
  assert.equal(first.contentType, 'image/png');
  assert.equal(Object.hasOwn(first, 'dataUrl'), false);
  const newlyMounted = await h.frame({ monitorId: 'primary', includeImage: true });
  assert.deepEqual(newlyMounted.data, first.data, 'a new viewer can obtain this slot image from a 304');
  for (const name of ['width', 'height', 'left', 'top', 'encodedWidth', 'encodedHeight', 'scale']) assert.equal(again[name], first[name], name);
  await h.input({ type: 'pointer.move', x: 1, y: 1 }, 'primary');
  assert.deepEqual([h.inputs().at(-1).body.x, h.inputs().at(-1).body.y], [primary.width - 1, primary.height - 1]);
  h.content.set('primary', 2);
  const changed = await h.frame({ monitorId: 'primary' });
  assert.equal(changed.unchanged, false);
  assert.notDeepEqual(changed.data, first.data, 'changed pixels always produce the new image');
});

test('coalesced idle requests respect each viewer need for its first image', async () => {
  const h = await scenario();
  const first = await h.frame();
  const [idle, newWindow] = await Promise.all([h.frame(), h.frame({ includeImage: true })]);
  assert.equal(idle.unchanged, true);
  assert.equal(idle.data, undefined);
  assert.deepEqual(newWindow.data, first.data);
  assert.equal(newWindow.bytes, 0, 'cached bytes cross IPC only; no image was transferred over the network');
});

test('frame cache separates negotiated format and quality and validates actual MIME', async () => {
  const h = await scenario({ canJpegFrames: true });
  await h.frame();
  const jpeg = await h.frame({ format: 'jpeg', quality: 50 });
  assert.equal(h.lastFrameCall().validator, null);
  assert.equal(h.lastFrameCall().quality, '50');
  assert.equal(jpeg.contentType, 'image/jpeg');
  await h.frame({ format: 'jpeg', quality: 50 });
  assert.ok(h.lastFrameCall().validator);
  await h.frame({ format: 'jpeg', quality: 75 });
  assert.equal(h.lastFrameCall().validator, null, 'different JPEG quality never reuses old validator');
  await h.frame();
  assert.equal(h.lastFrameCall().validator, null, 'PNG refinement cannot reuse JPEG validator');
  const legacy = await scenario();
  const png = await legacy.frame({ format: 'jpeg', quality: 500 });
  assert.equal(png.contentType, 'image/png');
  assert.equal(legacy.lastFrameCall().format, null);
  await assert.rejects(h.frame({ format: 'svg' }), /Invalid frame format/);
  await assert.rejects(h.frame({ quality: '75' }), /Invalid frame quality/);
  const unsupported = await scenario({ intercept: call => call.pathname.endsWith('/frame') ? {
    headers: { 'content-type': 'text/html' }, buffer: Buffer.from('<b>no</b>') } : undefined });
  await assert.rejects(unsupported.frame(), /unsupported frame image type/);
});

test('a concurrent change of encoding waits for the old request and fetches its own encoding', async () => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let block = true;
  const h = await scenario({ canJpegFrames: true, intercept: async call => {
    if (call.pathname.endsWith('/frame') && block) { block = false; began(); await blocked; }
  } });
  const png = h.frame();
  await started;
  const jpeg = h.frame({ format: 'jpeg' });
  release();
  assert.equal((await png).contentType, 'image/png');
  assert.equal((await jpeg).contentType, 'image/jpeg');
  assert.equal(h.frameCalls().length, 2);
  assert.equal(h.lastFrameCall().validator, null);
});

test('a JPEG-allowed request can cache a smaller PNG without changing its actual MIME', async () => {
  const h = await scenario({ canJpegFrames: true, intercept: call => {
    if (!call.pathname.endsWith('/frame')) return;
    const headers = { etag: '"png-choice"', 'content-type': 'image/png', 'x-orbit-width': '1920', 'x-orbit-height': '1080' };
    return call.validator === headers.etag ? { status: 304, headers, buffer: Buffer.alloc(0) }
      : { status: 200, headers, buffer: Buffer.from('synthetic PNG body') };
  } });
  const first = await h.frame({ format: 'jpeg' });
  assert.equal(first.contentType, 'image/png');
  const idle = await h.frame({ format: 'jpeg' });
  assert.equal(idle.unchanged, true);
  assert.equal(idle.contentType, 'image/png');
  assert.equal(idle.data, undefined);
  const reopened = await h.frame({ format: 'jpeg', includeImage: true });
  assert.deepEqual(reopened.data, first.data);
  assert.equal(reopened.contentType, 'image/png');
  await h.frame();
  assert.equal(h.lastFrameCall().validator, null, 'a lossless refinement starts its own negotiation context');
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
  const back = await h.frame({ monitorId: 'primary', includeImage: true });
  assert.equal(h.lastFrameCall().validator, primaryTag);
  assert.deepEqual(back.data, primaryFrame.data, 'a reused frame is the same slot image, not the last image shown');
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

test('401/403/410 clear every cached frame and stay terminal without another remote request', async () => {
  for (const status of [401, 403, 410]) {
    let failure = null;
    const h = await scenario({ intercept: call => {
      if (call.pathname.endsWith('/frame') && failure) throw httpError(failure);
    } });
    await h.frame({ monitorId: 'primary' }); await h.frame({ monitorId: 'secondary' });
    const session = h.controller.sessions.get(h.sessionId);
    assert.ok([...session.frameSlots.values()].every(slot => slot.cache && slot.frame));
    failure = status;
    await assert.rejects(h.frame({ monitorId: 'primary' }), error => error.status === status);
    assert.equal(h.controller.sessions.size, 0);
    assert.equal(session.frame, null);
    assert.ok([...session.frameSlots.values()].every(slot => slot.cache === null && slot.frame === null),
      'every monitor loses cached pixels and input geometry at the security boundary');
    const calls = h.calls.length;
    await assert.rejects(h.frame({ monitorId: 'secondary' }), /ended|Mock remote HTTP/);
    await assert.rejects(h.input({ type: 'pointer.move', x: 0.5, y: 0.5 }), /ended|Mock remote HTTP/);
    assert.equal(h.calls.length, calls, 'a removed session cannot issue image or input requests');
    assert.equal(h.creations().length, 1, 'terminal failures never renew');
  }
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
