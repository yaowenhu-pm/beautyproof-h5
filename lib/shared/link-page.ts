import { contentIdFor, douyinNote, parseState, platformFor, xhsNote } from './links.ts';
import type { Platform } from './links.ts';
import { isAllowedMediaUrl } from './media-url.ts';

export type ReasonCode = 'ok' | 'metadata_only' | 'media_only' | 'app_only' | 'captcha' | 'login_required' | 'not_found' | 'browser_required' | 'parse_failed' | 'identity_mismatch' | 'rate_limited' | 'timeout' | 'network_error' | 'access_denied' | 'invalid_redirect' | 'unsupported_page';
export const reasonMessages: Record<ReasonCode, string> = {
  ok: '', metadata_only: '只读取到标题或摘要，尚未读取完整正文及音视频。', media_only: '已取得作品媒体，尚未提取其中的文字或口播。',
  app_only: '这条作品仅允许在小红书 App 内查看，网站未取得正文。请在 App 中复制原文或上传截图。',
  captcha: '平台要求安全验证，网站未取得正文。请打开原作品，复制文字或上传截图继续。',
  login_required: '平台要求登录后查看，网站无法代你登录。请复制原文或上传截图继续。',
  not_found: '平台返回作品不可访问或不存在，未取得正文。请确认原作品仍可打开，或补充原文、截图。',
  browser_required: '平台返回浏览器校验或动态加载页，没有提供可读取的正文。请复制原文或上传截图、原视频继续。',
  parse_failed: '页面已返回，但没有找到这条作品的正文。请从 App 重新复制完整分享链接，或补充原文、截图。',
  identity_mismatch: '页面中的作品编号与提交的链接不一致，已停止读取，避免分析错内容。请重新复制分享链接。',
  rate_limited: '平台暂时限制了读取请求，请稍后再试，或补充原文、截图。',
  timeout: '平台读取超时，尚未取得正文。请稍后重试，或补充文字、截图。',
  network_error: '暂时无法连接内容平台，请稍后重试，或补充文字、截图。',
  access_denied: '平台拒绝了这次读取请求，未取得正文。请打开原作品，或补充文字、截图。',
  invalid_redirect: '平台跳转地址异常，已停止读取。请重新复制作品分享链接。',
  unsupported_page: '这个地址没有返回可读取的作品页面。请复制具体作品的分享链接。',
};
export type MediaItem = { type: 'image' | 'video'; url: string };
const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
function decodeHtml(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const n = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  });
}
function attrs(tag: string) {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3]);
  return result;
}
export function meta(html: string, key: string) {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) { const a = attrs(tag[0]); if ((a.property ?? a.name)?.toLowerCase() === key.toLowerCase()) return (a.content ?? '').trim(); }
  return '';
}
function canonicalFrom(html: string) {
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) { const a = attrs(tag[0]); if (a.rel?.toLowerCase() === 'canonical') return a.href ?? ''; }
  return meta(html, 'og:url');
}
export function safeMediaUrl(value: unknown) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  try { const url = new URL(value); if (url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return ''; url.protocol = 'https:'; url.port = ''; return url.toString(); } catch { return ''; }
}
function firstUrl(value: unknown): string {
  if (Array.isArray(value)) {
    const urls = value.map(safeMediaUrl).filter(Boolean);
    return urls.find(url => isAllowedMediaUrl(new URL(url))) ?? urls[0] ?? '';
  }
  const r = rec(value), list = r?.url_list ?? r?.urlList;
  return safeMediaUrl(value) || (Array.isArray(list) ? firstUrl(list) : '') || safeMediaUrl(r?.url);
}
function mediaFor(note: Record<string, unknown>, platform: Platform): MediaItem[] {
  const media: MediaItem[] = [], video = rec(note.video);
  if (platform === 'douyin') {
    const url = firstUrl(video?.play_addr ?? video?.playAddr);
    if (url) media.push({ type: 'video', url });
    const images = note.images ?? note.imageList;
    if (Array.isArray(images)) for (const image of images) { const url = firstUrl(image); if (url) media.push({ type: 'image', url }); }
  } else {
    const queue: unknown[] = [video];
    for (let i = 0; i < queue.length && i < 500; i++) {
      const value = queue[i], r = rec(value);
      if (r) for (const [key, v] of Object.entries(r)) {
        if (/^(masterUrl|backupUrls|url)$/i.test(key)) {
          for (const candidate of Array.isArray(v) ? v : [v]) { const url = safeMediaUrl(candidate); if (url && /(?:\.mp4|\.m3u8|sns-video)/i.test(url)) media.push({ type: 'video', url }); }
        } else if (typeof v === 'object' && queue.length < 500) queue.push(v);
      } else if (Array.isArray(value)) queue.push(...value.slice(0, 100));
    }
    if (Array.isArray(note.imageList)) for (const image of note.imageList) {
      const r = rec(image), infos = Array.isArray(r?.infoList) ? r.infoList.map(rec) : [];
      const preferred = infos.find(v => v?.imageScene === 'H5_DTL');
      const url = safeMediaUrl(preferred?.url) || infos.map(v => safeMediaUrl(v?.url)).find(Boolean) || safeMediaUrl(r?.url) || safeMediaUrl(r?.urlDefault);
      if (url) media.push({ type: 'image', url });
    }
  }
  return media.filter((item, i) => media.findIndex(v => v.url === item.url) === i).slice(0, 8);
}
export function canonicalWorkUrl(platform: Platform, url: URL) {
  const id = contentIdFor(platform, url);
  if (!id) return url.toString();
  if (platform === 'xiaohongshu') return `https://www.xiaohongshu.com/explore/${id}`;
  return `https://www.douyin.com/${/\/(?:note|slides)\//.test(url.pathname) ? 'note' : 'video'}/${id}`;
}
export function emptyResolution(platform: Platform, workUrl: URL, reasonCode: ReasonCode) {
  return {
    resolved: false, contentStatus: 'unavailable' as string, reasonCode, platform,
    canonicalUrl: canonicalWorkUrl(platform, workUrl), contentId: contentIdFor(platform, workUrl),
    title: `${platform === 'douyin' ? '抖音' : '小红书'}公开作品`, description: '', author: '', thumbnail: '',
    limitation: reasonMessages[reasonCode], fetchedAt: new Date().toISOString(),
    extraction: { pageText: '', textStatus: 'limited' as 'limited' | 'partial' | 'full', media: [] as MediaItem[] },
  };
}
// Known gate routes are terminal. Do not fetch an error/login page or treat a
// recommendation feed (whose URL no longer identifies the work) as its body.
export function terminalLinkRoute(platform: Platform, url: URL): ReasonCode | null {
  const path=url.pathname;
  if (/captcha|verify|challenge/i.test(path)) return 'captcha';
  if (/\/(?:website-login|login|signin|passport|auth)(?:\/|$)/i.test(path)) return 'login_required';
  if (/^\/404(?:\/|$)/.test(path)) return 'not_found';
  if (platform==='xiaohongshu' && /^(?:www\.)?xiaohongshu\.com$/.test(url.hostname) && !contentIdFor(platform,url)) return 'unsupported_page';
  return null;
}
function visibleMarkup(html: string) {
  return html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<([\w-]+)\b(?=[^>]*(?:\shidden(?=[\s=>])|aria-hidden=["']true["']|style=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)))[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}
function explicitGate(markup: string): ReasonCode | null {
  // Only standalone gate messages, not navigation buttons or words quoted by
  // the author. Embedded hydration data must not override an actual gate.
  const candidates = Array.from(markup.matchAll(/<(?:main|section|div|p|h[1-6])\b[^>]*>([^<>]{1,100})<\//gi), m => decodeHtml(m[1]).trim());
  candidates.push(decodeHtml(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  for (const value of candidates) {
    if (/^(?:请完成(?:安全)?验证|拖动滑块(?:完成验证)?|请输入验证码|安全验证|verify you are human)[。！!\s]*$/i.test(value)) return 'captcha';
    if (/^(?:当前内容)?仅(?:支持|限)在小红书\s*APP\s*内(?:查看|打开)[。！!\s]*$/i.test(value)) return 'app_only';
    if (/^(?:请先登录(?:后(?:查看|浏览))?|登录后(?:查看|浏览))[。！!\s]*$/.test(value)) return 'login_required';
    if (/^(?:访问频繁|请求过于频繁)(?:，?请稍后再试)?[。！!\s]*$/.test(value)) return 'rate_limited';
  }
  return null;
}
export function parseLinkPage(html: string, platform: Platform, workUrl: URL, finalUrl: URL, httpStatus = 200) {
  const id = contentIdFor(platform, workUrl), finalId = contentIdFor(platform, finalUrl);
  const empty = (reason: ReasonCode) => emptyResolution(platform, workUrl, reason);
  const path = finalUrl.pathname;
  if (/captcha|verify|challenge/i.test(path)) return empty('captcha');
  if (/\/(?:website-login|login|passport)(?:\/|$)/i.test(path)) return empty('login_required');
  if (httpStatus === 429) return empty('rate_limited');
  if (httpStatus >= 500) return empty('network_error');
  if (httpStatus === 401) return empty('login_required');
  if (httpStatus === 403) return empty('access_denied');
  const terminal=terminalLinkRoute(platform,finalUrl);
  if(terminal)return empty(terminal);
  if (id && finalId && id !== finalId) return empty('identity_mismatch');
  if (id && finalId !== id) return empty('unsupported_page');
  for (const canonical of [canonicalFrom(html), meta(html, 'og:url')].filter(Boolean)) {
    try { const url = new URL(canonical, finalUrl); if (platformFor(url) === platform) { const cid = contentIdFor(platform, url); if (id && cid && id !== cid) return empty('identity_mismatch'); } } catch { /* Malformed optional metadata. */ }
  }
  const markup = visibleMarkup(html), gate = explicitGate(markup);
  if (gate) return empty(gate);
  if (platform === 'douyin' && finalUrl.hostname === 'jingxuan.douyin.com') {
    // Public Jingxuan SSR layout identified in Apache-2.0 ShareXtract. Parse
    // literal data only, with stricter identity and coverage checks; no JS runs.
    // Its abstract is metadata, NOT the original caption or a video transcript.
    if (httpStatus === 404) return empty('not_found');
    if (httpStatus >= 400) return empty('network_error');
    if (!id || !/^\/m\/video\/\d+\/?$/.test(finalUrl.pathname)) return empty('unsupported_page');
    let value: unknown = parseState(html, '_SSR_DATA');
    for (const key of ['data', 'storeState', 'detail', 'videoData', 'result']) value = rec(value)?.[key];
    const summary = rec(value);
    if (!summary || typeof summary.gid !== 'string' || !summary.gid) return empty('parse_failed');
    if (summary.gid !== id || ['aweme_id', 'awemeId'].some(key => summary[key] != null && summary[key] !== id)) return empty('identity_mismatch');
    if (typeof summary.abstract !== 'string' || !summary.abstract.trim()) return empty('parse_failed');
    const description = summary.abstract.trim().slice(0, 12000);
    const title = typeof summary.title === 'string' ? summary.title.trim().slice(0, 180) : '';
    return {
      ...empty('metadata_only'), resolved: true, contentStatus: 'title_only',
      title: title || '抖音作品摘要', description: description.slice(0, 800),
      limitation: '仅自动读取到抖音公开摘要，未取得完整文案、视频画面或口播。本次分析只覆盖这段摘要。',
      extraction: { pageText: [...new Set([title, description].filter(Boolean))].join('\n').slice(0, 12000), textStatus: 'partial' as const, media: [] as MediaItem[] },
    };
  }
  const note = httpStatus >= 400 ? null : platform === 'xiaohongshu' ? xhsNote(html, id) : douyinNote(html, id);
  if (!note) {
    const visible = decodeHtml(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (/请完成(?:安全)?验证|拖动滑块|请输入验证码|verify you are human/i.test(visible) || /^安全验证$/.test(visible)) return empty('captcha');
    if (/仅支持在小红书\s*APP\s*内查看|仅(?:限|支持).*App内(?:打开|查看)/i.test(visible)) return empty('app_only');
    if (/登录后(?:查看|浏览)|请先登录/.test(visible)) return empty('login_required');
    if (/访问频繁|请求过于频繁/.test(visible)) return empty('rate_limited');
    if (httpStatus === 404 || /笔记不存在|作品不存在|内容已删除|暂时无法浏览/.test(visible) || path.startsWith('/404/')) return empty('not_found');
    if (/\_\$jsvmprt|acrawler|secsdk|enable javascript/i.test(html) && visible.length < 200) return empty('browser_required');
    if (httpStatus >= 400) return empty(httpStatus === 403 ? 'access_denied' : 'network_error');
    // An unmatched detail state must not fall back to another work's metadata.
    const state = platform === 'xiaohongshu' ? rec(parseState(html)) : null;
    if (state && (state.note || state.noteData || rec(state.global)?.noteData)) return empty('parse_failed');
    if (platform === 'douyin' && /["']aweme_?Id["']|["']aweme_id["']/.test(html)) return empty('parse_failed');
  }
  if (!id) return empty('unsupported_page');
  const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  const usefulMeta = (v: string) => /^(?:小红书(?:\s*[-—|]\s*你的生活指南)?|抖音(?:\s*[-—|]\s*记录美好生活)?|抖音短视频|记录美好生活)$/.test(v.trim()) || /已经收获了\d+个喜欢/.test(v) ? '' : v;
  // Metadata on the requested work route is partial, never a full transcript.
  const canUseMeta = !note && finalId === id;
  const title = text(note?.title) || (platform === 'douyin' ? text(note?.desc) : '') || (canUseMeta ? usefulMeta(meta(html, 'og:title') || meta(html, 'twitter:title')) : '');
  const description = text(note?.desc) || (canUseMeta ? usefulMeta(meta(html, 'og:description') || meta(html, 'description')) : '');
  const media = note ? mediaFor(note, platform) : [];
  if (!title && !description && !media.length) return empty('parse_failed');
  const pageText = [...new Set([title, description].filter(Boolean))].join('\n').slice(0, 12000);
  const full = Boolean(note && description);
  const reasonCode: ReasonCode = full ? 'ok' : pageText ? 'metadata_only' : 'media_only';
  const author = rec(note?.user) ?? rec(note?.author);
  return {
    ...emptyResolution(platform, workUrl, reasonCode), resolved: true,
    contentStatus: full ? 'body' : pageText ? 'title_only' : 'media_only',
    title: title.slice(0, 180) || `${platform === 'douyin' ? '抖音' : '小红书'}作品`, description: description.slice(0, 800),
    author: text(author?.nickname ?? author?.nickName).slice(0, 100), thumbnail: media.find(v => v.type === 'image')?.url ?? '',
    extraction: { pageText, textStatus: full ? 'full' as const : 'partial' as const, media },
  };
}
