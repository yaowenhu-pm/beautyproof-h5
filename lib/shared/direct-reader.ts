import { checkedReaderResult, limitedBody } from './reader-protocol.ts';

export type DirectReaderConfig = { endpoint: string; privateKey: string };
export function validReaderEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/v1/resolve' && (!url.port || url.port === '443') &&
      !/^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && url.hostname.includes('.') &&
      !/(?:^|\.)(?:localhost|local|internal|test)$/.test(url.hostname);
  } catch { return false; }
}

export async function callDirectReader(url: string, config: DirectReaderConfig, fetcher: typeof fetch = fetch) {
  if (!validReaderEndpoint(config.endpoint)) throw new Error('invalid_reader_endpoint');
  const requestId = crypto.randomUUID();
  const body = JSON.stringify({ requestId, nonce: crypto.randomUUID(), url });
  const timestamp = String(Date.now());
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(config.privateKey), c => c.charCodeAt(0)), 'Ed25519', false, ['sign']);
  const signed = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(timestamp + '\n' + body));
  const signature = btoa(String.fromCharCode(...new Uint8Array(signed)));
  const response = await fetcher(config.endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reader-Timestamp': timestamp, 'X-Reader-Signature': signature },
    body, redirect: 'error', signal: AbortSignal.timeout(38000), cache: 'no-store',
  });
  if (!response.ok) { void response.body?.cancel(); throw new Error(response.status === 429 ? 'reader_busy' : 'reader_unavailable'); }
  if (!response.headers.get('content-type')?.includes('application/json')) { void response.body?.cancel(); throw new Error('invalid_reader_response'); }
  const raw = await limitedBody(response, 60000, 3000);
  const data = JSON.parse(raw) as { requestId?: string; sourceUrl?: string; result?: unknown };
  if (data.requestId !== requestId || data.sourceUrl !== url) throw new Error('reader_identity_mismatch');
  const checked = checkedReaderResult(url, data.result);
  const method = (data.result as { diagnostics?: { method?: string } })?.diagnostics?.method;
  return { ...checked, resolverVersion: '3.2-cloud', diagnostics: { ...checked.diagnostics, transport: 'ecs-https', method: method === 'browser' ? 'browser' : 'html' } };
}
