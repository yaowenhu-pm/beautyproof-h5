// RMB micro-yuan. Official peak cache-miss input/output: 2 / 8 RMB per 1M tokens, checked 2026-09-14.
export const BUDGET_MICROS=1_000_000, TEST_BUDGET_MICROS=600_000, MAX_OUTPUT_TOKENS=1200;
export const MODEL='deepseek-flash',MODEL_LABEL='DeepSeek V4.1 Flash';
export const PRICE_VERSION='deepseek-flash-2026-09-14-peak-2-8';
export const PRICE_VALID_UNTIL=Date.parse('2026-09-21T00:00:00+08:00');
export function reserveMicros(messages:unknown){return (new TextEncoder().encode(JSON.stringify(messages)).length+2048)*2+MAX_OUTPUT_TOKENS*8;}
export function accountedMicros(input:number,output:number){if(![input,output].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('invalid_usage');return input*2+output*8;}
export const reserveSql=`INSERT OR IGNORE INTO api_calls (cache_key,reserved_micros,status,purpose,created_at,price_version)
  SELECT ?,?,'reserved',?,?,? WHERE
  (SELECT COALESCE(SUM(COALESCE(charged_micros,reserved_micros)),0) FROM api_calls)+?<=?
  AND (?!='test' OR (SELECT COALESCE(SUM(COALESCE(charged_micros,reserved_micros)),0) FROM api_calls WHERE purpose='test')+?<=?)`;
