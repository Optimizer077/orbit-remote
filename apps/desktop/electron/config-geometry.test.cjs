'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { streamGeometry, keepsControl } = require('../renderer/src/stream/config-geometry.ts');
const config = (over = {}) => ({ monitorId: 'screen', physicalLeft: -1920, physicalTop: 0, physicalWidth: 1920, physicalHeight: 1080, ...over });

test('a config with the same monitor and physical rectangle keeps Control (scale and encoder size may change)', () => {
  const first = streamGeometry(config());
  assert.equal(keepsControl(first, streamGeometry(config())), true);
});
test('the first config of a stream never keeps Control', () => {
  assert.equal(keepsControl(null, streamGeometry(config())), false);
});
test('any change of monitor or physical rectangle turns Control off', () => {
  const first = streamGeometry(config());
  for (const change of [{ monitorId: 'other' }, { physicalLeft: 0 }, { physicalTop: 1 }, { physicalWidth: 2560 }, { physicalHeight: 1440 }])
    assert.equal(keepsControl(first, streamGeometry(config(change))), false, JSON.stringify(change));
});
