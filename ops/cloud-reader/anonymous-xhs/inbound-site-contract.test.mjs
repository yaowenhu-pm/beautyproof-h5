import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createJobServer} from './job-server.mjs';
import {createInboundReaderHandlers} from '../../../lib/server/inbound-reader-core.ts';
import {validInboundEndpoint} from '../../../lib/shared/inbound-reader.ts';
import {ANONYMOUS_READER_SHA} from '../../../lib/shared/anonymous-reader-protocol.ts';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0002_lonely_logan.sql','0003_talented_lionheart.sql',
    '0004_anonymous_reader_jobs.sql','0005_anonymous_inbound_reader.sql'])
    sqlite.exec(readFileSync(new URL('../../../drizzle/'+migration,import.meta.url),'utf8'));
  function statement(sql,values=[]) { return {
    bind:(...args)=>statement(sql,args),
    first:async()=>sqlite.prepare(sql).get(...values)||null,
    run:async()=>{const result=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(result.changes)},results:[]};},
    execute:async()=>{
      if(/\bRETURNING\b|^SELECT/i.test(sql)) {
        const results=sqlite.prepare(sql).all(...values);
        return {results,meta:{changes:Number(sqlite.prepare('SELECT changes() AS n').get().n)}};
      }
      const result=sqlite.prepare(sql).run(...values);
      return {results:[],meta:{changes:Number(result.changes)}};
    },
  };}
  const db={prepare:statement,batch:async entries=>{
    sqlite.exec('BEGIN');try{const result=[];for(const entry of entries)result.push(await entry.execute());sqlite.exec('COMMIT');return result;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
  return {db,sqlite};
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const noteId='a'.repeat(24), url=`https://www.xiaohongshu.com/explore/${noteId}?xsec_token=public_share_parameter`;
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
const imageUrls=Array.from({length:13},(_,index)=>`https://sns-webpic-qc.xhscdn.com/verified-note-image-${index+1}?signature=public`);
const imageUrl=imageUrls[0];

test('inbound endpoint accepts only a named exact HTTPS v2 endpoint',()=>{
  assert.equal(validInboundEndpoint('https://reader.example.com/v2/xhs/jobs'),true);
  for(const value of ['http://reader.example.com/v2/xhs/jobs','https://127.0.0.1/v2/xhs/jobs',
    'https://reader.example.com:8443/v2/xhs/jobs','https://reader.example.com/v1/resolve',
    'https://user:pass@reader.example.com/v2/xhs/jobs','https://reader.example.com/v2/xhs/jobs?path=other'])
    assert.equal(validInboundEndpoint(value),false,value);
});

test('Sites signs real v2 HTTP jobs, keeps ECS tokens server-side and rechecks exact media bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'beautyproof-inbound-contract-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
  const pair=generateKeyPairSync('ed25519'),{db,sqlite}=database();
  let server, calls=0, tamperStatus=false, tamperPath=false, tamperMedia=false;
  try{
    server=await createJobServer({publicKey:pair.publicKey,dataDirectory:join(root,'jobs'),execute:async(source,directory)=>{
      assert.equal(source,url);
      const evidence=join(directory,'evidence');
      await mkdir(join(evidence,'images'),{recursive:true});
      for(let index=0;index<imageUrls.length;index++)await writeFile(join(evidence,'images',`${index+1}.png`),image);
      const text='这是完整的公开正文，含有一项可核对的美妆成分。';
      return {ok:true,auditPassed:true,evidenceDirectory:evidence,result:{noteId,canonicalUrl:`https://www.xiaohongshu.com/explore/${noteId}`,
        title:'公开样本',text,textSha256:digest(Buffer.from(text)),type:'normal',imagesRole:'note_images',mediaStatus:'complete',sourceImageCount:imageUrls.length,
        images:imageUrls.map((sourceUrl,index)=>({index:index+1,url:sourceUrl,sha256:digest(image),bytes:image.length,width:1,height:1,frames:1,format:'PNG',file:`images/${index+1}.png`})),
        checkedAt:new Date().toISOString(),readerSha256:ANONYMOUS_READER_SHA,accountUsed:false,browserCookiesRead:false,cacheUsed:false,
        redirects:[{host:'www.xiaohongshu.com',path:`/explore/${noteId}`,status:200}]}};
    }});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const origin=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(origin+'/v2/xhs/jobs',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
    const transport=async(target,options)=>{
      calls++;const path=new URL(target).pathname;
      assert.equal(new URL(target).hostname,'reader.example.com');
      assert.equal(options.redirect,'error');
      const response=await fetch(origin+path,options);
      if(tamperStatus&&options.method==='GET'&&!path.includes('/media/')) {
        const body=await response.json();body.sourceUrl='https://www.xiaohongshu.com/explore/'+'b'.repeat(24);
        return Response.json(body);
      }
      if(tamperPath&&options.method==='GET'&&!path.includes('/media/')) {
        const body=await response.json();
        if(body.status==='complete')body.result.images[0].mediaPath='/v2/xhs/jobs/other/media/1';
        return Response.json(body);
      }
      if(tamperMedia&&path.includes('/media/'))return new Response(Buffer.from('changed image bytes'));
      return response;
    };
    let enabled=false;
    const config=()=>({enabled,endpoint:'https://reader.example.com/v2/xhs/jobs',
      privateKey:pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64')});
    const handlers=createInboundReaderHandlers({getDb:()=>db,getConfig:config,transport});
    const submit=()=>handlers.submit(new Request('https://site.example.com/api/reader-jobs',
      {method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'203.0.113.25'},body:JSON.stringify({url})}));
    assert.equal((await submit()).status,503);assert.equal(calls,0);
    enabled=true;
    const ticketResponse=await submit();assert.equal(ticketResponse.status,202);
    const ticket=await ticketResponse.json();assert.equal(ticket.status,'queued');
    const dbJob=sqlite.prepare('SELECT remote_id,remote_token,access_hash FROM anonymous_inbound_jobs WHERE id=?').get(ticket.jobId);
    assert.ok(dbJob.remote_id);assert.ok(dbJob.remote_token);assert.notEqual(ticket.accessToken,dbJob.remote_token);
    assert.equal(JSON.stringify(ticket).includes(dbJob.remote_token),false);
    assert.equal(dbJob.access_hash,digest(Buffer.from(ticket.accessToken)));
    const bad=await handlers.poll(new Request('https://site.example.com/api/reader-jobs/'+ticket.jobId,
      {headers:{authorization:'Bearer '+'x'.repeat(43)}}),ticket.jobId);assert.equal(bad.status,404);
    let final;
    for(let i=0;i<15;i++){
      const response=await handlers.poll(new Request('https://site.example.com/api/reader-jobs/'+ticket.jobId,
        {headers:{authorization:'Bearer '+ticket.accessToken}}),ticket.jobId);
      assert.equal(response.status,200);final=await response.json();if(final.status==='complete')break;
      await new Promise(done=>setTimeout(done,20));
    }
    assert.equal(final.status,'complete');assert.equal(final.result.extraction.pageText,'这是完整的公开正文，含有一项可核对的美妆成分。');
    assert.deepEqual(final.result.extraction.media.map(item=>item.url),imageUrls);
    assert.deepEqual(final.result.extraction.media.map(item=>item.sha256),imageUrls.map(()=>digest(image)));
    assert.equal(final.result.verification.sourceImageCount,13);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM anonymous_inbound_media').get().n,13);
    const stored=sqlite.prepare('SELECT remote_token,image_index,bytes FROM anonymous_inbound_media WHERE url_hash=? AND sha256=?')
      .get(digest(Buffer.from(imageUrl)),digest(image));
    assert.equal(stored.remote_token,dbJob.remote_token);assert.equal(stored.image_index,1);assert.equal(stored.bytes,image.length);
    const mediaRequest=new Request('https://site.example.com/api/media',{headers:{'cf-connecting-ip':'203.0.113.25'}});
    const returned=await handlers.media(mediaRequest,imageUrl,digest(image));
    assert.equal(returned.status,200);assert.deepEqual(Buffer.from(await returned.arrayBuffer()),image);
    assert.equal(returned.headers.get('X-Content-SHA256'),digest(image));
    assert.equal(await handlers.media(mediaRequest,imageUrl,'0'.repeat(64)),null);
    tamperMedia=true;
    assert.equal((await handlers.media(mediaRequest,imageUrl,digest(image))).status,502);
    tamperMedia=false;
    const second=await (await submit()).json();tamperStatus=true;
    const wrong=await handlers.poll(new Request('https://site.example.com/api/reader-jobs/'+second.jobId,
      {headers:{authorization:'Bearer '+second.accessToken}}),second.jobId);
    assert.equal((await wrong.json()).error.code,'invalid_worker_result');
    assert.equal(sqlite.prepare('SELECT status FROM anonymous_inbound_jobs WHERE id=?').get(second.jobId).status,'failed');
    tamperStatus=false;tamperPath=true;
    const third=await (await submit()).json();
    let badPath;
    for(let i=0;i<15;i++){
      badPath=await (await handlers.poll(new Request('https://site.example.com/api/reader-jobs/'+third.jobId,
        {headers:{authorization:'Bearer '+third.accessToken}}),third.jobId)).json();
      if(badPath.status==='failed')break;
      await new Promise(done=>setTimeout(done,20));
    }
    assert.equal(badPath.error.code,'invalid_worker_result');
  }finally{
    if(server)await new Promise(done=>server.close(done));sqlite.close();
    await rm(root,{recursive:true,force:true});
  }
});
