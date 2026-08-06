import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${key} must be an integer, got "${v}"`);
  return n;
}

function resolvePath(key: string, fallback: string): string {
  return path.resolve(ROOT, str(key, fallback));
}

export type ClipMode = 'auto' | 'on' | 'off';

function clipMode(): ClipMode {
  const v = str('CLIP_MODE', 'auto');
  if (v !== 'auto' && v !== 'on' && v !== 'off') {
    throw new Error(`CLIP_MODE must be auto|on|off, got ${v}`);
  }
  return v;
}

export const config = {
  port: int('PORT', 8080),
  dbPath: resolvePath('DB_PATH', './data/catalog.db'),
  mediaCacheDir: resolvePath('MEDIA_CACHE_DIR', './data/media-cache'),
  mediaCacheMaxBytes: int('MEDIA_CACHE_MAX_BYTES', 8 * 1024 * 1024 * 1024),
  clipMode: clipMode(),
  ingestUserAgent: str(
    'INGEST_USER_AGENT',
    'borb-amq/0.1 (self-hosted anime music quiz; set INGEST_USER_AGENT)',
  ),
  ingestRpm: int('INGEST_RPM', 50),
  devOrigin: str('DEV_ORIGIN', 'http://localhost:5173'),
  isProduction: str('NODE_ENV', 'development') === 'production',
} as const;
