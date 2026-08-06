import path from 'node:path';
import Database from 'better-sqlite3';
import { fetchMalUnion } from '../src/mal.ts';
import {
  AnswerOracle,
  DB_PATH,
  ROOT,
  TestClient,
  check,
  failureCount,
  sleep,
  startServer,
  waitForHealth,
} from './helpers.ts';

const PORT = 8097;
const CACHE_DIR = path.join(ROOT, 'data/mal-e2e-cache');
const MAL_USER = 'Xinil';
const MAL_USER_2 = 'Kineta';
const ROUNDS = 3;

async function main(): Promise<void> {
  const db = new Database(DB_PATH, { readonly: true });
  const withMal = (db.prepare('SELECT COUNT(*) n FROM anime WHERE mal_id IS NOT NULL').get() as { n: number }).n;
  const wholeCatalogTracks = (db.prepare('SELECT COUNT(*) n FROM track').get() as { n: number }).n;
  db.close();
  if (withMal === 0) {
    console.error('Catalog has no MyAnimeList ids. Run `npm run ingest` first.');
    process.exit(1);
  }

  const { users: fixtures, malIds } = await fetchMalUnion(
    [MAL_USER, MAL_USER_2],
    ['watching', 'completed'],
  );
  const listed = new Set(malIds);
  console.log(
    `\nMyAnimeList filter end-to-end (${fixtures.map((u) => `${u.user}: ${u.entries}`).join(', ')} ` +
      `— ${listed.size} distinct)\n`,
  );

  const oracle = new AnswerOracle(CACHE_DIR);
  const server = startServer(PORT, CACHE_DIR);

  try {
    await waitForHealth(PORT);

    const host = new TestClient('host', PORT);
    const guest = new TestClient('guest', PORT);
    await host.connect('MALTEST');
    await guest.connect('MALTEST');

    guest.send({ t: 'use_list', users: [MAL_USER], statuses: ['completed'] });
    const guestTry = await guest.waitFor('error', 4_000).catch(() => null);
    check('a non-host cannot change the song pool', guestTry !== null, guestTry?.message ?? 'no error sent');

    host.send({ t: 'use_list', users: ['zzz_no_such_user_qqq'], statuses: ['completed'] });
    const bad = await host.waitFor('list_result');
    check('an unknown username is rejected', bad.ok === false, bad.message);
    host.forget('list_result');

    host.send({ t: 'use_list', users: ['../../etc/passwd'], statuses: ['completed'] });
    const malformed = await host.waitFor('list_result');
    check('a malformed username is rejected', malformed.ok === false, malformed.message);
    host.forget('list_result');

    host.send({ t: 'use_list', users: [MAL_USER, '!!!'], statuses: ['completed'] });
    const mixed = await host.waitFor('list_result');
    check('one invalid name rejects the whole set', mixed.ok === false, mixed.message);
    host.forget('list_result');

    await sleep(5_200);

    host.send({ t: 'use_list', users: [MAL_USER], statuses: ['watching', 'completed'] });
    const loaded = await host.waitFor('list_result');
    check('a single list loads', loaded.ok === true, loaded.message);
    host.forget('list_result');

    const solo = (await host.waitForRoomWhere((r) => r.listFilter !== null)).listFilter;
    check('the filter appears in the room snapshot', solo !== null);
    check('the summary names the one profile', solo?.users.length === 1 && solo.users[0]?.user === MAL_USER);

    await sleep(5_200);

    host.send({
      t: 'use_list',
      users: [MAL_USER, MAL_USER.toLowerCase()],
      statuses: ['watching', 'completed'],
    });
    const deduped = await host.waitFor('list_result');
    check('a repeated username loads', deduped.ok === true, deduped.message);
    host.forget('list_result');
    const dedupView = (await host.waitForRoomWhere((r) => r.listFilter !== null)).listFilter;
    check(
      'the same name twice collapses to one profile',
      dedupView?.users.length === 1,
      `${dedupView?.users.length} profile(s)`,
    );
    check(
      'de-duplicating changes nothing about the pool',
      dedupView?.entries === solo?.entries && dedupView?.tracks === solo?.tracks,
      `${dedupView?.entries}/${dedupView?.tracks} vs ${solo?.entries}/${solo?.tracks}`,
    );

    await sleep(5_200);

    host.send({ t: 'use_list', users: [MAL_USER, MAL_USER_2], statuses: ['watching', 'completed'] });
    const pooled = await host.waitFor('list_result');
    check('two lists load', pooled.ok === true, pooled.message);

    const summary = (await host.waitForRoomWhere(
      (r) => (r.listFilter?.users.length ?? 0) === 2,
    )).listFilter;
    check('the filter appears in the room snapshot', summary !== null);
    const guestView = await guest.waitForRoomWhere((r) => (r.listFilter?.users.length ?? 0) === 2);
    check(
      'everyone sees whose lists it is',
      guestView.listFilter?.users.map((u) => u.user).join(',') === `${MAL_USER},${MAL_USER_2}`,
      guestView.listFilter?.users.map((u) => u.user).join(', '),
    );

    if (summary && solo) {
      check('the summary reports matches', summary.matched > 0, `${summary.matched} shows`);
      check(
        'matched never exceeds the list size',
        summary.matched <= summary.entries,
        `${summary.matched}/${summary.entries}`,
      );
      check('the summary reports a track count', summary.tracks > 0, `${summary.tracks} songs`);
      check(
        'the filtered pool is smaller than the whole catalog',
        summary.tracks < wholeCatalogTracks,
        `${summary.tracks} of ${wholeCatalogTracks} songs`,
      );
      check(
        'pooling two lists widens the pool',
        summary.entries > solo.entries && summary.tracks > solo.tracks,
        `${solo.entries} shows/${solo.tracks} songs -> ${summary.entries}/${summary.tracks}`,
      );
      check(
        'shared shows are counted once',
        summary.entries < summary.users.reduce((n, u) => n + u.entries, 0),
        `${summary.entries} distinct of ${summary.users.map((u) => u.entries).join(' + ')}`,
      );
      check(
        'the union matches what we fetched independently',
        summary.entries === listed.size,
        `${summary.entries} vs ${listed.size}`,
      );
    }
    check(
      'the resolved anime ids are not sent to clients',
      !JSON.stringify(guestView).includes('animeIds'),
    );

    host.send({
      t: 'settings',
      patch: {
        totalRounds: ROUNDS,
        guessWindowMs: 5_000,
        revealMs: 2_000,
        loadTimeoutMs: 6_000,
        revealVideo: false,
      },
    });
    await sleep(150);
    host.send({ t: 'start' });

    const drawn: string[] = [];
    for (let round = 1; round <= ROUNDS; round++) {
      host.forget('round_start');
      guest.forget('round_start');
      if (round === 1) host.forget('round_start');
      await host.waitFor('round_start');

      const hit = oracle.newest();
      if (!hit) {
        check(`round ${round}: oracle resolved the track`, false);
        break;
      }
      drawn.push(hit.name);
      check(
        `round ${round} is on one of the lists — ${hit.name}`,
        hit.malId !== null && listed.has(hit.malId),
        `mal id ${hit.malId}`,
      );

      host.forget('reveal');
      host.send({ t: 'skip' });
      await host.waitFor('reveal');
    }

    check('no anime repeated within the game', new Set(drawn).size === drawn.length, drawn.join(' | '));

    host.forget('list_result');
    host.send({ t: 'clear_list' });
    const cleared = await host.waitFor('list_result', 5_000).catch(() => null);
    check('the filter can be cleared', cleared?.ok === true, cleared?.message ?? 'no reply');
    const after = await host.waitForRoomWhere((r) => r.listFilter === null).catch(() => null);
    check('the snapshot drops the filter', after !== null, `phase=${after?.phase}`);

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
  console.error('mal e2e failed:', err);
  process.exit(1);
});
