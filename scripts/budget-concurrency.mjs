import { Worker,isMainThread,workerData,parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,mkdtempSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import assert from 'node:assert/strict';
import {reserveSql} from '../lib/shared/budget.ts';
if(isMainThread){
 mkdirSync('outputs',{recursive:true});const folder=mkdtempSync(resolve('outputs/budget-test-')),file=join(folder,'ledger.sqlite');
 const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL');db.exec(readFileSync(new URL('../drizzle/0001_bored_boom_boom.sql',import.meta.url),'utf8'));
 const run=()=>Promise.all(Array.from({length:20},(_,id)=>new Promise((resolve,reject)=>{const worker=new Worker(new URL(import.meta.url),{workerData:{file,id}});worker.once('message',resolve);worker.once('error',reject);}))); 
 await run();const row=db.prepare('SELECT COUNT(*) AS calls,SUM(reserved_micros) AS spent FROM api_calls').get();assert.equal(row.calls,16);assert.equal(row.spent,960000);
 await run();assert.equal(db.prepare('SELECT COUNT(*) AS calls FROM api_calls').get().calls,16);db.close();
 console.log('PASS: 20 concurrent database writers cannot exceed 1 yuan; repeat wave cannot double-reserve. Zero API calls.');
}else{
 const db=new DatabaseSync(workerData.file);db.exec('PRAGMA busy_timeout=5000');const n=60000;
 const result=db.prepare(reserveSql).run('test-'+workerData.id,n,'demo',Date.now(),'fixture',n,1000000,'demo',n,600000);db.close();parentPort.postMessage(Number(result.changes));
}
