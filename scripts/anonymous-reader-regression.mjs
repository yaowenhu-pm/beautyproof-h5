import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createAnonymousReaderHandlers,ANONYMOUS_JOB_TTL,ANONYMOUS_RESULT_TTL,anonymousSql} from '../lib/server/anonymous-reader-core.ts';
import {ANONYMOUS_READER_SHA,checkedAnonymousResult,sha256Text} from '../lib/shared/anonymous-reader-protocol.ts';
let checks=0;const check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
const sqlite=new DatabaseSync(':memory:');
for(const name of ['0002_lonely_logan.sql','0003_talented_lionheart.sql','0004_anonymous_reader_jobs.sql'])sqlite.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
sqlite.exec('PRAGMA optimize');
function statement(sql,values=[]) {
  return {bind:(...args)=>statement(sql,args),first:async()=>sqlite.prepare(sql).get(...values)||null,
    run:async()=>{const result=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(result.changes)},results:[]};},
    execute:async()=>{
      if(/\bRETURNING\b|^SELECT/i.test(sql)){const results=sqlite.prepare(sql).all(...values);return {results,meta:{changes:Number(sqlite.prepare('SELECT changes() AS n').get().n)}};}
      const result=sqlite.prepare(sql).run(...values);return {results:[],meta:{changes:Number(result.changes)}};
    }};
}
const db={prepare:statement,batch:async statements=>{sqlite.exec('BEGIN');try{const results=[];for(const stmt of statements)results.push(await stmt.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
const {publicKey,privateKey}=generateKeyPairSync('ed25519');const encoded=publicKey.export({type:'spki',format:'der'}).toString('base64');
let clock=Date.now(),enabled=false,key=encoded;
const handlers=createAnonymousReaderHandlers({getDb:()=>db,getPublicKey:()=>key,isEnabled:()=>enabled,now:()=>clock});
const post=url=>handlers.submit(new Request('https://site.test/api/reader-jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})}));
function signed(payload){const raw=JSON.stringify({nonce:randomUUID(),...payload}),stamp=String(clock);return new Request('https://site.test/api/reader-jobs/worker',{method:'POST',body:raw,headers:{'x-reader-timestamp':stamp,'x-reader-signature':sign(null,Buffer.from(stamp+'\n'+raw),privateKey).toString('base64')}});}
const work=payload=>handlers.worker(signed(payload));
const poll=(ticket,accessToken=ticket.accessToken)=>handlers.poll(new Request('https://site.test/api/reader-jobs/'+ticket.jobId,{headers:{authorization:'Bearer '+accessToken}}),ticket.jobId);
const url='https://www.xiaohongshu.com/explore/'+'a'.repeat(24),short='https://xhslink.cn/o/test';
check((await (await post(url)).json()).code,'reader_disabled');enabled=true;key='';check((await (await post(url)).json()).code,'reader_disabled');key=encoded;
check((await (await post(url)).json()).code,'reader_offline');
check((await handlers.worker(new Request('https://site.test',{method:'POST',body:'{}'}))).status,401);
const heartbeat=signed({action:'heartbeat'});check((await handlers.worker(heartbeat.clone())).status,200);check((await handlers.worker(heartbeat.clone())).status,409);
check((await post('http://169.254.169.254/latest/meta-data')).status,400);
const a=await (await post(short)).json(), b=await (await post(url)).json(), c=await (await post(url)).json();
check(new Set([a.jobId,b.jobId,c.jobId]).size,3);check(a.accessToken.length,43);
check(sqlite.prepare('SELECT access_hash FROM anonymous_reader_jobs WHERE id=?').get(a.jobId).access_hash,await sha256Text(a.accessToken));
check((await (await post(url)).json()).code,'queue_full');check((await poll(a,'x'.repeat(43))).status,404);
const first=(await (await work({action:'take'})).json()).job;check(first.id,a.jobId);check((await (await work({action:'take'})).json()).job,null);
check((await (await poll(a)).json()).status,'running');
const text='完整正文与成分信息'.repeat(4000), images=Array.from({length:11},(_,i)=>({index:i+1,url:`https://sns-webpic-qc.xhscdn.com/image-${i}?signature=example`,sha256:'b'.repeat(64),bytes:120,width:100,height:100,frames:1,format:'JPEG'}));
const result={noteId:'a'.repeat(24),canonicalUrl:url,title:'完整标题',text,textSha256:await sha256Text(text),type:'normal',imagesRole:'note_images',mediaStatus:'complete',sourceImageCount:11,images,checkedAt:new Date(clock).toISOString(),readerSha256:ANONYMOUS_READER_SHA,accountUsed:false,browserCookiesRead:false,cacheUsed:false,
  redirects:[{host:'xhslink.cn',path:'/o/test',status:302},{host:'www.xiaohongshu.com',path:'/explore/'+'a'.repeat(24),status:200}]};
const validated=await checkedAnonymousResult(short,result);check(validated.extraction.pageText,text);check(validated.extraction.media.length,11);
check(validated.extraction.media.map(image=>image.sha256),images.map(image=>image.sha256));
for(const broken of [{...result,text:text+'tamper'},{...result,noteId:'c'.repeat(24)},{...result,sourceImageCount:12},{...result,images:images.slice(0,8)},{...result,images:[{...images[0],index:2},...images.slice(1)]},{...result,images:[{...images[0],url:'https://169.254.169.254/image'},...images.slice(1)]},{...result,redirects:[{host:'xhslink.cn',path:'/o/wrong',status:302},result.redirects[1]]},{...result,cacheUsed:true}]){await assert.rejects(()=>checkedAnonymousResult(short,broken));checks++;}
const small={...result,text:'完整正文',textSha256:await sha256Text('完整正文')};
const complete={action:'complete',id:first.id,claimToken:first.claimToken,sourceUrl:short,status:'complete',result:small};
check((await work({...complete,claimToken:randomUUID()})).status,410);
check((await work({...complete,result:{...small,text:'篡改正文'}})).status,422);
check((await work(complete)).status,200);check((await work(complete)).status,200);
const completed=await (await poll(a)).json();check(completed.status,'complete');check(completed.result.extraction.media.length,11);check(completed.result.verification.images.length,11);check(completed.result.extraction.pageText,'完整正文');
const second=(await (await work({action:'take'})).json()).job;check(second.id,b.jobId);
check((await work({action:'complete',id:second.id,claimToken:second.claimToken,sourceUrl:url,status:'failed',error:{code:'note_unavailable',message:'SECRET THIRD PARTY BODY'}})).status,200);
check((await (await poll(b)).json()).error,{code:'note_unavailable',message:'平台提示该内容暂时无法查看。'});
const third=(await (await work({action:'take'})).json()).job;check(third.id,c.jobId);
clock+=ANONYMOUS_JOB_TTL+1;
check((await work({action:'complete',id:third.id,claimToken:third.claimToken,sourceUrl:url,status:'failed',error:{code:'timeout'}})).status,410);
check((await (await poll(c)).json()).status,'failed');check((await (await poll(c)).json()).error.code,'timeout');
clock+=45001;check((await (await post(url)).json()).code,'reader_offline');
await work({action:'heartbeat'});check((await post(url)).status,202);
clock+=ANONYMOUS_RESULT_TTL+1;check((await poll(a)).status,404);
sqlite.exec('DELETE FROM anonymous_reader_jobs; DELETE FROM reader_rate;');await work({action:'heartbeat'});
for(let i=0;i<6;i++){check((await post(url)).status,202);const job=(await (await work({action:'take'})).json()).job;await work({action:'complete',id:job.id,claimToken:job.claimToken,sourceUrl:url,status:'failed',error:{code:'note_unavailable'}});}
check((await (await post(url)).json()).code,'rate_limited');
const plan=sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM anonymous_reader_jobs WHERE status='queued' AND deadline_at>? ORDER BY created_at LIMIT 1").all(clock);
assert.ok(plan.some(row=>row.detail.includes('idx_anonymous_reader_status_created')));checks++;
check(sqlite.prepare('SELECT COUNT(*) AS n FROM anonymous_reader_jobs').get().n,6);
sqlite.close();console.log(`${checks} anonymous reader checks passed using real SQLite, signed Request handlers and exact body/media validation. Zero network/model calls.`);
