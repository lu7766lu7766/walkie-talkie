import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMulaw, MULAW_TO_FLOAT } from '../shared/mulaw.ts';
import { audioStats, cleanTranscript, mulawToWav, parseCorrection, toBase64, worthTranscribing } from './transcribe.ts';

const tone = (seconds: number, amp: number) => {
  const n = Math.round(seconds * 16000);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = encodeMulaw(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * amp * 32767));
  return out;
};

test('mu-law chunks become a valid 16 kHz mono PCM WAV', () => {
  const wav = mulawToWav([tone(0.5, 0.5), tone(0.5, 0.5)]);
  const v = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 15)), 'WAVEfmt');
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 16000 * 2);
  assert.equal(wav.length, 44 + 16000 * 2);
  // 取樣值與 μ-law 解碼一致
  const first = tone(0.5, 0.5);
  for (const i of [0, 7, 100, 4000]) {
    assert.equal(v.getInt16(44 + i * 2, true), Math.round(MULAW_TO_FLOAT[first[i]] * 32767));
  }
});

test('a full 65-second clip converts quickly', () => {
  const chunks = Array.from({ length: 65 * 25 }, () => tone(0.04, 0.3));
  const t0 = performance.now();
  const wav = mulawToWav(chunks);
  audioStats(chunks);
  toBase64(wav);
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
  console.log(`65 s clip: ${ms.toFixed(1)} ms`);
});

test('base64 matches the standard encoding for every padding case', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 200_000, 200_001, 200_002]) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 131 + 7) % 256);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'), `length ${len}`);
  }
});

test('only speech-length, audible segments are transcribed', () => {
  assert.equal(worthTranscribing([tone(0.3, 0.5)]), false, 'too short');
  assert.equal(worthTranscribing([tone(2, 0.0001)]), false, 'silence from the voice gate');
  assert.equal(worthTranscribing([tone(1, 0.3)]), true);
  assert.ok(Math.abs(audioStats([tone(1.5, 0.3)]).seconds - 1.5) < 0.001);
});

test('whisper hallucinations and empty output are dropped', () => {
  assert.equal(cleanTranscript(''), null);
  assert.equal(cleanTranscript(' 。 '), null);
  assert.equal(cleanTranscript('字幕由Amara.org社区提供'), null);
  assert.equal(cleanTranscript('请不吝点赞 订阅 转发 打赏支持明镜与点点栏目'), null);
  assert.equal(cleanTranscript('謝謝觀看'), null);
  assert.equal(cleanTranscript('對講機通話，繁體中文。'), null, 'prompt echoed back');
  assert.equal(cleanTranscript('  第三組  到 門口 集合  '), '第三組 到 門口 集合');
  assert.equal(cleanTranscript('對講機通話測試'), '對講機通話測試', 'real speech containing prompt words is kept');
});

test('corrections are extracted from any response shape and sanity checked', () => {
  const raw = '第三组到门口集合';
  assert.equal(parseCorrection({ response: '第三組到門口集合。' }, raw), '第三組到門口集合。');
  assert.equal(parseCorrection({ choices: [{ message: { content: '<think>\n</think>\n\n第三組到門口集合。' } }] }, raw), '第三組到門口集合。');
  assert.equal(parseCorrection('校正後：「第三組到門口集合。」', raw), '第三組到門口集合。');
  assert.equal(parseCorrection(null, raw), raw);
  assert.equal(parseCorrection({ response: '' }, raw), raw);
  assert.equal(parseCorrection({ response: '好的！這是一段要求大家集合的對講機通話，第三組需要在十分鐘內到達門口並且向組長報到。' }, raw), raw, 'model rambling is rejected');
});

test('worthKeeping：太短或幾乎沒聲音的發話不留紀錄', async () => {
  const { worthKeeping } = await import('./transcribe.ts');
  assert.equal(worthKeeping(0.3, 0.1), false);
  assert.equal(worthKeeping(2, 0.001), false);
  assert.equal(worthKeeping(2, 0.05), true);
});
