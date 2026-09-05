import { findIngredients, KB_VERSION, type Evidence } from './knowledge.ts';
export const REPORT_VERSION='2.0';
export type Finding={quote:string;judgment:'supported'|'risk'|'insufficient'|'context';reason:string;citations:string[]};
export type ReportV2={version:string;kbVersion:string;status:'complete'|'unavailable'|'insufficient';summary:string;findings:Finding[];sources:Evidence[];ingredients:(ReturnType<typeof findIngredients>[number]&{origin:'label'|'mentioned'})[];scope:string[];note:string;cached?:boolean};
export const reportNote='仅核对已取得内容的宣传依据，不鉴定实物真假，不替代成品功效评价、实验室检测或医疗意见。';
export function alignQuote(quote:string,text:string){
  if(text.includes(quote))return quote;
  const compact=(value:string)=>{let normalized='';const spans:{start:number;end:number}[]=[];let offset=0;for(const ch of value){const next=offset+ch.length;const token=ch.normalize('NFKC').replace(/[“”「」『』]/g,'"').replace(/。/g,'.');if(!/\s/u.test(ch))for(const c of token){normalized+=c;for(let i=0;i<c.length;i++)spans.push({start:offset,end:next});}offset=next;}return {normalized,spans};};
  const source=compact(text),wanted=compact(quote).normalized;
  if(wanted.length<4)return null;
  const index=source.normalized.indexOf(wanted);
  if(index<0||source.normalized.indexOf(wanted,index+1)>=0)return null;
  return text.slice(source.spans[index].start,source.spans[index+wanted.length-1].end);
}
export function baseReport(text:string,labelText:string,sources:Evidence[],scope:string[]):ReportV2 {
  const labels=findIngredients(labelText);
  return {version:REPORT_VERSION,kbVersion:KB_VERSION,status:'insufficient',summary:'证据不足，暂无法判断',findings:[],sources,scope,note:reportNote,ingredients:findIngredients(text).map(item=>({...item,origin:labels.some(i=>i.id===item.id)?'label':'mentioned'}))};
}
export function validateReport(raw:unknown,base:ReportV2,text:string):ReportV2 {
  if(!raw||typeof raw!=='object')throw new Error('invalid_report');
  const v=raw as Record<string,unknown>;
  if(typeof v.summary!=='string'||!v.summary.trim()||v.summary.length>180||!Array.isArray(v.findings)||v.findings.length>3)throw new Error('invalid_report');
  const findings:Finding[]=[];
  for(const candidate of v.findings){
    if(!candidate||typeof candidate!=='object')throw new Error('invalid_finding');
    const f={...candidate} as Finding;
    if(typeof f.quote==='string')f.quote=alignQuote(f.quote,text)??f.quote;
    if(typeof f.quote!=='string'||f.quote.length<2||f.quote.length>300||!text.includes(f.quote)||!['supported','risk','insufficient','context'].includes(f.judgment)||typeof f.reason!=='string'||f.reason.length<4||f.reason.length>600||!Array.isArray(f.citations)||f.citations.some(id=>typeof id!=='string'||!base.sources.some(s=>s.id===id)))throw new Error('unverified_finding');
    if(['risk','supported'].includes(f.judgment)&&!f.citations.length)throw new Error('missing_evidence');
    // This initial knowledge base contains no product-specific efficacy evidence.
    if(f.judgment==='supported')throw new Error('efficacy_evidence_not_available');
    if(f.judgment==='risk'&&/香皂|硫磺皂/.test(f.quote)&&!f.citations.includes('CN-AD11'))throw new Error('soap_requires_advertising_law');
    if(/资料未否定|未发现反证/.test(f.reason))throw new Error('absence_is_not_evidence');
    if(!findings.some(x=>x.quote===f.quote&&x.judgment===f.judgment))findings.push({quote:f.quote,judgment:f.judgment,reason:f.reason,citations:[...new Set(f.citations)]});
  }
  if(!findings.length)return {...base,summary:'未提取到可核验的具体宣称'};
  return {...base,status:'complete',summary:v.summary.replace(/判断为context[。.]?/g,'属于辟谣或语境说明。'),findings};
}
