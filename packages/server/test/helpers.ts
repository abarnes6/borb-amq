import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import type { ClientMessage, RoomSnapshot, ServerMessage } from '@borb/shared';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DB_PATH = path.join(ROOT, 'data/catalog.db');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let failures = 0;

export function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

export function failureCount(): number {
  return failures;
}

export interface OracleHit {
  animeId: number;
  name: string;
  englishName: string | null;
  malId: number | null;
}

export class AnswerOracle {
  private readonly byHash = new Map<string, OracleHit>();
  private readonly seen = new Set<string>();

  constructor(private readonly cacheDir: string) {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db
      .prepare(
        `SELECT t.audio_url, a.id AS anime_id, a.name, a.english_name, a.mal_id
         FROM track t JOIN theme th ON th.id = t.theme_id JOIN anime a ON a.id = th.anime_id`,
      )
      .all() as {
      audio_url: string;
      anime_id: number;
      name: string;
      english_name: string | null;
      mal_id: number | null;
    }[];
    for (const r of rows) {
      this.byHash.set(createHash('sha256').update(r.audio_url).digest('hex'), {
        animeId: r.anime_id,
        name: r.name,
        englishName: r.english_name,
        malId: r.mal_id,
      });
    }
    db.close();
  }

  newest(): OracleHit | null {
    const files = fs
      .readdirSync(this.cacheDir)
      .filter((f) => f.endsWith('.ogg') && !f.startsWith('tmp-') && !f.includes('.part-'));
    for (const f of files) {
      if (this.seen.has(f)) continue;
      this.seen.add(f);
      const hit = this.byHash.get(f.replace(/\.ogg$/, ''));
      if (hit) return hit;
    }
    return null;
  }
}

export class TestClient {
  readonly received: ServerMessage[] = [];
  readonly handlers = new Set<(m: ServerMessage) => void>();
  private ws!: WebSocket;
  playerId = '';

  constructor(
    readonly label: string,
    private readonly port: number,
  ) {}

  async connect(roomId: string): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.received.push(msg);
      if (msg.t === 'welcome') this.playerId = msg.playerId;
      this.handlers.forEach((h) => h(msg));
    });
    this.send({ t: 'join', roomId, name: this.label });
    await this.waitFor('welcome');
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor<T extends ServerMessage['t']>(
    type: T,
    timeoutMs = 30_000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((resolve, reject) => {
      const existing = this.received.find((m) => m.t === type);
      if (existing) return resolve(existing as Extract<ServerMessage, { t: T }>);
      const timer = setTimeout(() => {
        this.handlers.delete(handler);
        reject(new Error(`${this.label}: timed out waiting for ${type}`));
      }, timeoutMs);
      const handler = (m: ServerMessage): void => {
        if (m.t !== type) return;
        clearTimeout(timer);
        this.handlers.delete(handler);
        resolve(m as Extract<ServerMessage, { t: T }>);
      };
      this.handlers.add(handler);
    });
  }

  waitForRoomWhere(pred: (room: RoomSnapshot) => boolean, timeoutMs = 15_000): Promise<RoomSnapshot> {
    const roomOf = (m: ServerMessage | undefined): RoomSnapshot | null =>
      m?.t === 'room' || m?.t === 'welcome' ? m.room : null;

    return new Promise((resolve, reject) => {
      for (let i = this.received.length - 1; i >= 0; i--) {
        const room = roomOf(this.received[i]);
        if (room && pred(room)) return resolve(room);
      }
      const timer = setTimeout(() => {
        this.handlers.delete(handler);
        reject(new Error(`${this.label}: no room snapshot matched in ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (m: ServerMessage): void => {
        const room = roomOf(m);
        if (!room || !pred(room)) return;
        clearTimeout(timer);
        this.handlers.delete(handler);
        resolve(room);
      };
      this.handlers.add(handler);
    });
  }

  forget(type: ServerMessage['t']): void {
    for (let i = this.received.length - 1; i >= 0; i--) {
      if (this.received[i]?.t === type) this.received.splice(i, 1);
    }
  }

  latestRoom(): Extract<ServerMessage, { t: 'room' }> | null {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i];
      if (m?.t === 'room') return m;
      if (m?.t === 'welcome') return { t: 'room', room: m.room };
    }
    return null;
  }

  close(): void {
    this.ws.close();
  }
}

export function startServer(
  port: number,
  cacheDir: string,
  extraEnv: Record<string, string> = {},
): ChildProcess {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const server = spawn('npx', ['tsx', path.join(ROOT, 'packages/server/src/index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MEDIA_CACHE_DIR: cacheDir,
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  return server;
}

export function forkCatalog(destPath: string): void {
  fs.rmSync(destPath, { force: true });
  fs.rmSync(`${destPath}-wal`, { force: true });
  fs.rmSync(`${destPath}-shm`, { force: true });
  const src = new Database(DB_PATH);
  try {
    src.prepare('VACUUM INTO ?').run(destPath);
  } finally {
    src.close();
  }
}

export async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
    }
    await sleep(250);
  }
  throw new Error('server did not become healthy');
}
