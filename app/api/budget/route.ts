import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/server/db';
import { BUDGET_MICROS, TEST_BUDGET_MICROS, PRICE_VERSION, PRICE_VALID_UNTIL } from '@/lib/shared/budget';
export async function GET(request:Request){
 const token=(env as unknown as {BEAUTYPROOF_TEST_TOKEN?:string}).BEAUTYPROOF_TEST_TOKEN;
 if(!token||request.headers.get('x-beautyproof-test')!==token)return Response.json({error:'需要管理员凭证'},{status:401});
 const totals=await getDb().prepare('SELECT purpose, status, COUNT(*) AS calls, SUM(COALESCE(charged_micros,reserved_micros)) AS accounted_micros, SUM(prompt_tokens) AS input_tokens, SUM(completion_tokens) AS output_tokens, SUM(cached_tokens) AS cached_tokens FROM api_calls GROUP BY purpose,status').all();
 return Response.json({cap_micros:BUDGET_MICROS,test_cap_micros:TEST_BUDGET_MICROS,price_version:PRICE_VERSION,price_valid_until:PRICE_VALID_UNTIL,totals:totals.results},{headers:{'Cache-Control':'no-store'}});
}
