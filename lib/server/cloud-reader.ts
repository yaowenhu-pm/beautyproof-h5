import { env } from 'cloudflare:workers';
import { getDb } from './db';
import { emptyResolution } from '../shared/link-page';
import { platformFor } from '../shared/links';
import { checkedReaderResult, readerSignatureHeadersValid, readerSignatureValid, limitedBody } from '../shared/reader-protocol';

type Row = { id: string; url: string; platform: string; status: string; claim_token: string | null; result_json: string | null; expires_at: number };
const key = () => (env as unknown as { BEAUTYPROOF_READER_PUBLIC_KEY?: string }).BEAUTYPROOF_READER_PUBLIC_KEY ?? '';
const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, '0')).join('');

export async function resolveOnCloud(url: string, request: Request) {
  if (!key()) return null; // Deliberate feature switch; old deployment remains usable.
  const db = getDb(), now = Date.now(), platform = platformFor(new URL(url))!;
  const failure = (code: 'timeout' | 'rate_limited' | 'network_error', detail?: string) => ({
    ...emptyResolution(platform, new URL(url), code), ...(detail ? { limitation: detail } : {}),
    resolverVersion: '3.1-cloud', diagnostics: { transport: 'ecs-outbound', upstreamStatus: 0, redirects: [], elapsedMs: Date.now() - now },
  });
  const id = await hash('reader-3.1\n' + url);
  let row = await db.prepare('SELECT * FROM reader_jobs WHERE id=?').bind(id).first<Row>();
  if (row && row.expires_at > now && row.result_json) return JSON.parse(row.result_json);
  const worker = await db.prepare("SELECT last_seen FROM reader_worker WHERE id='main'").first<{ last_seen: number }>();
  if (!worker || worker.last_seen < now - 45000) return failure('network_error', '云端读取服务暂时离线，请稍后再试，或补充文字、截图。');
  if (!row || row.expires_at <= now) {
    // Fixed-window quota is persisted and atomically incremented across isolates.
    // Hash the trusted edge address; never store raw visitor IP addresses.
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ipHash = await hash(key() + '\n' + ip), window = Math.floor(now / 60000);
    const rates = await db.batch([
      db.prepare('INSERT INTO reader_rate(id,count,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count').bind('global:' + window, now + 120000),
      db.prepare('INSERT INTO reader_rate(id,count,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count').bind(ipHash + ':' + window, now + 120000),
    ]);
    if (Number((rates[0].results[0] as {count:number})?.count) > 20 || Number((rates[1].results[0] as {count:number})?.count) > 6) return failure('rate_limited', '本分钟读取次数较多，请稍后再试。');
    await db.prepare('DELETE FROM reader_jobs WHERE id=? AND expires_at<=?').bind(id, now).run();
    await db.prepare("INSERT OR IGNORE INTO reader_jobs(id,url,platform,status,created_at,expires_at) SELECT ?,?,?,'pending',?,? WHERE (SELECT COUNT(*) FROM reader_jobs WHERE status IN ('pending','processing') AND expires_at>?)<8").bind(id, url, platform, now, now + 24000, now).run();
  }
  while (Date.now() - now < 22000 && !request.signal.aborted) {
    row = await db.prepare('SELECT * FROM reader_jobs WHERE id=?').bind(id).first<Row>();
    if (!row) return failure('rate_limited', '云端读取队列已满，请稍后再试。');
    if (row.result_json && row.expires_at > Date.now()) return JSON.parse(row.result_json);
    if (row.expires_at <= Date.now()) break;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  // Do not resend to the platform or charge a model on timeout.
  return failure('timeout');
}

export async function workerRequest(request: Request) {
  try {
    const publicKey = key(); if (!publicKey) return answer({ error: 'disabled' }, 503);
    const timestamp = request.headers.get('x-reader-timestamp') ?? '';
    const signature = request.headers.get('x-reader-signature') ?? '';
    if (!readerSignatureHeadersValid(timestamp, signature)) return answer({ error: 'unauthorized' }, 401);
    const contentLength = request.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > 60000)) return answer({ error: 'body_too_large' }, 413);
    let raw: string;
    try { raw = await limitedBody(request, 60000, 3000); }
    catch (error) {
      if (error instanceof Error && error.message === 'body_timeout') return answer({ error: 'body_timeout' }, 408);
      if (error instanceof Error && error.message === 'body_too_large') return answer({ error: 'body_too_large' }, 413);
      throw error;
    }
    if (!await readerSignatureValid(publicKey, timestamp, signature, raw)) return answer({ error: 'unauthorized' }, 401);
    const payload = JSON.parse(raw) as { nonce?: string; action?: string; id?: string; claimToken?: string; sourceUrl?: string; result?: unknown };
    if (!/^[a-f0-9-]{36}$/.test(payload.nonce ?? '') || !['take', 'complete'].includes(payload.action ?? '')) return answer({ error: 'invalid_request' }, 400);
    const db = getDb(), now = Date.now();
    const nonce = await db.prepare('INSERT OR IGNORE INTO reader_nonces(id,expires_at) VALUES(?,?)').bind(payload.nonce, now + 120000).run();
    if (!nonce.meta.changes) return answer({ error: 'replayed_request' }, 409);
    await db.prepare("INSERT INTO reader_worker(id,last_seen,last_cleanup) VALUES('main',?,0) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen").bind(now).run();
    if (payload.action === 'take') {
      const cleanup = await db.prepare("UPDATE reader_worker SET last_cleanup=? WHERE id='main' AND last_cleanup<? RETURNING id").bind(now, now - 60000).first();
      if (cleanup) await db.batch([
        db.prepare('DELETE FROM reader_jobs WHERE expires_at<?').bind(now),
        db.prepare('DELETE FROM reader_nonces WHERE expires_at<?').bind(now),
        db.prepare('DELETE FROM reader_rate WHERE expires_at<?').bind(now),
      ]);
      const job = await db.prepare("UPDATE reader_jobs SET status='processing',claim_token=? WHERE id=(SELECT id FROM reader_jobs WHERE status='pending' AND expires_at>? ORDER BY created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM reader_jobs WHERE status='processing' AND expires_at>?) RETURNING id,url,claim_token AS claimToken").bind(crypto.randomUUID(), now, now).first<{id:string;url:string;claimToken:string}>();
      return answer({ job, pollAfterMs: 3000 });
    }
    if (!/^[a-f0-9]{64}$/.test(payload.id ?? '') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(payload.claimToken ?? '') || typeof payload.sourceUrl !== 'string') return answer({ error: 'invalid_job' }, 400);
    const job = await db.prepare('SELECT * FROM reader_jobs WHERE id=?').bind(payload.id).first<Row>();
    if (!job || job.expires_at <= now) return answer({ error: 'expired_job' }, 410);
    if (job.claim_token !== payload.claimToken) return answer({ error: 'stale_claim' }, 410);
    if (job.url !== payload.sourceUrl) return answer({ error: 'source_mismatch' }, 409);
    if (job.status === 'complete') return answer({ ok: true });
    if (job.status !== 'processing') return answer({ error: 'unclaimed_job' }, 409);
    let result;
    try { result = checkedReaderResult(job.url, payload.result); }
    catch { return answer({ error: 'invalid_result' }, 422); }
    const completedAt = Date.now();
    const completed = await db.prepare("UPDATE reader_jobs SET status='complete',result_json=?,expires_at=? WHERE id=? AND claim_token=? AND status='processing' AND expires_at>?")
      .bind(JSON.stringify(result), completedAt + (result.resolved ? 300000 : 10000), job.id, payload.claimToken, completedAt).run();
    if (!completed.meta.changes) {
      const current = await db.prepare('SELECT * FROM reader_jobs WHERE id=?').bind(job.id).first<Row>();
      if (current?.status === 'complete' && current.claim_token === payload.claimToken && current.url === payload.sourceUrl) return answer({ ok: true });
      if (!current || current.expires_at <= completedAt) return answer({ error: 'expired_job' }, 410);
      return answer({ error: 'stale_claim' }, 410);
    }
    return answer({ ok: true });
  } catch { return answer({ error: 'reader_unavailable' }, 503); }
}
