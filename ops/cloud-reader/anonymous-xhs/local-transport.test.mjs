import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalTransport } from './local-transport.mjs';

test('private IPC keeps signature and job-token checks without a TCP listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bproof-ipc-'));
  let starts = 0;
  const local = await createLocalTransport({ dataDirectory: root, execute: async () => { starts++; return { ok: false, error: 'note_unavailable' }; } });
  try {
    assert.equal(typeof local.address, 'string'); // Node TCP listen returns an address object.
    if (process.platform !== 'win32') {
      assert.equal((await stat(local.address)).mode & 0o777, 0o600);
    }
    const unsigned = await local.request('POST', '/v2/xhs/jobs', Buffer.from('{}'));
    assert.equal(unsigned.status, 401);
    assert.equal(starts, 0);
    const submitted = await local.signedRequest('POST', '/v2/xhs/jobs', { requestId: randomUUID(), url: 'https://www.xiaohongshu.com/explore/' + 'a'.repeat(24) });
    assert.equal(submitted.status, 202);
    const ticket = await submitted.json();
    assert.equal((await local.signedRequest('GET', '/v2/xhs/jobs/' + ticket.jobId, undefined, 'wrong-token')).status, 404);
    const polled = await local.signedRequest('GET', '/v2/xhs/jobs/' + ticket.jobId, undefined, ticket.jobToken);
    assert.equal(polled.status, 200);
    const job = await polled.json();
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'note_unavailable');
    assert.equal(starts, 1);
  } finally {
    await local.close();
    assert.deepEqual(await readdir(root), []);
    await rmdir(root);
  }
});
