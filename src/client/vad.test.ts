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

/** 模擬別人說話時喇叭的音量（像語音一樣有起伏、有停頓） */
const speechLike = (i: number) => (i % 25 < 18 ? -20 + 6 * Math.sin(i * 0.9) : -100);

test('回音模式：學會回音大小後，回音不觸發，對著麥克風說話可以插話', () => {
  const vad = new VoiceDetector({ gateDb: -45, voiceThreshold: 0.6 });
  for (let i = 0; i < 50; i++) vad.update(db(-62), 0.05);
  // 回音比喇叭小 18 dB（有回音消除），被自動增益放大到 -38 dB 左右，AI 也覺得像人聲
  let echo = false;
  for (let i = 0; i < 250; i++) {
    const ref = speechLike(i);
    echo = vad.update(ref > -60 ? db(ref - 18) : db(-62), ref > -60 ? 0.9 : 0.05, ref) || echo;
  }
  assert.equal(echo, false, '回音被當成說話');
  assert.ok(vad.erlDb < -12, `應學到回音比喇叭小，實際 ${vad.erlDb.toFixed(1)} dB`);
  // 喇叭 -20 dB 時自己對著麥克風說話（-12 dB）：160 ms 後觸發
  const frames = [];
  for (let i = 0; i < 6; i++) frames.push(vad.update(db(-12), 0.95, -20));
  assert.deepEqual(frames, [false, false, false, true, true, true]);
});

test('回音模式：一開始保守，很大聲的回音（沒有回音消除）也不會觸發', () => {
  const vad = new VoiceDetector({ gateDb: -45, voiceThreshold: 0.6 });
  for (let i = 0; i < 50; i++) vad.update(db(-62), 0.05);
  let echo = false;
  for (let i = 0; i < 250; i++) {
    const ref = speechLike(i);
    echo = vad.update(ref > -60 ? db(ref - 3) : db(-62), ref > -60 ? 0.95 : 0.05, ref) || echo;
  }
  assert.equal(echo, false);
});

test('沒有傳喇叭音量（沒人說話）時照一般標準判斷', () => {
  const vad = new VoiceDetector({ gateDb: -45, voiceThreshold: 0.6 });
  for (let i = 0; i < 50; i++) vad.update(db(-62), 0.05);
  let on = false;
  for (let i = 0; i < 3; i++) on = vad.update(db(-30), 0.9);
  assert.equal(on, true);
  assert.equal(vad.strict, false);
});

test('回音模式：回音消除很好（麥克風幾乎收不到喇叭聲）時，約一秒內就能插話', () => {
  const vad = new VoiceDetector({ gateDb: -45, voiceThreshold: 0.6 });
  for (let i = 0; i < 50; i++) vad.update(db(-62), 0.05);
  for (let i = 0; i < 25; i++) vad.update(db(-62), 0.05, -20);
  let on = false;
  for (let i = 0; i < 6; i++) on = vad.update(db(-18), 0.95, -20);
  assert.equal(on, true, `門檻 ${vad.thresholdDb.toFixed(1)} dB`);
});
