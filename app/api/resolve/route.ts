import { extractShareUrl, platformFor } from '@/lib/shared/links';
import { resolveLink, resolverTtl } from '@/lib/server/link-resolver';
import { resolveOnCloud } from '@/lib/server/cloud-reader';
import { resolveDirect } from '@/lib/server/direct-reader';
import { limitedBody } from '@/lib/shared/reader-protocol';
import { emptyResolution } from '@/lib/shared/link-page';

type Payload = Awaited<ReturnType<typeof resolveLink>>;
const cache = new Map<string, { expires: number; value: Payload }>();
const pending = new Map<string, Promise<Payload>>();
function json(value: Payload, cacheStatus: string) {
  return Response.json(value, { headers: { 'X-BeautyProof-Cache': cacheStatus, 'Cache-Control': 'no-store' } });
}
export async function POST(request: Request) {
  try {
    const body = JSON.parse(await limitedBody(request, 12000, 3000)) as { url?: string };
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
    const task = (async () => {
      try { return await resolveDirect(input, request) ?? await resolveOnCloud(input, request) ?? await resolveLink(start, platform); }
      catch { return { ...emptyResolution(platform, start, 'network_error'), resolverVersion: '3.1-cloud', diagnostics: { upstreamStatus: 0, redirects: [], elapsedMs: 0 } }; }
    })();
    pending.set(input, task);
    try {
      const value = await task;
      if (cache.size >= 100) cache.delete(cache.keys().next().value ?? '');
      cache.set(input, { value, expires: Date.now() + resolverTtl(value) });
      console.info('link-resolve', JSON.stringify({ version: value.resolverVersion, platform, reason: value.reasonCode, status: value.contentStatus, upstream: value.diagnostics.upstreamStatus, ms: value.diagnostics.elapsedMs }));
      return json(value, 'MISS');
    } finally { pending.delete(input); }
  } catch {
    return Response.json({ error: '无法解析请求。' }, { status: 400 });
  }
}
