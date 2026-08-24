const allowedSuffixes = ['.xhscdn.com', '.xhscdn.net', '.douyinvod.com', '.douyinpic.com', '.byteimg.com'];

function isAllowed(url: URL) {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && allowedSuffixes.some((suffix) => host.endsWith(suffix));
}

export async function GET(request: Request) {
  try {
    const source = new URL(request.url).searchParams.get('url');
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
          'Range': request.headers.get('range') ?? 'bytes=0-',
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
