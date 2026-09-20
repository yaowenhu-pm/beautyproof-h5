// One isolated acceptance run; keypair lives only in process memory.
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.getuid?.() !== 0) throw new Error('Run this launcher using Cloud Assistant root; browser runs as the dedicated non-root account.');
const here = dirname(fileURLToPath(import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const node = '/opt/beautyproof-node/bin/node';
const reader = spawn('/usr/sbin/runuser', ['-u','beautyproof-reader','--',node,'/opt/beautyproof-cloud-reader/direct-server.mjs'], {
  stdio: ['ignore','inherit','inherit'], env: {...process.env,
    HOME:'/var/lib/beautyproof-reader',PLAYWRIGHT_BROWSERS_PATH:'/var/lib/beautyproof-reader/ms-playwright',
    BEAUTYPROOF_SITE_PUBLIC_KEY:publicKey.export({type:'spki',format:'der'}).toString('base64')},
});
let stopped = false;
reader.on('exit',()=>{stopped=true;});
let tester;
try {
  let healthy = false;
  for(let n=0;n<30 && !stopped;n++) {
    try { const r=await fetch('http://127.0.0.1:18080/health'); if(r.ok){healthy=true;break;} } catch {}
    await new Promise(r=>setTimeout(r,200));
  }
  if(!healthy) throw new Error('reader_start_failed');
  const unsigned=await fetch('http://127.0.0.1:18080/v1/resolve',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  if(unsigned.status!==401) throw new Error('unsigned_request_not_rejected');
  console.log(JSON.stringify({preflight:'unsigned_request_rejected',status:unsigned.status}));
  tester=spawn(node,[join(here,'acceptance-20.mjs'),'--endpoint','http://127.0.0.1:18080/v1/resolve','--signed','--outdir','/root/beautyproof-acceptance-20260920',...process.argv.slice(2)],{
    cwd:here,stdio:['ignore','inherit','inherit'],env:{...process.env,READER_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'der'}).toString('base64')},
  });
  const exitCode=await new Promise((resolve,reject)=>{tester.once('error',reject);tester.once('exit',code=>resolve(code??1));});
  process.exitCode=exitCode;
} finally {
  if(tester && tester.exitCode===null) tester.kill('SIGTERM');
  reader.kill('SIGTERM');
  await new Promise(resolve=>{if(stopped)return resolve(); const timer=setTimeout(()=>{reader.kill('SIGKILL');resolve();},5000);reader.once('exit',()=>{clearTimeout(timer);resolve();});});
}
