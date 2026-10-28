'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { OrbitController } = require('./controller.cjs');

const monitor = { id: 'primary', name: 'Primary', left: 0, top: 0, width: 1001, height: 1001, primary: true };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// In-memory host double: every /input request waits on its own gate, so tests decide when a round trip ends.
async function fixture({ batch = true, inputBatchLimit } = {}) {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test', inputBatchLimit });
  const permissions = { view: true, control: true, clipboard: false, files: false, power: false };
  controller.connections.push({ id: 'paired-device', name: 'Test computer', permissions });
  const requests = [];
  let inFlight = 0, maxInFlight = 0;
  controller.remote = async (_device, route, options = {}) => {
    if (route === '/api/info') return { json: { platform: { monitors: [monitor], ...(batch ? { canInputBatch: true } : {}) }, permissions } };
    if (route === '/api/sessions') return { json: { id: 'remote-1', permissions, resumeEpoch: 'epoch' } };
    if (route.endsWith('/frame')) return { headers: { 'x-orbit-width': '1001', 'x-orbit-height': '1001', 'x-orbit-left': '0', 'x-orbit-top': '0' }, buffer: Buffer.from('frame') };
    if (route.endsWith('/release-inputs')) { requests.push({ release: true }); return {}; }
    if (route.endsWith('/input')) {
      const request = { body: options.body, gate: deferred() };
      requests.push(request); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { return await request.gate.promise; } finally { inFlight--; }
    }
    throw new Error('Unexpected mock route: ' + route);
  };
  const { sessionId } = await controller.invoke('session.start', { deviceId: 'paired-device' });
  await controller.invoke('session.frame', { sessionId });
  const input = event => controller.invoke('session.input', { sessionId, event });
  const inputs = () => requests.filter(request => !request.release);
  // Lets the queued remote call start, then returns the newest request.
  const started = async count => { for (let i = 0; i < 20 && inputs().length < count; i++) await nextTurn(); assert.equal(inputs().length, count); return inputs()[count - 1]; };
  return { controller, sessionId, input, requests, inputs, started, maxInFlight: () => maxInFlight };
}
const kinds = body => (body.events || [body]).map(e => e.kind + (e.isDown === undefined ? '' : e.isDown ? ':down' : ':up') + (e.key ? ':' + e.key : '') + (e.kind === 'pointerMove' ? '@' + e.x : ''));

test('queued input leaves as one ordered batch after the in-flight request, with moves coalesced only between non-moves', { timeout: 3000 }, async () => {
  const f = await fixture();
  const first = f.input({ type: 'key', code: 'ShiftLeft', down: true });
  const head = await f.started(1);
  assert.deepEqual(kinds(head.body), ['key:down:ShiftLeft'], 'an idle queue sends the first event at once as a single object');
  const results = [
    f.input({ type: 'pointer.button', button: 0, down: true, x: 0.1, y: 0.1 }),
    f.input({ type: 'pointer.move', x: 0.2, y: 0.1 }),
    f.input({ type: 'pointer.move', x: 0.3, y: 0.1 }),
    f.input({ type: 'pointer.button', button: 0, down: false, x: 0.3, y: 0.1 }),
    f.input({ type: 'pointer.move', x: 0.4, y: 0.1 }),
    f.input({ type: 'key', code: 'KeyA', down: true }),
    f.input({ type: 'pointer.move', x: 0.5, y: 0.1 }),
    f.input({ type: 'pointer.move', x: 0.6, y: 0.1 }),
  ];
  await nextTurn(); await nextTurn();
  assert.equal(f.inputs().length, 1, 'nothing else is sent while one input request is in flight');
  head.gate.resolve({});
  const batch = await f.started(2);
  assert.deepEqual(kinds(batch.body), ['pointerButton:down', 'pointerMove@300', 'pointerButton:up', 'pointerMove@400', 'key:down:KeyA', 'pointerMove@600']);
  batch.gate.resolve({});
  await Promise.all([first, ...results]);
  assert.equal(f.maxInFlight(), 1);
  assert.equal(f.controller.sessions.get(f.sessionId).pendingInputCount, 0);
});

test('a batch above the per-request cap is split in order without a second request in flight', { timeout: 3000 }, async () => {
  const f = await fixture({ inputBatchLimit: 3 });
  const all = [f.input({ type: 'key', code: 'KeyA', down: true })];
  const head = await f.started(1);
  for (const code of ['KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF']) all.push(f.input({ type: 'key', code, down: true }));
  head.gate.resolve({});
  const second = await f.started(2);
  assert.deepEqual(kinds(second.body), ['key:down:KeyB', 'key:down:KeyC', 'key:down:KeyD']);
  await nextTurn(); assert.equal(f.inputs().length, 2);
  second.gate.resolve({});
  const third = await f.started(3);
  assert.deepEqual(kinds(third.body), ['key:down:KeyE', 'key:down:KeyF']);
  third.gate.resolve({});
  await Promise.all(all);
  assert.equal(f.maxInFlight(), 1);
});

test('hosts without canInputBatch keep the one-event-per-request path', { timeout: 3000 }, async () => {
  const f = await fixture({ batch: false });
  const all = [f.input({ type: 'key', code: 'KeyA', down: true })];
  const head = await f.started(1);
  all.push(f.input({ type: 'pointer.move', x: 0.1, y: 0 }), f.input({ type: 'pointer.move', x: 0.2, y: 0 }),
    f.input({ type: 'key', code: 'KeyA', down: false }));
  head.gate.resolve({});
  for (let count = 2; count <= 3; count++) (await f.started(count)).gate.resolve({});
  await Promise.all(all);
  assert.deepEqual(f.inputs().map(request => kinds(request.body)), [['key:down:KeyA'], ['pointerMove@200'], ['key:up:KeyA']]);
  assert.ok(f.inputs().every(request => !request.body.events), 'an older host never receives the batch body');
});

test('a failed batch rejects every event it carried and the next batch still follows in order', { timeout: 3000 }, async () => {
  const f = await fixture();
  const first = f.input({ type: 'key', code: 'KeyA', down: true });
  const head = await f.started(1);
  const failed = [f.input({ type: 'key', code: 'KeyB', down: true }), f.input({ type: 'key', code: 'KeyC', down: true })];
  head.gate.resolve({});
  const batch = await f.started(2);
  batch.gate.reject(Object.assign(new Error('Unsupported keyboard code.'), { status: 400 }));
  for (const result of await Promise.allSettled(failed)) assert.equal(result.reason?.status, 400);
  await first;
  const after = f.input({ type: 'key', code: 'KeyD', down: true });
  (await f.started(3)).gate.resolve({});
  await after;
  assert.equal(f.controller.sessions.get(f.sessionId).pendingInputCount, 0);
});

test('release-inputs drops queued batch events and orders the release before later input', { timeout: 3000 }, async () => {
  const f = await fixture();
  const first = f.input({ type: 'key', code: 'KeyA', down: true });
  const head = await f.started(1);
  const dropped = f.input({ type: 'key', code: 'KeyB', down: true });
  const release = f.controller.invoke('session.release-inputs', { sessionId: f.sessionId });
  head.gate.resolve({});
  await Promise.all([first, dropped, release]);
  const later = f.input({ type: 'key', code: 'KeyC', down: true });
  (await f.started(2)).gate.resolve({});
  await later;
  assert.deepEqual(f.requests.map(request => request.release ? 'release' : kinds(request.body).join(',')), ['key:down:KeyA', 'release', 'key:down:KeyC']);
});

test('a view-only session cannot queue batched input', async () => {
  const f = await fixture();
  f.controller.sessions.get(f.sessionId).viewOnly = true;
  await assert.rejects(f.input({ type: 'key', code: 'KeyA', down: true }), /view only/);
  assert.equal(f.inputs().length, 0);
});

test('a move that arrives while a batch is in flight goes out in the next request, not into the sent batch', { timeout: 3000 }, async () => {
  const f = await fixture();
  const first = f.input({ type: 'key', code: 'KeyA', down: true });
  const head = await f.started(1);
  const batched = [f.input({ type: 'key', code: 'KeyB', down: true }), f.input({ type: 'pointer.move', x: 0.2, y: 0.1 })];
  head.gate.resolve({}); await first;
  const second = await f.started(2);
  const sentBatch = kinds(second.body);
  const late = f.input({ type: 'pointer.move', x: 0.7, y: 0.1 });
  await nextTurn();
  assert.deepEqual(kinds(second.body), sentBatch, 'the batch already sent is never changed');
  second.gate.resolve({}); await Promise.all(batched);
  const third = await f.started(3);
  assert.equal(kinds(third.body).length, 1); assert.match(kinds(third.body)[0], /^pointerMove@/);
  assert.notEqual(kinds(third.body)[0], sentBatch[1], 'the late move carries its own position');
  third.gate.resolve({}); await late;
});

test('events queued before an input epoch change (sleep, close, identity failure) are dropped, not sent', { timeout: 3000 }, async () => {
  const f = await fixture();
  const first = f.input({ type: 'key', code: 'KeyA', down: true });
  const head = await f.started(1);
  const queued = [f.input({ type: 'key', code: 'KeyB', down: true }), f.input({ type: 'pointer.move', x: 0.3, y: 0.1 })];
  const session = f.controller.sessions.get(f.sessionId);
  session.inputEpoch = (session.inputEpoch || 0) + 1;
  head.gate.resolve({});
  await Promise.all([first, ...queued]);
  for (let i = 0; i < 5; i++) await nextTurn();
  assert.equal(f.inputs().length, 1, 'nothing queued under the old epoch reaches the host');
});
