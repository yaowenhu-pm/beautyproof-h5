import { env } from 'cloudflare:workers';
import { getDb } from './db';
import { BUDGET_MICROS, PRICE_VALID_UNTIL, reserveMicros, MODEL_LABEL } from '../shared/budget';
export async function serviceStatus(){
 const cfg=env as unknown as {DEEPSEEK_API_KEY?:string;BEAUTYPROOF_PAID_ENABLED?:string};
 const base={model:MODEL_LABEL,priceValidUntil:PRICE_VALID_UNTIL};
 if(!cfg.DEEPSEEK_API_KEY||cfg.BEAUTYPROOF_PAID_ENABLED!=='true')return {...base,available:false,code:'not_configured',message:'智能分析暂未开启。你可以保留内容，稍后再试。'};
 if(Date.now()>PRICE_VALID_UNTIL)return {...base,available:false,code:'price_expired',message:'智能分析暂时暂停，等待维护者复核服务价格。'};
 try{
  const totals=await getDb().prepare('SELECT COALESCE(SUM(COALESCE(charged_micros,reserved_micros)),0) AS used FROM api_calls').first<{used:number}>();
  if(BUDGET_MICROS-(totals?.used??0)<reserveMicros([]))return {...base,available:false,code:'budget_exhausted',message:'本轮演示额度已用完，暂不接受新的分析。'};
  return {...base,available:true,code:'ready',message:'可分析文字与已提取内容；链接读取受平台限制。'};
 }catch{return {...base,available:false,code:'storage_unavailable',message:'服务暂时不可用，请保留输入内容。'};}
}
