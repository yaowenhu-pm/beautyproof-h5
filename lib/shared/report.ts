import { findIngredients, KB_VERSION, type Evidence } from './knowledge.ts';
export const REPORT_VERSION='2.0';
export type Finding={quote:string;judgment:'supported'|'risk'|'insufficient'|'context';reason:string;citations:string[]};
export type ReportV2={version:string;kbVersion:string;status:'complete'|'unavailable'|'insufficient';summary:string;findings:Finding[];sources:Evidence[];ingredients:(ReturnType<typeof findIngredients>[number]&{origin:'label'|'mentioned'})[];scope:string[];note:string;cached?:boolean};
export const reportNote='仅核对已取得内容的宣传依据，不鉴定实物真假，不替代成品功效评价、实验室检测或医疗意见。';
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
    const f=candidate as Finding;
    if(typeof f.quote!=='string'||f.quote.length<2||f.quote.length>300||!text.includes(f.quote)||!['supported','risk','insufficient','context'].includes(f.judgment)||typeof f.reason!=='string'||f.reason.length<4||f.reason.length>600||!Array.isArray(f.citations)||f.citations.some(id=>typeof id!=='string'||!base.sources.some(s=>s.id===id)))throw new Error('unverified_finding');
    if(['risk','supported'].includes(f.judgment)&&!f.citations.length)throw new Error('missing_evidence');
    if(!findings.some(x=>x.quote===f.quote&&x.judgment===f.judgment))findings.push({quote:f.quote,judgment:f.judgment,reason:f.reason,citations:[...new Set(f.citations)]});
  }
  if(!findings.length)return {...base,summary:'未提取到可核验的具体宣称'};
  return {...base,status:'complete',summary:v.summary,findings};
}
