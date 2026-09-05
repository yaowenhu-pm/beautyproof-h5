export type Platform='xiaohongshu'|'douyin';
export const platformHosts:Record<Platform,Set<string>>={
 xiaohongshu:new Set(['xiaohongshu.com','www.xiaohongshu.com','xhslink.com','www.xhslink.com','xhslink.cn','www.xhslink.cn','xhs.cn','www.xhs.cn']),
 douyin:new Set(['douyin.com','www.douyin.com','v.douyin.com','iesdouyin.com','www.iesdouyin.com'])
};
export function platformFor(url:URL):Platform|null{
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return null;
 for(const p of ['xiaohongshu','douyin'] as const)if(platformHosts[p].has(url.hostname.toLowerCase()))return p;
 return null;
}
export function extractShareUrl(value:string){
 const candidates=value.match(/https?:\/\/[^\s<>"“”「」【】\u4e00-\u9fff]+/gi)??[];
 for(const raw of candidates){try{const u=new URL(raw.replace(/[，。；、!！?？)）\]】…]+$/g,''));if(u.protocol==='http:')u.protocol='https:';if(platformFor(u))return u.toString();}catch{}}
 return '';
}
export function contentIdFor(platform:Platform,url:URL){return platform==='douyin' ? url.pathname.match(/\/(?:video|note|share\/video)\/(\d+)/)?.[1]??url.searchParams.get('modal_id')??'' : url.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/)?.[1]??'';}
export function parseState(html:string,marker='__INITIAL_STATE__'):Record<string,unknown>|null {
 const start=html.indexOf(marker);if(start<0)return null;
 const open=html.indexOf('{',start+marker.length);if(open<0)return null;
 let depth=0,quoted=false,escape=false;
 for(let i=open;i<Math.min(html.length,open+2_000_000);i++){
  const c=html[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}
  if(c==='"'){quoted=true;continue;}if(c==='{')depth++;if(c==='}'&&--depth===0){try{return JSON.parse(html.slice(open,i+1).replace(/([:\[,]\s*)undefined(?=\s*[,}\]])/g,'$1null'));}catch{return null;}}
 }return null;
}
type RecordValue=Record<string,unknown>;
const rec=(v:unknown):RecordValue|undefined=>v&&typeof v==='object'&&!Array.isArray(v)?v as RecordValue:undefined;
export function xhsNote(html:string,id=''){
 const s=parseState(html);if(!s)return null;
 const n=rec(s.note), map=rec(n?.noteDetailMap);
 if(map){const wanted=id||String(n?.currentNoteId??'');const entry=rec(map[wanted]);const note=rec(entry?.note);if(note)return note;}
 const nd=rec(s.noteData)??rec(rec(s.global)?.noteData), note=rec(rec(nd?.data)?.noteData);
 if(note&&(!id||!note.noteId||note.noteId===id))return note;
 return null;
}
export function douyinNote(html:string,id:string){
 let state:unknown=parseState(html,'_ROUTER_DATA');
 if(!state){const raw=html.match(/<script[^>]*id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];if(raw)try{state=JSON.parse(decodeURIComponent(raw));}catch{}}
 const queue:unknown[]=[state];let count=0;
 while(queue.length&&count++<5000){const v=queue.shift(),r=rec(v);if(r){if(String(r.aweme_id??r.awemeId??'')===id&&(r.desc||r.video))return r;queue.push(...Object.values(r));}else if(Array.isArray(v))queue.push(...v);}
 return null;
}
