import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {retrieve,evidence} from '../lib/shared/knowledge.ts';
import {baseReport,validateReport} from '../lib/shared/report.ts';
const cases=JSON.parse(readFileSync(new URL('../tests/calibration-cases.json',import.meta.url),'utf8'));
for(const c of cases){
 const refs=retrieve(c.text);const base=baseReport(c.text,'',refs,[]);
 for(const id of c.citations)assert.ok(refs.some(s=>s.id===id),`${c.id} missing ${id}`);
 if(c.text){const r=validateReport({summary:'仅供结构测试',findings:[{quote:c.quote,judgment:c.judgment,citations:c.citations,reason:'这是结构校准输入，不是实际模型分析结果。'}]},base,c.text);assert.equal(r.status,'complete');}
 else assert.equal(base.status,'insufficient');
 console.log('PASS calibration retrieval/schema',c.id);
}
const d=cases.find(c=>c.id==='D1');
assert.throws(()=>validateReport({summary:'风险',findings:[{quote:'硫磺皂能治好湿疹',judgment:'risk',reason:'被引述的宣传存在风险',citations:['CN-AD11']}]},baseReport(d.text,'',retrieve(d.text),[]),d.text),/context_requires_review/);
const n=cases.find(c=>c.id==='N4');
assert.throws(()=>validateReport({summary:'风险',findings:[{quote:n.quote,judgment:'risk',reason:'神器是禁用词所以违法',citations:['CN-CONTEXT']}]},baseReport(n.text,'',retrieve(n.text),[]),n.text),/context_requires_review/);
assert.equal(new Set(evidence.map(s=>s.id)).size,evidence.length);
assert.ok(evidence.every(s=>s.url.startsWith('https://')&&s.kind&&s.limitation&&s.reviewedAt));
const opinion='天然美容蚕茧球，真的好用';
assert.equal(validateReport({summary:'x',findings:[{quote:opinion,judgment:'insufficient',reason:'缺少具体产品试验',citations:['CN-EFFICACY']}]},baseReport(opinion,'',retrieve(opinion),[]),opinion).findings[0].judgment,'context');
console.log('12 constructed cases + protective guards passed. No LLM calls; not an accuracy evaluation.');
