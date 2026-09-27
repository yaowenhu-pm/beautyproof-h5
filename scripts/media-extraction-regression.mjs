import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stubs = {
  analysis: `export async function analyzeFile(file) { return { name: file.name, type: file.type, size: file.size, sha256: 'test' }; }
    export function shouldSkipWhisper() { return true; }`,
  tesseract: `export async function createWorker() { return {
    async recognize() { globalThis.__ocrCalls += 1; if (globalThis.__ocrCalls === globalThis.__failOcrAt) throw new Error('模拟 OCR 失败'); return { data: { text: '第' + globalThis.__ocrCalls + '张图片：烟酰胺' } }; },
    async terminate() {},
  }; }`,
  whisper: `export const env = {}; export async function pipeline() { return async () => ({ text: '' }); }`,
};
const plugin = {
  name: 'media-extraction-test-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/client\/analysis$/ }, () => ({ path: 'analysis', namespace: 'stub' }));
    builder.onResolve({ filter: /^tesseract\.js$/ }, () => ({ path: 'tesseract', namespace: 'stub' }));
    builder.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({ path: 'whisper', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: stubs[path], loader: 'js' }));
  },
};

const bundle = await build({ entryPoints: ['lib/client/extraction.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent', plugins: [plugin] });
const source = bundle.outputFiles[0].text;
const { extractResolvedContent } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

globalThis.__ocrCalls = 0;
globalThis.__failOcrAt = -1;
globalThis.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
globalThis.document = { createElement: (tag) => {
  assert.equal(tag, 'canvas');
  return { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (callback) => callback(new Blob(['pixels'], { type: 'image/jpeg' })) };
} };
let failedDownload = -1;
let fetched = [];
globalThis.fetch = async (url) => {
  const original = new URL(String(url), 'http://localhost').searchParams.get('url');
  const number = Number(original?.split('/').pop());
  fetched.push(number);
  return number === failedDownload
    ? new Response('download failed', { status: 502 })
    : new Response(new Blob(['image'], { type: 'image/jpeg' }), { headers: { 'Content-Type': 'image/jpeg' } });
};
const images = (count) => Array.from({ length: count }, (_, index) => ({ type: 'image', url: `https://example.com/${index + 1}` }));

failedDownload = 2;
const three = (await extractResolvedContent({ pageText: '这款产品保证立即美白，并含有烟酰胺，请核对图片中的成分信息。', media: images(3) })).extraction;
assert.deepEqual(fetched, [1, 2, 3]);
assert.deepEqual({ total: three.mediaCoverage[0].totalImages, attempted: three.mediaCoverage[0].attemptedImages,
  completed: three.mediaCoverage[0].completedImages, failed: three.mediaCoverage[0].failedImages, skipped: three.mediaCoverage[0].skippedImages },
{ total: 3, attempted: 3, completed: 2, failed: 1, skipped: 0 });
assert.match(three.ocrText, /第1张图片/);
assert.match(three.ocrText, /第2张图片/);
assert.ok(three.limitations.some((item) => /第 2 张图片下载/.test(item)));
assert.equal(three.stages.ocr.status, 'partial');

fetched = [];
failedDownload = -1;
globalThis.__failOcrAt = globalThis.__ocrCalls + 2;
const ocrFailure = (await extractResolvedContent({ pageText: '正文', media: images(2) })).extraction.mediaCoverage[0];
assert.deepEqual({ completed: ocrFailure.completedImages, failed: ocrFailure.failedImages, skipped: ocrFailure.skippedImages },
  { completed: 1, failed: 1, skipped: 0 });

fetched = [];
globalThis.__failOcrAt = -1;
const capped = (await extractResolvedContent({ pageText: '正文', media: images(13) })).extraction.mediaCoverage[0];
assert.equal(fetched.length, 12);
assert.deepEqual({ total: capped.totalImages, completed: capped.completedImages, failed: capped.failedImages, skipped: capped.skippedImages },
  { total: 13, completed: 12, failed: 0, skipped: 1 });

fetched = [];
const actualNow = Date.now;
let fakeNow = actualNow();
Date.now = () => fakeNow;
const ocrBeforeSlowDownload = globalThis.__ocrCalls;
try {
  globalThis.fetch = async (url) => {
    const original = new URL(String(url), 'http://localhost').searchParams.get('url');
    const number = Number(original?.split('/').pop());
    fetched.push(number);
    fakeNow += number === 1 ? 1_000 : 35_000;
    return number === 2
      ? new Response('download failed', { status: 502 })
      : new Response(new Blob(['image'], { type: 'image/jpeg' }), { headers: { 'Content-Type': 'image/jpeg' } });
  };
  const partial = (await extractResolvedContent({ pageText: '正文', media: images(3) })).extraction;
  assert.deepEqual(fetched, [1, 2]);
  assert.equal(globalThis.__ocrCalls, ocrBeforeSlowDownload + 1);
  assert.match(partial.ocrText, /烟酰胺/);
  assert.deepEqual({ completed: partial.mediaCoverage[0].completedImages, failed: partial.mediaCoverage[0].failedImages, skipped: partial.mediaCoverage[0].skippedImages },
    { completed: 1, failed: 1, skipped: 1 });
  assert.ok(partial.limitations.some((item) => /下载阶段已达时限/.test(item)));
} finally {
  Date.now = actualNow;
}

fetched = [];
fakeNow = actualNow();
Date.now = () => fakeNow;
try {
  globalThis.fetch = async (url) => {
    const original = new URL(String(url), 'http://localhost').searchParams.get('url');
    fetched.push(Number(original?.split('/').pop()));
    fakeNow += 91_000;
    return new Response(new Blob(['image'], { type: 'image/jpeg' }), { headers: { 'Content-Type': 'image/jpeg' } });
  };
  const expired = (await extractResolvedContent({ pageText: '正文', media: images(3) })).extraction.mediaCoverage[0];
  assert.deepEqual(fetched, [1]);
  assert.deepEqual({ attempted: expired.attemptedImages, completed: expired.completedImages, failed: expired.failedImages, skipped: expired.skippedImages },
    { attempted: 0, completed: 0, failed: 0, skipped: 3 });
} finally {
  Date.now = actualNow;
}
console.log('PASS platform media: failed download, separate OCR failure, item cap, slow-download OCR reserve, total time budget, no text-only shortcut');
