import { env } from 'cloudflare:workers';
import { getDb } from './db';
import { createAnonymousReaderHandlers } from './anonymous-reader-core';
export const anonymousReader = createAnonymousReaderHandlers({getDb,
  getPublicKey: () => (env as unknown as {BEAUTYPROOF_READER_PUBLIC_KEY?: string}).BEAUTYPROOF_READER_PUBLIC_KEY || '',
  isEnabled: () => (env as unknown as {BEAUTYPROOF_ANONYMOUS_READER_ENABLED?: string}).BEAUTYPROOF_ANONYMOUS_READER_ENABLED === 'true'});
