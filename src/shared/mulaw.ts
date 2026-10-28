/** G.711 μ-law 編解碼。實作極小、零相依，所有瀏覽器都能跑。 */

const BIAS = 0x84;
const CLIP = 32635;

/** 16-bit 線性 PCM → 8-bit μ-law */
export function encodeMulaw(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** μ-law byte → [-1, 1] 浮點數的查表 */
export const MULAW_TO_FLOAT = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
    table[i] = (u & 0x80 ? -magnitude : magnitude) / 32768;
  }
  return table;
})();
