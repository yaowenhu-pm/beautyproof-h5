import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the pure decisions in page.tsx without mounting the browser-only OCR UI.
const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function decision(name) {
  const declaration = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(declaration, `${name} exists in the input page`);
  const javascript = ts.transpileModule(declaration.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(`${javascript}\nreturn ${name};`)();
}

const offerRecovery = decision('shouldOfferLinkRecovery');
const supplementOnlyDecision = decision('shouldUseSupplementOnly');
const containsPlatformMediaText = decision('containsPlatformMediaText');
const url = 'https://www.xiaohongshu.com/explore/AAA';
const mediaWithoutText = { url, value: { resolved: true, contentStatus: 'media_only' }, noUsableText: true };

assert.equal(offerRecovery('link', url, mediaWithoutText, '未识别到文字'), true,
  'media URL without extractable text keeps the original-work recovery entry');
assert.equal(supplementOnlyDecision(mediaWithoutText, url, true), true,
  'pasted text or screenshot skips a repeat anonymous read and media download');
assert.equal(supplementOnlyDecision(mediaWithoutText, url, false), false,
  'a deliberate retry without a supplement starts a fresh read');
assert.equal(supplementOnlyDecision({ ...mediaWithoutText, noUsableText: false }, url, true), false,
  'a prior media read that produced text is not discarded');
assert.equal(supplementOnlyDecision(mediaWithoutText, url.replace('AAA', 'BBB'), true), false,
  'another work never reuses the previous result');
assert.equal(offerRecovery('link', url.replace('AAA', 'BBB'), mediaWithoutText, '未识别到文字'), false,
  'another work never displays the old recovery entry');
assert.equal(offerRecovery('upload', url, mediaWithoutText, '未识别到文字'), false,
  'recovery is scoped to link input');
assert.equal(offerRecovery('link', url, { url, value: { resolved: true, contentStatus: 'body' } }, ''), false,
  'a complete body without errors needs no recovery prompt');
assert.equal(containsPlatformMediaText({ ocrText: '图片里提到烟酰胺', transcript: '' }), true,
  'platform image OCR remains attributed to the platform');
assert.equal(containsPlatformMediaText({ ocrText: '', transcript: '视频口播提到保湿' }), true,
  'platform video speech remains attributed to the platform');
assert.equal(containsPlatformMediaText({ ocrText: '', transcript: '', pageText: '用户补充原文' }), false,
  'supplemented page text alone never becomes platform media text');
assert.equal(containsPlatformMediaText({ ocrText: '  ', transcript: '\n' }), false,
  'blank OCR and speech do not count as platform media text');

console.log('12 page recovery and provenance decisions passed. No network or model calls.');
