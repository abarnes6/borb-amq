import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PlayerId } from '@borb/shared';
import { buildTitleIndex, catalogStats } from './catalog.ts';
import { config, ROOT } from './config.ts';
import { hub, randomRoomCode } from './hub.ts';
import { mediaStore } from './media.ts';
import type { Room } from './room.ts';
import { parseClientMessage, RateLimiter } from './wire.ts';

const CLIENT_DIST = path.join(ROOT, 'packages/client/dist');

interface CachedIndex {
  raw: Buffer;
  gzipped: Buffer;
  etag: string;
  builtAt: number;
}
let titleIndex: CachedIndex | null = null;
const TITLE_INDEX_TTL_MS = 10 * 60_000;

function getTitleIndex(): CachedIndex {
  if (titleIndex && Date.now() - titleIndex.builtAt < TITLE_INDEX_TTL_MS) return titleIndex;
  const raw = Buffer.from(JSON.stringify(buildTitleIndex()));
  titleIndex = {
    raw,
    gzipped: gzipSync(raw),
    etag: `"${createHash('sha1').update(raw).digest('hex').slice(0, 16)}"`,
    builtAt: Date.now(),
  };
  return titleIndex;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
  });
  res.end(payload);
}

function applyDevCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (config.isProduction) return;
  const origin = req.headers.origin;
  if (origin === config.devOrigin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'range, content-type');
    res.setHeader('access-control-expose-headers', 'content-range, accept-ranges, content-length');
  }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(CLIENT_DIST, rel);
  const indexHtml = path.join(CLIENT_DIST, 'index.html');

  let filePath = target;
  if (!target.startsWith(CLIENT_DIST + path.sep) && target !== CLIENT_DIST) {
    filePath = indexHtml;
  } else {
    try {
      const st = await fsp.stat(target);
      if (st.isDirectory()) filePath = indexHtml;
    } catch {
      filePath = indexHtml;
    }
  }

  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath);
    const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': String(data.byteLength),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(
      fs.existsSync(CLIENT_DIST)
        ? 'not found'
        : 'Client not built. Run `npm run build`, or use `npm run dev` for the Vite dev server.',
    );
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  applyDevCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (pathname.startsWith('/media/')) {
    const token = decodeURIComponent(pathname.slice('/media/'.length));
    void mediaStore.serve(req, res, token);
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      rooms: hub.count,
      clipping: mediaStore.clipping,
      catalog: catalogStats(),
    });
    return;
  }

  if (pathname === '/api/room/new') {
    sendJson(res, 200, { roomId: randomRoomCode() });
    return;
  }

  if (pathname === '/api/titles') {
    const index = getTitleIndex();
    if (req.headers['if-none-match'] === index.etag) {
      res.writeHead(304, { etag: index.etag }).end();
      return;
    }
    const wantsGzip = (req.headers['accept-encoding'] ?? '').includes('gzip');
    const body = wantsGzip ? index.gzipped : index.raw;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
      etag: index.etag,
      'cache-control': 'no-cache',
      ...(wantsGzip ? { 'content-encoding': 'gzip' } : {}),
    });
    res.end(body);
    return;
  }

  void serveStatic(req, res, pathname);
});

const wss = new WebSocketServer({ noServer: true });

interface SocketState {
  room: Room | null;
  playerId: PlayerId | null;
  limiter: RateLimiter;
  alive: boolean;
}

const sockets = new WeakMap<WebSocket, SocketState>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket) => {
  const state: SocketState = { room: null, playerId: null, limiter: new RateLimiter(), alive: true };
  sockets.set(ws, state);

  ws.on('pong', () => {
    state.alive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    if (!state.limiter.allow()) return;

    const msg = parseClientMessage(data.toString());
    if (!msg) return;

    if (msg.t === 'join') {
      if (state.room) return;
      const room = hub.getOrCreate(msg.roomId);
      const { playerId } = room.join(ws, msg.name, msg.avatar, msg.playerId, msg.sessionKey);
      state.room = room;
      state.playerId = playerId;
      return;
    }

    if (!state.room || !state.playerId) return;
    state.room.handleMessage(state.playerId, msg);
  });

  ws.on('close', () => {
    if (state.room && state.playerId) state.room.detach(state.playerId);
  });

  ws.on('error', () => ws.terminate());
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const state = sockets.get(ws);
    if (!state) continue;
    if (!state.alive) {
      ws.terminate();
      continue;
    }
    state.alive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

async function main(): Promise<void> {
  await mediaStore.init();

  const stats = catalogStats();
  if (stats.tracks === 0) {
    console.warn(
      '\nCatalog is empty — games cannot start yet.\n' +
        'Run `npm run ingest` (about 2 minutes) or `npm run ingest -- --pages 3` for a quick test.\n',
    );
  } else {
    console.log(
      `Catalog: ${stats.anime} anime, ${stats.themes} themes, ${stats.tracks} playable tracks` +
        (stats.lastIngest ? ` (ingested ${stats.lastIngest})` : ''),
    );
  }

  server.listen(config.port, () => {
    console.log(`borb-amq listening on http://localhost:${config.port}`);
    if (!config.isProduction) console.log(`Dev client expected at ${config.devOrigin}`);
  });
}

function shutdown(signal: string): void {
  console.log(`\n${signal} — shutting down`);
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err: unknown) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
