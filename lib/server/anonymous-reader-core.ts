import { anonymousFailure, anonymousInput, checkedAnonymousResult, JOB_UUID, sha256Text } from '../shared/anonymous-reader-protocol.ts';
import { limitedBody, readerSignatureHeadersValid, readerSignatureValid } from '../shared/reader-protocol.ts';

type JobRow = {id: string; url: string; access_hash: string; status: string; claim_token: string | null; result_json: string | null; error_json: string | null; created_at: number; deadline_at: number; expires_at: number};
const answer = (value: unknown, status = 200) => Response.json(value, {status, headers: {'Cache-Control': 'no-store'}});
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const error = (code: string, message: string, status: number) => answer({code, error: message}, status);
export const ANONYMOUS_JOB_TTL = 8 * 60_000;
export const ANONYMOUS_RESULT_TTL = 30 * 60_000;
export const anonymousSql = {
  insert: `INSERT INTO anonymous_reader_jobs(id,url,access_hash,status,created_at,deadline_at,expires_at)
    SELECT ?,?,?,'queued',?,?,? WHERE
    (SELECT COUNT(*) FROM anonymous_reader_jobs WHERE status IN ('queued','running') AND deadline_at>?)<3
    AND (SELECT count FROM reader_rate WHERE id=?)<=20 AND (SELECT count FROM reader_rate WHERE id=?)<=6`,
  take: `UPDATE anonymous_reader_jobs SET status='running',claim_token=?
    WHERE id=(SELECT id FROM anonymous_reader_jobs WHERE status='queued' AND deadline_at>? ORDER BY created_at LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM anonymous_reader_jobs WHERE status='running' AND deadline_at>?)
    RETURNING id,url,claim_token AS claimToken`,
  complete: `UPDATE anonymous_reader_jobs SET status=?,result_json=?,error_json=?,expires_at=?
    WHERE id=? AND claim_token=? AND status='running' AND deadline_at>?`,
};

export function createAnonymousReaderHandlers({getDb, getPublicKey, isEnabled = () => false, now = Date.now}: {getDb: () => D1Database; getPublicKey: () => string; isEnabled?: () => boolean; now?: () => number}) {
  async function submit(request: Request) {
    try {
      const publicKey = getPublicKey();
      if (!isEnabled() || !publicKey) return error('reader_disabled', '云端匿名读取尚未配置。', 503);
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return error('invalid_request', '请求格式不正确。', 400);
      let input: string;
      try {
        const payload = JSON.parse(await limitedBody(request, 12000, 3000));
        if (!payload || Object.keys(payload).join(',') !== 'url') throw new Error('invalid_request');
        input = anonymousInput(payload.url);
      } catch { return error('invalid_url', '请一次粘贴一条完整的小红书作品分享链接。', 400); }
      const db = getDb(), time = now();
      const worker = await db.prepare("SELECT last_seen FROM reader_worker WHERE id='anonymous-v2'").first<{last_seen: number}>();
      if (!worker || worker.last_seen < time - 45000) return error('reader_offline', anonymousFailure({code: 'reader_offline'}).message, 503);
      const id = crypto.randomUUID(), accessToken = token(), accessHash = await sha256Text(accessToken);
      const ipHash = await sha256Text(publicKey + '\n' + (request.headers.get('cf-connecting-ip') || 'unknown'));
      const window = Math.floor(time / 60000), globalKey = 'anonymous:global:' + window, userKey = 'anonymous:' + ipHash + ':' + window;
      const rate = 'INSERT INTO reader_rate(id,count,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count';
      const results = await db.batch([
        db.prepare(rate).bind(globalKey, time + 120000), db.prepare(rate).bind(userKey, time + 120000),
        db.prepare(anonymousSql.insert).bind(id, input, accessHash, time, time + ANONYMOUS_JOB_TTL, time + ANONYMOUS_JOB_TTL + ANONYMOUS_RESULT_TTL, time, globalKey, userKey),
      ]);
      if (Number((results[0].results[0] as {count: number})?.count) > 20 || Number((results[1].results[0] as {count: number})?.count) > 6) return error('rate_limited', '读取请求较多，请稍后再试。', 429);
      if (!results[2].meta.changes) return error('queue_full', '当前读取队列已满，请稍后再试。', 429);
      return answer({jobId: id, accessToken, status: 'queued', pollAfterMs: 1500, expiresAt: time + ANONYMOUS_JOB_TTL}, 202);
    } catch { return error('reader_unavailable', '读取服务暂时不可用，请保留输入并稍后再试。', 503); }
  }
  async function poll(request: Request, id: string) {
    try {
      const accessToken = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z\d_-]{43})$/)?.[1];
      if (!JOB_UUID.test(id) || !accessToken) return error('not_found', '读取任务不存在或已失效。', 404);
      const db = getDb(), time = now();
      let job = await db.prepare('SELECT * FROM anonymous_reader_jobs WHERE id=? AND access_hash=? AND expires_at>?').bind(id, await sha256Text(accessToken), time).first<JobRow>();
      if (!job) return error('not_found', '读取任务不存在或已失效。', 404);
      if (['queued', 'running'].includes(job.status) && job.deadline_at <= time) {
        await db.prepare("UPDATE anonymous_reader_jobs SET status='failed',error_json=?,expires_at=? WHERE id=? AND status IN ('queued','running') AND deadline_at<=?")
          .bind(JSON.stringify(anonymousFailure({code: 'timeout'})), time + ANONYMOUS_RESULT_TTL, id, time).run();
        job = await db.prepare('SELECT * FROM anonymous_reader_jobs WHERE id=?').bind(id).first<JobRow>() || job;
      }
      return answer({jobId: id, status: job.status, pollAfterMs: 1500, expiresAt: job.expires_at,
        ...(job.status === 'complete' && job.result_json ? {result: JSON.parse(job.result_json)} : {}),
        ...(job.status === 'failed' ? {error: job.error_json ? JSON.parse(job.error_json) : anonymousFailure({})} : {})});
    } catch { return error('reader_unavailable', '读取状态暂时不可用，请稍后再试。', 503); }
  }
  async function worker(request: Request) {
    try {
      const publicKey = getPublicKey(); if (!publicKey) return answer({error: 'disabled'}, 503);
      const timestamp = request.headers.get('x-reader-timestamp') || '', signature = request.headers.get('x-reader-signature') || '';
      if (!readerSignatureHeadersValid(timestamp, signature, now())) return answer({error: 'unauthorized'}, 401);
      let raw: string;
      try {raw = await limitedBody(request, 100000, 3000);} catch {return answer({error: 'invalid_body'}, 413);}
      if (!await readerSignatureValid(publicKey, timestamp, signature, raw, now())) return answer({error: 'unauthorized'}, 401);
      const payload = JSON.parse(raw);
      if (!payload || !JOB_UUID.test(payload.nonce || '') || !['take', 'heartbeat', 'complete'].includes(payload.action)) return answer({error: 'invalid_request'}, 400);
      const db = getDb(), time = now();
      const nonce = await db.prepare('INSERT OR IGNORE INTO reader_nonces(id,expires_at) VALUES(?,?)').bind('anonymous:' + payload.nonce, time + 120000).run();
      if (!nonce.meta.changes) return answer({error: 'replayed_request'}, 409);
      await db.prepare("INSERT INTO reader_worker(id,last_seen,last_cleanup) VALUES('anonymous-v2',?,0) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen").bind(time).run();
      if (payload.action === 'heartbeat') return answer({ok: true});
      if (payload.action === 'take') {
        const cleanup = await db.prepare("UPDATE reader_worker SET last_cleanup=? WHERE id='anonymous-v2' AND last_cleanup<? RETURNING id").bind(time, time - 60000).first();
        if (cleanup) await db.batch([
          db.prepare("UPDATE anonymous_reader_jobs SET status='failed',error_json=?,expires_at=? WHERE status IN ('queued','running') AND deadline_at<=?").bind(JSON.stringify(anonymousFailure({code: 'timeout'})), time + ANONYMOUS_RESULT_TTL, time),
          db.prepare('DELETE FROM anonymous_reader_jobs WHERE expires_at<=?').bind(time),
          db.prepare('DELETE FROM reader_nonces WHERE expires_at<=?').bind(time),
          db.prepare('DELETE FROM reader_rate WHERE expires_at<=?').bind(time),
        ]);
        const job = await db.prepare(anonymousSql.take).bind(crypto.randomUUID(), time, time).first();
        return answer({job, pollAfterMs: 3000});
      }
      if (!JOB_UUID.test(payload.id || '') || !JOB_UUID.test(payload.claimToken || '') || typeof payload.sourceUrl !== 'string' || !['complete', 'failed'].includes(payload.status)) return answer({error: 'invalid_job'}, 400);
      const job = await db.prepare('SELECT * FROM anonymous_reader_jobs WHERE id=?').bind(payload.id).first<JobRow>();
      if (!job || job.expires_at <= time) return answer({error: 'expired_job'}, 410);
      if (job.claim_token !== payload.claimToken) return answer({error: 'stale_claim'}, 410);
      if (job.url !== payload.sourceUrl) return answer({error: 'source_mismatch'}, 409);
      if (['complete', 'failed'].includes(job.status)) return answer({ok: true});
      if (job.deadline_at <= time) return answer({error: 'expired_job'}, 410);
      if (job.status !== 'running') return answer({error: 'unclaimed_job'}, 409);
      let result = null;
      if (payload.status === 'complete') {
        try {result = await checkedAnonymousResult(job.url, payload.result);} catch {return answer({error: 'invalid_result'}, 422);}
      }
      const safeError = payload.status === 'failed' ? anonymousFailure(payload.error) : null;
      const committed = await db.prepare(anonymousSql.complete).bind(payload.status, result ? JSON.stringify(result) : null, safeError ? JSON.stringify(safeError) : null, now() + ANONYMOUS_RESULT_TTL, job.id, payload.claimToken, now()).run();
      if (!committed.meta.changes) return answer({error: 'expired_or_stale_claim'}, 410);
      return answer({ok: true});
    } catch { return answer({error: 'reader_unavailable'}, 503); }
  }
  return {submit, poll, worker};
}
