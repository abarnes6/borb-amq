import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { setTrackDuration, type TrackRow } from './catalog.ts';

const AUDIO_CONTENT_TYPE = 'audio/ogg';
const VIDEO_CONTENT_TYPE = 'video/webm';

export interface PreparedMedia {
  token: string;
  seekMs: number;
  sourceOffsetMs: number;
  durationMs: number | null;
}

interface TokenEntry {
  filePath: string;
  contentType: string;
  isTemp: boolean;
  expiresAt: number;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const { code } = await run(cmd, ['-version'], 5_000);
    return code === 0;
  } catch {
    return false;
  }
}

export class MediaStore {
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private clippingEnabled = false;
  private probeEnabled = false;

  async init(): Promise<void> {
    await fsp.mkdir(config.mediaCacheDir, { recursive: true });
    await this.cleanTempFiles();

    const [hasFfmpeg, hasFfprobe] = await Promise.all([
      commandExists('ffmpeg'),
      commandExists('ffprobe'),
    ]);
    this.probeEnabled = hasFfprobe;

    if (config.clipMode === 'off') {
      this.clippingEnabled = false;
    } else if (hasFfmpeg) {
      this.clippingEnabled = true;
    } else if (config.clipMode === 'on') {
      throw new Error('CLIP_MODE=on but ffmpeg is not on PATH. Install ffmpeg or set CLIP_MODE=auto.');
    } else {
      this.clippingEnabled = false;
      console.warn(
        'ffmpeg not found: serving whole audio files. Rounds always start at 0:00, and\n' +
          '  content-length can in principle fingerprint the track. Install ffmpeg to fix both.',
      );
    }

    setInterval(() => void this.expireTokens(), 60_000).unref();
  }

  get clipping(): boolean {
    return this.clippingEnabled;
  }

  async prepareRound(track: TrackRow, guessWindowMs: number, ttlMs: number): Promise<PreparedMedia> {
    const source = await this.ensureCached(track.audioUrl, 'ogg');
    const durationS = await this.durationOf(track, source);

    const clipS = Math.ceil(guessWindowMs / 1000) + 5;
    let filePath = source;
    let isTemp = false;
    let seekMs = 0;
    let sourceOffsetMs = 0;
    let durationMs = durationS === null ? null : Math.round(durationS * 1000);

    const maxStartS = durationS === null ? 0 : Math.max(0, durationS - clipS);
    const startS = maxStartS > 0 ? Math.random() * maxStartS : 0;

    if (this.clippingEnabled) {
      const out = path.join(config.mediaCacheDir, `tmp-${randomBytes(12).toString('hex')}.ogg`);
      const ok = await this.clip(source, out, startS, clipS);
      if (ok) {
        filePath = out;
        isTemp = true;
        seekMs = 0;
        sourceOffsetMs = Math.round(startS * 1000);
        durationMs = clipS * 1000;
      }
    } else if (durationS !== null) {
      seekMs = Math.round(startS * 1000);
      sourceOffsetMs = seekMs;
    }

    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, {
      filePath,
      contentType: AUDIO_CONTENT_TYPE,
      isTemp,
      expiresAt: Date.now() + ttlMs,
    });
    return { token, seekMs, sourceOffsetMs, durationMs };
  }

  prefetchVideo(track: TrackRow): void {
    if (!track.videoUrl) return;
    void this.ensureCached(track.videoUrl, 'webm').catch(() => {
    });
  }

  async prepareVideo(track: TrackRow, ttlMs: number): Promise<string | null> {
    if (!track.videoUrl) return null;
    try {
      const filePath = await this.ensureCached(track.videoUrl, 'webm');
      const token = randomBytes(24).toString('base64url');
      this.tokens.set(token, {
        filePath,
        contentType: VIDEO_CONTENT_TYPE,
        isTemp: false,
        expiresAt: Date.now() + ttlMs,
      });
      return token;
    } catch (err) {
      console.warn(`video unavailable for track ${track.trackId}:`, err);
      return null;
    }
  }

  async releaseRound(token: string): Promise<void> {
    const entry = this.tokens.get(token);
    if (!entry) return;
    this.tokens.delete(token);
    if (entry.isTemp) await fsp.rm(entry.filePath, { force: true }).catch(() => {});
  }

  private async ensureCached(url: string, ext: 'ogg' | 'webm'): Promise<string> {
    const key = createHash('sha256').update(url).digest('hex');
    const dest = path.join(config.mediaCacheDir, `${key}.${ext}`);

    try {
      await fsp.access(dest);
      return dest;
    } catch {
    }

    const existing = this.inFlight.get(dest);
    if (existing) return existing;

    const job = this.download(url, dest).finally(() => this.inFlight.delete(dest));
    this.inFlight.set(dest, job);
    return job;
  }

  private async download(url: string, dest: string): Promise<string> {
    const tmp = `${dest}.part-${randomBytes(6).toString('hex')}`;
    const res = await fetch(url, {
      headers: { 'user-agent': config.ingestUserAgent },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) {
      throw new Error(`media fetch failed ${res.status} for ${url}`);
    }
    try {
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(tmp));
      await fsp.rename(tmp, dest);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    void this.evictIfOverBudget();
    return dest;
  }

  private async durationOf(track: TrackRow, filePath: string): Promise<number | null> {
    if (track.durationS !== null && track.durationS > 0) return track.durationS;
    if (!this.probeEnabled) return null;
    try {
      const { code, stdout } = await run(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
        15_000,
      );
      if (code !== 0) return null;
      const seconds = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      setTrackDuration(track.trackId, seconds);
      return seconds;
    } catch {
      return null;
    }
  }

  private async clip(source: string, dest: string, startS: number, durationS: number): Promise<boolean> {
    try {
      const { code, stderr } = await run(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-ss', startS.toFixed(3),
          '-t', String(durationS),
          '-i', source,
          '-vn', '-c:a', 'libvorbis', '-q:a', '5',
          '-f', 'ogg', '-y', dest,
        ],
        60_000,
      );
      if (code !== 0) {
        console.warn(`ffmpeg clip failed (${code}), serving full file: ${stderr.trim().slice(0, 300)}`);
        await fsp.rm(dest, { force: true }).catch(() => {});
        return false;
      }
      return true;
    } catch (err) {
      console.warn('ffmpeg clip errored, serving full file:', err);
      return false;
    }
  }

  async serve(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const entry = this.tokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('unknown or expired media token');
      return;
    }

    let size: number;
    try {
      size = (await fsp.stat(entry.filePath)).size;
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('media unavailable');
      return;
    }

    const headers: Record<string, string> = {
      'content-type': entry.contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };

    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }).end();
      return;
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    headers['content-length'] = String(end - start + 1);
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;

    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(entry.filePath, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  private async expireTokens(): Promise<void> {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt < now) await this.releaseRound(token);
    }
  }

  private async cleanTempFiles(): Promise<void> {
    try {
      const names = await fsp.readdir(config.mediaCacheDir);
      await Promise.all(
        names
          .filter((n) => n.startsWith('tmp-') || n.includes('.part-'))
          .map((n) => fsp.rm(path.join(config.mediaCacheDir, n), { force: true }).catch(() => {})),
      );
    } catch {
    }
  }

  private async evictIfOverBudget(): Promise<void> {
    try {
      const names = await fsp.readdir(config.mediaCacheDir);
      const pinned = new Set([...this.tokens.values()].map((e) => e.filePath));
      const files: { p: string; size: number; mtime: number }[] = [];
      let total = 0;

      for (const name of names) {
        if (!/\.(ogg|webm)$/.test(name) || name.startsWith('tmp-')) continue;
        const p = path.join(config.mediaCacheDir, name);
        try {
          const st = await fsp.stat(p);
          total += st.size;
          if (!pinned.has(p)) files.push({ p, size: st.size, mtime: st.mtimeMs });
        } catch {
        }
      }
      if (total <= config.mediaCacheMaxBytes) return;

      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files) {
        if (total <= config.mediaCacheMaxBytes) break;
        await fsp.rm(f.p, { force: true }).catch(() => {});
        total -= f.size;
      }
    } catch {
    }
  }
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';

  const [, rawStart = '', rawEnd = ''] = m;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  let start: number;
  let end: number;
  if (rawStart === '') {
    const n = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

export const mediaStore = new MediaStore();
