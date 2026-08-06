import path from 'node:path';
import type { ServerMessage } from '@borb/shared';
import {
  AnswerOracle,
  ROOT,
  TestClient,
  check,
  failureCount,
  sleep,
  startServer,
  waitForHealth,
} from './helpers.ts';

const PORT = 8099;
const CACHE_DIR = path.join(ROOT, 'data/e2e-cache');
const BASE = `http://127.0.0.1:${PORT}`;

async function main(): Promise<void> {
  const oracle = new AnswerOracle(CACHE_DIR);
  const server = startServer(PORT, CACHE_DIR);

  try {
    await waitForHealth(PORT);
    console.log('\nbuzzer round end-to-end\n');

    const host = new TestClient('host', PORT);
    const guest = new TestClient('guest', PORT);
    await host.connect('E2E');
    await guest.connect('E2E');

    host.send({
      t: 'settings',
      patch: {
        totalRounds: 1,
        guessWindowMs: 20_000,
        answerMs: 5_000,
        revealMs: 2_000,
        loadTimeoutMs: 8_000,
        revealVideo: false,
      },
    });
    await sleep(150);
    host.send({ t: 'start' });

    const cueing = await guest
      .waitForRoomWhere((r) => r.phase === 'LOADING' && r.round === null, 5_000)
      .catch(() => null);
    check('the room leaves the lobby before the audio is ready', cueing !== null);

    const startedHost = await host.waitFor('round_start');
    const startedGuest = await guest.waitFor('round_start');
    check('both clients get round_start', startedHost.token === startedGuest.token);
    check(
      'media url carries no filename',
      /^\/media\/[A-Za-z0-9_-]+$/.test(startedHost.mediaUrl),
      startedHost.mediaUrl,
    );

    const expected = oracle.newest();
    check('answer oracle resolved the round', expected !== null, expected?.name ?? 'no match');
    const answer = expected?.englishName ?? expected?.name ?? '';
    const answeringInEnglish = expected?.englishName != null;

    const mediaRes = await fetch(`${BASE}${startedHost.mediaUrl}`);
    const body = Buffer.from(await mediaRes.arrayBuffer());
    check('media streams ogg audio', mediaRes.headers.get('content-type') === 'audio/ogg');
    check('media has no content-disposition', mediaRes.headers.get('content-disposition') === null);
    check('media supports range requests', mediaRes.headers.get('accept-ranges') === 'bytes');
    check('media body is a real ogg', body.subarray(0, 4).toString('latin1') === 'OggS');
    const headerBlob = JSON.stringify([...mediaRes.headers.entries()]).toLowerCase();
    check(
      'no anime name appears in media headers',
      answer === '' || !headerBlob.includes(answer.toLowerCase().slice(0, 8)),
    );

    const rangeRes = await fetch(`${BASE}${startedHost.mediaUrl}`, { headers: { range: 'bytes=0-99' } });
    check('range request returns 206', rangeRes.status === 206, `got ${rangeRes.status}`);
    check(
      'range request returns exactly the requested bytes',
      (await rangeRes.arrayBuffer()).byteLength === 100,
    );

    let playedEarly = false;
    const earlyWatch = (m: ServerMessage): void => {
      if (m.t === 'play') playedEarly = true;
    };
    host.handlers.add(earlyWatch);
    host.send({ t: 'ready', token: startedHost.token });
    await sleep(600);
    check('playback waits for the slow client', !playedEarly);
    host.handlers.delete(earlyWatch);

    guest.send({ t: 'ready', token: startedGuest.token });
    const play = await host.waitFor('play');
    check(
      'play is scheduled in the future',
      play.startAtServerMs > Date.now(),
      `${play.startAtServerMs - Date.now()}ms`,
    );

    guest.send({ t: 'buzz' });
    const early = await guest.waitFor('buzz_rejected', 3_000).catch(() => null);
    check('buzz before the music starts is rejected', early?.reason === 'not_playing', early?.reason ?? 'none');
    guest.forget('buzz_rejected');

    await sleep(Math.max(0, play.startAtServerMs - Date.now()) + 250);

    host.send({ t: 'buzz' });
    guest.send({ t: 'buzz' });
    const accepted = await host.waitFor('buzz_accepted');
    const loser = accepted.playerId === host.playerId ? guest : host;
    const winner = accepted.playerId === host.playerId ? host : guest;
    const rejection = await loser.waitFor('buzz_rejected', 3_000).catch(() => null);
    check('exactly one buzz is accepted', rejection?.reason === 'already_locked', rejection?.reason ?? 'none');
    check('answer deadline is set by the server', accepted.deadlineServerMs > Date.now());

    host.forget('play');
    guest.forget('play');
    winner.send({ t: 'answer', text: 'definitely not the right anime' });
    const wrong = await winner.waitFor('judged');
    check('wrong answer is judged wrong', wrong.correct === false);
    check('round continues after a wrong answer', wrong.roundOver === false);

    const resumed = await loser.waitFor('play');
    check('music resumes for everyone else', resumed.elapsedMs > 0, `${resumed.elapsedMs}ms consumed`);

    winner.forget('buzz_rejected');
    winner.send({ t: 'buzz' });
    const lockedOut = await winner.waitFor('buzz_rejected', 3_000).catch(() => null);
    check('a locked-out player cannot re-buzz', lockedOut?.reason === 'locked_out', lockedOut?.reason ?? 'none');

    await sleep(Math.max(0, resumed.startAtServerMs - Date.now()) + 200);
    loser.forget('judged');
    loser.send({ t: 'buzz' });
    await loser.waitFor('buzz_accepted');
    loser.send({ t: 'answer', text: answer });

    const right = await loser.waitFor('judged');
    check(
      `correct answer is accepted${answeringInEnglish ? ' (English title)' : ' (romaji title)'}`,
      right.correct === true,
      `answered "${answer}"`,
    );
    check('correct answer ends the round', right.roundOver === true);

    const reveal = await loser.waitFor('reveal');
    check('reveal names the anime', reveal.reveal.animeName === expected?.name, reveal.reveal.animeName);
    check(
      'reveal carries the English title for display',
      reveal.reveal.animeEnglishName === (expected?.englishName ?? null),
      reveal.reveal.animeEnglishName ?? 'none (falls back to romaji)',
    );
    check('reveal credits the winner', reveal.reveal.winnerId === loser.playerId);

    const scored = await loser.waitForRoomWhere((r) =>
      r.players.some((p) => p.id === loser.playerId && p.score === 1),
    ).catch(() => null);
    check('winner scored a point', scored !== null);

    host.close();
    guest.close();
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }

  const failed = failureCount();
  console.log(failed === 0 ? '\nall checks passed\n' : `\n${failed} check(s) failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('e2e failed:', err);
  process.exit(1);
});
