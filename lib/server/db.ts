import { env } from 'cloudflare:workers';

type RuntimeEnv = { DB?: D1Database };


export function getDb() {
  const db = (env as unknown as RuntimeEnv).DB;
  if (!db) throw new Error('D1 binding DB is unavailable');
  return db;
}

export async function ensureSchema() {
  // Production schema is owned by Drizzle migrations, not request handlers.
  return getDb();
}
