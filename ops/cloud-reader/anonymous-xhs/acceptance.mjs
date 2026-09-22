// Run on ECS to test ECS egress; running locally is explicitly labelled local-only.
import {generateKeyPairSync, randomUUID, sign, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJobServer, pythonExecutor, signingPayload} from './job-server.mjs';
const args=process.argv.slice(2), arg=name=>args[args.indexOf(name)+1];
for(const name of ['--manifest','--out','--python','--reader','--environment'])if(!args.includes(name))throw new Error('Missing '+name);
const root=resolve(arg('--out')), manifest=JSON.parse(await readFile(arg('--manifest'),'utf8'));
await mkdir(root,{recursive:true});
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const server=await createJobServer({publicKey,dataDirectory:resolve(root,'jobs'),ttlMs:3600000,
  execute:pythonExecutor({python:arg('--python'),reader:arg('--reader'),worker:fileURLToPath(new URL('./worker.py',import.meta.url))})});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const hash=data=>createHash('sha256').update(data).digest('hex');
async function request(method,path,payload,token='') {
  const raw=Buffer.from(payload?JSON.stringify(payload):''), timestamp=String(Date.now()),nonce=randomUUID();
  const headers={'content-type':'application/json','x-reader-timestamp':timestamp,'x-reader-nonce':nonce,
    'x-reader-signature':sign(null,signingPayload(timestamp,nonce,method,path,token,raw),privateKey).toString('base64')};
  if(token)headers['x-reader-job-token']=token;
  return fetch(origin+path,{method,headers,...(method==='POST'?{body:raw}:{}),signal:AbortSignal.timeout(10000)});
}
const report={startedAt:new Date().toISOString(),environment:arg('--environment'),cloudVerified:arg('--environment')==='ecs',
  accountUsed:false,browserCookiesRead:false,cacheUsed:false,modelCalls:0,fixtureSha256:hash(await readFile(arg('--manifest'))),rows:[]};
const save=()=>writeFile(resolve(root,'acceptance.json'),JSON.stringify(report,null,2),'utf8');
async function readSample(sample,round) {
  const started=Date.now(),requestId=randomUUID();
  const response=await request('POST','/v2/xhs/jobs',{requestId,url:sample.url});
  if(response.status!==202)throw new Error('Submission rejected '+response.status);
  const job=await response.json();
  let result;
  while(Date.now()-started<330000) {
    const status=await request('GET','/v2/xhs/jobs/'+job.jobId,undefined,job.jobToken);
    if(status.status!==200)throw new Error('Poll failed '+status.status);
    result=await status.json();
    if(['complete','failed'].includes(result.status))break;
    await new Promise(r=>setTimeout(r,2000));
  }
  const row={sampleId:sample.sampleId,round,jobId:job.jobId,expected:sample.expected,status:result?.status||'timeout',
    error:result?.error,elapsedMs:Date.now()-started,checkedAt:new Date().toISOString()};
  if(result?.status==='complete') {
    const content=result.result;
    if(!content.text?.trim()||content.cacheUsed!==false||content.mediaStatus!=='complete')throw new Error('Invalid complete response');
    if(sample.noteId && sample.noteId!==content.noteId)throw new Error('Wrong target ID');
    if(hash(Buffer.from(content.text))!==content.textSha256)throw new Error('Text hash mismatch');
    const directory=resolve(root,`round${round}-${sample.sampleId}`);await mkdir(directory,{recursive:true});
    await writeFile(resolve(directory,'result.json'),JSON.stringify(result,null,2));
    const hashes=[];
    for(const image of content.images) {
      const media=await request('GET',image.mediaPath,undefined,job.jobToken);
      if(media.status!==200)throw new Error('Media request failed');
      const bytes=Buffer.from(await media.arrayBuffer());
      if(bytes.length!==image.bytes||hash(bytes)!==image.sha256)throw new Error('Media bytes mismatch');
      await writeFile(resolve(directory,`${image.index}.${image.format.toLowerCase()}`),bytes);
      hashes.push(image.sha256);
    }
    Object.assign(row,{noteId:content.noteId,textChars:content.text.length,textSha256:content.textSha256,imageCount:content.images.length,imageHashes:hashes,mediaDelivered:true});
    if(round===2){const baseline=report.rows.find(x=>x.sampleId===sample.sampleId&&x.round===1);row.comparison={noteIdEqual:baseline.noteId===row.noteId,textEqual:baseline.textSha256===row.textSha256,imageCountEqual:baseline.imageCount===row.imageCount,imageBytesInOrderEqual:JSON.stringify(baseline.imageHashes)===JSON.stringify(row.imageHashes)};}
  }
  report.rows.push(row);await save();console.log(JSON.stringify(row));return row;
}
try {
  report.unsignedRejected=(await fetch(origin+'/v2/xhs/jobs',{method:'POST',body:'{}'})).status===401;
  for(const sample of manifest.samples){await readSample(sample,1);await new Promise(r=>setTimeout(r,8000));}
  for(const sample of manifest.samples){if(report.rows.some(x=>x.sampleId===sample.sampleId&&x.round===1&&x.status==='complete')){await readSample(sample,2);await new Promise(r=>setTimeout(r,8000));}}
  report.finishedAt=new Date().toISOString();report.counts={attempts:report.rows.length,complete:report.rows.filter(x=>x.status==='complete').length,failed:report.rows.filter(x=>x.status==='failed').length};
  await save();
} finally {await new Promise(r=>server.close(r));}
