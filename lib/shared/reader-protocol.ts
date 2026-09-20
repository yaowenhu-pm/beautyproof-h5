import { contentIdFor, platformFor } from './links.ts';
import { emptyResolution, reasonMessages } from './link-page.ts';
import type { ReasonCode } from './link-page.ts';
import { isAllowedMediaUrl } from './media-url.ts';

export function readerSignatureHeadersValid(timestamp: string, signature: string, now = Date.now()) {
  return /^\d{13}$/.test(timestamp) && Math.abs(now - Number(timestamp)) <= 60_000 && /^[A-Za-z0-9+/]{86}==$/.test(signature);
}

export async function readerSignatureValid(key: string, timestamp: string, signature: string, body: string, now = Date.now()) {
  if (!readerSignatureHeadersValid(timestamp, signature, now)) return false;
  try {
    const bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey('spki', bytes(key), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', publicKey, bytes(signature), new TextEncoder().encode(timestamp + '\n' + body));
  } catch { return false; }
}

// Even an authenticated worker cannot silently replace one work with another.
export function checkedReaderResult(input: string, raw: unknown) {
  const start = new URL(input), platform = platformFor(start);
  if (!platform || !raw || typeof raw !== 'object') throw new Error('invalid_result');
  const r = raw as Record<string, unknown>;
  const canonical = new URL(String(r.canonicalUrl));
  if (platformFor(canonical) !== platform || r.platform !== platform) throw new Error('invalid_result');
  const id = contentIdFor(platform, canonical), expected = contentIdFor(platform, start);
  if (String(r.contentId ?? '') !== id || (expected && expected !== id)) throw new Error('identity_mismatch');
  if (r.resolved === true && !id) throw new Error('invalid_result');
  const diagnostics = r.diagnostics as Record<string, unknown> | undefined;
  if (r.resolved === true && !expected) {
    const redirects = Array.isArray(diagnostics?.redirects) ? diagnostics.redirects : [];
    const first = redirects[0] as Record<string, unknown> | undefined;
    const last = redirects.at(-1) as Record<string, unknown> | undefined;
    const matches = (hop: Record<string, unknown> | undefined, url: URL) =>
      hop?.host === url.hostname.toLowerCase() && hop?.path === url.pathname;
    let finalIdentity = false;
    try {
      const final = new URL('https://' + String(last?.host) + String(last?.path));
      finalIdentity = platformFor(final) === platform && contentIdFor(platform, final) === id;
    } catch { /* Reject malformed redirect evidence. */ }
    if (!redirects.length || !matches(first, start) || !finalIdentity) throw new Error('identity_mismatch');
  }
  const reason = String(r.reasonCode) as ReasonCode;
  if (!Object.hasOwn(reasonMessages, reason)) throw new Error('invalid_result');
  const base = emptyResolution(platform, canonical, reason);
  const extraction = r.extraction as Record<string, unknown> | undefined;
  const text = typeof extraction?.pageText === 'string' ? extraction.pageText.slice(0, 12000) : '';
  const full = r.contentStatus === 'body' && r.resolved === true && reason === 'ok' && extraction?.textStatus === 'full';
  if (full && (!id || !text.trim())) throw new Error('invalid_result');
  if (r.resolved === true && !['body', 'title_only', 'media_only'].includes(String(r.contentStatus))) throw new Error('invalid_result');
  const media = (Array.isArray(extraction?.media) ? extraction.media : []).filter(item => {
    try { return ['image', 'video'].includes(item.type) && isAllowedMediaUrl(new URL(item.url)); } catch { return false; }
  }).slice(0, 8).map(item => ({ type: item.type as 'image' | 'video', url: String(item.url) }));
  const resolved = r.resolved === true;
  if (resolved && r.contentStatus === 'body' && !full) throw new Error('invalid_result');
  if (resolved && r.contentStatus === 'title_only' && (reason !== 'metadata_only' || !text.trim())) throw new Error('invalid_result');
  if (resolved && r.contentStatus === 'media_only' && (reason !== 'media_only' || !media.length)) throw new Error('invalid_result');
  if (!resolved && ['ok', 'metadata_only', 'media_only'].includes(reason)) throw new Error('invalid_result');
  if (resolved && !full && !['metadata_only', 'media_only'].includes(reason)) throw new Error('invalid_result');
  return {
    ...base, resolved, contentStatus: resolved ? String(r.contentStatus) : 'unavailable',
    title: resolved && typeof r.title === 'string' ? r.title.slice(0, 180) : base.title,
    description: resolved && typeof r.description === 'string' ? r.description.slice(0, 800) : '',
    author: resolved && typeof r.author === 'string' ? r.author.slice(0, 100) : '',
    thumbnail: resolved ? media.find(item => item.type === 'image')?.url ?? '' : '',
    extraction: { pageText: resolved ? text : '', textStatus: full ? 'full' as const : resolved ? 'partial' as const : 'limited' as const, media: resolved ? media : [] },
    resolverVersion: '3.1-cloud',
    diagnostics: { transport: 'ecs-outbound', upstreamStatus: Number(diagnostics?.upstreamStatus) || 0,
      redirects: (Array.isArray(diagnostics?.redirects) ? diagnostics.redirects : []).slice(0, 8).flatMap(hop => {
        try {
          const u = new URL('https://' + String(hop.host) + String(hop.path));
          if (platformFor(u) !== platform || u.search || u.hash) return [];
          return [{ host: u.hostname, path: u.pathname.slice(0, 160), status: Math.max(0, Math.min(599, Number(hop.status) || 0)) }];
        } catch { return []; }
      }), elapsedMs: Math.max(0, Math.min(60000, Number(diagnostics?.elapsedMs) || 0)) },
  };
}

export async function limitedBody(request: Pick<Request, 'body'>, max: number, timeoutMs?: number) {
  const reader = request.body?.getReader(); if (!reader) throw new Error('missing_body');
  let raw = '', size = 0; const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error('body_timeout');
  const timeout = timeoutMs === undefined ? null : new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  try {
    while (true) { const part = await (timeout ? Promise.race([reader.read(), timeout]) : reader.read()); if (part.done) break; size += part.value.length;
      if (size > max) { void reader.cancel().catch(() => undefined); throw new Error('body_too_large'); }
      raw += decoder.decode(part.value, { stream: true });
    }
  } catch (error) {
    if (error === timeoutError) void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return raw + decoder.decode();
}
