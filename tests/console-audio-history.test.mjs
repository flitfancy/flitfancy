import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window = {};
const source = fs.readFileSync(new URL('../docs/assets/console-audio-history.js', import.meta.url), 'utf8');
vm.runInNewContext(source, { window });
const segment = window.FlitFancyAudioHistory.seriesSegments;
const rows = [
  { time: 0, first: 0, last: 59, left: -30, gains: [4] },
  { time: 60, first: 60, last: 119, left: -40, gains: [4] },
  { time: 300, first: 300, last: 359, left: -40, gains: [4] },
  { time: 360, first: 360, last: 419, left: -20, gains: [8] },
];
assert.deepEqual(Array.from(segment(rows, 'left', 60), s => s.length), [2, 1, 1]);
assert.equal(segment([], 'left', 60).length, 0);
assert.equal(segment([{ ...rows[0], left: null }], 'left', 60).length, 0);
assert.ok(source.includes('/api/audio/history?'), 'must use same-origin authenticated proxy');
console.log('audio history: gaps and gain changes break curves; empty periods stay empty');
