type Platform = 'xiaohongshu' | 'douyin';
type MediaItem = { type: 'image' | 'video'; url: string };
type CachedResolve = { expiresAt: number; payload: Record<string, unknown> };

const resolveCache = new Map<string, CachedResolve>();

const platformHosts: Record<Platform, Set<string>> = {
  xiaohongshu: new Set(['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn', 'xhs.cn', 'www.xhs.cn']),
  douyin: new Set(['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com']),
};

function platformFor(url: URL): Platform | null {
  for (const [platform, hosts] of Object.entries(platformHosts) as [Platform, Set<string>][]) {
    if (hosts.has(url.hostname.toLowerCase())) return platform;
  }
  return null;
}

function decodeHtml(value: string) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function meta(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1].trim());
  }
  return '';
}

function canonicalFrom(html: string) {
  return decodeHtml(html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? '');
}

function jsonString(html: string, keys: string[]) {
  for (const key of keys) {
    const match = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'));
    if (!match?.[1]) continue;
    try { return JSON.parse(`"${match[1]}"`) as string; } catch { return match[1]; }
  }
  return '';
}

function contentIdFor(platform: Platform, url: URL) {
  if (platform === 'douyin') return url.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1] ?? '';
  return url.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/)?.[1] ?? '';
}

function canonicalWorkUrl(platform: Platform, url: URL) {
  const id = contentIdFor(platform, url);
  if (!id) return url.toString();
  return platform === 'douyin' ? `https://www.douyin.com/video/${id}` : `https://www.xiaohongshu.com/explore/${id}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseInitialState(html: string) {
  const marker = '__INITIAL_STATE__=';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  const raw = html.slice(start + marker.length, end).trim().replace(/;$/, '')
    .replace(/([:\[,]\s*)undefined(?=\s*[,}\]])/g, '$1null');
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
}

function xhsNoteFromState(html: string) {
  const state = parseInitialState(html);
  const global = asRecord(state?.global);
  const noteData = asRecord(state?.noteData) ?? asRecord(global?.noteData);
  const data = asRecord(noteData?.data);
  return asRecord(data?.noteData);
}

function safeUrl(value: unknown) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.toString();
  } catch { return ''; }
}

function xhsImageUrl(value: unknown) {
  const image = asRecord(value);
  if (!image) return '';
  const info = Array.isArray(image.infoList) ? image.infoList.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  const detail = info.find((item) => item.imageScene === 'H5_DTL') ?? info[0];
  return safeUrl(detail?.url) || safeUrl(image.url);
}

function collectVideoUrls(value: unknown, output = new Set<string>(), key = '') {
  if (typeof value === 'string') {
    const url = safeUrl(value);
    if (url && /(?:masterUrl|backupUrls|play|video|url)/i.test(key) && /(?:\.mp4|\.m3u8|sns-video|xhscdn)/i.test(url)) output.add(url);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectVideoUrls(item, output, key));
    return output;
  }
  const record = asRecord(value);
  if (record) Object.entries(record).forEach(([childKey, child]) => collectVideoUrls(child, output, childKey));
  return output;
}

function extractXhsContent(html: string) {
  const note = xhsNoteFromState(html);
  if (!note) return null;
  const title = typeof note.title === 'string' ? note.title : '';
  const description = typeof note.desc === 'string' ? note.desc : '';
  const user = asRecord(note.user);
  const author = typeof user?.nickname === 'string' ? user.nickname : typeof user?.nickName === 'string' ? user.nickName : '';
  const images = Array.isArray(note.imageList) ? note.imageList.map(xhsImageUrl).filter(Boolean) : [];
  const videos = Array.from(collectVideoUrls(note.video)).slice(0, 2);
  const media: MediaItem[] = [
    ...videos.map((url) => ({ type: 'video' as const, url })),
    ...images.map((url) => ({ type: 'image' as const, url })),
  ].slice(0, 8);
  return { title, description, author, media };
}

async function fetchPage(start: URL, platform: Platform) {
  let current = start;
  for (let hop = 0; hop < 5; hop += 1) {
    if (!platformHosts[platform].has(current.hostname.toLowerCase())) throw new Error('链接跳转到了不受信任的域名');
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('平台返回了无效跳转');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`平台返回 HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) throw new Error('平台没有返回可解析的作品页面');
    return { html: await response.text(), finalUrl: current };
  }
  throw new Error('链接跳转次数过多');
}

function usefulDouyinText(value: string) {
  if (!value || /记录美好生活|已经收获了\d+个喜欢|抖音短视频/.test(value)) return '';
  return value;
}

function cacheResponse(key: string, payload: Record<string, unknown>, ttlMs: number) {
  if (resolveCache.size >= 100) resolveCache.delete(resolveCache.keys().next().value ?? '');
  resolveCache.set(key, { payload, expiresAt: Date.now() + ttlMs });
  return Response.json(payload, { headers: { 'X-BeautyProof-Cache': 'MISS' } });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: string };
    const input = typeof body.url === 'string' ? body.url.trim() : '';
    if (!input || input.length > 2000) return Response.json({ error: '链接无效' }, { status: 400 });
    const start = new URL(input);
    if (start.protocol !== 'https:') return Response.json({ error: '仅支持 HTTPS 公开链接' }, { status: 400 });
    const platform = platformFor(start);
    if (!platform) return Response.json({ error: '仅支持小红书或抖音公开作品链接' }, { status: 400 });
    const cached = resolveCache.get(input);
    if (cached && cached.expiresAt > Date.now()) return Response.json(cached.payload, { headers: { 'X-BeautyProof-Cache': 'HIT' } });
    if (cached) resolveCache.delete(input);

    try {
      const { html, finalUrl } = await fetchPage(start, platform);
      const canonicalValue = canonicalFrom(html);
      const pageCanonical = canonicalValue && platformFor(new URL(canonicalValue, finalUrl)) === platform ? new URL(canonicalValue, finalUrl) : finalUrl;
      const xhs = platform === 'xiaohongshu' ? extractXhsContent(html) : null;
      const fallbackTitle = meta(html, 'og:title') || meta(html, 'twitter:title') || jsonString(html, ['title', 'desc', 'noteTitle']);
      const fallbackDescription = meta(html, 'og:description') || meta(html, 'description') || jsonString(html, ['desc', 'description']);
      const title = xhs?.title || (platform === 'douyin' ? usefulDouyinText(fallbackTitle) : fallbackTitle) || `${platform === 'douyin' ? '抖音' : '小红书'}公开作品`;
      const description = xhs?.description || (platform === 'douyin' ? usefulDouyinText(fallbackDescription) : fallbackDescription);
      const author = xhs?.author || meta(html, 'author') || jsonString(html, ['nickname', 'userName', 'authorName']);
      const media = xhs?.media ?? [];
      const thumbnail = media.find((item) => item.type === 'image')?.url || meta(html, 'og:image') || meta(html, 'twitter:image') || jsonString(html, ['coverUrl', 'imageUrl']);
      const canonicalUrl = canonicalWorkUrl(platform, pageCanonical);
      const genericTitle = `${platform === 'douyin' ? '抖音' : '小红书'}公开作品`;
      const hasMeaningfulContent = Boolean(description || media.length || author || (title && title !== genericTitle));
      const pageText = hasMeaningfulContent ? [title, description].filter(Boolean).join('\n').slice(0, 12000) : '';
      return cacheResponse(input, {
        resolved: hasMeaningfulContent,
        platform,
        canonicalUrl,
        contentId: contentIdFor(platform, new URL(canonicalUrl)),
        title: String(title).slice(0, 180),
        description: String(description).slice(0, 800),
        author: String(author).slice(0, 100),
        thumbnail: String(thumbnail).slice(0, 1600),
        limitation: hasMeaningfulContent ? undefined : '已识别作品链接，但平台未开放正文和媒体；请上传原视频完成内容分析。',
        fetchedAt: new Date().toISOString(),
        extraction: {
          pageText,
          textStatus: description ? 'full' : hasMeaningfulContent ? 'partial' : 'limited',
          media,
        },
      }, 5 * 60 * 1000);
    } catch (error) {
      return cacheResponse(input, {
        resolved: false,
        platform,
        canonicalUrl: canonicalWorkUrl(platform, start),
        contentId: contentIdFor(platform, start),
        title: `${platform === 'douyin' ? '抖音' : '小红书'}公开作品`,
        limitation: error instanceof Error ? error.message : '平台访问受限',
        fetchedAt: new Date().toISOString(),
        extraction: { pageText: '', textStatus: 'limited', media: [] },
      }, 20 * 1000);
    }
  } catch {
    return Response.json({ error: '无法解析请求' }, { status: 400 });
  }
}
