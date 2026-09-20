import { env } from 'cloudflare:workers';
import { callDirectReader } from '../shared/direct-reader';
import { emptyResolution } from '../shared/link-page';
import { platformFor } from '../shared/links';
import { getDb } from './db';

type Config = { BEAUTYPROOF_READER_URL?: string; BEAUTYPROOF_READER_PRIVATE_KEY?: string };
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(b => b.toString(16).padStart(2, '0')).join('');
export async function resolveDirect(url: string, request: Request) {
  const config = env as unknown as Config;
  if (!config.BEAUTYPROOF_READER_URL && !config.BEAUTYPROOF_READER_PRIVATE_KEY) return null;
  const now = Date.now(), parsed = new URL(url), platform = platformFor(parsed)!;
  const fail = (code: 'network_error' | 'rate_limited' | 'timeout' | 'identity_mismatch', limitation: string) => ({
    ...emptyResolution(platform, parsed, code), limitation, resolverVersion: '3.2-cloud',
    diagnostics: { transport: 'ecs-https', upstreamStatus: 0, redirects: [], elapsedMs: Date.now() - now },
  });
  try {
    if (!config.BEAUTYPROOF_READER_URL || !config.BEAUTYPROOF_READER_PRIVATE_KEY) throw new Error('incomplete_config');
    const db = getDb(), slot = Math.floor(now / 60000);
    const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const visitor = await hash(config.BEAUTYPROOF_READER_PRIVATE_KEY + '\n' + address);
    const results = await db.batch([
      db.prepare('INSERT INTO reader_rate(id,count,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count').bind('direct-global:' + slot, now + 120000),
      db.prepare('INSERT INTO reader_rate(id,count,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count').bind('direct:' + visitor + ':' + slot, now + 120000),
      db.prepare('DELETE FROM reader_rate WHERE expires_at<?').bind(now),
    ]);
    if (Number((results[0].results[0] as {count:number})?.count) > 20 || Number((results[1].results[0] as {count:number})?.count) > 6) return fail('rate_limited', '当前读取请求较多，请稍后重试。原链接已保留。');
    return await callDirectReader(url, { endpoint: config.BEAUTYPROOF_READER_URL, privateKey: config.BEAUTYPROOF_READER_PRIVATE_KEY });
  } catch (error) {
    const name = error instanceof Error ? error.name : '', message = error instanceof Error ? error.message : '';
    if (/TimeoutError|AbortError/.test(name)) return fail('timeout', '云端读取超时，尚未取得正文。请稍后重试或补充文字、截图。');
    if (message === 'reader_busy') return fail('rate_limited', '云端正在处理其他作品，请稍后重试。原链接已保留。');
    if (/identity/.test(message)) return fail('identity_mismatch', '返回内容与提交的作品不一致，已停止分析。请重新复制链接。');
    return fail('network_error', '云端读取服务暂时不可用，请稍后重试，或补充文字、截图。');
  }
}
