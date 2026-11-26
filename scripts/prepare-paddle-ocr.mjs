import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = new URL('../node_modules/.cache/canggu-paddle-ocr/', import.meta.url);
const runtime = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);
const bundledWorker = new URL('../node_modules/@paddleocr/paddleocr-js/dist/assets/worker-entry-C9UNuyOJ.js', import.meta.url);
const models = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/';
const files = [
  {
    name: 'detector.tar', model: 'PP-OCRv6_small_det', bytes: 9891840,
    sha256: 'd218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4'
  },
  {
    name: 'recognizer.tar', model: 'PP-OCRv6_small_rec', bytes: 21319680,
    sha256: 'd267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1'
  }
];
const runtimeFiles = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

async function prepareModel({ name, model, bytes, sha256 }) {
  const target = new URL(name, output);
  const valid = (buffer) => buffer?.byteLength === bytes && createHash('sha256').update(buffer).digest('hex') === sha256;
  if (valid(await readFile(target).catch(() => null))) return;
  const address = models + model + '_onnx_infer.tar';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(address, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok || Number(response.headers.get('content-length')) !== bytes) throw new Error('模型下載不完整');
      const data = Buffer.from(await response.arrayBuffer());
      if (!valid(data)) throw new Error('模型校驗失敗');
      const temporary = new URL(name + '.tmp', output);
      await writeFile(temporary, data);
      await rename(temporary, target);
      return;
    } catch (error) {
      if (attempt === 2) throw new Error('無法準備 PaddleOCR 模型 ' + model, { cause: error });
    }
  }
}

await mkdir(output, { recursive: true });
await Promise.all([
  build({
    stdin: { contents: "export { PaddleOCR } from '@paddleocr/paddleocr-js';", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
    outfile: fileURLToPath(new URL('client.js', output)),
    bundle: true, minify: true, legalComments: 'inline', platform: 'browser', format: 'esm',
    external: ['fs', 'path'] // Used only by the Node branch of OpenCV.js.
  }),
  copyFile(bundledWorker, new URL('worker.js', output)),
  ...runtimeFiles.map((name) => copyFile(new URL(name, runtime), new URL(name, output))),
  ...files.map(prepareModel)
]);
