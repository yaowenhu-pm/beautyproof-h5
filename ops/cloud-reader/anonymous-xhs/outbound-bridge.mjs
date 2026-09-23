import {createPrivateKey, randomUUID, sign} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {pythonExecutor, validateUrl} from './job-server.mjs';
import {createLocalTransport} from './local-transport.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export function endpointUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search || url.pathname !== '/api/reader-jobs/worker') throw new Error('invalid_worker_endpoint');
  return url.href;
}
export function makeCloudClient(endpoint, privateKey, transport = fetch) {
  endpoint = endpointUrl(endpoint);
  return async payload => {
    const body=JSON.stringify({nonce:randomUUID(),...payload}),timestamp=String(Date.now());
    if(Buffer.byteLength(body)>100000)throw new Error('result_too_large');
    const response=await transport(endpoint,{method:'POST',redirect:'error',body,signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',
      'x-reader-timestamp':timestamp,'x-reader-signature':sign(null,Buffer.from(`${timestamp}\n${body}`),privateKey).toString('base64')}});
    if([401,403,404].includes(response.status))throw Object.assign(new Error('worker_endpoint_rejected'),{terminal:true,status:response.status});
    if(!response.ok)throw Object.assign(new Error('worker_http_error'),{status:response.status});
    const raw=await response.text();if(raw.length>20000)throw new Error('invalid_worker_response');
    return JSON.parse(raw);
  };
}

const errorMessage = code => ({unavailable_or_login:'平台要求登录、验证或暂不允许浏览。',note_unavailable:'平台提示该内容暂时无法查看。',timeout:'正文或完整图片读取超时。',upstream_cooldown:'平台访问失败后正在冷却。'}[code] || '未能完整验证这条内容的正文和全部图片。');
export async function processClaim(job,{cloud,localRequest,pollDelayMs=1500,deadlineMs=310000,heartbeatMs=20000}={}) {
  if(!job||typeof job.id!=='string'||!/^[a-f\d-]{36,64}$/i.test(job.id)||typeof job.claimToken!=='string'||!/^[a-f\d-]{36}$/i.test(job.claimToken))throw new Error('invalid_claim');
  validateUrl(job.url);
  const submit=await localRequest('POST','/v2/xhs/jobs',{requestId:randomUUID(),url:job.url});
  if(submit.status!==202)throw new Error('local_submission_failed');
  const ticket=await submit.json(),started=Date.now();let completed,heartbeatFailure;
  let heartbeatInFlight=false;
  const heartbeat=setInterval(()=>{
    if(heartbeatInFlight)return;
    heartbeatInFlight=true;
    void cloud({action:'heartbeat'}).catch(error=>{if(error.terminal)heartbeatFailure=error;}).finally(()=>{heartbeatInFlight=false;});
  },heartbeatMs);
  try {
    while(Date.now()-started<deadlineMs) {
      const response=await localRequest('GET',`/v2/xhs/jobs/${ticket.jobId}`,undefined,ticket.jobToken);
      if(response.status!==200)throw new Error('local_poll_failed');
      const state=await response.json();
      if(state.status==='complete'||state.status==='failed'){completed=state;break;}
      await sleep(pollDelayMs);
    }
  } finally {clearInterval(heartbeat);}
  if(heartbeatFailure)throw heartbeatFailure;
  const status=completed?.status==='complete'?'complete':'failed';
  const payload={action:'complete',id:job.id,claimToken:job.claimToken,sourceUrl:job.url,status,
    ...(status==='complete'?{result:completed.result}:{error:{code:completed?.error||'timeout',message:errorMessage(completed?.error||'timeout')}})};
  // Retransmit only an already obtained result; never start another platform read.
  try {await cloud(payload);} catch(error) {
    if(error.terminal||[400,409,410,422].includes(error.status))throw error;
    await sleep(2000);await cloud(payload);
  }
  return {id:job.id,status,error:payload.error?.code};
}

export async function main() {
  const here=fileURLToPath(new URL('.',import.meta.url));
  const encoded=process.env.READER_PRIVATE_KEY||'';
  const privateKey=encoded.includes('BEGIN')?createPrivateKey(encoded):createPrivateKey({key:Buffer.from(encoded,'base64'),type:'pkcs8',format:'der'});
  if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('invalid_private_key');
  const cloud=makeCloudClient(process.env.BEAUTYPROOF_XHS_WORKER_URL||'',privateKey);
  const local=await createLocalTransport({dataDirectory:process.env.XHS_JOB_DATA_DIR||'/var/lib/beautyproof-xhs/jobs',
    execute:pythonExecutor({python:process.env.XHS_PYTHON||resolve(here,'.venv/bin/python'),reader:resolve(here,'reader/read_xhs.py'),worker:resolve(here,'worker.py')})});
  const localRequest=local.signedRequest;
  let stop=false,failures=0;process.once('SIGTERM',()=>{stop=true;});process.once('SIGINT',()=>{stop=true;});
  console.log(JSON.stringify({event:'bridge_started',version:'2.0-anonymous-xhs',publicListener:false}));
  try {
    while(!stop) {
      try {
        const response=await cloud({action:'take'});
        if(response.job) console.log(JSON.stringify({event:'job_finished',...await processClaim(response.job,{cloud,localRequest})}));
        failures=0;
        await sleep(Math.max(3000,Math.min(15000,Number(response.pollAfterMs)||5000)));
      } catch(error) {
        console.log(JSON.stringify({event:'bridge_error',error:error.message,status:error.status||null,terminal:!!error.terminal}));
        if(error.terminal||++failures>=3)break;
        await sleep(30000);
      }
    }
  } finally {await local.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
