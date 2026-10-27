'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os');
const { OrbitController } = require('./controller.cjs');
const { frameRequestError } = require('./stream-session.cjs');

const monitor = { id: 'primary', primary: true, width: 1280, height: 720, left: 0, top: 0 };
const image = () => ({ status: 200, headers: { 'content-type': 'image/png', 'x-orbit-width': '1280',
  'x-orbit-height': '720' }, buffer: Buffer.from('generated-frame') });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const ended = error => error?.status === 410 && error.code === 'session_ended';

// Only outgoing transport/identity are fake. Controller delivery/close/cleanup
// and the main-process frame-error serializer are their production exports.
// There are no real sockets, native hosts, OS input or persisted device files.
async function fixture(t) {
  const calls = [], reply = deferred(), entered = deferred();
  let hold = false;
  const device = { id: 'paired', name: 'Generated host', address: 'https://100.100.1.1:47832',
    fingerprint: 'AA'.repeat(32), permissions: { view: true, control: true } };
  const controller = new OrbitController({ directory: os.tmpdir(), remoteRequest: async (_target, _identity, route, options = {}) => {
    const method = options.method || 'GET', pathname = new URL(route, 'https://fixture.invalid').pathname;
    calls.push({ route, method });
    if (route === '/api/info') return { json: { platform: { monitors: [monitor] } } };
    if (route === '/api/sessions' && method === 'POST') return { json: {
      id: 'remote-session', permissions: device.permissions, resumeEpoch: 'generated-original-epoch' } };
    if (pathname.endsWith('/frame')) { if (hold) { entered.resolve(); return reply.promise; } return image(); }
    if (method === 'DELETE') return {};
    const error = new Error('Unexpected generated transport operation.');
    if (hold) entered.reject(error);
    throw error;
  } });
  controller.connections.push(device);
  controller.getIdentity = async () => ({ certificatePem: 'generated-client', privateKeyPem: 'generated-key' });
  controller.local = async () => assert.fail('Outgoing delivery must not use local incoming-session authority.');
  t.after(async () => { reply.resolve(image()); await controller.shutdown(); });
  const session = await controller.invoke('session.start', { deviceId: device.id, monitorId: monitor.id });
  calls.length = 0;
  return { controller, session, calls, entered, reply,
    live: controller.sessions.get(session.sessionId),
    startFrame() { hold = true; return controller.invoke('session.frame', { sessionId: session.sessionId, monitorId: monitor.id }); },
  };
}

test('TypedEnd closed or replaced local authority is a typed terminal independent of its text', { timeout: 1000 }, async t => {
  const h = await fixture(t);
  assert.doesNotThrow(() => h.controller.assertSession(h.session.sessionId, h.live));
  assert.throws(() => h.controller.assertSession(h.session.sessionId, { ...h.live }), ended);
  h.live.closed = true;
  assert.throws(() => h.controller.assertSession(h.session.sessionId, h.live), error => {
    assert.ok(ended(error));
    error.message = 'Generated replacement wording.';
    const { error: detail } = frameRequestError(error);
    assert.equal(detail.status, 410); assert.equal(detail.retryable, false);
    assert.equal(detail.code, 'session_ended_by_host');
    return true;
  });
  assert.equal(h.calls.length, 0);
});

for (const response of ['image', 'missing404']) test(`TypedEnd closed pending ${response} delivery is terminal and makes no renewal POST`, { timeout: 1000 }, async t => {
  const h = await fixture(t);
  const delivery = h.startFrame().then(value => ({ value }), error => ({ error }));
  await h.entered.promise;
  const closing = h.controller.invoke('session.end', { sessionId: h.session.sessionId });
  assert.equal(h.live.closed, true); assert.equal(h.controller.sessions.size, 0);
  assert.equal(h.controller.endedSessions.has(h.session.sessionId), false, 'the serializer cannot rely on an existing ended-reason entry');
  if (response === 'image') h.reply.resolve(image());
  else h.reply.reject(Object.assign(new Error('Generated missing frame.'), { status: 404 }));
  const result = await delivery; await closing;
  assert.ok(ended(result.error)); assert.equal(result.value, undefined);
  const { error: detail } = frameRequestError(result.error);
  assert.equal(detail.status, 410); assert.equal(detail.code, 'session_ended_by_host'); assert.equal(detail.retryable, false);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0, 'closed delivery never enters protected renewal');
  assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 1, 'ordinary close cleanup still runs once');
  assert.equal(h.controller.sessions.size, 0); assert.equal(h.live.frame, null);
  assert.ok([...h.live.frameSlots.values()].every(slot => slot.frame === null && slot.cache === null));
  assert.throws(() => h.controller.getSession(h.session), error => error.status === 410);
});

test('TypedEnd late identity failure retains precedence over a closed pending delivery', { timeout: 1000 }, async t => {
  const h = await fixture(t);
  const delivery = h.startFrame().then(value => ({ value }), error => ({ error }));
  await h.entered.promise;
  const identity = Object.assign(new Error('Generated local identity comparison failure.'), { code: 'pin_mismatch' });
  h.live.identityFailure = identity;
  const closing = h.controller.invoke('session.end', { sessionId: h.session.sessionId });
  h.reply.resolve(image());
  const result = await delivery; await closing;
  assert.equal(result.error, identity);
  const { error: detail } = frameRequestError(result.error);
  assert.equal(detail.code, 'pin_mismatch'); assert.equal(detail.status, undefined); assert.equal(detail.retryable, false);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(h.controller.sessions.size, 0); assert.equal(h.live.frame, null);
});
