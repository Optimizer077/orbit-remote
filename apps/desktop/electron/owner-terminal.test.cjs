'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os');
const { OrbitController } = require('./controller.cjs');
const terminal = (status, code) => Object.assign(new Error('Generated terminal denial.'), { status, ...(code ? { code } : {}) });
const monitor = { id: 'primary', primary: true, width: 1920, height: 1080, left: -1920, top: 0 };
const initialGrants = { view: true, control: true, clipboard: false, files: false, power: false };
const renewedGrants = { ...initialGrants, control: false };
const image = () => ({ status: 200, headers: { 'content-type': 'image/png', 'x-orbit-width': '1920',
  'x-orbit-height': '1080', 'x-orbit-left': '-1920', 'x-orbit-top': '0' }, buffer: Buffer.from('generated-frame-bytes') });

// Actual production controller, with only transport/identity replaced. There is
// no socket, native host, file transfer, clipboard or OS input in this fixture.
// Host route tests establish which HTTP status is returned; these checks prove
// the consumer behavior for that status, not a real-device/network result.
async function fixture(t) {
  const calls = [], identity = { certificatePem: 'generated-client', privateKeyPem: 'generated-key' };
  let creations = 0, frame = () => image(), renewal;
  const device = { id: 'paired', name: 'Generated computer', address: 'https://100.100.1.1:47832',
    fingerprint: 'AA'.repeat(32), permissions: initialGrants };
  const controller = new OrbitController({ directory: os.tmpdir(), remoteRequest: async (target, client, route, options = {}) => {
    const call = { target, identity: client, route, pathname: new URL(route, 'https://fixture.invalid').pathname,
      method: options.method || 'GET', body: options.body }; calls.push(call);
    if (route === '/api/info') return { json: { platform: { monitors: [monitor] } } };
    if (route === '/api/sessions' && call.method === 'POST') {
      if (++creations === 1) return { json: { id: 'remote-initial', permissions: initialGrants, resumeEpoch: 'generated-original-epoch' } };
      if (renewal) throw renewal;
      return { json: { id: 'remote-renewed', permissions: renewedGrants, resumeEpoch: 'generated-renewed-epoch' } };
    }
    if (call.pathname.endsWith('/frame')) return frame(call);
    if (call.method === 'DELETE') return {};
    throw new Error('Unexpected generated transport operation.');
  } });
  controller.connections.push(device); controller.getIdentity = async () => identity;
  controller.local = async () => assert.fail('An outgoing terminal cannot use local incoming-session authority.');
  t.after(() => controller.shutdown());
  const session = await controller.invoke('session.start', { deviceId: device.id, monitorId: monitor.id });
  const initial = calls.slice(); calls.length = 0;
  return { controller, session, device, identity, calls, initial,
    frame() { return controller.invoke('session.frame', { sessionId: session.sessionId, monitorId: monitor.id }); },
    setFrame(handler) { frame = handler; }, setRenewalError(error) { renewal = error; },
    posts() { return calls.filter(call => call.method === 'POST'); },
  };
}

async function assertStopped(h) {
  const count = h.calls.length, posts = h.posts().length;
  assert.equal(h.controller.sessions.has(h.session.sessionId), false);
  for (let i = 0; i < 4; i++) await assert.rejects(h.frame(), error => error.status === 410);
  await assert.rejects(h.controller.invoke('session.input', { sessionId: h.session.sessionId,
    event: { type: 'key', code: 'KeyA', down: true } }), error => error.status === 410);
  assert.equal(h.calls.length, count, 'known terminal polling/input cannot reach transport');
  assert.equal(h.posts().length, posts, 'no POST follows the first known terminal');
}

for (const { status, code } of [
  { status: 403, code: 'ended_by_owner' }, { status: 401, code: 'access_revoked' }, { status: 403, code: 'access_revoked' },
]) test(`S9 frame ${status} ${code} clears authority and issues zero POSTs`, async t => {
  const h = await fixture(t); await h.frame();
  const live = h.controller.sessions.get(h.session.sessionId), inputEpoch = live.inputEpoch;
  assert.ok(live.frameSlots.get(monitor.id).frame);
  h.controller.noteHostStopping(h.session.sessionId, 'host_stopping');
  const denial = terminal(status, code); h.setFrame(() => { throw denial; });
  const responses = await Promise.allSettled([h.frame(), h.frame()]);
  assert.ok(responses.every(value => value.status === 'rejected' && value.reason === denial));
  assert.equal(h.posts().length, 0, 'a typed terminal must not enter missing-session renewal');
  assert.equal(live.closed, true); assert.ok(live.inputEpoch > inputEpoch); assert.equal(live.frame, null);
  assert.ok([...live.frameSlots.values()].every(slot => slot.frame === null && slot.cache === null));
  assert.equal(h.controller.reconnectTargets.has(h.session.sessionId), false);
  assert.equal(h.controller.canReconnect(h.session.sessionId), false);
  await assert.rejects(h.controller.invoke('session.reconnect', h.session), /unavailable/);
  await assertStopped(h); assert.equal(h.posts().length, 0);
});

for (const status of [401, 403]) test(`S9 frame HTTP ${status} remains terminal when the transport has no JSON code`, async t => {
  const h = await fixture(t); h.setFrame(() => { throw terminal(status); });
  await assert.rejects(h.frame(), error => error.status === status);
  await assertStopped(h); assert.equal(h.posts().length, 0);
});

test('S9 authorized missing404 makes one protected renewal with the original epoch and current host grants', async t => {
  const h = await fixture(t), live = h.controller.sessions.get(h.session.sessionId);
  h.setFrame(call => { if (call.pathname.includes('/remote-initial/')) throw terminal(404); return image(); });
  const frames = await Promise.all([h.frame(), h.frame()]);
  assert.equal(h.initial.filter(call => call.method === 'POST').length, 1);
  assert.equal(Object.hasOwn(h.initial.find(call => call.method === 'POST').body, 'resumeEpoch'), false, 'only the initial explicit connect is a new logical session');
  assert.equal(h.posts().length, 1);
  const post = h.posts()[0];
  assert.equal(post.route, '/api/sessions'); assert.equal(post.identity, h.identity);
  assert.equal(post.target.fingerprint, h.device.fingerprint);
  assert.deepEqual(post.body, { monitorId: monitor.id, viewOnly: false, resumeEpoch: 'generated-original-epoch' });
  assert.ok(frames.every(frame => frame.sessionGeneration === 1 && frame.left === monitor.left));
  assert.equal(h.controller.sessions.get(h.session.sessionId), live); assert.equal(live.closed, false);
  assert.equal(live.remoteId, 'remote-renewed'); assert.equal(live.resumeEpoch, 'generated-renewed-epoch');
  assert.deepEqual(live.permissions, renewedGrants);
  await assert.rejects(h.controller.invoke('session.input', { sessionId: h.session.sessionId,
    event: { type: 'key', code: 'KeyA', down: true } }), /view only/);
  assert.equal(h.posts().length, 1, 'renewal cannot restore an old Control grant');
  h.setFrame(() => { throw terminal(403, 'ended_by_owner'); });
  await assert.rejects(h.frame(), error => error.status === 403);
  await assertStopped(h); assert.equal(h.posts().length, 1);
});

for (const { status, code } of [{ status: 403, code: 'ended_by_owner' }, { status: 410, code: 'session_ended' }])
  test(`S9 missing404 followed by rejected renewal${status} creates no authority and never POSTs after terminal`, async t => {
    const h = await fixture(t), denial = terminal(status, code);
    h.setFrame(() => { throw terminal(404); }); h.setRenewalError(denial);
    await assert.rejects(h.frame(), error => error === denial);
    assert.equal(h.posts().length, 1, 'legacy404 can make one protected attempt before the terminal is known');
    assert.equal(h.posts()[0].body.resumeEpoch, 'generated-original-epoch');
    assert.equal(h.controller.sessions.size, 0, 'a rejected renewal installs no replacement authority');
    await assertStopped(h); assert.equal(h.posts().length, 1);
  });

test('S9 missing404 without protected-resume authority never creates a new logical session', async t => {
  const h = await fixture(t); h.controller.sessions.get(h.session.sessionId).resumeEpoch = null;
  h.setFrame(() => { throw terminal(404); });
  await assert.rejects(h.frame(), error => error.status === 410);
  await assertStopped(h); assert.equal(h.posts().length, 0);
});
