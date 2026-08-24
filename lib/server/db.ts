import { env } from 'cloudflare:workers';

type RuntimeEnv = { DB?: D1Database };

let initialized = false;

export function getDb() {
  const db = (env as unknown as RuntimeEnv).DB;
  if (!db) throw new Error('D1 binding DB is unavailable');
  return db;
}

export async function ensureSchema() {
  if (initialized) return getDb();
  const db = getDb();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY NOT NULL,
      source_type TEXT NOT NULL,
      platform TEXT,
      canonical_url TEXT,
      content_id TEXT,
      title TEXT NOT NULL,
      sha256 TEXT,
      perceptual_hash TEXT,
      text_hash TEXT,
      features_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_analyses_sha256 ON analyses (sha256)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_analyses_canonical_url ON analyses (canonical_url)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_analyses_content_id ON analyses (content_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_analyses_created_at ON analyses (created_at)'),
  ]);
  initialized = true;
  return db;
}
