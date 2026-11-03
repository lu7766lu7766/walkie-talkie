import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, mix } from './background-player.ts';

test('encodeWav writes a 16 kHz mono 16-bit header and clamps samples', async () => {
  const blob = encodeWav(new Float32Array([0, 0.5, -1, 2]), 16000);
  const v = new DataView(await blob.arrayBuffer());
  assert.equal(blob.size, 44 + 8);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(v.getInt16(44, true), 0);
  assert.equal(v.getInt16(46, true), Math.trunc(0.5 * 0x7fff));
  assert.equal(v.getInt16(48, true), -0x8000);
  assert.equal(v.getInt16(50, true), 0x7fff);
});

test('mix lines up each speaker from the start and sums them', () => {
  const out = mix(
    new Map([
      [0, [new Float32Array([0.1, 0.1]), new Float32Array([0.1])]],
      [1, [new Float32Array([0.2])]],
    ]),
  );
  assert.deepEqual([...out].map((x) => +x.toFixed(3)), [0.3, 0.1, 0.1]);
});
