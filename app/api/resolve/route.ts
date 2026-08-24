type Platform = 'xiaohongshu' | 'douyin';

const platformHosts: Record<Platform, Set<string>> = {
  xiaohongshu: new Set(['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com', 'xhs.cn', 'www.xhs.cn']),
  douyin: new Set(['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com']),
};

function platformFor(url: URL): Platform | null {
  for (const [platform, hosts] of Object.entries(platformHosts) as [Platform, Set<string>][]) {
    if (hosts.has(url.hostname.toLowerCase())) return platform;
  }
  return null;
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
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
    try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
  }
  return '';
}

function contentIdFor(platform: Platform, url: URL) {
  if (platform === 'douyin') return url.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1] ?? '';
  return url.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/)?.[1] ?? '';
}

async function fetchPage(start: URL, platform: Platform) {
  let current = start;
  for (let hop = 0; hop < 5; hop += 1) {
    if (!platformHosts[platform].has(current.hostname.toLowerCase())) throw new Error('链接跳转到了不受信任的域名');
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(9000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
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

export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: string };
    const input = typeof body.url === 'string' ? body.url.trim() : '';
    if (!input || input.length > 2000) return Response.json({ error: '链接无效' }, { status: 400 });
    const start = new URL(input);
    if (start.protocol !== 'https:') return Response.json({ error: '仅支持 HTTPS 公开链接' }, { status: 400 });
    const platform = platformFor(start);
    if (!platform) return Response.json({ error: '仅支持小红书或抖音公开作品链接' }, { status: 400 });

    try {
      const { html, finalUrl } = await fetchPage(start, platform);
      const canonicalValue = canonicalFrom(html);
      const canonical = canonicalValue && platformFor(new URL(canonicalValue, finalUrl)) === platform
        ? new URL(canonicalValue, finalUrl).toString()
        : finalUrl.toString();
      const title = meta(html, 'og:title') || meta(html, 'twitter:title') || jsonString(html, ['title', 'desc', 'noteTitle']) || `${platform === 'douyin' ? '抖音' : '小红书'}公开作品`;
      const description = meta(html, 'og:description') || meta(html, 'description') || jsonString(html, ['desc', 'description']);
      const author = meta(html, 'author') || jsonString(html, ['nickname', 'userName', 'authorName']);
      const thumbnail = meta(html, 'og:image') || meta(html, 'twitter:image') || jsonString(html, ['coverUrl', 'imageUrl']);
      return Response.json({
        resolved: true,
        platform,
        canonicalUrl: canonical,
        contentId: contentIdFor(platform, new URL(canonical)),
        title: String(title).slice(0, 180),
        description: String(description).slice(0, 600),
        author: String(author).slice(0, 100),
        thumbnail: String(thumbnail).slice(0, 1600),
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      return Response.json({
        resolved: false,
        platform,
        canonicalUrl: start.toString(),
        contentId: contentIdFor(platform, start),
        title: `${platform === 'douyin' ? '抖音' : '小红书'}公开作品`,
        limitation: error instanceof Error ? error.message : '平台访问受限',
        fetchedAt: new Date().toISOString(),
      });
    }
  } catch {
    return Response.json({ error: '无法解析请求' }, { status: 400 });
  }
}
