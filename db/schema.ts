import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
