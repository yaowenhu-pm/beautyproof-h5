import { JOB_UUID, sha256Text } from './anonymous-reader-protocol.ts';

type Fetcher = typeof fetch;
export type InboundConfig = { endpoint: string; privateKey: string };

const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));

export function validInboundEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/v2/xhs/jobs' && (!url.port || url.port === '443') &&
      !/^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && url.hostname.includes('.') &&
      !/(?:^|\.)(?:localhost|local|internal|test)$/.test(url.hostname);
  } catch { return false; }
}

async function boundedBytes(response: Response, max: number) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > max || !response.body) throw new Error('inbound_response_too_large');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > max) { await reader.cancel(); throw new Error('inbound_response_too_large'); }
    chunks.push(part.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export function createInboundClient(config: InboundConfig, transport: Fetcher = fetch) {
  if (!validInboundEndpoint(config.endpoint)) throw new Error('invalid_inbound_endpoint');
  const origin = new URL(config.endpoint).origin;
  let keyPromise: Promise<CryptoKey> | undefined;
  const signingKey = () => keyPromise ??= crypto.subtle.importKey('pkcs8', fromBase64(config.privateKey), 'Ed25519', false, ['sign']);
  async function request(method: 'POST' | 'GET', path: string, jobToken = '', body = '', max = 600_000) {
    const timestamp = String(Date.now()), nonce = crypto.randomUUID();
    const digest = await sha256Text(body);
    const signed = `${timestamp}\n${nonce}\n${method}\n${path}\n${jobToken}\n${digest}`;
    const signature = base64(new Uint8Array(await crypto.subtle.sign('Ed25519', await signingKey(), encoder.encode(signed))));
    const headers: Record<string, string> = {
      'x-reader-timestamp': timestamp, 'x-reader-nonce': nonce, 'x-reader-signature': signature,
      ...(jobToken ? {'x-reader-job-token': jobToken} : {}),
      ...(method === 'POST' ? {'content-type': 'application/json'} : {}),
    };
    const response = await transport(origin + path, {method, headers,
      ...(method === 'POST' ? {body} : {}), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000)});
    if (!response.ok) { void response.body?.cancel(); throw new Error(`inbound_http_${response.status}`); }
    return boundedBytes(response, max);
  }
  async function json(method: 'POST' | 'GET', path: string, jobToken = '', body = '') {
    const raw = await request(method, path, jobToken, body);
    try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)) as Record<string, unknown>; }
    catch { throw new Error('invalid_inbound_json'); }
  }
  return {
    async submit(url: string, requestId: string) {
      if (!JOB_UUID.test(requestId)) throw new Error('invalid_request_id');
      return json('POST', '/v2/xhs/jobs', '', JSON.stringify({requestId, url}));
    },
    async poll(jobId: string, jobToken: string) {
      if (!JOB_UUID.test(jobId) || !/^[A-Za-z\d_-]{43}$/.test(jobToken)) throw new Error('invalid_remote_job');
      return json('GET', `/v2/xhs/jobs/${jobId}`, jobToken);
    },
    async media(jobId: string, jobToken: string, index: number, expected: {sha256: string; bytes: number; format: string}) {
      if (!JOB_UUID.test(jobId) || !/^[A-Za-z\d_-]{43}$/.test(jobToken) || !Number.isInteger(index) || index < 1 || index > 100 ||
        !/^[a-f\d]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > 30 * 1024 * 1024) throw new Error('invalid_remote_media');
      const path = `/v2/xhs/jobs/${jobId}/media/${index}`;
      const bytes = await request('GET', path, jobToken, '', Math.min(30 * 1024 * 1024, expected.bytes));
      if (bytes.byteLength !== expected.bytes) throw new Error('invalid_remote_media');
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== expected.sha256) throw new Error('remote_media_hash_mismatch');
      const type = ({JPEG: 'image/jpeg', PNG: 'image/png', WEBP: 'image/webp', GIF: 'image/gif', AVIF: 'image/avif'} as Record<string, string>)[expected.format];
      if (!type) throw new Error('invalid_remote_media');
      return {bytes, contentType: type, sha256: digest};
    },
  };
}
