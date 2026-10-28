'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sameData, keepIfSame } = require('../renderer/src/ui/stable-data.ts');

const status = () => ({ host: { id: 'h', name: 'Generated', tailscale: { connected: true, ip: '100.64.0.1' } }, sessions: [{ id: 's', permissions: { view: true } }] });

test('an equal reply keeps the previous object, so a React setter bails out', () => {
  const previous = status();
  assert.equal(keepIfSame(previous, status()), previous);
  const list = [status(), status()];
  assert.equal(keepIfSame(list, JSON.parse(JSON.stringify(list))), list);
  assert.equal(keepIfSame(null, null), null);
});

test('any changed, added or removed value yields the new reply', () => {
  const previous = status();
  for (const change of [
    next => { next.host.tailscale.connected = false; },
    next => { next.sessions.push({ id: 't' }); },
    next => { next.sessions = []; },
    next => { delete next.host.name; },
    next => { next.host.extra = undefined; },
    next => { next.sessions[0].permissions.view = 'true'; },
  ]) {
    const next = status(); change(next);
    assert.equal(keepIfSame(previous, next), next);
  }
  assert.equal(sameData([1, 2], { 0: 1, 1: 2, length: 2 }), false, 'an array never equals an object');
  assert.equal(sameData(null, {}), false);
  assert.equal(keepIfSame(null, status()) !== null, true, 'the first reply replaces null');
});

test('key order does not matter', () => {
  assert.equal(sameData({ a: 1, b: { c: [1, { d: 2 }] } }, { b: { c: [1, { d: 2 }] }, a: 1 }), true);
});
