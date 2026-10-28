'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowHiddenTracker } = require('../renderer/src/ui/window-hidden-tracker.ts');

function track() {
  const calls = { hidden: [], shown: 0 };
  const tracker = windowHiddenTracker(value => calls.hidden.push(value), () => { calls.shown += 1; });
  return { tracker, calls };
}

test('a late failure of the initial query does not undo a received hidden state', () => {
  const { tracker, calls } = track();
  tracker.state(true);
  tracker.queryFailed();
  assert.deepEqual(calls.hidden, [true]);
  tracker.state(false);
  assert.equal(calls.shown, 1, 'restoring the window still refreshes at once');
});

test('a failed initial query with no state yet counts the window as shown', () => {
  const { tracker, calls } = track();
  tracker.queryFailed();
  assert.deepEqual(calls.hidden, [false]);
  assert.equal(calls.shown, 0);
});

test('only a hidden-to-shown change triggers the shown callback', () => {
  const { tracker, calls } = track();
  tracker.state(false);
  tracker.state(false);
  assert.equal(calls.shown, 0);
  tracker.state(true);
  tracker.state(false);
  assert.equal(calls.shown, 1);
});
