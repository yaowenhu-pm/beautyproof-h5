// Run on ECS to test ECS egress; running locally is explicitly labelled local-only.
import {randomUUID, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pythonExecutor} from './job-server.mjs';
import {createLocalTransport} from './local-transport.mjs';
import {summarizeAcceptance} from './acceptance-report.mjs';
const args=process.argv.slice(2), arg=name=>args[args.indexOf(name)+1];
for(const name of ['--manifest','--out','--python','--reader','--environment'])if(!args.includes(name))throw new Error('Missing '+name);
const root=resolve(arg('--out')), manifest=JSON.parse(await readFile(arg('--manifest'),'utf8'));
await mkdir(root,{recursive:true});
const local=await createLocalTransport({dataDirectory:resolve(root,'jobs'),ttlMs:3600000,
  execute:pythonExecutor({python:arg('--python'),reader:arg('--reader'),worker:fileURLToPath(new URL('./worker.py',import.meta.url))})});
const hash=data=>createHash('sha256').update(data).digest('hex');
const request=local.signedRequest;
const report={startedAt:new Date().toISOString(),environment:arg('--environment'),cloudVerified:false,acceptancePassed:false,
  executionEnvironment:{declared:arg('--environment'),locationSource:'operator-declared',platform:process.platform,uid:process.getuid?.()??null},
  verificationScope:'reader-sidecar-on-executing-host',websiteEndToEndVerified:false,
  accountUsed:false,browserCookiesRead:false,cacheUsed:false,modelCalls:0,fixtureSha256:hash(await readFile(arg('--manifest'))),rows:[]};
const save=()=>{Object.assign(report,summarizeAcceptance(report,manifest.samples));return writeFile(resolve(root,'acceptance.json'),JSON.stringify(report,null,2),'utf8');};
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
  await save();
  report.unsignedRejected=(await local.request('POST','/v2/xhs/jobs',Buffer.from('{}'))).status===401;
  for(const sample of manifest.samples){await readSample(sample,1);await new Promise(r=>setTimeout(r,8000));}
  for(const sample of manifest.samples){if(report.rows.some(x=>x.sampleId===sample.sampleId&&x.round===1&&x.status==='complete')){await readSample(sample,2);await new Promise(r=>setTimeout(r,8000));}}
  report.finishedAt=new Date().toISOString();
  await save();
  if(!report.acceptancePassed)process.exitCode=1;
} catch(error) {
  report.executionError=error instanceof Error?error.message:'acceptance_failed';
  report.finishedAt=new Date().toISOString();await save();throw error;
} finally {await local.close();}
