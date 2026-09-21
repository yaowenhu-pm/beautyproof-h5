// Synthetic/offline fixtures. Never sends network requests or calls an AI model.
import assert from 'node:assert/strict';
import { extractShareUrl, contentIdFor, platformFor, parseState, xhsNote, douyinNote } from '../lib/shared/links.ts';
import { parseLinkPage, meta } from '../lib/shared/link-page.ts';
import { resolveLink, resolverTtl } from '../lib/server/link-resolver.ts';
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }
const x = new URL('https://www.xiaohongshu.com/explore/AAA?xsec_token=test%2Bvalue%3D&xsec_source=pc_feed');
const d = new URL('https://www.douyin.com/video/123');
const state = data => `<script>window.__INITIAL_STATE__ = ${JSON.stringify(data)};</script>`;
const xstate = (note, id = 'AAA') => state({ note: { currentNoteId: id, noteDetailMap: { [id]: { note } } } });
const router = data => `<script>window._ROUTER_DATA = ${JSON.stringify(data)};</script>`;
const parse = html => parseLinkPage(html, 'xiaohongshu', x, x);
const response = (html, status = 200, headers = {}) => new Response(html, { status, headers: { 'content-type': 'text/html', ...headers } });
const mocked = async (url, list) => { let calls = 0; const result = await resolveLink(new URL(url), platformFor(new URL(url)), async input => { const spec = list[calls++]; assert.ok(spec, 'Unexpected extra request'); return typeof spec === 'function' ? spec(input) : spec; }); return { result, calls }; };

await test('Chinese adjacent share text', () => assert.equal(extractShareUrl('推荐 https://xhslink.cn/o/test美妆'), 'https://xhslink.cn/o/test'));
await test('Douyin short link punctuation', () => assert.equal(extractShareUrl('打开 https://v.douyin.com/abc/）'), 'https://v.douyin.com/abc/'));
await test('HTML and Markdown query escaping', () => assert.equal(extractShareUrl(String.raw`https://www.xiaohongshu.com/explore/AAA?xsec_token=a%2Bb=&amp;xsec\_source=pc\&foo=bar`), 'https://www.xiaohongshu.com/explore/AAA?xsec_token=a%2Bb=&xsec_source=pc&foo=bar'));
await test('home before work is ignored', () => assert.equal(extractShareUrl('https://www.xiaohongshu.com/ ' + x.href), x.href));
await test('two different works are rejected', () => assert.equal(extractShareUrl(x.href + ' ' + d.href), ''));
await test('duplicate URL in Markdown accepted', () => assert.equal(extractShareUrl(`[${x.href}](${x.href})`), x.href));
await test('forbidden hosts and userinfo', () => { for (const url of ['https://xiaohongshu.com.evil.test/explore/a','https://user@xhslink.cn/a','https://xhslink.cn:444/a']) assert.equal(extractShareUrl(url), ''); });
await test('Douyin slides and modal id', () => { assert.equal(contentIdFor('douyin',new URL('https://www.iesdouyin.com/share/slides/123/')),'123'); assert.equal(contentIdFor('douyin',new URL('https://www.douyin.com/?modal_id=456')),'456'); });
await test('unsigned home is not a work', () => assert.equal(extractShareUrl('https://www.douyin.com/'),''));
await test('undefined string preserved', () => assert.deepEqual(parseState('<script>__INITIAL_STATE__={"a":undefined,"quote":"keep: undefined, exact"}</script>'),{a:null,quote:'keep: undefined, exact'}));
await test('marker mention before actual assignment', () => assert.equal(parseState('<script>var a="__INITIAL_STATE__";</script>'+state({ok:true})).ok,true));
await test('no page code execution', () => assert.equal(parseState('<script>__INITIAL_STATE__={"a":alert(1)}</script>'),null));
await test('nested strings with brace and quote', () => assert.equal(parseState(state({a:{b:'} hi "'}})).a.b,'} hi "'));
await test('XHS exact detail and author', () => { const r=parse(xstate({noteId:'AAA',title:'面霜',desc:'保湿',user:{nickname:'作者'}})); assert.equal(r.contentStatus,'body'); assert.equal(r.author,'作者'); });
await test('keyed map conflicting ID rejected', () => assert.equal(xhsNote(xstate({noteId:'BBB',desc:'other'}),'AAA'),null));
await test('unkeyed missing identity rejected', () => assert.equal(xhsNote(state({noteData:{data:{noteData:{desc:'unknown'}}}}),'AAA'),null));
await test('H5 global note exact ID', () => assert.equal(xhsNote(state({global:{noteData:{data:{noteData:{noteId:'AAA',desc:'ok'}}}}}),'AAA').desc,'ok'));
await test('canonical cannot replace original work', () => assert.equal(parse('<link href="/explore/BBB" rel="canonical">'+xstate({noteId:'BBB',desc:'other'},'BBB')).reasonCode,'identity_mismatch'));
await test('redirect cannot replace original work', () => assert.equal(parseLinkPage(xstate({noteId:'BBB',desc:'other'},'BBB'),'xiaohongshu',x,new URL('https://www.xiaohongshu.com/explore/BBB')).reasonCode,'identity_mismatch'));
await test('wrong state cannot fall back to OG meta', () => assert.equal(parse('<meta property="og:title" content="other">'+xstate({noteId:'BBB',desc:'other'},'BBB')).resolved,false));
await test('normal body gate words are not blocked', () => assert.equal(parse(xstate({noteId:'AAA',title:'记录美好生活',desc:'登录后查看是页面提示，不是产品功效'})).resolved,true));
await test('exact app-only gate', () => assert.equal(parse('<main>当前内容仅支持在小红书 APP 内查看</main>').reasonCode,'app_only'));
await test('captcha route never supplies content', () => { const r=parseLinkPage(xstate({noteId:'AAA',desc:'do not use'}),'xiaohongshu',x,new URL('https://www.xiaohongshu.com/website-login/captcha'));assert.equal(r.reasonCode,'captcha');assert.equal(r.extraction.pageText,'');assert.equal(r.contentId,'AAA'); });
await test('login body classified', () => assert.equal(parse('<main>请先登录</main>').reasonCode,'login_required'));
await test('404 is not a successful title', () => assert.equal(parseLinkPage('<title>404</title>','xiaohongshu',x,x,404).reasonCode,'not_found'));
await test('rate limit classified', () => assert.equal(parseLinkPage('','xiaohongshu',x,x,429).reasonCode,'rate_limited'));
await test('upstream 5xx cannot look successful', () => assert.equal(parseLinkPage(xstate({noteId:'AAA',desc:'old'}),'xiaohongshu',x,x,502).resolved,false));
await test('JS challenge is not content', () => assert.equal(parseLinkPage('<script>var a; window._$jsvmprt=function(){};</script>','douyin',d,d).reasonCode,'browser_required'));
await test('plain denial is not invented captcha', () => assert.equal(parseLinkPage('Forbidden','douyin',d,d,403).reasonCode,'access_denied'));
await test('meta attribute quotes and order', () => assert.equal(meta(`<meta content="It's 保湿 &amp; 清洁" property='og:title'>`,'og:title'),"It's 保湿 & 清洁"));
await test('meta-only content is partial', () => { const r=parse('<meta name="description" content="保湿面霜">');assert.equal(r.contentStatus,'title_only');assert.equal(r.extraction.textStatus,'partial'); });
await test('Douyin empty target cannot match anonymous object', () => assert.equal(douyinNote(router({desc:'other'}),''),null));
await test('Douyin router selects exact id', () => assert.equal(douyinNote(router([{aweme_id:'456',desc:'other'},{aweme_id:'123',desc:'target'}]),'123').desc,'target'));
await test('Douyin render works alongside empty router', () => { const html=router({})+`<script id="RENDER_DATA">${encodeURIComponent(JSON.stringify({awemeId:'123',desc:'target'}))}</script>`;assert.equal(douyinNote(html,'123').desc,'target'); });
await test('Douyin JSON hydration exact identity', () => assert.equal(douyinNote('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"item":{"aweme_id":"123","desc":"body"}}</script>','123').desc,'body'));
await test('Douyin image note supported', () => { const r=parseLinkPage(router({aweme_id:'123',images:[{url_list:['https://p.douyinpic.com/a.jpg']}]}),'douyin',d,d);assert.equal(r.contentStatus,'media_only');assert.equal(r.extraction.media[0].type,'image');assert.equal(r.extraction.pageText,''); });
await test('Douyin camelCase video URL and no duplicated desc', () => { const r=parseLinkPage(router({awemeId:'123',desc:'body',video:{playAddr:{urlList:['https://v.douyinvod.com/a.mp4']}}}),'douyin',d,d);assert.equal(r.extraction.pageText,'body');assert.equal(r.extraction.media[0].type,'video'); });
await test('XHS image and video variants', () => { const r=parse(xstate({noteId:'AAA',desc:'body',imageList:[{urlDefault:'https://img.xhscdn.com/a.jpg'}],video:{media:{stream:{h264:[{masterUrl:'https://sns-video.xhscdn.com/a.mp4'}]}}}}));assert.deepEqual(r.extraction.media.map(v=>v.type),['video','image']); });
await test('metadata on unknown route is not content', () => assert.equal(parseLinkPage('<meta property="og:title" content="random">','douyin',new URL('https://v.douyin.com/abc/'),new URL('https://v.douyin.com/abc/')).resolved,false));
await test('only verified full bodies receive a five minute cache', () => {
 assert.equal(resolverTtl(parse(xstate({noteId:'AAA',desc:'body'}))),300000);
 for(const result of [{resolved:false},{resolved:true},parse('<meta property="og:title" content="title">'),{resolved:true,reasonCode:'media_only'}])assert.equal(resolverTtl(result),10000);
});
await test('signed URL reaches upstream unchanged', async () => {const {result}=await mocked(x,[url=>{assert.equal(url.href,x.href);return response(xstate({noteId:'AAA',desc:'body'}));}]);assert.equal(result.resolved,true);assert.ok(!JSON.stringify(result.diagnostics).includes('test%2Bvalue'));});
await test('short redirect keeps identity and stops before error page', async () => {const {result,calls}=await mocked('https://xhslink.cn/o/test',[response('',302,{location:x.href}),response('',302,{location:'/404/sec_demo'})]);assert.equal(calls,2);assert.equal(result.contentId,'AAA');assert.equal(result.reasonCode,'not_found');assert.equal(result.canonicalUrl,'https://www.xiaohongshu.com/explore/AAA');});
await test('redirect outside platform is not fetched', async () => {const {result,calls}=await mocked(x,[response('',302,{location:'http://127.0.0.1/private'})]);assert.equal(result.reasonCode,'invalid_redirect');assert.equal(calls,1);});
await test('redirect to another work stops before fetch', async () => {const {result,calls}=await mocked(x,[response('',302,{location:'/explore/BBB'})]);assert.equal(result.reasonCode,'identity_mismatch');assert.equal(calls,1);});
await test('timeout classification and no retry', async () => {const {result,calls}=await mocked(x,[()=>{throw new DOMException('timeout','TimeoutError');}]);assert.equal(result.reasonCode,'timeout');assert.equal(calls,1);});
await test('network failure does not become gate', async () => {const {result}=await mocked(x,[()=>{throw new TypeError('fetch failed');}]);assert.equal(result.reasonCode,'network_error');});
await test('oversized HTML is bounded', async () => {const {result}=await mocked(x,[response('x'.repeat(2_000_001))]);assert.equal(result.reasonCode,'unsupported_page');});
await test('non-HTML rejected', async () => {const {result}=await mocked(x,[new Response('{}',{headers:{'content-type':'application/json'}})]);assert.equal(result.reasonCode,'unsupported_page');});
await test('HTTP 401 classified without parsing', async () => {const {result}=await mocked(x,[response('',401)]);assert.equal(result.reasonCode,'login_required');});
await test('redirect limit bounded', async () => {const {result,calls}=await mocked('https://xhslink.cn/o/test',Array.from({length:6},()=>response('',302,{location:'/o/loop'})));assert.equal(result.reasonCode,'invalid_redirect');assert.equal(calls,6);});
await test('XHS alternate id mismatch rejected',()=>assert.equal(parse(xstate({id:'BBB',desc:'other'})).resolved,false));
await test('OG identity cannot disagree with canonical',()=>assert.equal(parse('<link rel="canonical" href="/explore/AAA"><meta property="og:url" content="https://www.xiaohongshu.com/explore/BBB"><meta property="og:title" content="other">').reasonCode,'identity_mismatch'));
await test('prefer supported CDN among play alternatives',()=>{const r=parseLinkPage(router({aweme_id:'123',video:{play_addr:{url_list:['https://www.iesdouyin.com/aweme/v1/play','https://v.douyinvod.com/a.mp4']}}}),'douyin',d,d);assert.equal(r.extraction.media[0].url,'https://v.douyinvod.com/a.mp4');});
await test('HTTP404 with stale embedded state cannot succeed',()=>assert.equal(parseLinkPage(xstate({noteId:'AAA',desc:'body'}),'xiaohongshu',x,x,404).resolved,false));
await test('HTTP403 with stale embedded state cannot succeed',()=>assert.equal(parseLinkPage(xstate({noteId:'AAA',desc:'body'}),'xiaohongshu',x,x,403).resolved,false));
await test('hidden login form is not a captcha gate',()=>assert.equal(parse('<meta property="og:title" content="保湿面霜"><aside hidden aria-hidden="true"><label>验证码</label></aside>').contentStatus,'title_only'));
await test('empty Map placeholders do not discard the target body',()=>{
 const html='<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"AAA":{"note":{"noteId":"AAA","desc":"成分保湿"}}}},"cache":new Map([]),"other":undefined}</script>';
 assert.equal(parse(html).description,'成分保湿');
 assert.deepEqual(parseState(html).cache,[]);
});
await test('literal text and arbitrary JavaScript are never rewritten or run',()=>{
 const desc='new Map([]) / undefined / new Map([1])';
 assert.equal(parse(xstate({noteId:'AAA',desc})).description,desc);
 for(const value of ['new Map([1])','new Map(alert(1))','(()=>({}))()'])assert.equal(parseState('<script>__INITIAL_STATE__={"cache":'+value+'}</script>'),null);
});
await test('whitespace-only empty Map is supported',()=>assert.deepEqual(parseState('<script>__INITIAL_STATE__={"cache":new Map ( [ ] )}</script>'),{cache:[]}));
await test('last state assignment wins, not early empty bootstrap',()=>{
 assert.equal(parse(state({note:{}})+xstate({noteId:'AAA',desc:'later body'})).description,'later body');
 assert.equal(parse(xstate({noteId:'AAA',desc:'stale'})+state({note:{}})).resolved,false);
});
await test('opaque map keys only match explicit requested identity',()=>{
 const html=state({note:{noteDetailMap:{opaque:{note:{noteId:'AAA',desc:'target'}},recommended:{note:{noteId:'BBB',desc:'other'}}}}});
 assert.equal(parse(html).description,'target');
 assert.equal(parse(xstate({desc:'missing ID'})).resolved,false);
});
await test('ambiguous or conflicting map identities fail closed',()=>{
 const html=state({note:{noteDetailMap:{a:{note:{noteId:'AAA',desc:'one'}},b:{note:{noteId:'AAA',desc:'two'}}}}});
 assert.equal(parse(html).resolved,false);
 assert.equal(parse(xstate({noteId:'AAA',id:'BBB',desc:'conflict'})).resolved,false);
});
await test('matching stale state on a feed or profile cannot count as a work',()=>{
 for(const route of ['/explore','/','/user/profile/abc','/404']){
  const r=parseLinkPage(xstate({noteId:'AAA',desc:'cached target'}),'xiaohongshu',x,new URL(route,x));
  assert.equal(r.resolved,false);assert.equal(r.extraction.pageText,'');
 }
});
await test('lost work identity is not followed to a feed',async()=>{
 const {result,calls}=await mocked(x,[response('',302,{location:'/explore'})]);
 assert.equal(result.reasonCode,'unsupported_page');assert.equal(calls,1);assert.equal(result.contentId,'AAA');
});
await test('shortlink profile and explicit login paths stop before follow',async()=>{
 for(const [path,reason] of [['/user/profile/abc','unsupported_page'],['/auth/signin','login_required'],['/404','not_found']]){
  const {result,calls}=await mocked('https://xhslink.cn/o/test',[response('',302,{location:'https://www.xiaohongshu.com'+path})]);
  assert.equal(result.reasonCode,reason);assert.equal(calls,1);
 }
});
await test('desktop document headers retain the original share query',async()=>{
 const r=await resolveLink(x,'xiaohongshu',async(url,options)=>{
  assert.equal(url.href,x.href);assert.ok(!options.headers['User-Agent'].includes('Mobile'));
  assert.equal(options.headers.Referer,'https://www.xiaohongshu.com/');assert.equal(options.redirect,'manual');
  return response(xstate({noteId:'AAA',desc:'body'}));
 });assert.equal(r.contentStatus,'body');assert.equal(r.resolverVersion,'3.4');
});
await test('explicit visible gates override stale matching hydration state',()=>{
 for(const [text,code] of [['请先登录后查看','login_required'],['请完成安全验证','captcha'],['仅支持在小红书 App 内查看','app_only'],['访问频繁，请稍后再试','rate_limited']]) {
  const result=parse(`<main>${text}</main>`+xstate({noteId:'AAA',desc:'old body'}));
  assert.equal(result.reasonCode,code);assert.equal(result.resolved,false);
 }
});
await test('hidden gates, navigation and author discussion are not access denials',()=>{
 for(const markup of ['<button>登录</button>','<aside hidden>请完成安全验证</aside>','<div style="display: none">请先登录后查看</div>','<main>作者说登录后查看是页面提示，不是产品功效</main>']) {
  assert.equal(parse(markup+xstate({noteId:'AAA',desc:'body'})).reasonCode,'ok');
 }
});
const cloudParser=await import('../ops/cloud-reader/lib/shared/link-page.mjs');
await test('cloud generated parser matches the source parser for regression fixtures',()=>{
 for(const html of [
  '<script>__INITIAL_STATE__={"note":{"noteDetailMap":{"AAA":{"note":{"noteId":"AAA","desc":"body"}}}},"cache":new Map([])}</script>',
  xstate({noteId:'AAA',desc:'old'})+xstate({noteId:'AAA',desc:'new'}),
  xstate({noteId:'BBB',desc:'wrong'}),'<main>请先登录后查看</main>'+xstate({noteId:'AAA',desc:'old'}),
 ])for(const path of [x.href,'https://www.xiaohongshu.com/explore']) {
  const a=parseLinkPage(html,'xiaohongshu',x,new URL(path));
  const b=cloudParser.parseLinkPage(html,'xiaohongshu',x,new URL(path));
  assert.deepEqual({...a,fetchedAt:null},{...b,fetchedAt:null});
 }
});
const j = new URL('https://jingxuan.douyin.com/m/video/123');
const ssr = value => `<script>window._SSR_DATA = ${JSON.stringify({data:{storeState:{detail:{videoData:{result:value}}}}})};</script>`;
const summaryHtml=ssr({gid:'123',title:'面霜推荐',abstract:'含甘油的保湿面霜'});
await test('Jingxuan exact host and video identity',()=>{
 assert.equal(extractShareUrl(j.href),j.href);assert.equal(contentIdFor('douyin',j),'123');
 assert.equal(platformFor(new URL('https://jingxuan.douyin.com.evil.test/m/video/123')),null);
});
await test('Jingxuan summary can never become body or media',()=>{
 const r=parseLinkPage(summaryHtml,'douyin',d,j);
 assert.equal(r.resolved,true);assert.equal(r.reasonCode,'metadata_only');assert.equal(r.contentStatus,'title_only');
 assert.equal(r.extraction.textStatus,'partial');assert.deepEqual(r.extraction.media,[]);
 assert.equal(r.extraction.pageText,'面霜推荐\n含甘油的保湿面霜');assert.ok(r.limitation.includes('未取得完整文案'));
 assert.equal(resolverTtl(r),10000);
});
await test('Jingxuan missing, numeric or conflicting identity never falls back',()=>{
 for(const value of [{abstract:'text'},{gid:123,abstract:'text'},{gid:'456',abstract:'text'},{gid:'123',aweme_id:'456',abstract:'text'}]) {
  const r=parseLinkPage(ssr(value)+'<meta property="og:description" content="other">','douyin',d,j);
  assert.equal(r.resolved,false);assert.equal(r.extraction.pageText,'');
 }
});
await test('Jingxuan empty or non-string abstract is not a successful title',()=>{
 for(const abstract of ['', '  ', null, [], {}, 123]) assert.equal(parseLinkPage(ssr({gid:'123',title:'title',abstract}),'douyin',d,j).resolved,false);
});
await test('Jingxuan gates and status override matching SSR',()=>{
 for(const status of [401,403,404,429,503])assert.equal(parseLinkPage(summaryHtml,'douyin',d,j,status).resolved,false);
 assert.equal(parseLinkPage('<main>请完成安全验证</main>'+summaryHtml,'douyin',d,j).reasonCode,'captcha');
 assert.equal(parseLinkPage(summaryHtml,'douyin',d,new URL('https://jingxuan.douyin.com/')).resolved,false);
});
await test('known video selects summary first, without requesting a private detail API',async()=>{
 const {result,calls}=await mocked(d,[url=>{assert.equal(url.href,j.href);return response(summaryHtml);}]);
 assert.equal(calls,1);assert.equal(result.reasonCode,'metadata_only');assert.equal(result.canonicalUrl,d.href);
});
await test('short share resolves same work then selects public summary once',async()=>{
 const {result,calls}=await mocked('https://v.douyin.com/test/',[response('',302,{location:'https://www.iesdouyin.com/share/video/123/?share=example'}),url=>{assert.equal(url.href,j.href);return response(summaryHtml);}]);
 assert.equal(calls,2);assert.equal(result.contentId,'123');assert.equal(result.reasonCode,'metadata_only');
});
await test('note slides and modal routes do not infer a video',async()=>{
 for(const url of ['https://www.douyin.com/note/123','https://www.iesdouyin.com/share/slides/123/','https://www.douyin.com/?modal_id=123']){
  const {result,calls}=await mocked(url,[actual=>{assert.equal(actual.href,url);return response(router({aweme_id:'123',desc:'original body'}));}]);
  assert.equal(calls,1);assert.equal(result.contentStatus,'body');
 }
});
await test('summary rejection, missing state and redirect never retry elsewhere',async()=>{
 for(const first of [response('',401),response('',403),response('',429),response('<meta property="og:title" content="no identity">'),response('',302,{location:d.href}),response('',302,{location:j.href+'?loop=1'})]){
  const {result,calls}=await mocked(d,[first]);assert.equal(result.resolved,false);assert.equal(calls,1);
 }
});
await test('summary gate redirects are classified before route conversion',async()=>{
 for(const [path,reason] of [['/login','login_required'],['/captcha','captcha'],['/video/456','identity_mismatch']]){
  const {result,calls}=await mocked(d,[response('',302,{location:'https://www.douyin.com'+path})]);
  assert.equal(result.reasonCode,reason);assert.equal(calls,1);assert.equal(result.contentId,'123');
 }
});
await test('summary generated cloud parser matches source',()=>{
 for(const html of [summaryHtml,ssr({gid:'456',abstract:'other'}),ssr({gid:'123',abstract:''})]) {
  const a=parseLinkPage(html,'douyin',d,j),b=cloudParser.parseLinkPage(html,'douyin',d,j);
  assert.deepEqual({...a,fetchedAt:null},{...b,fetchedAt:null});
 }
});
console.log(`${passed} offline link checks passed. Zero network requests / model calls.`);
