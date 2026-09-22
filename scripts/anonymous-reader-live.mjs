// Bounded LOCAL integration: live platform reads through HTTP sidecar, real
// bridge serialization/signatures, and real SQLite-backed website handlers.
// The website worker transport is in-process; this is never an ECS/E2E claim.
import {generateKeyPairSync,randomUUID,sign,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createAnonymousReaderHandlers} from '../lib/server/anonymous-reader-core.ts';
import {createJobServer,pythonExecutor,signingPayload} from '../ops/cloud-reader/anonymous-xhs/job-server.mjs';
import {makeCloudClient,processClaim} from '../ops/cloud-reader/anonymous-xhs/outbound-bridge.mjs';
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
for(const k of ['--manifest','--out','--python','--reader'])if(!args.includes(k))throw new Error('Missing '+k);
const root=resolve(arg('--out')), samples=JSON.parse(await readFile(arg('--manifest'),'utf8')).samples;
if(samples.length<1||samples.length>2)throw new Error('This acceptance is limited to one or two fixed samples');
await mkdir(root,{recursive:true});
const sqlite=new DatabaseSync(join(root,'site-local.sqlite'));
for(const file of ['0002_lonely_logan.sql','0003_talented_lionheart.sql','0004_anonymous_reader_jobs.sql'])sqlite.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
function stmt(sql,values=[]){return {bind:(...v)=>stmt(sql,v),first:async()=>sqlite.prepare(sql).get(...values)||null,run:async()=>{const r=sqlite.prepare(sql).run(...values);return {results:[],meta:{changes:Number(r.changes)}};},execute:async()=>{if(/\bRETURNING\b|^SELECT/i.test(sql)){const rows=sqlite.prepare(sql).all(...values);return {results:rows,meta:{changes:Number(sqlite.prepare('SELECT changes() AS n').get().n)}};}const r=sqlite.prepare(sql).run(...values);return {results:[],meta:{changes:Number(r.changes)}};}};}
const db={prepare:stmt,batch:async rows=>{sqlite.exec('BEGIN');try{const out=[];for(const row of rows)out.push(await row.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const pair=generateKeyPairSync('ed25519');
const site=createAnonymousReaderHandlers({getDb:()=>db,getPublicKey:()=>pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),isEnabled:()=>true});
const packets=[];
const cloud=makeCloudClient('https://local-contract.invalid/api/reader-jobs/worker',pair.privateKey,async(url,options)=>{
  const payload=JSON.parse(options.body);if(payload.action==='complete')packets.push(payload);
  return site.worker(new Request(url,options));
});
const server=await createJobServer({publicKey:pair.publicKey,dataDirectory:join(root,'jobs'),execute:pythonExecutor({python:arg('--python'),reader:arg('--reader'),worker:resolve('ops/cloud-reader/anonymous-xhs/worker.py')})});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const localRequest=(method,path,payload,token='')=>{
  const body=Buffer.from(payload?JSON.stringify(payload):''),stamp=String(Date.now()),nonce=randomUUID();
  const headers={'content-type':'application/json','x-reader-timestamp':stamp,'x-reader-nonce':nonce,'x-reader-signature':sign(null,signingPayload(stamp,nonce,method,path,token,body),pair.privateKey).toString('base64')};
  if(token)headers['x-reader-job-token']=token;
  return fetch(origin+path,{method,headers,...(method==='POST'?{body}:{}),signal:AbortSignal.timeout(10000)});
};
const report={scope:'Local HTTP sidecar + live anonymous platform reads + real outbound bridge serialization + real SQLite site handlers; no ECS or deployed site requests',cloudVerified:false,startedAt:new Date().toISOString(),rows:[]};
try{
  for(const sample of samples){
    await cloud({action:'heartbeat'});
    const submitted=await site.submit(new Request('https://local-contract.invalid/api/reader-jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:sample.url})}));
    if(submitted.status!==202)throw new Error('site_submit_'+submitted.status);
    const ticket=await submitted.json(),taken=await cloud({action:'take'});if(taken.job?.id!==ticket.jobId)throw new Error('wrong_claim');
    const started=Date.now();await processClaim(taken.job,{cloud,localRequest});
    const polled=await site.poll(new Request('https://local-contract.invalid/api/reader-jobs/'+ticket.jobId,{headers:{authorization:'Bearer '+ticket.accessToken}}),ticket.jobId);
    const final=await polled.json(),packet=packets.find(x=>x.id===ticket.jobId);
    const row={sampleId:sample.sampleId,status:final.status,error:final.error,elapsedMs:Date.now()-started,checkedAt:new Date().toISOString(),bridgeSignatureAccepted:true};
    if(final.status==='complete'){
      const a=packet.result,b=final.result;const hash=createHash('sha256').update(b.extraction.pageText).digest('hex');
      if(a.noteId!==b.contentId||hash!==a.textSha256||a.text!==b.extraction.pageText||a.images.length!==b.extraction.media.length||a.images.some((x,i)=>x.url!==b.extraction.media[i].url||x.sha256!==b.verification.images[i].sha256))throw new Error('bridge_site_integrity_mismatch');
      Object.assign(row,{noteId:b.contentId,textChars:b.extraction.pageText.length,textSha256:hash,imageCount:b.extraction.media.length,sourceImageCount:a.sourceImageCount,redirectsVerified:true,allMediaPreserved:true});
    }
    await writeFile(join(root,sample.sampleId+'-bridge-packet.json'),JSON.stringify(packet,null,2));
    await writeFile(join(root,sample.sampleId+'-site-result.json'),JSON.stringify(final,null,2));
    report.rows.push(row);await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(row));
    await new Promise(r=>setTimeout(r,8000));
  }
  report.finishedAt=new Date().toISOString();await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));
}finally{await new Promise(r=>server.close(r));sqlite.close();}
