import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify,randomUUID} from 'node:crypto';
import {endpointUrl,makeCloudClient,processClaim} from './outbound-bridge.mjs';

test('outbound endpoint is explicit HTTPS, signed and never follows rejection redirects',async()=>{
  for(const value of ['http://site.test/api/reader-jobs/worker','https://u:p@site.test/api/reader-jobs/worker','https://site.test/wrong'])assert.throws(()=>endpointUrl(value));
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');let calls=0;
  const cloud=makeCloudClient('https://site.test/api/reader-jobs/worker',privateKey,async(url,options)=>{
    calls++;assert.equal(options.redirect,'error');assert.equal(verify(null,Buffer.from(options.headers['x-reader-timestamp']+'\n'+options.body),publicKey,Buffer.from(options.headers['x-reader-signature'],'base64')),true);
    assert.equal(JSON.parse(options.body).action,'take');return new Response('{}',{status:403});
  });
  await assert.rejects(cloud({action:'take'}),error=>error.terminal&&error.status===403);assert.equal(calls,1);
});

test('complete and failure are transmitted without re-reading the source',async()=>{
  for(const state of [{status:'complete',result:{noteId:'a'.repeat(24),mediaStatus:'complete',images:[{url:'https://sns-webpic-qc.xhscdn.com/example',sha256:'b'.repeat(64)}]}},{status:'failed',error:'note_unavailable'}]) {
    let submits=0;const completions=[];
    const job={id:randomUUID(),claimToken:randomUUID(),url:'https://xhslink.cn/o/test'};
    const outcome=await processClaim(job,{pollDelayMs:1,cloud:async payload=>{completions.push(payload);return {ok:true};},localRequest:async method=>{
      if(method==='POST'){submits++;return new Response(JSON.stringify({jobId:randomUUID(),jobToken:'secret'}),{status:202});}
      return new Response(JSON.stringify(state));
    }});
    assert.equal(submits,1);assert.equal(completions.length,1);assert.equal(outcome.status,state.status);assert.equal(completions[0].sourceUrl,job.url);
    assert.equal(completions[0].claimToken,job.claimToken);assert.equal(completions[0].status,state.status);
    if(state.status==='failed')assert.deepEqual(completions[0].error,{code:'note_unavailable',message:'平台提示该内容暂时无法查看。'});
  }
});

test('heartbeat keeps long jobs visible and completion retry never starts a second read',async()=>{
  let starts=0,polls=0,completes=0,heartbeats=0;const sent=[];
  const job={id:randomUUID(),claimToken:randomUUID(),url:'https://xhslink.cn/o/test'};
  await processClaim(job,{pollDelayMs:10,heartbeatMs:5,cloud:async payload=>{
    if(payload.action==='heartbeat'){heartbeats++;return {ok:true};}
    completes++;sent.push(payload);if(completes===1)throw Object.assign(new Error('temporary'),{status:503});return {ok:true};
  },localRequest:async method=>{
    if(method==='POST'){starts++;return new Response(JSON.stringify({jobId:randomUUID(),jobToken:'secret'}),{status:202});}
    polls++;return new Response(JSON.stringify(polls<4?{status:'running'}:{status:'failed',error:'timeout'}));
  }});
  assert.equal(starts,1);assert.ok(heartbeats>=1);assert.equal(completes,2);assert.deepEqual(sent[0],sent[1]);
});
