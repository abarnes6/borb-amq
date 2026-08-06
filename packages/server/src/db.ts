import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from './config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function migrate(d: Database.Database): void {
  const columns = d.prepare('PRAGMA table_info(anime)').all() as { name: string }[];
  const has = (name: string): boolean => columns.some((c) => c.name === name);

  if (!has('mal_id')) d.exec('ALTER TABLE anime ADD COLUMN mal_id INTEGER');
  if (!has('english_name')) d.exec('ALTER TABLE anime ADD COLUMN english_name TEXT');
  d.exec('CREATE INDEX IF NOT EXISTS idx_anime_mal ON anime(mal_id)');
}

function open(): Database.Database {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const d = new Database(config.dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  migrate(d);
  return d;
}

export const db = open();
