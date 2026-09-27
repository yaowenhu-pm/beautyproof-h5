import { env } from 'cloudflare:workers';
import { getDb } from './db';
import { createAnonymousReaderHandlers } from './anonymous-reader-core';
import { createInboundReaderHandlers } from './inbound-reader-core';

type ReaderEnv = {BEAUTYPROOF_READER_PUBLIC_KEY?: string; BEAUTYPROOF_ANONYMOUS_READER_ENABLED?: string;
  BEAUTYPROOF_XHS_INBOUND_ENABLED?: string; BEAUTYPROOF_XHS_INBOUND_URL?: string; BEAUTYPROOF_XHS_INBOUND_PRIVATE_KEY?: string};
const config = () => env as unknown as ReaderEnv;
const inboundEnabled = () => config().BEAUTYPROOF_XHS_INBOUND_ENABLED === 'true';
const outbound = createAnonymousReaderHandlers({getDb,
  getPublicKey: () => inboundEnabled() ? '' : config().BEAUTYPROOF_READER_PUBLIC_KEY || '',
  isEnabled: () => !inboundEnabled() && config().BEAUTYPROOF_ANONYMOUS_READER_ENABLED === 'true'});
const inbound = createInboundReaderHandlers({getDb, getConfig: () => ({enabled: inboundEnabled(),
  endpoint: config().BEAUTYPROOF_XHS_INBOUND_URL || '', privateKey: config().BEAUTYPROOF_XHS_INBOUND_PRIVATE_KEY || ''})});
export const anonymousReader = {
  submit: (request: Request) => inboundEnabled() ? inbound.submit(request) : outbound.submit(request),
  poll: (request: Request, id: string) => inboundEnabled() ? inbound.poll(request, id) : outbound.poll(request, id),
  worker: (request: Request) => outbound.worker(request),
  media: (request: Request, url: string, sha256: string) => inbound.media(request, url, sha256),
};
