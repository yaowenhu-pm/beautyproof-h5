import { contentIdFor, extractShareUrl, platformFor } from './links.ts';
import { emptyResolution } from './link-page.ts';
import { isAllowedMediaUrl } from './media-url.ts';

export const ANONYMOUS_READER_SHA = '070070a6b036c5d82259d304b46677a59981723b5929603eff8d273874211d0f';
export const JOB_UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const HASH = /^[a-f\d]{64}$/;
const HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.cn', 'xhslink.com']);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_result');
  return value as Record<string, unknown>;
};
export const sha256Text = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

export function anonymousInput(value: unknown) {
  if (typeof value !== 'string' || value.length > 10000) throw new Error('invalid_url');
  const input = extractShareUrl(value);
  if (!input || input.length > 4096) throw new Error('invalid_url');
  const url = new URL(input);
  if (!HOSTS.has(url.hostname)) throw new Error('invalid_url');
  const short = url.hostname.startsWith('xhslink.');
  if (short ? !/^\/(?:o\/[a-z\d]+|[a-z\d]+)$/i.test(url.pathname) : !/^\/(?:explore|discovery\/item)\/[a-f\d]{24}$/i.test(url.pathname)) throw new Error('invalid_url');
  return input;
}

const failureMessages: Record<string, string> = {
  unavailable_or_login: '平台要求登录、验证或暂不允许浏览。', note_unavailable: '平台提示该内容暂时无法查看。',
  timeout: '正文或完整图片读取超时，请稍后再试，或提供原文和截图。', upstream_cooldown: '平台访问失败后正在冷却，请稍后再试。',
  http_error: '平台拒绝或未能完成这次读取。', network_error: '暂时无法连接内容平台。',
  image_http_error: '部分图片无法读取，尚未取得完整内容。', validation_or_runtime_error: '正文或图片未能通过完整性验证。',
  incomplete_images: '图片列表不完整，尚未取得完整内容。', audit_failed: '正文或图片未能通过独立核对。',
  worker_failed: '读取服务暂时无法完成这条内容，请稍后再试。', reader_offline: '云端读取服务暂时离线，请稍后再试，或补充文字、截图。',
  invalid_worker_result: '读取结果未能通过完整性验证。', result_too_large: '这条内容超过当前读取容量，请提供原文或截图。',
};
export function anonymousFailure(value: unknown) {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const code = typeof raw.code === 'string' && Object.hasOwn(failureMessages, raw.code) ? raw.code : 'worker_failed';
  return { code, message: failureMessages[code] };
}

export async function checkedAnonymousResult(input: string, value: unknown) {
  const r = record(value), source = new URL(anonymousInput(input));
  const canonical = new URL(String(r.canonicalUrl));
  const noteId = typeof r.noteId === 'string' ? r.noteId : '';
  if (!/^[a-f\d]{24}$/.test(noteId) || platformFor(canonical) !== 'xiaohongshu' || contentIdFor('xiaohongshu', canonical) !== noteId) throw new Error('identity_mismatch');
  const expected = contentIdFor('xiaohongshu', source);
  if (expected && expected !== noteId) throw new Error('identity_mismatch');
  if (r.accountUsed !== false || r.browserCookiesRead !== false || r.cacheUsed !== false || r.readerSha256 !== ANONYMOUS_READER_SHA) throw new Error('invalid_result');
  if (typeof r.text !== 'string' || !r.text.trim() || !HASH.test(String(r.textSha256)) || await sha256Text(r.text) !== r.textSha256) throw new Error('text_hash_mismatch');
  if (typeof r.title !== 'string' || !['normal', 'video'].includes(String(r.type)) || r.mediaStatus !== 'complete') throw new Error('invalid_result');
  if (!Array.isArray(r.redirects) || r.redirects.length < 1 || r.redirects.length > 8) throw new Error('identity_mismatch');
  const redirects = r.redirects.map(value => {
    const hop = record(value);
    if (typeof hop.host !== 'string' || !HOSTS.has(hop.host) || typeof hop.path !== 'string' || !hop.path.startsWith('/') || /[?#\\]/.test(hop.path) || !Number.isInteger(hop.status) || Number(hop.status) < 200 || Number(hop.status) > 399) throw new Error('invalid_redirect');
    return {host: hop.host, path: hop.path, status: Number(hop.status)};
  });
  const first = redirects[0], last = redirects.at(-1)!;
  if (first.host !== source.hostname || first.path !== source.pathname || last.host !== canonical.hostname || last.path !== canonical.pathname || last.status !== 200) throw new Error('identity_mismatch');
  if (!Array.isArray(r.images) || !r.images.length || r.images.length > 100 || r.sourceImageCount !== r.images.length) throw new Error('incomplete_images');
  const images = r.images.map((value, i) => {
    const image = record(value), url = new URL(String(image.url));
    if (!isAllowedMediaUrl(url) || !url.hostname.endsWith('.xhscdn.com') || url.href.length > 4096 || image.index !== i + 1 || !HASH.test(String(image.sha256))) throw new Error('invalid_media');
    for (const field of ['bytes', 'width', 'height', 'frames']) if (!Number.isSafeInteger(image[field]) || Number(image[field]) < 1) throw new Error('invalid_media');
    if (Number(image.bytes) > 30 * 1024 * 1024 || Number(image.width) > 65535 || Number(image.height) > 65535 || Number(image.frames) > 10000 || !['JPEG', 'PNG', 'WEBP', 'GIF', 'AVIF'].includes(String(image.format))) throw new Error('invalid_media');
    return {index: i + 1, url: url.href, sha256: String(image.sha256), bytes: Number(image.bytes), width: Number(image.width), height: Number(image.height), frames: Number(image.frames), format: String(image.format)};
  });
  if (typeof r.checkedAt !== 'string' || !Number.isFinite(Date.parse(r.checkedAt))) throw new Error('invalid_result');
  const base = emptyResolution('xiaohongshu', canonical, 'ok');
  return {...base, resolved: true, contentStatus: 'body', title: r.title, description: r.text, thumbnail: images[0].url,
    fetchedAt: r.checkedAt, limitation: r.type === 'video' ? '已读取视频说明和封面，未转写视频语音。' : '',
    extraction: {pageText: r.text, textStatus: 'full' as const, media: images.map(image => ({type: 'image' as const, url: image.url, sha256: image.sha256}))},
    resolverVersion: '4.0-anonymous-xhs', diagnostics: {transport: 'ecs-outbound-v2', upstreamStatus: 200, redirects, elapsedMs: 0},
    verification: {mediaStatus: 'complete' as const, sourceImageCount: images.length, textSha256: r.textSha256, readerSha256: r.readerSha256,
      accountUsed: false, browserCookiesRead: false, cacheUsed: false, imagesRole: String(r.imagesRole || ''), images}};
}
