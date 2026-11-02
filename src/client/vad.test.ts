import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceDetector } from './vad.ts';

const db = (v: number) => 10 ** (v / 20);
const make = (gateDb = -45, voiceThreshold = 0.6) => new VoiceDetector({ gateDb, voiceThreshold });

function feed(vad: VoiceDetector, level: number, frames: number, prob = -1) {
  let out = false;
  for (let i = 0; i < frames; i++) out = vad.update(db(level), prob);
  return out;
}

test('quiet room never triggers', () => {
  assert.equal(feed(make(), -65, 200), false);
});

test('speech triggers after the attack time and ends after the hangover', () => {
  const vad = make();
  feed(vad, -65, 50);
  assert.equal(vad.update(db(-20)), false, 'one loud frame is not enough');
  assert.equal(vad.update(db(-20)), true);
  assert.equal(feed(vad, -20, 50), true);
  assert.equal(feed(vad, -65, 19), true, 'short pause keeps talking');
  assert.equal(vad.update(db(-65)), false);
});

test('a single click does not trigger', () => {
  const vad = make();
  feed(vad, -65, 50);
  vad.update(db(-10));
  assert.equal(feed(vad, -65, 5), false);
});

test('adapts to steady background noise', () => {
  const vad = make();
  feed(vad, -65, 50);
  // 冷氣、引擎這類持續噪音：一開始可能誤觸，但底線會跟上，最後回到不說話
  feed(vad, -40, 1500);
  assert.equal(feed(vad, -40, 50), false);
  // 在噪音之上說話仍然偵測得到
  assert.equal(feed(vad, -15, 5), true);
});

test('raising the noise gate ignores louder ambient sound', () => {
  const normal = make(-45);
  const windy = make(-25);
  feed(normal, -70, 50);
  feed(windy, -70, 50);
  assert.equal(feed(normal, -32, 5), true);
  assert.equal(feed(windy, -32, 5), false, '風大時調高門檻，-32 dB 的聲音不會觸發');
  assert.equal(feed(windy, -15, 5), true, '大聲說話仍然會觸發');
});

test('loud sound that the AI says is not voice does not trigger', () => {
  const vad = make();
  feed(vad, -65, 50, 0.01);
  assert.equal(feed(vad, -15, 20, 0.05), false, '風聲、喇叭聲：音量夠但不是人聲');
  assert.equal(feed(vad, -15, 3, 0.9), true, '人聲：兩個條件都成立');
});

test('quiet voice below the noise gate does not trigger even if the AI hears it', () => {
  const vad = make(-30);
  feed(vad, -70, 50, 0.01);
  assert.equal(feed(vad, -40, 10, 0.95), false);
});

test('a stricter voice threshold needs higher confidence', () => {
  const loose = make(-45, 0.3);
  const strict = make(-45, 0.9);
  feed(loose, -65, 50, 0);
  feed(strict, -65, 50, 0);
  assert.equal(feed(loose, -20, 5, 0.6), true);
  assert.equal(feed(strict, -20, 5, 0.6), false);
});

test('reset requires a fresh attack', () => {
  const vad = make();
  feed(vad, -65, 50);
  feed(vad, -20, 5);
  vad.reset();
  assert.equal(vad.speaking, false);
  assert.equal(vad.update(db(-20)), false);
  assert.equal(vad.update(db(-20)), true);
});
