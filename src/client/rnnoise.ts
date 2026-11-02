/**
 * RNNoise（Xiph.org 的 AI 降噪模型）WASM 極簡載入器。
 *
 * WASM 檔來自 @sapphi-red/web-noise-suppressor（RNNoise 0.2 由 Shiguredo 編譯），只需要三個匯入函式，
 * 不用 Emscripten 的整包膠水程式碼，可以直接在 AudioWorklet 裡同步建立。
 *
 * 每次處理 480 個取樣（48 kHz 下的 10 ms），回傳「這段是人聲」的機率 0~1，並就地輸出降噪後的聲音。
 */

export const RNNOISE_FRAME = 480;
export const RNNOISE_SAMPLE_RATE = 48_000;

interface RnnoiseExports {
  memory: WebAssembly.Memory;
  emscripten_stack_init(): void;
  __wasm_call_ctors(): void;
  rnnoise_create(model: number): number;
  rnnoise_destroy(state: number): void;
  rnnoise_process_frame(state: number, out: number, input: number): number;
  malloc(size: number): number;
  free(ptr: number): void;
}

export class Rnnoise {
  private readonly x: RnnoiseExports;
  private readonly state: number;
  private readonly ptr: number;
  private heap: Float32Array;

  constructor(module: WebAssembly.Module) {
    let memory: WebAssembly.Memory | undefined;
    const instance = new WebAssembly.Instance(module, {
      env: {
        // 回傳值會被 C 程式拿去用，一定要回傳 dest
        emscripten_memcpy_big: (dest: number, src: number, num: number) => {
          new Uint8Array(memory!.buffer).copyWithin(dest, src, src + num);
          return dest;
        },
        emscripten_resize_heap: (size: number) => {
          try {
            memory!.grow(Math.ceil((size - memory!.buffer.byteLength) / 65536));
            return 1;
          } catch {
            return 0;
          }
        },
        __assert_fail: () => {
          throw new Error('RNNoise assertion failed');
        },
      },
    });
    this.x = instance.exports as unknown as RnnoiseExports;
    memory = this.x.memory;
    this.x.emscripten_stack_init();
    this.x.__wasm_call_ctors();
    this.state = this.x.rnnoise_create(0);
    this.ptr = this.x.malloc(RNNOISE_FRAME * 4);
    this.heap = new Float32Array(memory.buffer, this.ptr, RNNOISE_FRAME);
  }

  /** 就地降噪一個 480 取樣的框（[-1, 1] 浮點數），回傳人聲機率 */
  process(frame: Float32Array): number {
    // 記憶體成長後舊的 view 會失效，要重建
    if (this.heap.byteLength === 0) this.heap = new Float32Array(this.x.memory.buffer, this.ptr, RNNOISE_FRAME);
    const heap = this.heap;
    for (let i = 0; i < RNNOISE_FRAME; i++) heap[i] = frame[i] * 32768;
    const prob = this.x.rnnoise_process_frame(this.state, this.ptr, this.ptr);
    for (let i = 0; i < RNNOISE_FRAME; i++) frame[i] = heap[i] / 32768;
    return prob;
  }

  destroy() {
    this.x.free(this.ptr);
    this.x.rnnoise_destroy(this.state);
  }
}
