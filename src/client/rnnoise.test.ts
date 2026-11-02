import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Rnnoise, RNNOISE_FRAME, RNNOISE_SAMPLE_RATE } from './rnnoise.ts';

const wasm = readFileSync(new URL('../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise.wasm', import.meta.url));

/** 跑幾秒鐘的訊號，回傳平均人聲機率與降噪前後的音量差（dB） */
function run(gen: (t: number) => number, seconds = 3) {
  const rnn = new Rnnoise(new WebAssembly.Module(wasm));
  const frame = new Float32Array(RNNOISE_FRAME);
  const probs: number[] = [];
  let inE = 0;
  let outE = 0;
  const frames = (seconds * RNNOISE_SAMPLE_RATE) / RNNOISE_FRAME;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < RNNOISE_FRAME; i++) {
      frame[i] = gen((f * RNNOISE_FRAME + i) / RNNOISE_SAMPLE_RATE);
      if (f >= 50) inE += frame[i] ** 2;
    }
    probs.push(rnn.process(frame));
    if (f >= 50) for (let i = 0; i < RNNOISE_FRAME; i++) outE += frame[i] ** 2;
  }
  rnn.destroy();
  const tail = probs.slice(50); // 前 0.5 秒是模型暖機
  return { vad: tail.reduce((a, b) => a + b, 0) / tail.length, gainDb: 10 * Math.log10(outE / inE) };
}

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
let lp = 0;
/** 風聲近似：低通濾波的白噪音 */
const wind = () => (lp = lp * 0.97 + rnd() * 0.03) * 2.4;
/** 類人聲：140 Hz 基頻與諧波、三個共振峰、每秒三個音節 */
const voice = (t: number) => {
  const env = Math.max(0, Math.sin(2 * Math.PI * 3 * t));
  let s = 0;
  for (let k = 1; k < 20; k++) {
    const f = 140 * k;
    const formant =
      Math.exp(-(((f - 700) / 300) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 300) ** 2)) + 0.3 * Math.exp(-(((f - 2500) / 400) ** 2));
    s += (formant * Math.sin(2 * Math.PI * f * t)) / k;
  }
  return 0.2 * env * s;
};

test('wind noise is suppressed and not judged as voice', () => {
  const r = run(wind);
  assert.ok(r.vad < 0.1, `vad ${r.vad}`);
  assert.ok(r.gainDb < -12, `gain ${r.gainDb} dB`);
});

test('voice-like signal is kept and judged as voice', () => {
  const r = run(voice);
  assert.ok(r.vad > 0.3, `vad ${r.vad}`);
  assert.ok(r.gainDb > -3, `gain ${r.gainDb} dB`);
});
