import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceDetector } from './vad.ts';

const db = (v: number) => 10 ** (v / 20);

function feed(vad: VoiceDetector, level: number, frames: number) {
  let out = false;
  for (let i = 0; i < frames; i++) out = vad.update(db(level));
  return out;
}

test('quiet room never triggers', () => {
  const vad = new VoiceDetector();
  assert.equal(feed(vad, -65, 200), false);
});

test('speech triggers after the attack time and ends after the hangover', () => {
  const vad = new VoiceDetector();
  feed(vad, -65, 50);
  assert.equal(vad.update(db(-20)), false, 'one loud frame is not enough');
  assert.equal(vad.update(db(-20)), true);
  assert.equal(feed(vad, -20, 50), true);
  assert.equal(feed(vad, -65, 19), true, 'short pause keeps talking');
  assert.equal(vad.update(db(-65)), false);
});

test('a single click does not trigger', () => {
  const vad = new VoiceDetector();
  feed(vad, -65, 50);
  vad.update(db(-10));
  assert.equal(feed(vad, -65, 5), false);
});

test('adapts to steady background noise', () => {
  const vad = new VoiceDetector();
  feed(vad, -65, 50);
  // 冷氣、引擎這類持續噪音：一開始可能誤觸，但底線會跟上，最後回到不說話
  feed(vad, -40, 1500);
  assert.equal(feed(vad, -40, 50), false);
  // 在噪音之上說話仍然偵測得到
  assert.equal(feed(vad, -15, 5), true);
});

test('higher sensitivity picks up quieter speech', () => {
  const low = new VoiceDetector(0);
  const high = new VoiceDetector(1);
  feed(low, -70, 50);
  feed(high, -70, 50);
  assert.equal(feed(low, -42, 5), false);
  assert.equal(feed(high, -42, 5), true);
});

test('reset requires a fresh attack', () => {
  const vad = new VoiceDetector();
  feed(vad, -65, 50);
  feed(vad, -20, 5);
  vad.reset();
  assert.equal(vad.speaking, false);
  assert.equal(vad.update(db(-20)), false);
  assert.equal(vad.update(db(-20)), true);
});
