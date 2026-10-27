'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HostSupervisor, NetworkChangeTracker, tailscaleObservation, BoundedHostLog, IdentityRotationGuard } = require('./host-supervisor.cjs');

test('crashes remain bounded even with a successful health response between every exit', () => {
  const supervisor = new HostSupervisor(); let now = 0;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000]) {
    supervisor.started(); supervisor.healthy(now, true);
    assert.equal(supervisor.exited(now + 100, 'Host stopped.'), delay); now += delay + 100;
  }
  supervisor.started(); supervisor.healthy(now, true);
  assert.equal(supervisor.exited(now + 100, 'Host stopped.'), null);
  assert.deepEqual(supervisor.snapshot(), { state: 'stopped', reason: 'Host stopped.', restartsLeft: 0, nextRetryAt: null });
  supervisor.healthy(now + 1000000, true);
  assert.equal(supervisor.snapshot().state, 'stopped', 'terminal state needs explicit Retry');
  supervisor.retry(now); assert.equal(supervisor.exited(now), 1000);
});

test('five continuous healthy minutes resets budget; elapsed retry window prunes attempts', () => {
  const supervisor = new HostSupervisor(); supervisor.exited(0); supervisor.started();
  for (let now = 1000; now <= 291000; now += 10000) supervisor.healthy(now, false);
  supervisor.healthy(300999, false);
  assert.equal(supervisor.snapshot().restartsLeft, 5);
  supervisor.healthy(301000, false); assert.equal(supervisor.snapshot().restartsLeft, 6);
  assert.equal(supervisor.exited(301001), 1000);
  assert.equal(supervisor.exited(1000000), 1000);
});

test('failed health or a sleep-sized gap cannot count toward five continuous healthy minutes', () => {
  const supervisor = new HostSupervisor(); supervisor.exited(0); supervisor.started(); supervisor.healthy(1000, true);
  supervisor.healthy(301000, true); assert.equal(supervisor.snapshot().restartsLeft, 5);
  supervisor.failedHealth(); supervisor.healthy(601000, true);
  assert.equal(supervisor.snapshot().restartsLeft, 5);
});

test('Retry is offered only after recovery or terminal stop, never for a healthy host', () => {
  const supervisor = new HostSupervisor(); assert.equal(supervisor.canRetry(), false);
  supervisor.healthy(0, true); assert.equal(supervisor.canRetry(), false);
  supervisor.healthy(1, false); assert.equal(supervisor.canRetry(), false);
  supervisor.exited(2); assert.equal(supervisor.canRetry(), true);
  supervisor.started(); assert.equal(supervisor.canRetry(), false);
  for (let i = 0; i < 7; i++) supervisor.exited(i + 3);
  assert.equal(supervisor.snapshot().state, 'stopped'); assert.equal(supervisor.canRetry(), true);
});

test('only two consecutive positive address changes trigger rebind; failures are unknown', () => {
  const tracker = new NetworkChangeTracker(); const a = '100.64.0.1', b = '100.64.0.2';
  assert.equal(tracker.observe(a, b), false);
  assert.equal(tracker.observe(a, undefined), false);
  assert.equal(tracker.observe(a, b), false);
  assert.equal(tracker.observe(a, b), true);
  tracker.reset(); assert.equal(tracker.observe(a, null), false); assert.equal(tracker.observe(a, null), true);
  tracker.reset(); assert.equal(tracker.observe(null, null), false);
  assert.equal(tracker.observe(null, b), false); assert.equal(tracker.observe(null, b), true);
  assert.equal(tracker.observe(b, b), false);
});

test('Tailscale parser distinguishes verified offline, no IPv4, and malformed/failed observations', () => {
  assert.equal(tailscaleObservation({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.1'] } }), '100.64.0.1');
  assert.equal(tailscaleObservation({ BackendState: 'Running', Self: { TailscaleIPs: ['192.168.0.1', '100.128.0.1', 'fd7a:115c:a1e0::1'] } }), null);
  assert.equal(tailscaleObservation({ BackendState: 'Stopped' }), null);
  for (const value of [null, {}, { BackendState: 'Running' }, { BackendState: 'invalid' }]) assert.equal(tailscaleObservation(value), undefined);
  assert.equal(tailscaleObservation({ BackendState: 'Running', Self: { TailscaleIPs: [] } }), null);
});

test('host logs rotate to two bounded files including oversized chunks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-log-tests-'));
  try {
    const file = path.join(directory, 'host.log'), log = new BoundedHostLog(file, 32);
    log.write(Buffer.alloc(100, 65));
    assert.equal(fs.statSync(file).size, 4); assert.equal(fs.statSync(file + '.1').size, 32);
    log.write('B'.repeat(31));
    assert.equal(fs.statSync(file).size, 3); assert.equal(fs.statSync(file + '.1').size, 32);
    log.end(); log.write('ignored'); assert.equal(fs.statSync(file).size, 3);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['host.log', 'host.log.1']);
  } finally { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); }
});

test('identity confirmation rejects stale requests and cancellation before disconnecting anything', async () => {
  const guard = new IdentityRotationGuard(); let prompts = 0, rotates = 0;
  const operations = { getStatus: async () => ({ certificateFingerprint: 'current', pairedDevices: [{}, { revokedAt: 'past' }] }),
    confirm: async count => { prompts++; assert.equal(count, 1); return false; }, rotate: async () => { rotates++; } };
  await assert.rejects(guard.run({ confirmRePair: true, expectedFingerprint: 'stale' }, operations), /identity changed/);
  assert.equal(prompts, 0); assert.equal(rotates, 0);
  assert.deepEqual(await guard.run({ confirmRePair: true, expectedFingerprint: 'current' }, operations), { state: 'cancelled' });
  assert.equal(prompts, 1); assert.equal(rotates, 0); assert.equal(guard.inFlight, false);
});

test('identity confirmation rechecks state after the native prompt and serializes concurrent requests', async () => {
  const guard = new IdentityRotationGuard(); let accept, reads = 0, rotates = 0;
  const operations = { getStatus: async () => ({ certificateFingerprint: 'current', pairedDevices: ++reads === 1 ? [] : [{}] }),
    confirm: () => new Promise(resolve => { accept = resolve; }), rotate: async () => { rotates++; return { state: 'restarting' }; } };
  const payload = { confirmRePair: true, expectedFingerprint: 'current' };
  const first = guard.run(payload, operations); await Promise.resolve();
  await assert.rejects(guard.run(payload, operations), /already open/);
  accept(true); await assert.rejects(first, /paired devices changed/); assert.equal(rotates, 0);
  operations.getStatus = async () => ({ certificateFingerprint: 'current', pairedDevices: [] }); operations.confirm = async () => true;
  assert.deepEqual(await guard.run(payload, operations), { state: 'restarting' }); assert.equal(rotates, 1);
});
