import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  ROOT,
  TestClient,
  check,
  failureCount,
  forkCatalog,
  sleep,
  startServer,
  waitForHealth,
} from './helpers.ts';

const PORT = 8095;
const CACHE_DIR = path.join(ROOT, 'data/reveal-e2e-cache');
const TEST_DB = path.join(ROOT, 'data/reveal-e2e.db');
const BASE = `http://127.0.0.1:${PORT}`;
const REVEAL_MS = 25_000;
const FAKE_DURATION_S = 95;

async function main(): Promise<void> {
  forkCatalog(TEST_DB);
  const seed = new Database(TEST_DB);
  seed.prepare('UPDATE track SET duration_s = ?').run(FAKE_DURATION_S);
  seed.close();

  const server = startServer(PORT, CACHE_DIR, { DB_PATH: TEST_DB });

  try {
    await waitForHealth(PORT);
    console.log('\nreveal, video and votes end-to-end\n');

    const host = new TestClient('host', PORT);
    const guest = new TestClient('guest', PORT);
    await host.connect('REVEAL');
    await guest.connect('REVEAL');

    host.send({
      t: 'settings',
      patch: {
        totalRounds: 4,
        guessWindowMs: 8_000,
        revealMs: REVEAL_MS,
        loadTimeoutMs: 8_000,
        revealVideo: true,
      },
    });
    await sleep(150);
    host.send({ t: 'start' });
    const round1 = await host.waitFor('round_start');

    host.send({ t: 'ready', token: round1.token });
    guest.send({ t: 'ready', token: round1.token });
    const play = await host.waitFor('play');

    host.send({ t: 'skip' });
    const reveal = await host.waitFor('reveal');

    const health = (await (await fetch(`${BASE}/api/health`)).json()) as { clipping: boolean };
    const videoStartMs = reveal.reveal.videoStartMs;
    console.log(`  (clip mode ${health.clipping ? 'on' : 'off'})`);

    check(
      'the round started somewhere other than 0:00',
      videoStartMs > 0,
      `${(videoStartMs / 1000).toFixed(1)}s into the track`,
    );
    if (health.clipping) {
      check(
        'the clip is delivered from its own zero, hiding the offset',
        play.seekMs === 0,
        `seekMs ${play.seekMs}`,
      );
    } else {
      check(
        'the video starts where the audio did',
        videoStartMs === play.seekMs,
        `video ${videoStartMs}ms vs audio ${play.seekMs}ms`,
      );
    }
    check(
      'the start offset leaves runway in the track',
      videoStartMs > 0 && videoStartMs < FAKE_DURATION_S * 1000,
      `${videoStartMs}ms of ${FAKE_DURATION_S * 1000}ms`,
    );

    check('reveal does not block on the video', reveal.reveal.videoStreamUrl === null);
    check('reveal states how long until the next round', reveal.nextInMs > 0, `${reveal.nextInMs}ms`);

    const revealing = await host.waitForRoomWhere((r) => r.phase === 'REVEAL');
    const endsAt = revealing.round?.revealEndsAtServerMs ?? null;
    check('the snapshot carries a reveal deadline', endsAt !== null, `${endsAt}`);
    check(
      'the deadline is in the future, so a countdown can run',
      endsAt !== null && endsAt > Date.now(),
      endsAt === null ? 'none' : `${endsAt - Date.now()}ms out`,
    );

    const videoMsg = await host.waitFor('reveal_video', 90_000).catch(() => null);
    check('the reveal video arrives', videoMsg !== null, videoMsg?.url ?? 'never arrived');

    if (videoMsg) {
      const res = await fetch(`${BASE}${videoMsg.url}`, { headers: { range: 'bytes=0-2047' } });
      check('video is served as webm', res.headers.get('content-type') === 'video/webm');
      check('video supports range, so clients pull only what they watch', res.status === 206, `${res.status}`);
      check('video leaks no filename', res.headers.get('content-disposition') === null);
      const bytes = Buffer.from(await res.arrayBuffer());
      check('video body is a real webm', bytes.subarray(0, 4).toString('hex') === '1a45dfa3', bytes.subarray(0, 4).toString('hex'));
      check('video url is an opaque token', /^\/media\/[A-Za-z0-9_-]+$/.test(videoMsg.url));

      const mid = await fetch(`${BASE}${videoMsg.url}`, { headers: { range: 'bytes=1000000-1002047' } });
      check('video seeks mid-file, so the offset is reachable', mid.status === 206, `${mid.status}`);
      check(
        'mid-file range reports the right window',
        (mid.headers.get('content-range') ?? '').startsWith('bytes 1000000-1002047/'),
        mid.headers.get('content-range') ?? 'none',
      );
    }

    host.send({ t: 'vote', kind: 'skip_reveal', on: true });
    const oneVote = await host.waitForRoomWhere((r) => r.votes.skipReveal.length === 1);
    check('a vote is visible to everyone', oneVote.votes.skipReveal[0] === host.playerId);
    check('two players need two votes', oneVote.votes.needed === 2, `needed ${oneVote.votes.needed}`);

    host.forget('round_start');
    await sleep(2_500);
    const leaked = host.received.some((m) => m.t === 'round_start');
    check('one vote of two does not skip the reveal', !leaked && host.latestRoom()?.room.phase === 'REVEAL');

    const beforeSkip = Date.now();
    guest.send({ t: 'vote', kind: 'skip_reveal', on: true });
    const nextRound = await host.waitFor('round_start', 20_000);
    const elapsed = Date.now() - beforeSkip;
    check('a majority skips the reveal', nextRound.n === 2, `round ${nextRound.n}`);
    check('skipping beat the reveal timer', elapsed < REVEAL_MS - 5_000, `${elapsed}ms vs ${REVEAL_MS}ms`);

    const fresh = await host.waitForRoomWhere((r) => r.round?.n === 2);
    check('skip votes reset each round', fresh.votes.skipReveal.length === 0);

    host.send({ t: 'vote', kind: 'to_lobby', on: true });
    const half = await host.waitForRoomWhere((r) => r.votes.toLobby.length === 1);
    check('one vote does not end the game', half.phase !== 'LOBBY', `phase ${half.phase}`);

    guest.send({ t: 'vote', kind: 'to_lobby', on: true });
    const lobby = await host.waitForRoomWhere((r) => r.phase === 'LOBBY', 15_000).catch(() => null);
    check('a majority returns everyone to the lobby', lobby !== null);
    if (lobby) {
      check('the abandoned round is cleared', lobby.round === null);
      check('votes are cleared on return', lobby.votes.toLobby.length === 0);
      check('scores survive so the game can be discussed', lobby.players.length === 2);
      check('nobody is left locked out', lobby.players.every((p) => !p.lockedOut && !p.spectating));
    }

    host.send({ t: 'start' });
    const restarted = await host.waitFor('round_start', 30_000).catch(() => null);
    check('a new game can start after returning to the lobby', restarted !== null);

    host.close();
    guest.close();
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${TEST_DB}${suffix}`, { force: true });
  }

  const failed = failureCount();
  console.log(failed === 0 ? '\nall checks passed\n' : `\n${failed} check(s) failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('reveal e2e failed:', err);
  process.exit(1);
});
