import { isAllowedMediaUrl as isAllowed } from '@/lib/shared/media-url';

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    const source = query.get('url'), expectedHash = query.get('sha256');
    if (expectedHash && !/^[a-f0-9]{64}$/.test(expectedHash)) return Response.json({ error: '图片校验信息无效' }, { status: 400 });
    if (!source || source.length > 2200) return Response.json({ error: '媒体地址无效' }, { status: 400 });
    const start = new URL(source);
    if (start.protocol === 'http:') start.protocol = 'https:';
    if (!isAllowed(start)) return Response.json({ error: '媒体来源不受支持' }, { status: 400 });

    let current = start;
    let response: Response | null = null;
    for (let hop = 0; hop < 4; hop += 1) {
      if (!isAllowed(current)) return Response.json({ error: '媒体跳转来源不受支持' }, { status: 400 });
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36',
          ...(!expectedHash ? { 'Range': request.headers.get('range') ?? 'bytes=0-' } : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) break;
        current = new URL(location, current);
        continue;
      }
      break;
    }
    if (!response?.ok) return Response.json({ error: `媒体源返回 HTTP ${response?.status ?? 502}` }, { status: 502 });
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^(image|video|audio)\//i.test(contentType)) return Response.json({ error: '媒体源返回了非媒体内容' }, { status: 415 });
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 80 * 1024 * 1024) return Response.json({ error: '平台媒体超过 80 MB，建议下载后上传' }, { status: 413 });
    if (expectedHash) {
      if (!contentType.startsWith('image/') || !response.body) return Response.json({ error: '未取得已校验图片' }, { status: 415 });
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 30 * 1024 * 1024) { await reader.cancel(); return Response.json({ error: '图片超过校验容量' }, { status: 413 }); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (actual !== expectedHash) return Response.json({ error: '图片与读取时的内容不一致，请重新读取原链接。' }, { status: 409 });
      return new Response(bytes, { headers: { 'Content-Type': contentType, 'Content-Length': String(size), 'Cache-Control': 'private, no-store', 'X-Content-SHA256': actual, 'X-Content-Type-Options': 'nosniff' } });
    }
    const headers = new Headers({
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=600',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const key of ['content-length', 'content-range', 'accept-ranges']) {
      const value = response.headers.get(key);
      if (value) headers.set(key, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '媒体读取失败' }, { status: 502 });
  }
}
