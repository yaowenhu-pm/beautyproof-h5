import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, randomUUID, createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJobServer, signingPayload, validateUrl} from './job-server.mjs';

test('URL input accepts only public note/share URLs', () => {
  for (const url of ['http://127.0.0.1/test', 'http://169.254.169.254/latest/meta-data', 'https://xhslink.cn.evil.test/o/a', 'https://u:p@xhslink.cn/o/a', 'https://www.xiaohongshu.com/login', 'https://www.xiaohongshu.com/', 'https://xhslink.cn:18080/o/a']) assert.throws(() => validateUrl(url));
  assert.equal(validateUrl('https://xhslink.cn/o/hello'), 'https://xhslink.cn/o/hello');
});

test('authentication, replay, token ownership, exact media bytes, fresh executions and TTL', async () => {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const root = await mkdtemp(join(tmpdir(), 'xhs-server-test-'));
  let calls = 0, clock = Date.now();
  const bytes = Buffer.from('test-verified-image-bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const server = await createJobServer({publicKey, dataDirectory: root, ttlMs: 1000, now: () => clock, execute: async (url, directory) => {
    calls++;
    await mkdir(join(directory, 'evidence/images'), {recursive:true});
    await writeFile(join(directory, 'evidence/images/01.jpg'), bytes);
    return {ok:true, auditPassed:true, evidenceDirectory: join(directory, 'evidence'), result:{noteId:'a'.repeat(24), text:'fresh source body', mediaStatus:'complete', sourceImageCount:1, accountUsed:false,browserCookiesRead:false,cacheUsed:false,
      images:[{index:1,file:'images/01.jpg',sha256:hash,bytes:bytes.length,format:'JPEG'}]}};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const signed = (method,path,payload,token='',nonce=randomUUID()) => {
    const raw=Buffer.from(payload ? JSON.stringify(payload) : ''), timestamp=String(clock);
    const headers={'content-type':'application/json','x-reader-timestamp':timestamp,'x-reader-nonce':nonce,'x-reader-signature':sign(null,signingPayload(timestamp,nonce,method,path,token,raw),privateKey).toString('base64')};
    if(token)headers['x-reader-job-token']=token;
    return {method,headers,...(method==='POST'?{body:raw}:{})};
  };
  try {
    assert.equal((await fetch(origin+'/v2/xhs/jobs',{method:'POST'})).status,401);
    const path='/v2/xhs/jobs', payload={requestId:randomUUID(),url:'https://xhslink.cn/o/a'};
    const options=signed('POST',path,payload);
    const response=await fetch(origin+path,options); assert.equal(response.status,202);
    const job=await response.json();
    assert.equal((await fetch(origin+path,options)).status,409);
    assert.equal((await fetch(origin+path,{...signed('POST',path,payload),body:JSON.stringify({...payload,url:'https://xhslink.cn/o/b'})})).status,401);
    const statusPath=path+'/'+job.jobId;
    assert.equal((await fetch(origin+statusPath,signed('GET',statusPath,undefined,'wrong-token'))).status,404);
    let complete;
    for(let i=0;i<30;i++) { complete=await (await fetch(origin+statusPath,signed('GET',statusPath,undefined,job.jobToken))).json(); if(complete.status==='complete')break; await new Promise(r=>setTimeout(r,10)); }
    assert.equal(complete.status,'complete'); assert.equal('file' in complete.result.images[0],false);
    const mediaPath=complete.result.images[0].mediaPath;
    const media=await fetch(origin+mediaPath,signed('GET',mediaPath,undefined,job.jobToken));
    assert.equal(media.status,200); assert.deepEqual(Buffer.from(await media.arrayBuffer()),bytes);
    assert.equal((await fetch(origin+mediaPath,signed('GET',statusPath,undefined,job.jobToken))).status,401);
    const second=await fetch(origin+path,signed('POST',path,{...payload,requestId:randomUUID()})); assert.equal(second.status,202);
    for(let i=0;i<30&&calls<2;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(calls,2);
    await new Promise(r=>setTimeout(r,30)); clock+=2000;
    assert.equal((await fetch(origin+statusPath,signed('GET',statusPath,undefined,job.jobToken))).status,404);
  } finally { await new Promise(r=>server.close(r)); await rm(root,{recursive:true,force:true}); }
});

test('failure cannot become complete; sequential queue is bounded', async () => {
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'), root=await mkdtemp(join(tmpdir(),'xhs-queue-test-'));
  let release;
  const server=await createJobServer({publicKey,dataDirectory:root,maxPending:1,execute:()=>new Promise(r=>{release=r;})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin=`http://127.0.0.1:${server.address().port}`;
  async function post(url){const raw=Buffer.from(JSON.stringify({requestId:randomUUID(),url})),nonce=randomUUID(),timestamp=String(Date.now()),path='/v2/xhs/jobs'; return fetch(origin+path,{method:'POST',body:raw,headers:{'content-type':'application/json','x-reader-nonce':nonce,'x-reader-timestamp':timestamp,'x-reader-signature':sign(null,signingPayload(timestamp,nonce,'POST',path,'',raw),privateKey).toString('base64')}});}
  try {
    assert.equal((await post('https://xhslink.cn/o/a')).status,202);
    assert.equal((await post('https://xhslink.cn/o/b')).status,202);
    assert.equal((await post('https://xhslink.cn/o/c')).status,429);
    release({ok:false,error:'note_unavailable'}); await new Promise(r=>setTimeout(r,10));
    release({ok:false,error:'note_unavailable'}); await new Promise(r=>setTimeout(r,10));
    const cooldown=await post('https://xhslink.cn/o/a'); assert.equal(cooldown.status,429);assert.equal((await cooldown.json()).error,'upstream_cooldown');
  } finally {await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
