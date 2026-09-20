import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const apiCalls = sqliteTable('api_calls', {
  cacheKey: text('cache_key').primaryKey(), reservedMicros: integer('reserved_micros').notNull(),
  chargedMicros: integer('charged_micros'), status: text('status').notNull(), purpose: text('purpose').notNull(),
  createdAt: integer('created_at').notNull(), priceVersion: text('price_version').notNull(),
  promptTokens: integer('prompt_tokens'), completionTokens: integer('completion_tokens'), cachedTokens: integer('cached_tokens'), resultJson: text('result_json'),
});

export const analyses = sqliteTable('analyses', {
  id: text('id').primaryKey(),
  sourceType: text('source_type').notNull(),
  platform: text('platform'),
  canonicalUrl: text('canonical_url'),
  contentId: text('content_id'),
  title: text('title').notNull(),
  sha256: text('sha256'),
  perceptualHash: text('perceptual_hash'),
  textHash: text('text_hash'),
  featuresJson: text('features_json').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_analyses_sha256').on(table.sha256),
  index('idx_analyses_canonical_url').on(table.canonicalUrl),
  index('idx_analyses_content_id').on(table.contentId),
  index('idx_analyses_created_at').on(table.createdAt),
]);

// Short-lived public-link work queue. No account cookies or model credentials.
export const readerJobs = sqliteTable('reader_jobs', {
  id: text('id').primaryKey(), url: text('url').notNull(),
  platform: text('platform').notNull(), status: text('status').notNull(),
  claimToken: text('claim_token'), resultJson: text('result_json'), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('idx_reader_jobs_status_created').on(table.status, table.createdAt)]);
export const readerWorker = sqliteTable('reader_worker', {
  id: text('id').primaryKey(), lastSeen: integer('last_seen').notNull(),
  lastCleanup: integer('last_cleanup').notNull(),
});
export const readerNonces = sqliteTable('reader_nonces', {
  id: text('id').primaryKey(), expiresAt: integer('expires_at').notNull(),
}, table => [index('idx_reader_nonces_expires').on(table.expiresAt)]);
export const readerRate = sqliteTable('reader_rate', {
  id: text('id').primaryKey(), count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
