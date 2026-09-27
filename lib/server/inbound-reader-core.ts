import { anonymousFailure, anonymousInput, checkedAnonymousResult, JOB_UUID, sha256Text } from '../shared/anonymous-reader-protocol.ts';
import { createInboundClient, validInboundEndpoint } from '../shared/inbound-reader.ts';
import { limitedBody } from '../shared/reader-protocol.ts';

type Config = {enabled: boolean; endpoint: string; privateKey: string};
type Job = {id: string; url: string; access_hash: string; remote_id: string | null; remote_token: string | null;
  status: string; result_json: string | null; error_json: string | null; deadline_at: number; expires_at: number};
type Media = {remote_id: string; remote_token: string; image_index: number; bytes: number; format: string};
const answer = (value: unknown, status = 200) => Response.json(value, {status, headers: {'Cache-Control': 'no-store'}});
const error = (code: string, message: string, status: number) => answer({code, error: message}, status);
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const JSON_TYPE = /^application\/json(?:;|$)/i;
const HASH = /^[a-f\d]{64}$/;
const DURATION = 8 * 60_000;
const RESULT_DURATION = 30 * 60_000;

export function createInboundReaderHandlers({getDb, getConfig, now = Date.now, transport = fetch}:
  {getDb: () => D1Database; getConfig: () => Config; now?: () => number; transport?: typeof fetch}) {
  function client() {
    const config = getConfig();
    if (!config.enabled || !config.privateKey || !validInboundEndpoint(config.endpoint)) return null;
    try { return createInboundClient(config, transport); } catch { return null; }
  }
  async function submit(request: Request) {
    const remote = client();
    if (!remote) return error('reader_disabled', '云端匿名读取尚未配置。', 503);
    if (!JSON_TYPE.test(request.headers.get('content-type') || '')) return error('invalid_request', '请求格式不正确。', 400);
    let url: string;
    try {
      const payload = JSON.parse(await limitedBody(request, 12000, 3000));
      if (!payload || Object.keys(payload).join(',') !== 'url') throw new Error('invalid_request');
      url = anonymousInput(payload.url);
    } catch { return error('invalid_url', '请一次粘贴一条完整的小红书作品分享链接。', 400); }
    const time = now(), id = crypto.randomUUID(), accessToken = randomToken();
    try {
      const db = getDb(), accessHash = await sha256Text(accessToken);
      await db.batch([db.prepare('DELETE FROM anonymous_inbound_media WHERE expires_at<=?').bind(time),
        db.prepare('DELETE FROM anonymous_inbound_jobs WHERE expires_at<=?').bind(time),
        db.prepare('DELETE FROM reader_rate WHERE expires_at<=?').bind(time)]);
      const ipHash = await sha256Text(getConfig().privateKey + '\n' + (request.headers.get('cf-connecting-ip') || 'unknown'));
      const window = Math.floor(time / 60000), globalKey = 'inbound:global:' + window, userKey = 'inbound:' + ipHash + ':' + window;
      const rate = 'INSERT INTO reader_rate(id,count,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count';
      const inserted = await db.batch([
        db.prepare(rate).bind(globalKey, time + 120000), db.prepare(rate).bind(userKey, time + 120000),
        db.prepare(`INSERT INTO anonymous_inbound_jobs(id,url,access_hash,status,created_at,deadline_at,expires_at)
          SELECT ?,?,?,'submitting',?,?,? WHERE
          (SELECT COUNT(*) FROM anonymous_inbound_jobs WHERE status IN ('submitting','queued','running') AND deadline_at>?)<3
          AND (SELECT count FROM reader_rate WHERE id=?)<=20 AND (SELECT count FROM reader_rate WHERE id=?)<=6`).bind(
          id, url, accessHash, time, time + DURATION, time + DURATION + RESULT_DURATION, time, globalKey, userKey),
      ]);
      if (Number((inserted[0].results[0] as {count: number})?.count) > 20 || Number((inserted[1].results[0] as {count: number})?.count) > 6)
        return error('rate_limited', '读取请求较多，请稍后再试。', 429);
      if (!inserted[2].meta.changes) return error('queue_full', '当前读取队列已满，请稍后再试。', 429);
      let accepted: Record<string, unknown>;
      try { accepted = await remote.submit(url, id); }
      catch {
        await db.prepare("UPDATE anonymous_inbound_jobs SET status='failed',error_json=? WHERE id=?")
          .bind(JSON.stringify(anonymousFailure({code: 'reader_offline'})), id).run();
        return error('reader_offline', '云端读取服务暂时离线，请稍后再试。', 503);
      }
      if (accepted.requestId !== id || accepted.sourceUrl !== url || !JOB_UUID.test(String(accepted.jobId || '')) ||
        !/^[A-Za-z\d_-]{43}$/.test(String(accepted.jobToken || '')) || !['queued', 'running'].includes(String(accepted.status))) {
        await db.prepare("UPDATE anonymous_inbound_jobs SET status='failed',error_json=? WHERE id=?")
          .bind(JSON.stringify(anonymousFailure({code: 'invalid_worker_result'})), id).run();
        return error('invalid_worker_result', '读取服务返回了不匹配的任务。', 502);
      }
      await db.prepare("UPDATE anonymous_inbound_jobs SET status=?,remote_id=?,remote_token=? WHERE id=? AND status='submitting'")
        .bind(accepted.status, accepted.jobId, accepted.jobToken, id).run();
      return answer({jobId: id, accessToken, status: accepted.status, pollAfterMs: 1500, expiresAt: time + DURATION}, 202);
    } catch { return error('reader_unavailable', '读取服务暂时不可用，请保留输入并稍后再试。', 503); }
  }
  async function poll(request: Request, id: string) {
    const accessToken = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z\d_-]{43})$/)?.[1];
    if (!JOB_UUID.test(id) || !accessToken) return error('not_found', '读取任务不存在或已失效。', 404);
    try {
      const db = getDb(), time = now();
      const job = await db.prepare('SELECT * FROM anonymous_inbound_jobs WHERE id=? AND access_hash=? AND expires_at>?')
        .bind(id, await sha256Text(accessToken), time).first<Job>();
      if (!job) return error('not_found', '读取任务不存在或已失效。', 404);
      if (job.status === 'complete' && job.result_json) return answer({jobId: id, status: 'complete', result: JSON.parse(job.result_json), expiresAt: job.expires_at});
      if (job.status === 'failed') return answer({jobId: id, status: 'failed', error: JSON.parse(job.error_json || '{}'), expiresAt: job.expires_at});
      if (job.deadline_at <= time) {
        const failure = anonymousFailure({code: 'timeout'});
        await db.prepare("UPDATE anonymous_inbound_jobs SET status='failed',error_json=?,expires_at=? WHERE id=? AND status IN ('submitting','queued','running')")
          .bind(JSON.stringify(failure), time + RESULT_DURATION, id).run();
        return answer({jobId: id, status: 'failed', error: failure, expiresAt: time + RESULT_DURATION});
      }
      if (!job.remote_id || !job.remote_token) return answer({jobId: id, status: 'queued', pollAfterMs: 1500, expiresAt: job.deadline_at});
      const remote = client();
      if (!remote) return error('reader_disabled', '云端匿名读取尚未配置。', 503);
      let state: Record<string, unknown>;
      try { state = await remote.poll(job.remote_id, job.remote_token); }
      catch (reason) {
        if (reason instanceof Error && reason.message === 'inbound_http_404') {
          const failure = anonymousFailure({code: 'reader_offline'});
          await db.prepare("UPDATE anonymous_inbound_jobs SET status='failed',error_json=?,expires_at=? WHERE id=? AND status IN ('submitting','queued','running')")
            .bind(JSON.stringify(failure), time + RESULT_DURATION, id).run();
          return answer({jobId: id, status: 'failed', error: failure, expiresAt: time + RESULT_DURATION});
        }
        return error('reader_unavailable', '云端读取状态暂时不可用，请保留原链接。', 503);
      }
      if (state.jobId !== job.remote_id || state.requestId !== id || state.sourceUrl !== job.url) {
        const failure = anonymousFailure({code: 'invalid_worker_result'});
        await db.prepare("UPDATE anonymous_inbound_jobs SET status='failed',error_json=?,expires_at=? WHERE id=? AND status IN ('submitting','queued','running')")
          .bind(JSON.stringify(failure), time + RESULT_DURATION, id).run();
        return answer({jobId: id, status: 'failed', error: failure, expiresAt: time + RESULT_DURATION});
      }
      if (state.status === 'queued' || state.status === 'running') {
        await db.prepare("UPDATE anonymous_inbound_jobs SET status=? WHERE id=? AND status IN ('submitting','queued','running')")
          .bind(state.status, id).run();
        return answer({jobId: id, status: state.status, pollAfterMs: 1500, expiresAt: job.deadline_at});
      }
      if (state.status === 'failed') {
        const failure = anonymousFailure({code: state.error});
        await db.prepare("UPDATE anonymous_inbound_jobs SET status='failed',error_json=?,expires_at=? WHERE id=? AND status IN ('submitting','queued','running')")
          .bind(JSON.stringify(failure), time + RESULT_DURATION, id).run();
        return answer({jobId: id, status: 'failed', error: failure, expiresAt: time + RESULT_DURATION});
      }
      if (state.status !== 'complete') {
        const failure = anonymousFailure({code: 'invalid_worker_result'});
        await db.prepare("UPDATE anonymous_inbound_jobs SET status='failed',error_json=?,expires_at=? WHERE id=? AND status IN ('submitting','queued','running')")
          .bind(JSON.stringify(failure), time + RESULT_DURATION, id).run();
        return answer({jobId: id, status: 'failed', error: failure, expiresAt: time + RESULT_DURATION});
      }
      try {
        const verified = await checkedAnonymousResult(job.url, state.result);
        const original = state.result as {images?: {url?: string; sha256?: string; mediaPath?: string; bytes?: number; format?: string}[]};
        if (!Array.isArray(original.images) || original.images.some((image, index) =>
          image.mediaPath !== `/v2/xhs/jobs/${job.remote_id}/media/${index + 1}` ||
          image.url !== verified.extraction.media[index]?.url || image.sha256 !== verified.extraction.media[index]?.sha256)) throw new Error('invalid_media_path');
        const mediaRows = await Promise.all(original.images.map(async (image, index) => [
          await sha256Text(image.url || ''), image.sha256, job.remote_id, job.remote_token, index + 1,
          image.bytes, image.format, time + RESULT_DURATION]));
        const media = [];
        // D1 allows at most 100 bound parameters per statement. Twelve images use 96.
        for (let offset = 0; offset < mediaRows.length; offset += 12) {
          const group = mediaRows.slice(offset, offset + 12);
          media.push(db.prepare(`INSERT INTO anonymous_inbound_media
            (url_hash,sha256,remote_id,remote_token,image_index,bytes,format,expires_at)
            VALUES ${group.map(() => '(?,?,?,?,?,?,?,?)').join(',')}
            ON CONFLICT(url_hash,sha256) DO UPDATE SET remote_id=excluded.remote_id,remote_token=excluded.remote_token,
            image_index=excluded.image_index,bytes=excluded.bytes,format=excluded.format,expires_at=excluded.expires_at`)
            .bind(...group.flat()));
        }
        await db.batch([db.prepare("UPDATE anonymous_inbound_jobs SET status='complete',result_json=?,expires_at=? WHERE id=? AND status IN ('submitting','queued','running')")
          .bind(JSON.stringify(verified), time + RESULT_DURATION, id), ...media]);
        return answer({jobId: id, status: 'complete', result: verified, expiresAt: time + RESULT_DURATION});
      } catch {
        const failure = anonymousFailure({code: 'invalid_worker_result'});
        await db.prepare("UPDATE anonymous_inbound_jobs SET status='failed',error_json=?,expires_at=? WHERE id=? AND status IN ('submitting','queued','running')")
          .bind(JSON.stringify(failure), time + RESULT_DURATION, id).run();
        return answer({jobId: id, status: 'failed', error: failure, expiresAt: time + RESULT_DURATION});
      }
    } catch { return error('reader_unavailable', '读取状态暂时不可用，请稍后再试。', 503); }
  }
  async function media(request: Request, url: string, sha256: string): Promise<Response | null> {
    const remote = client();
    if (!remote || !HASH.test(sha256)) return null;
    try {
      const db = getDb(), time = now();
      const row = await db.prepare('SELECT remote_id,remote_token,image_index,bytes,format FROM anonymous_inbound_media WHERE url_hash=? AND sha256=? AND expires_at>?')
        .bind(await sha256Text(url), sha256, time).first<Media>();
      if (!row) return null;
      const ipHash = await sha256Text(getConfig().privateKey + '\n' + (request.headers.get('cf-connecting-ip') || 'unknown'));
      const window = Math.floor(time / 60000), globalKey = 'inbound-media:global:' + window, userKey = 'inbound-media:' + ipHash + ':' + window;
      const rate = 'INSERT INTO reader_rate(id,count,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count';
      const limits = await db.batch([db.prepare(rate).bind(globalKey, time + 120000), db.prepare(rate).bind(userKey, time + 120000)]);
      if (Number((limits[0].results[0] as {count: number})?.count) > 150 || Number((limits[1].results[0] as {count: number})?.count) > 110)
        return error('rate_limited', '图片读取请求较多，请稍后再试。', 429);
      const image = await remote.media(row.remote_id, row.remote_token, row.image_index,
        {sha256, bytes: row.bytes, format: row.format});
      return new Response(image.bytes, {headers: {'Content-Type': image.contentType, 'Content-Length': String(image.bytes.length),
        'Cache-Control': 'private, no-store', 'X-Content-SHA256': image.sha256, 'X-Content-Type-Options': 'nosniff'}});
    } catch { return error('media_unavailable', '已核验图片暂时无法从读取服务取得，请重新读取原链接。', 502); }
  }
  return {submit, poll, media};
}
