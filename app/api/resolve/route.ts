import { extractShareUrl, platformFor } from '@/lib/shared/links';
import { resolveLink, resolverTtl } from '@/lib/server/link-resolver';

type Payload = Awaited<ReturnType<typeof resolveLink>>;
const cache = new Map<string, { expires: number; value: Payload }>();
const pending = new Map<string, Promise<Payload>>();
function json(value: Payload, cacheStatus: string) {
  return Response.json(value, { headers: { 'X-BeautyProof-Cache': cacheStatus, 'Cache-Control': 'no-store' } });
}
export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: string };
    const input = typeof body.url === 'string' ? extractShareUrl(body.url.slice(0, 10000)) : '';
    if (!input || input.length > 2000) return Response.json({ error: '请一次粘贴一条完整的小红书或抖音作品分享链接。' }, { status: 400 });
    const start = new URL(input), platform = platformFor(start);
    if (!platform) return Response.json({ error: '仅支持小红书或抖音公开作品链接。' }, { status: 400 });
    const cached = cache.get(input);
    if (cached && cached.expires > Date.now()) return json(cached.value, 'HIT');
    cache.delete(input);
    const inFlight = pending.get(input);
    if (inFlight) return json(await inFlight, 'COALESCED');
    if (pending.size >= 20) return Response.json({ error: '读取请求较多，请稍后再试。' }, { status: 429 });
    const task = resolveLink(start, platform);
    pending.set(input, task);
    try {
      const value = await task;
      if (cache.size >= 100) cache.delete(cache.keys().next().value ?? '');
      cache.set(input, { value, expires: Date.now() + resolverTtl(value.resolved) });
      console.info('link-resolve', JSON.stringify({ version: value.resolverVersion, platform, reason: value.reasonCode, status: value.contentStatus, upstream: value.diagnostics.upstreamStatus, ms: value.diagnostics.elapsedMs }));
      return json(value, 'MISS');
    } finally { pending.delete(input); }
  } catch {
    return Response.json({ error: '无法解析请求。' }, { status: 400 });
  }
}
