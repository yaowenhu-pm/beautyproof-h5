import assert from 'node:assert/strict';
import { build } from 'esbuild';

const plugin = {
  name: 'report-scope-server-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'env', namespace: 'stub' }));
    builder.onResolve({ filter: /^\.\/db$/ }, ({ importer }) => importer.endsWith('analysis-v2.ts')
      ? { path: 'db', namespace: 'stub' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({
      contents: path === 'env' ? 'export const env = {};' : 'export function getDb() { throw new Error("offline_test"); }',
      loader: 'js',
    }));
  },
};
const bundle = await build({
  entryPoints: ['lib/server/analysis-v2.ts'], bundle: true, format: 'esm', platform: 'node',
  write: false, logLevel: 'silent', plugins: [plugin],
});
const { analyzeV2 } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

async function scope(contentStatus, resolved, platformText, supplement, platformMediaTextPresent = false) {
  const response = await analyzeV2(new Request('https://site.example.com/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceType: 'link', title: '样本', resolver: { contentStatus, resolved, platformMediaTextPresent },
      extraction: {
        pageText: [platformText, supplement].filter(Boolean).join('\n'),
        ocrText: platformMediaTextPresent ? '平台画面烟酰胺' : '', transcript: '',
        limitations: ['包含用户补充内容，未确认与原链接完全一致'],
        stages: { page: { status: 'complete', detail: '合并文字' } },
      },
    }),
  }));
  assert.equal(response.status, 200);
  return (await response.json()).reportV2.scope[0];
}

assert.equal(await scope('media_only', true, '', '这款面霜有烟酰胺，宣称美白。'),
  '未取得平台正文；本次仅分析用户补充内容');
assert.equal(await scope('media_only', true, '', '这款面霜有烟酰胺，宣称美白。', true),
  '未取得平台正文；本次分析平台媒体识别文字与用户补充内容');
assert.equal(await scope('unavailable', false, '', '这款面霜有烟酰胺，宣称美白。'),
  '未取得平台正文；本次仅分析用户补充内容');
assert.equal(await scope('title_only', true, '公开标题', '这款面霜有烟酰胺，宣称美白。'),
  '平台标题或摘要与用户补充文字（平台正文不完整）');
assert.equal(await scope('body', true, '平台正文', '这款面霜有烟酰胺，宣称美白。'),
  '平台公开文字与用户补充内容（不保证作品完整）');
console.log('PASS link report source scope for media-only, unavailable, title-only and body');
