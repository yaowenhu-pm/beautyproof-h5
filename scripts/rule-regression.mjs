import assert from 'node:assert/strict';
import { analyzeClaims } from '../lib/client/analysis.ts';
import { evaluateEvidence } from '../lib/shared/evidence.ts';

const samples = [
  { id: 1, expected: 'risk', text: '对乌斯玛草的权威后知后觉。以后不用去种睫毛啦，睫毛营养液，睫毛液增长液真的有用吗。' },
  { id: 2, expected: 'risk', text: '长睫毛一个不小心养过头啦，坚持上一段时间你会发现睫毛变得又浓密又纤长，睫毛增长液。' },
  { id: 3, expected: 'risk', text: '花小钱办大事，硫磺皂真是个好东西，结果把困扰我多年的头皮屑给整好了。' },
  { id: 4, expected: 'low', text: '今日俺的美容神器。美容蚕茧指套有保湿、控油之效，也有一定的去黑头、去粉刺、护理角质等效果。敏感肌肤要注意自己的皮肤状况，不要过频过度使用。' },
  { id: 5, expected: 'warning', text: '7元的蚕茧居然是黑头闭口橡皮擦，晚晚同款。真的可以洗掉黑头和闭口，注意要轻轻的。' },
  { id: 6, expected: 'warning', text: '天然美容蚕茧球，在日本很流行，京都艺妓使用，日本美容师IKKO介绍。蚕丝含有天然的蛋白质，能将毛孔深处的污垢及老化角质带走。' },
];

function classify(text) {
  const claims = analyzeClaims(text);
  const evidence = evaluateEvidence(text);
  const conflicts = evidence.filter((item) => item.status === 'conflict').length;
  const unsupported = evidence.filter((item) => item.status === 'needs_source').length;
  const high = claims.filter((item) => item.level === 'high').length;
  const medium = claims.filter((item) => item.level === 'medium');
  const contextual = [
    ...evidence.filter((item) => item.status === 'context' && item.signal !== '化妆品功效宣称').map((item) => item.signal),
    ...medium.map((item) => item.rule),
  ].map((signal) => signal.includes('绝对化') || signal.includes('夸大') ? '夸大表述' : signal.includes('背书') ? '背书信息' : signal.includes('天然') ? '天然表述' : signal);
  const lowSignals = new Set(contextual).size;
  const result = conflicts || high ? 'risk' : unsupported || lowSignals >= 2 ? 'warning' : lowSignals ? 'low' : 'clear';
  return { result, claims: claims.map((item) => item.rule), evidence: evidence.map((item) => item.signal) };
}

for (const sample of samples) {
  const actual = classify(sample.text);
  assert.equal(actual.result, sample.expected, `样本 ${sample.id} 预期 ${sample.expected}，实际 ${actual.result}`);
  console.log(JSON.stringify({ id: sample.id, ...actual }));
}
