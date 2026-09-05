// Explicit opt-in. Never retries. Run only against the production shared ledger.
import assert from 'node:assert/strict';
if(!process.env.BEAUTYPROOF_TEST_TOKEN)throw new Error('Set the private test token outside the repository.');
if(process.argv[2]!=='--spend-within-approved-budget')throw new Error('Explicit paid-test flag required.');
const origin='https://beautyproof-h5.yaowen-hu.chatgpt.site';
const headers={'Content-Type':'application/json','x-beautyproof-test':process.env.BEAUTYPROOF_TEST_TOKEN};
const samples=[
 {id:'moisturizer',text:'这款普通面霜含甘油和透明质酸钠，主要用于日常保湿。实际感受因人而异，不承诺治疗皮肤疾病。',expect:'not-risk'},
 {id:'medical',text:'这款普通硫磺香皂治好了我的脱发和湿疹，三天就能治好，大家可以用它代替药膏。',expect:'risk'},
 {id:'debunk',text:'辟谣：不要相信“硫磺皂能治好脱发”的广告。普通清洁用品不能代替药物治疗，天然也不等于绝对安全。',expect:'not-risk'},
];
for(const sample of samples){
 const budget=await fetch(origin+'/api/budget',{headers}).then(r=>r.json());
 assert.ok(Array.isArray(budget.totals),'budget endpoint must be available');
 const testSpend=budget.totals.filter(x=>x.purpose==='test').reduce((n,x)=>n+x.accounted_micros,0);
 assert.ok(testSpend<500000,'Leave room inside the 0.6 yuan test cap');
 const start=Date.now();
 const response=await fetch(origin+'/api/analyze',{method:'POST',headers,body:JSON.stringify({sourceType:'text',title:sample.text.slice(0,52),extraction:{pageText:sample.text}}),signal:AbortSignal.timeout(65000)});
 const data=await response.json(),report=data.reportV2;
 const semanticPass=report?.status==='complete'&&(sample.expect==='risk'?report.findings.some(f=>f.judgment==='risk'):report.findings.every(f=>f.judgment!=='risk'));
 console.log(JSON.stringify({id:sample.id,http:response.status,ms:Date.now()-start,semanticPass,report}));
 if(!semanticPass){console.log('Stopped for manual review; no automatic paid retry.');break;}
}
console.log(JSON.stringify({budget:await fetch(origin+'/api/budget',{headers}).then(r=>r.json())}));
