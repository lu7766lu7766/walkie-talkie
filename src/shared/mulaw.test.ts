import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMulaw, MULAW_TO_FLOAT } from './mulaw.ts';

test('μ-law round trip stays within quantisation error', () => {
  for (let s = -32768; s <= 32767; s += 7) {
    const decoded = MULAW_TO_FLOAT[encodeMulaw(s)] * 32768;
    const clipped = Math.max(-32635, Math.min(32635, s));
    // μ-law 量化誤差約為訊號大小的 1/16，加上小訊號的固定誤差
    assert.ok(Math.abs(decoded - clipped) <= Math.abs(clipped) / 16 + 8, `${s} -> ${decoded}`);
  }
});

test('silence encodes to silence', () => {
  assert.equal(MULAW_TO_FLOAT[encodeMulaw(0)], 0);
});
