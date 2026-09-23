import { request as httpRequest } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createJobServer, signingPayload } from './job-server.mjs';

// HTTP over private IPC retains all job authentication and validation without
// opening TCP or relaxing the reader user's existing egress firewall.
export async function createLocalTransport(options) {
  const root = resolve(options.dataDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, '.ipc-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\beautyproof-xhs-${randomUUID()}` : join(directory, 'reader.sock');
  const pair = generateKeyPairSync('ed25519');
  const server = await createJobServer({ ...options, publicKey: pair.publicKey });
  try {
    await new Promise((resolveReady, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolveReady(); });
    });
    if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  } catch (error) {
    if (server.listening) await new Promise(done => server.close(done));
    await rmdir(directory);
    throw error;
  }
  const request = (method, path, body = Buffer.alloc(0), headers = {}) => new Promise((resolveResponse, reject) => {
    const req = httpRequest({ socketPath, method, path, headers, agent: false }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) response.destroy(new Error('local_response_too_large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        resolveResponse(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: resultHeaders }));
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('local_request_timeout')));
    req.once('error', reject);
    req.end(body);
  });
  const signedRequest = (method, path, payload, token = '') => {
    const body = Buffer.from(payload ? JSON.stringify(payload) : '');
    const timestamp = String(Date.now()), nonce = randomUUID();
    const headers = { 'content-type': 'application/json', 'x-reader-timestamp': timestamp, 'x-reader-nonce': nonce,
      'x-reader-signature': sign(null, signingPayload(timestamp, nonce, method, path, token, body), pair.privateKey).toString('base64') };
    if (token) headers['x-reader-job-token'] = token;
    return request(method, path, body, headers);
  };
  return { request, signedRequest, address: server.address(), close: async () => {
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    await rmdir(directory);
  } };
}
