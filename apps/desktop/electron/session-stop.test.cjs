'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { OrbitController } = require('./controller.cjs');

const permissions = { view: true, control: true, clipboard: false, files: false, power: false };
const error = status => Object.assign(new Error(status === 410 ? 'Session ended by host. Connect again explicitly.' : 'Missing session'), { status });
const frame = { headers: { 'x-orbit-width': '1280', 'x-orbit-height': '720' }, buffer: Buffer.from('synthetic PNG') };

async function fixture({ epoch = 'test-resume-epoch', intercept } = {}) {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  controller.connections.push({ id: 'paired', name: 'Test host', permissions });
  const calls = [];
  let sequence = 0;
  controller.remote = async (_device, route, options = {}) => {
    const call = { route, method: options.method || 'GET', body: options.body };
    calls.push(call);
    const custom = await intercept?.(call);
    if (custom !== undefined) return custom;
    if (route === '/api/info') return { json: { monitors: [{ id: 'primary' }, { id: 'secondary' }] } };
    if (route === '/api/sessions') return { json: { id: 'remote-' + ++sequence, permissions, resumeEpoch: epoch } };
    if (route.includes('/frame')) return frame;
    return {};
  };
  const { sessionId } = await controller.invoke('session.start', { deviceId: 'paired' });
  return { controller, sessionId, calls, capture: monitorId => controller.invoke('session.frame', { sessionId, monitorId }),
    creations: () => calls.filter(call => call.route === '/api/sessions') };
}

test('host-stopped renewal is terminal and a further frame cannot recreate the session', async () => {
  const h = await fixture({ intercept: call => {
    if (call.route.includes('/frame')) throw error(404);
    if (call.route === '/api/sessions' && call.body.resumeEpoch) throw error(410);
  } });
  await assert.rejects(h.capture(), err => err.status === 410);
  assert.equal(h.creations()[1].body.resumeEpoch, 'test-resume-epoch');
  assert.equal(h.controller.sessions.has(h.sessionId), false);
  await assert.rejects(h.capture(), /ended/);
  await assert.rejects(h.controller.invoke('session.input', { sessionId: h.sessionId, event: { type: 'key', code: 'KeyA', down: true } }), /ended/);
  assert.equal(h.creations().length, 2, 'only the initial connect and one denied resume are attempted');
  const manual = await h.controller.invoke('session.start', { deviceId: 'paired' });
  assert.ok(manual.sessionId, 'a person may explicitly connect again while still authorized');
  assert.equal(h.creations().at(-1).body.resumeEpoch, undefined);
});

test('a direct ended-by-host frame closes local access without attempting renewal', async () => {
  const h = await fixture({ intercept: call => { if (call.route.includes('/frame')) throw error(410); } });
  await assert.rejects(h.capture(), err => err.status === 410);
  assert.equal(h.controller.sessions.size, 0);
  assert.equal(h.creations().length, 1);
  await assert.rejects(h.capture(), /ended by host/);
  h.controller.local = () => { throw new Error('An already-ended outgoing session must not be sent to local incoming-session administration.'); };
  assert.deepEqual(await h.controller.invoke('session.end', { sessionId: h.sessionId }), { ok: true });
});

test('internal incoming resume authorization is omitted from renderer-facing status', async () => {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  controller.local = async () => ({ sessions: [{ id: 'incoming', resumeEpoch: 'internal-epoch', createdAt: 'now' }] });
  const result = await controller.invoke('status');
  assert.equal(result.sessions[0].id, 'incoming');
  assert.equal(Object.hasOwn(result.sessions[0], 'resumeEpoch'), false);
});

test('legacy hosts without resume authorization require an explicit reconnect', async () => {
  const h = await fixture({ epoch: null, intercept: call => { if (call.route.includes('/frame')) throw error(404); } });
  await assert.rejects(h.capture(), /cannot safely resume/);
  assert.equal(h.creations().length, 1, 'a missing epoch must never turn recovery into an unscoped new session');
  assert.equal(h.controller.sessions.size, 0);
});

test('normal recovery sends the current resume epoch and keeps frame access working', async () => {
  let first = true;
  const h = await fixture({ intercept: call => {
    if (call.route.includes('/frame') && first) { first = false; throw error(404); }
  } });
  assert.equal((await h.capture()).width, 1280);
  assert.equal(h.creations().length, 2);
  assert.equal(h.creations()[1].body.resumeEpoch, 'test-resume-epoch');
  assert.equal(h.controller.sessions.get(h.sessionId).resumeEpoch, 'test-resume-epoch');
});

test('two monitor windows share one denied resume and both lose the stopped session', async () => {
  const h = await fixture({ intercept: async call => {
    if (call.route.includes('/frame')) throw error(404);
    if (call.route === '/api/sessions' && call.body.resumeEpoch) { await new Promise(resolve => setImmediate(resolve)); throw error(410); }
  } });
  const results = await Promise.allSettled([h.capture('primary'), h.capture('secondary')]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(h.creations().length, 2, 'one denied automatic resume is shared across both windows');
  assert.equal(h.controller.sessions.size, 0);
});
