'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os');
const { OrbitController } = require('./controller.cjs');
const { SECURITY_TERMINAL } = require('./security-terminal.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
const unavailable = () => Object.assign(new Error('Generated private endpoint detail.'), { status: 503 });
function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Clock {
  time = 0; sequence = 0; jobs = new Map();
  setTimeout(fn, delay) { assert.equal(delay, 10000); const id = ++this.sequence; this.jobs.set(id, { at: this.time + delay, fn }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  async advance(ms) {
    this.time += ms;
    for (const [id, job] of [...this.jobs]) if (job.at <= this.time && this.jobs.delete(id)) { job.fn(); await turn(); }
    await turn();
  }
}
async function fixture(t, intercept = () => undefined) {
  const clock = new Clock(), calls = [], changes = [], held = [], local = [];
  const identity = { certificatePem: 'generated-certificate', privateKeyPem: 'generated-private-key' };
  const devices = [{ id: 'a', name: 'Computer A', fingerprint: 'AA'.repeat(32) }, { id: 'b', name: 'Computer B', fingerprint: 'BB'.repeat(32) }]
    .map(value => ({ ...value, address: 'https://100.100.1.1:47832', permissions: { view: true, control: false } }));
  let sequence = 0;
  const controller = new OrbitController({ directory: os.tmpdir(), cleanupScheduler: clock, onCleanupChanged: change => changes.push(change),
    remoteRequest: async (target, client, route, options = {}) => {
      const call = { target, identity: client, route, method: options.method || 'GET', body: options.body }; calls.push(call);
      const value = await intercept(call); if (value !== undefined) return value;
      if (route === '/api/info') return { json: { platform: { monitors: [] } } };
      if (route === '/api/sessions') return { json: { id: 'remote-' + ++sequence, permissions: { view: true, control: false } } };
      if (call.method === 'DELETE') return {};
      throw new Error('Unexpected generated remote route.');
    } });
  controller.connections.push(...devices); controller.getIdentity = async () => identity;
  controller.save = async () => {};
  controller.local = async (...args) => { local.push(args); throw new Error('Cleanup cannot fall back to local incoming authority.'); };
  t.after(async () => { for (const gate of held) gate.resolve({}); await controller.shutdown(); });
  const a = await controller.invoke('session.start', { deviceId: 'a' });
  return { controller, clock, calls, changes, devices, identity, a, local,
    hold() { const gate = deferred(); held.push(gate); return gate; },
    deletes() { return calls.filter(call => call.method === 'DELETE' && call.target.fingerprint === devices[0].fingerprint); },
    async end() { await assert.rejects(controller.invoke('session.end', a), error => error.status === 503); },
    list() { return controller.invoke('session.cleanup.list'); },
    retry(id = a.sessionId) { return controller.invoke('session.cleanup.retry', { cleanupId: id }); },
  };
}

test('G10 regression transient A cleanup retries once at ten seconds while B keeps its new session', async t => {
  let deletes = 0;
  const h = await fixture(t, call => { if (call.method === 'DELETE' && ++deletes === 1) throw unavailable(); });
  await h.end();
  const b = await h.controller.invoke('session.start', { deviceId: 'b' }), live = h.controller.sessions.get(b.sessionId);
  assert.equal(h.controller.sessions.has(h.a.sessionId), false);
  await h.clock.advance(9999); assert.equal(h.deletes().length, 1);
  await h.clock.advance(1); assert.equal(h.deletes().length, 2);
  await h.clock.advance(60000); assert.equal(h.deletes().length, 2);
  assert.equal(h.controller.sessions.get(b.sessionId), live);
  assert.equal(h.calls.filter(call => call.method === 'POST' && call.target.fingerprint === h.devices[0].fingerprint).length, 1);
  assert.deepEqual((await h.list()).entries, []);
});

test('G10 regression a failed automatic retry cannot start another timer', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  await h.end(); await h.clock.advance(10000); assert.equal(h.deletes().length, 2);
  await h.clock.advance(60000); assert.equal(h.deletes().length, 2);
  assert.deepEqual((await h.list()).entries, [{ id: h.a.sessionId, deviceName: 'Computer A', state: 'failed', retryScheduled: false }]);
});

test('G10 regression known connection failure gets one delayed DELETE but unknown errors stay manual', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw Object.assign(new Error('Generated connection loss.'), { code: 'ECONNRESET' }); });
  await assert.rejects(h.controller.invoke('session.end', h.a), error => error.code === 'ECONNRESET');
  await h.clock.advance(10000); assert.equal(h.deletes().length, 2);
  await h.clock.advance(10000); assert.equal(h.deletes().length, 2);
});

test('G10 regression manual retry cancels its timer, joins in flight and confirms only successful DELETE', async t => {
  let deletes = 0, gate;
  const h = await fixture(t, call => {
    if (call.method === 'DELETE' && ++deletes === 1) throw unavailable();
    if (call.method === 'DELETE' && deletes === 2) return gate.promise;
  });
  await h.end(); gate = h.hold();
  const first = h.retry(), second = h.retry(); await turn();
  assert.equal(h.deletes().length, 2); assert.equal(h.clock.jobs.size, 0);
  assert.equal((await h.list()).entries[0].state, 'retrying');
  await h.clock.advance(10000); assert.equal(h.deletes().length, 2);
  gate.resolve({});
  assert.deepEqual(await first, { cleared: true, confirmed: true }); assert.deepEqual(await second, { cleared: true, confirmed: true });
});

test('G10 regression manual retry during the first pending DELETE consumes the future automatic permit', async t => {
  let gate;
  const h = await fixture(t, call => { if (call.method === 'DELETE') return gate.promise; }); gate = h.hold();
  const ended = h.controller.invoke('session.end', h.a).catch(error => error); await turn();
  assert.deepEqual((await h.list()).entries, [], 'an ordinary pending end must not appear as a failure');
  const retry = h.retry(); gate.reject(unavailable());
  assert.equal((await ended).status, 503); assert.deepEqual(await retry, { cleared: false, confirmed: false });
  await h.clock.advance(10000); assert.equal(h.deletes().length, 1);
  assert.equal((await h.list()).entries[0].retryScheduled, false);
});

test('G10 regression a timer and manual retry share one DELETE flight', async t => {
  let deletes = 0, gate;
  const h = await fixture(t, call => {
    if (call.method === 'DELETE' && ++deletes === 1) throw unavailable();
    if (call.method === 'DELETE' && deletes === 2) return gate.promise;
  });
  await h.end(); gate = h.hold(); await h.clock.advance(10000);
  const retry = h.retry(); await turn(); assert.equal(h.deletes().length, 2);
  gate.resolve({}); assert.deepEqual(await retry, { cleared: true, confirmed: true });
  await h.clock.advance(10000); assert.equal(h.deletes().length, 2);
});

test('G10 regression a synchronous retry observer joins the flight already registered by the timer', async t => {
  let deletes = 0, gate, retry;
  const h = await fixture(t, call => {
    if (call.method === 'DELETE' && ++deletes === 1) throw unavailable();
    if (call.method === 'DELETE' && deletes === 2) return gate.promise;
  });
  await h.end(); gate = h.hold();
  h.controller.onCleanupChanged = () => {
    if (!retry && h.controller.cleanupList().entries[0]?.state === 'retrying') retry = h.retry();
  };
  await h.clock.advance(10000); assert.equal(h.deletes().length, 2); assert.ok(retry);
  gate.resolve({}); assert.deepEqual(await retry, { cleared: true, confirmed: true });
});

test('G10 regression identity retirement from a retry observer prevents the next DELETE', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); }); await h.end();
  h.controller.onCleanupChanged = () => {
    if (h.controller.cleanupList().entries[0]?.state === 'retrying')
      h.controller.retireIdentity(h.devices[0], Object.assign(new Error('Generated local comparison failure.'), { code: 'pin_mismatch' }));
  };
  await h.clock.advance(10000); assert.equal(h.deletes().length, 1);
  assert.equal(h.controller.sessionCleanups.size, 0); assert.equal(h.clock.jobs.size, 0);
});

test('G10 regression existing explicit session.end retry consumes the same automatic budget', async t => {
  let deletes = 0;
  const h = await fixture(t, call => { if (call.method === 'DELETE' && ++deletes <= 2) throw unavailable(); });
  await h.end(); await h.end(); await h.clock.advance(10000); assert.equal(h.deletes().length, 2);
  assert.deepEqual(await h.retry(), { cleared: true, confirmed: true }); assert.equal(h.deletes().length, 3);
});

test('G10 guard final HTTP cleanup denial is settled but never claims confirmed deletion', async t => {
  let status;
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw Object.assign(new Error('Generated final cleanup denial.'), { status }); });
  for (status of [401, 403, 404, 410]) {
    const started = status === 401 ? h.a : await h.controller.invoke('session.start', { deviceId: 'a' });
    assert.deepEqual(await h.controller.invoke('session.end', started), { ok: true });
    assert.deepEqual(await h.retry(started.sessionId), { cleared: true, confirmed: false });
  }
  assert.equal(h.clock.jobs.size, 0); assert.deepEqual((await h.list()).entries, []);
});

test('G10 guard security codes are final even with a contradictory transient HTTP status', async t => {
  let error;
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw error; });
  for (const code of SECURITY_TERMINAL) {
    h.controller.connections[1] = { ...h.devices[1] };
    const started = await h.controller.invoke('session.start', { deviceId: 'b' });
    error = Object.assign(new Error('Generated security denial.'), { code,
      ...(['pin_mismatch', 'identity_mismatch'].includes(code) ? {} : { status: 503 }) });
    await h.controller.invoke('session.end', started);
    assert.deepEqual(await h.retry(started.sessionId), { cleared: true, confirmed: false });
  }
  assert.equal(h.clock.jobs.size, 0);
});

test('G10 guard unknown and protocol failures never get an automatic timer', async t => {
  let error = new Error('Generated unknown failure.');
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw error; });
  for (const value of [error, Object.assign(new Error('Generated protocol failure.'), { code: 'stream_protocol_error' }),
    Object.assign(new Error('Generated contradictory protocol failure.'), { code: 'stream_protocol_error', status: 503 })]) {
    error = value;
    const started = await h.controller.invoke('session.start', { deviceId: 'b' });
    await assert.rejects(h.controller.invoke('session.end', started));
  }
  assert.equal(h.clock.jobs.size, 0); await h.clock.advance(10000);
  assert.ok((await h.list()).entries.every(value => value.state === 'failed' && !value.retryScheduled));
});

test('G10 regression pin retirement cancels a scheduled cleanup without another TLS request', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  await h.end(); const cleanup = h.controller.sessionCleanups.get(h.a.sessionId);
  assert.equal(h.clock.jobs.size, 1);
  h.controller.retireIdentity(h.devices[0], Object.assign(new Error('Generated local comparison failure.'), { code: 'pin_mismatch' }));
  await h.clock.advance(10000); assert.equal(h.deletes().length, 1); assert.equal(h.clock.jobs.size, 0);
  assert.deepEqual(await h.retry(), { cleared: true, confirmed: false });
  assert.equal(cleanup.deleteRemote, null); assert.equal(cleanup.deviceRef, null);
  const fresh = { ...h.devices[0] }; h.controller.connections[0] = fresh;
  const started = await h.controller.invoke('session.start', { deviceId: fresh.id }); assert.ok(h.controller.sessions.has(started.sessionId));
});

test('G10 regression cancelled-created cleanup gets the same bounded delayed retry', async t => {
  let deletes = 0;
  const h = await fixture(t);
  await h.controller.cleanupCreated(h.devices[0], 'late-created', async () => { if (++deletes === 1) throw unavailable(); });
  const entry = (await h.list()).entries[0]; assert.equal(entry.deviceName, 'Computer A');
  await h.clock.advance(10000); assert.equal(deletes, 2); assert.deepEqual((await h.list()).entries, []);
});

test('G10 guard final cancelled-created cleanup is never auto even during its first failure', async t => {
  let deletes = 0;
  const h = await fixture(t);
  await h.controller.cleanupCreated(h.devices[0], 'late-terminal-created', async () => { deletes++; throw unavailable(); }, true);
  assert.equal(h.clock.jobs.size, 0); assert.deepEqual((await h.list()).entries, []);
  await h.clock.advance(10000); assert.equal(deletes, 1);
});

test('G10 regression eviction clears timers and a late failure cannot re-arm its old record', async t => {
  let calls = 0, gate;
  const h = await fixture(t, call => {
    if (call.method !== 'DELETE') return;
    if (++calls === 2) return gate.promise;
    throw unavailable();
  });
  await h.end(); const old = h.controller.sessionCleanups.get(h.a.sessionId);
  gate = h.hold(); await h.clock.advance(10000);
  for (let i = 0; i < 64; i++) await h.controller.cleanupCreated(h.devices[0], 'bounded-' + i, async () => { throw unavailable(); });
  assert.equal(h.controller.sessionCleanups.size, 64); assert.equal(h.clock.jobs.size, 64);
  gate.reject(unavailable()); await turn();
  assert.equal(old.disposed, true); assert.equal(old.deleteRemote, null); assert.equal(old.deviceRef, null);
  assert.equal(h.controller.sessionCleanups.has(h.a.sessionId), false); assert.equal(h.clock.jobs.size, 64);
  assert.deepEqual(await h.retry(), { cleared: true, confirmed: false });
});

test('G10 regression a cancelled timer callback cannot reach an evicted target', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  await h.end(); const callback = [...h.clock.jobs.values()][0].fn;
  for (let i = 0; i < 64; i++) await h.controller.cleanupCreated(h.devices[0], 'bounded-' + i, async () => { throw unavailable(); });
  const count = h.calls.length; callback(); await turn();
  assert.equal(h.calls.length, count); assert.equal(h.controller.sessionCleanups.size, 64);
});

test('G10 regression an already queued timer cannot retry after a failed manual attempt consumed its permit', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  await h.end(); const callback = [...h.clock.jobs.values()][0].fn;
  assert.deepEqual(await h.retry(), { cleared: false, confirmed: false }); assert.equal(h.deletes().length, 2);
  callback(); await turn(); assert.equal(h.deletes().length, 2); assert.equal(h.clock.jobs.size, 0);
});

test('G10 regression a stale queued timer cannot act on a successor with the same local ID', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  const session = h.controller.sessions.get(h.a.sessionId); await h.end();
  const callback = [...h.clock.jobs.values()][0].fn, old = h.controller.sessionCleanups.get(h.a.sessionId);
  h.controller.disposeCleanup(h.a.sessionId, old, h.controller.sessionCleanups);
  let successorDeletes = 0;
  h.controller.sessions.set(h.a.sessionId, { ...session, closed: false, remoteId: 'successor',
    deleteRemote: async () => { successorDeletes++; throw unavailable(); } });
  await h.end(); assert.equal(successorDeletes, 1);
  callback(); await turn(); assert.equal(successorDeletes, 1); assert.equal(h.clock.jobs.size, 1);
});

test('G10 regression strict cleanup retry never uses the local fallback after retired IDs are evicted', async t => {
  const h = await fixture(t); await h.controller.invoke('session.end', h.a);
  for (let i = 0; i < 257; i++) await h.controller.cleanupCreated(h.devices[0], 'retired-' + i, async () => {});
  assert.equal(h.controller.retiredOutgoingSessions.has(h.a.sessionId), false);
  for (const cleanupId of [h.a.sessionId, 'unknown', undefined, '', 'x'.repeat(129)])
    assert.deepEqual(await h.retry(cleanupId), { cleared: true, confirmed: false });
  assert.equal(h.local.length, 0);
});

test('G10 guard strict cleanup retry cannot close an active session or select a remote route', async t => {
  const h = await fixture(t), live = h.controller.sessions.get(h.a.sessionId), before = h.calls.length;
  assert.deepEqual(await h.controller.invoke('session.cleanup.retry', { cleanupId: h.a.sessionId,
    address: 'https://untrusted.invalid', remoteId: 'untrusted', sessionId: h.a.sessionId }), { cleared: true, confirmed: false });
  assert.equal(h.controller.sessions.get(h.a.sessionId), live); assert.equal(h.calls.length, before); assert.equal(h.local.length, 0);
  assert.deepEqual((await h.list()).entries, []);
});

test('G10 guard synchronous invalidation snapshots remain bounded while a new record is inserted', async t => {
  const h = await fixture(t); const snapshots = [];
  h.controller.onCleanupChanged = () => snapshots.push(h.controller.cleanupList());
  for (let i = 0; i < 65; i++) await h.controller.cleanupCreated(h.devices[0], 'bounded-' + i, async () => { throw unavailable(); });
  assert.ok(snapshots.length > 65); assert.ok(snapshots.every(value => value.entries.length <= 64));
  assert.equal((await h.list()).entries.length, 64); assert.equal(h.controller.sessionCleanups.size, 64);
});

test('G10 regression snapshots expose only bounded safe names and monotonic revision invalidations', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  h.devices[0].name = 'Private\nname\u0000' + 'N'.repeat(180); await h.end();
  const before = await h.list(), entry = before.entries[0];
  assert.deepEqual(Object.keys(entry).sort(), ['deviceName', 'id', 'retryScheduled', 'state']);
  assert.equal(entry.deviceName.length, 128); assert.doesNotMatch(entry.deviceName, /[\x00-\x1f\x7f]/);
  assert.ok(h.changes.every((value, index) => Object.keys(value).join() === 'revision' && (!index || value.revision > h.changes[index - 1].revision)));
  const cleanup = h.controller.sessionCleanups.get(h.a.sessionId); cleanup.deleteRemote = async () => {};
  assert.deepEqual(await h.retry(), { cleared: true, confirmed: true });
  const after = await h.list(); assert.ok(after.revision > before.revision); assert.deepEqual(after.entries, []);
  assert.equal(before.entries.length, 1, 'old snapshots keep their older revision and cannot mutate the new snapshot');
});

test('G10 regression final retry outcome clears the notice without claiming confirmed deletion', async t => {
  let deletes = 0;
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw Object.assign(new Error('Generated remote denial.'), { status: ++deletes === 1 ? 503 : 401 }); });
  await h.end(); assert.deepEqual(await h.retry(), { cleared: true, confirmed: false });
  assert.deepEqual((await h.list()).entries, []); assert.equal(h.clock.jobs.size, 0);
});

test('G10 regression reset cancels its timer, makes one old-identity pass and releases the key reference', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  const b = await h.controller.invoke('session.start', { deviceId: 'b' }), live = h.controller.sessions.get(b.sessionId);
  await h.end(); const cleanup = h.controller.sessionCleanups.get(h.a.sessionId);
  await h.controller.setLocalControl({ destroy() {} }, 'new-local-bearer');
  assert.equal(h.deletes().length, 2); assert.ok(h.deletes().every(value => value.identity === h.identity));
  await h.clock.advance(10000); assert.equal(h.deletes().length, 2); assert.equal(h.clock.jobs.size, 0);
  assert.equal(cleanup.deleteRemote, null); assert.equal(cleanup.deviceRef, null); assert.deepEqual((await h.list()).entries, []);
  assert.equal(h.controller.sessions.get(b.sessionId), live);
});

test('G10 regression shutdown stops timers before its single final cleanup pass', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  await h.end(); const cleanup = h.controller.sessionCleanups.get(h.a.sessionId);
  await h.controller.shutdown(); assert.equal(h.deletes().length, 2);
  await h.clock.advance(10000); assert.equal(h.deletes().length, 2); assert.equal(h.clock.jobs.size, 0);
  assert.equal(cleanup.deleteRemote, null); assert.equal(cleanup.deviceRef, null);
  assert.deepEqual(await h.retry(), { cleared: true, confirmed: false });
});

test('G10 regression pending failure after reset cannot schedule another cleanup timer', async t => {
  let deletes = 0, gate;
  const h = await fixture(t, call => {
    if (call.method === 'DELETE' && ++deletes === 1) return gate.promise;
    if (call.method === 'DELETE') throw unavailable();
  }); gate = h.hold();
  const ended = h.controller.invoke('session.end', h.a).catch(error => error); await turn();
  const resetting = h.controller.setLocalControl({ destroy() {} }, 'new-local-bearer');
  gate.reject(unavailable()); await ended; await resetting;
  assert.equal(h.deletes().length, 2); assert.equal(h.clock.jobs.size, 0); assert.deepEqual((await h.list()).entries, []);
});

test('G10 guard a failing observer cannot alter cleanup success or authority', async t => {
  const h = await fixture(t); h.controller.onCleanupChanged = () => { throw new Error('Generated observer failure.'); };
  assert.deepEqual(await h.controller.invoke('session.end', h.a), { ok: true });
  assert.equal(h.controller.sessions.has(h.a.sessionId), false); assert.equal(h.controller.sessionCleanups.size, 0);
});

for (const action of ['device.forget', 'device.revoke']) {
  test(`G10 review ${action} drops scheduled and queued cleanup while another device stays retained`, async t => {
    const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
    h.controller.local = async (route, method) => { assert.equal(route, 'peers/a'); assert.equal(method, 'DELETE'); return {}; };
    await h.end(); const old = h.controller.sessionCleanups.get(h.a.sessionId), callback = [...h.clock.jobs.values()][0].fn;
    let otherDeletes = 0;
    await h.controller.cleanupCreated(h.devices[1], 'other-remote', async () => { if (++otherDeletes === 1) throw unavailable(); });
    await h.controller.invoke(action, { deviceId: 'a' });
    assert.deepEqual((await h.list()).entries.map(value => value.deviceName), ['Computer B']);
    assert.equal(old.deleteRemote, null); assert.equal(old.deviceRef, null);
    callback(); await h.clock.advance(10000);
    assert.equal(h.deletes().length, 1); assert.equal(otherDeletes, 2);
    assert.deepEqual(await h.retry(), { cleared: true, confirmed: false });
  });

  test(`G10 review ${action} disposes an in-flight cleanup before its late failure can re-arm`, async t => {
    let gate;
    const h = await fixture(t, call => { if (call.method === 'DELETE') return gate.promise; }); gate = h.hold();
    h.controller.local = async () => ({});
    const closing = h.controller.invoke('session.end', h.a).catch(error => error); await turn();
    const old = h.controller.sessionCleanups.get(h.a.sessionId);
    await h.controller.invoke(action, { deviceId: 'a' });
    gate.reject(unavailable()); await closing; await h.clock.advance(10000);
    assert.equal(h.deletes().length, 1); assert.equal(h.controller.sessionCleanups.size, 0); assert.equal(h.clock.jobs.size, 0);
    assert.equal(old.deleteRemote, null); assert.equal(old.deviceRef, null);
  });

  test(`G10 review ${action} retires late cleanup origins absent from connections while a fresh re-pair stays eligible`, async t => {
    const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); }); await h.end();
    h.controller.connections = h.controller.connections.filter(value => value.id !== 'a'); h.controller.local = async () => ({});
    await h.controller.invoke(action, { deviceId: 'a' });
    let late = 0, fresh = 0; const snapshots = [];
    h.controller.onCleanupChanged = () => snapshots.push(h.controller.cleanupList());
    await h.controller.cleanupCreated(h.devices[0], 'late-created', async () => { late++; throw unavailable(); });
    await h.controller.cleanupCreated({ ...h.devices[0] }, 'fresh-created', async () => { fresh++; });
    await h.clock.advance(10000);
    assert.equal(late, 1); assert.equal(fresh, 1); assert.equal(h.clock.jobs.size, 0); assert.equal(h.deletes().length, 1);
    assert.ok(snapshots.every(value => value.entries.length === 0), 'the final orphan never creates even a transient notice');
  });
}

test('G10 review forget retires a reconnect POST that finishes after the saved device was removed', async t => {
  let armed = false, gate; const entered = deferred();
  const h = await fixture(t, call => {
    if (armed && call.method === 'POST' && call.route === '/api/sessions') { entered.resolve(); return gate.promise; }
    if (call.method === 'DELETE') throw unavailable();
  }); gate = h.hold();
  h.controller.sessions.delete(h.a.sessionId); h.controller.endedSessions.set(h.a.sessionId, 'Generated ordinary host stop.');
  h.controller.reconnectTargets.set(h.a.sessionId, { deviceId: 'a', fingerprint: h.devices[0].fingerprint, monitorId: null });
  armed = true; const pending = h.controller.invoke('session.reconnect', h.a).catch(error => error); await entered.promise;
  await h.controller.invoke('device.forget', { deviceId: 'a' });
  gate.resolve({ json: { id: 'late-reconnect', permissions: { view: true } } });
  assert.match((await pending).message, /cancelled|unavailable/i);
  await h.clock.advance(10000); assert.equal(h.deletes().length, 1);
  assert.equal(h.deletes()[0].identity, h.identity); assert.equal(h.deletes()[0].target.fingerprint, h.devices[0].fingerprint);
  assert.equal(h.controller.sessionCleanups.size, 0); assert.equal(h.clock.jobs.size, 0); assert.equal(h.controller.sessions.size, 0);
});

test('G10 review forget disposes a cleanup created by its own failed session end', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  await assert.rejects(h.controller.invoke('device.forget', { deviceId: 'a' }), error => error.status === 503);
  assert.equal(h.controller.sessions.has(h.a.sessionId), false);
  await h.clock.advance(10000); assert.equal(h.deletes().length, 1);
  assert.equal(h.controller.sessionCleanups.size, 0); assert.equal(h.clock.jobs.size, 0);
});

test('G10 review guard a failed Forget followed by an explicit new connection still permits its Disconnect cleanup', async t => {
  let deletes = 0;
  const h = await fixture(t, call => { if (call.method === 'DELETE' && ++deletes === 1) throw unavailable(); });
  await assert.rejects(h.controller.invoke('device.forget', { deviceId: 'a' }), error => error.status === 503);
  assert.equal(h.controller.connections.includes(h.devices[0]), true);
  const started = await h.controller.invoke('session.start', { deviceId: 'a' });
  assert.deepEqual(await h.controller.invoke('session.end', started), { ok: true });
  assert.equal(h.deletes().length, 2, 'the new explicit session has a working original-bound DELETE');
});

test('G10 review guard a failed Forget leaves a second active session able to Disconnect normally', async t => {
  let deletes = 0;
  const h = await fixture(t, call => { if (call.method === 'DELETE' && ++deletes === 1) throw unavailable(); });
  const second = await h.controller.invoke('session.start', { deviceId: 'a' });
  await assert.rejects(h.controller.invoke('device.forget', { deviceId: 'a' }), error => error.status === 503);
  assert.equal(h.controller.sessions.has(second.sessionId), true);
  assert.deepEqual(await h.controller.invoke('session.end', second), { ok: true });
  assert.equal(h.deletes().length, 2, 'still-live authority retains its normal DELETE cleanup');
});

test('G10 review cleanup names strip bidi and zero-width controls and bound Unicode code points', async t => {
  const h = await fixture(t, call => { if (call.method === 'DELETE') throw unavailable(); });
  h.devices[0].name = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200b\u200c\u200d\u200e\u200f' + '😀'.repeat(140);
  await h.end(); const name = (await h.list()).entries[0].deviceName;
  assert.equal(name, '😀'.repeat(128)); assert.equal(Array.from(name).length, 128);
  assert.doesNotMatch(name, /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
});
