/**
 * 語音轉文字：發話結束後，把這段 μ-law 語音轉成 WAV 交給 Workers AI Whisper 辨識，
 * 再請語言模型校正同音錯字、補標點、轉成繁體中文。
 */
import { MULAW_TO_FLOAT } from '../shared/mulaw.ts';
import { AUDIO_SAMPLE_RATE } from '../shared/protocol.ts';

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const CORRECTION_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

/** 太短的發話（誤觸、只有開頭）不辨識，省額度也避免 Whisper 亂猜 */
export const MIN_TRANSCRIBE_SECONDS = 0.6;
/** 整段音量太小（幾乎都被人聲閘門靜音）就不辨識 */
const MIN_RMS = 0.003;
const AI_TIMEOUT_MS = 20_000;

/** Whisper 的提示：引導輸出繁體中文與全形標點 */
const WHISPER_PROMPT = '對講機通話，繁體中文。';

/**
 * Whisper 在靜音或雜音上常見的「幻覺」輸出（訓練資料裡的影片字幕），出現就整段丟掉。
 */
const HALLUCINATIONS = [
  /字幕/,
  /amara/i,
  /訂閱|订阅/,
  /點贊|点赞|按讚/,
  /轉發|转发|打賞|打赏/,
  /謝謝(大家)?(收看|觀看|觀賞)|谢谢(大家)?(收看|观看)/,
  /請不吝|请不吝/,
  /優優獨播|优优独播/,
  /明鏡與點點|明镜与点点/,
];

const CORRECTION_PROMPT =
  '你是繁體中文（台灣）的語音辨識校正工具。使用者會給你一段對講機通話的語音辨識結果，' +
  '請只修正同音錯字、補上全形標點符號，並把簡體字轉成繁體字（台灣用語）。' +
  '不要改寫語意、不要增加或刪減內容、不要回答或回應內容、不要加任何說明，只輸出校正後的那一段文字。';

export interface Transcriber {
  /** 辨識一段 WAV（base64），沒有可用文字時回傳 null */
  transcribe(wavBase64: string, seconds: number): Promise<string | null>;
  /** 校正辨識結果，失敗時回傳原文 */
  correct(text: string): Promise<string>;
}

interface TranscribeEnv {
  AI?: Ai;
  /** 本機開發沒有 Workers AI 時設成 "1"，改用假的辨識結果測試整個流程；"fail" 模擬 AI 出錯 */
  TRANSCRIBE_FAKE?: string;
}

export function createTranscriber(env: TranscribeEnv): Transcriber | null {
  if (env.TRANSCRIBE_FAKE === '1') return fakeTranscriber;
  if (env.TRANSCRIBE_FAKE === 'fail') return failingTranscriber;
  if (!env.AI) return null;
  const ai = env.AI;
  return {
    async transcribe(audio) {
      const res = await withTimeout(
        ai.run(WHISPER_MODEL, {
          audio,
          task: 'transcribe',
          language: 'zh',
          vad_filter: true,
          initial_prompt: WHISPER_PROMPT,
          condition_on_previous_text: false,
        }),
      );
      return cleanTranscript(res.text ?? '');
    },
    async correct(text) {
      try {
        const res = await withTimeout(
          ai.run(CORRECTION_MODEL, {
            messages: [
              { role: 'system', content: CORRECTION_PROMPT },
              // Qwen3 的 /no_think：不要先「思考」，直接輸出，延遲短很多
              { role: 'user', content: `${text}\n/no_think` },
            ],
            max_tokens: 400,
            temperature: 0.2,
          }),
        );
        return parseCorrection(res, text);
      } catch {
        return text;
      }
    },
  };
}

const fakeTranscriber: Transcriber = {
  async transcribe(_audio, seconds) {
    return `測試語音 ${seconds.toFixed(1)} 秒`;
  },
  async correct(text) {
    await new Promise((r) => setTimeout(r, 300));
    return `${text}。`;
  },
};

/** μ-law byte → 16-bit PCM 查表 */
const MULAW_TO_INT16 = Int16Array.from(MULAW_TO_FLOAT, (f) => Math.round(f * 32767));

const failingTranscriber: Transcriber = {
  async transcribe() {
    throw new Error('simulated AI failure');
  },
  async correct(text) {
    return text;
  },
};

/** 把 μ-law 語音片段轉成 16-bit PCM WAV（查表寫入，Durable Object 每次事件的 CPU 時間有限） */
export function mulawToWav(chunks: Uint8Array[]): Uint8Array {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const wav = new Uint8Array(44 + samples * 2);
  const v = new DataView(wav.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 單聲道
  v.setUint32(24, AUDIO_SAMPLE_RATE, true);
  v.setUint32(28, AUDIO_SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  // Cloudflare 的機器都是 little-endian，可以直接用 Int16Array 寫入
  const pcm = new Int16Array(wav.buffer, 44, samples);
  let o = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) pcm[o++] = MULAW_TO_INT16[chunk[i]];
  }
  return wav;
}

/** 片段的長度（秒）與整體音量（每 4 個取樣抽 1 個估算，夠準也省 CPU） */
export function audioStats(chunks: Uint8Array[]): { seconds: number; rms: number } {
  let total = 0;
  let n = 0;
  let sum = 0;
  for (const chunk of chunks) {
    total += chunk.length;
    for (let i = 0; i < chunk.length; i += 4) {
      const s = MULAW_TO_FLOAT[chunk[i]];
      sum += s * s;
      n++;
    }
  }
  return { seconds: total / AUDIO_SAMPLE_RATE, rms: n ? Math.sqrt(sum / n) : 0 };
}

export function worthTranscribing(chunks: Uint8Array[]): boolean {
  const { seconds, rms } = audioStats(chunks);
  return seconds >= MIN_TRANSCRIBE_SECONDS && rms >= MIN_RMS;
}

const B64 = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');

/** base64 編碼：直接寫入位元組陣列再一次轉成字串，比逐段串接字串 + btoa 快十倍以上 */
export function toBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64[n >> 18];
    out[o++] = B64[(n >> 12) & 63];
    out[o++] = B64[(n >> 6) & 63];
    out[o++] = B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const n = (bytes[i] << 16) | (rest === 2 ? bytes[i + 1] << 8 : 0);
    out[o++] = B64[n >> 18];
    out[o++] = B64[(n >> 12) & 63];
    out[o++] = rest === 2 ? B64[(n >> 6) & 63] : 61; // '='
    out[o++] = 61;
  }
  return new TextDecoder().decode(out);
}

/** 整理 Whisper 的輸出；空白、只有標點或是常見幻覺就回傳 null */
export function cleanTranscript(text: string): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
  // 沒聲音時 Whisper 有時會把提示原封不動吐回來
  if (stripPunct(cleaned) === stripPunct(WHISPER_PROMPT)) return null;
  if (HALLUCINATIONS.some((re) => re.test(cleaned))) return null;
  return cleaned;
}

/**
 * 從語言模型的回應取出校正後的文字。
 * 支援 { response }、OpenAI 格式的 choices 與純字串；去掉思考過程、引號與「校正後：」之類的前綴。
 * 結果長度跟原文差太多（模型自己發揮或回答了問題）就用原文。
 */
export function parseCorrection(res: unknown, original: string): string {
  let text: string | undefined;
  if (typeof res === 'string') text = res;
  else if (res && typeof res === 'object') {
    const r = res as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
    if (typeof r.response === 'string') text = r.response;
    else if (typeof r.choices?.[0]?.message?.content === 'string') text = r.choices[0].message.content;
  }
  if (!text) return original;
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*(校正後|修正後|校正結果|輸出)\s*[:：]\s*/, '')
    .trim()
    .replace(/^["「『“](.*)["」』”]$/s, '$1')
    .trim();
  if (!cleaned) return original;
  const ratio = cleaned.length / original.length;
  return ratio < 0.5 || ratio > 2 ? original : cleaned;
}

function stripPunct(s: string) {
  return s.replace(/[\p{P}\s]/gu, '');
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AI timeout')), AI_TIMEOUT_MS)),
  ]);
}
