import { normalizeTitle } from '@borb/shared';
import { config } from '../config.ts';
import { db } from '../db.ts';

const ANILIST_URL = 'https://graphql.anilist.co';

const BATCH = 50;

const REQUESTS_PER_MINUTE = 22;
const GAP_MS = Math.ceil(60_000 / REQUESTS_PER_MINUTE);

const QUERY = `
  query ($ids: [Int]) {
    Page(page: 1, perPage: ${BATCH}) {
      media(idMal_in: $ids, type: ANIME) {
        idMal
        title { english romaji }
      }
    }
  }`;

interface AniListMedia {
  idMal: number | null;
  title: { english: string | null; romaji: string | null } | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const setEnglish = db.prepare('UPDATE anime SET english_name = ? WHERE id = ?');
const addTitle = db.prepare(`
  INSERT OR IGNORE INTO anime_title (anime_id, title, normalized, kind)
  VALUES (?, ?, ?, 'synonym')`);

const applyBatch = db.transaction((rows: { animeId: number; english: string }[]) => {
  for (const row of rows) {
    setEnglish.run(row.english, row.animeId);
    const normalized = normalizeTitle(row.english);
    if (normalized) addTitle.run(row.animeId, row.english, normalized);
  }
});

async function fetchBatch(malIds: number[], attempt = 1): Promise<AniListMedia[]> {
  let res: Response;
  try {
    res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': config.ingestUserAgent,
      },
      body: JSON.stringify({ query: QUERY, variables: { ids: malIds } }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(2 ** attempt * 1000);
    return fetchBatch(malIds, attempt + 1);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`AniList ${res.status} after ${attempt} attempts`);
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const waitMs = Number.isFinite(retryAfter) ? (retryAfter + 1) * 1000 : 2 ** attempt * 2000;
    console.warn(`  ${res.status} from AniList, waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    return fetchBatch(malIds, attempt + 1);
  }
  if (!res.ok) throw new Error(`AniList ${res.status} ${res.statusText}`);

  const body = (await res.json()) as {
    data?: { Page?: { media?: AniListMedia[] } };
    errors?: { message: string }[];
  };
  if (body.errors?.length) {
    throw new Error(`AniList error: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data?.Page?.media ?? [];
}

export interface EnglishBackfillResult {
  considered: number;
  matched: number;
  requests: number;
}

export async function backfillEnglishTitles(all = false): Promise<EnglishBackfillResult> {
  const rows = db
    .prepare(
      `SELECT id, mal_id FROM anime
       WHERE mal_id IS NOT NULL ${all ? '' : 'AND english_name IS NULL'}
       ORDER BY id`,
    )
    .all() as { id: number; mal_id: number }[];

  if (rows.length === 0) return { considered: 0, matched: 0, requests: 0 };

  const byMalId = new Map<number, number>();
  for (const r of rows) byMalId.set(r.mal_id, r.id);

  const malIds = [...byMalId.keys()];
  const totalBatches = Math.ceil(malIds.length / BATCH);
  let matched = 0;
  let requests = 0;

  console.log(
    `Fetching English titles from AniList for ${malIds.length} anime ` +
      `(${totalBatches} requests at ~${REQUESTS_PER_MINUTE}/min)`,
  );

  for (let i = 0; i < malIds.length; i += BATCH) {
    if (requests > 0) await sleep(GAP_MS);
    const slice = malIds.slice(i, i + BATCH);
    const media = await fetchBatch(slice);
    requests++;

    const updates: { animeId: number; english: string }[] = [];
    for (const m of media) {
      const english = m.title?.english?.trim();
      const animeId = m.idMal === null ? undefined : byMalId.get(m.idMal);
      if (!english || animeId === undefined) continue;
      updates.push({ animeId, english });
    }
    applyBatch(updates);
    matched += updates.length;

    const batchNo = Math.floor(i / BATCH) + 1;
    if (batchNo % 10 === 0 || batchNo === totalBatches) {
      console.log(`  ${batchNo}/${totalBatches} batches — ${matched} English titles so far`);
    }
  }

  return { considered: malIds.length, matched, requests };
}

export function englishTitleCoverage(): { withEnglish: number; total: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN english_name IS NOT NULL THEN 1 ELSE 0 END) AS withEnglish
       FROM anime`,
    )
    .get() as { total: number; withEnglish: number | null };
  return { withEnglish: row.withEnglish ?? 0, total: row.total };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = process.argv.includes('--all');
  backfillEnglishTitles(all)
    .then((result) => {
      const coverage = englishTitleCoverage();
      console.log(
        `\nDone — ${result.matched} English titles from ${result.requests} requests.\n` +
          `${coverage.withEnglish} of ${coverage.total} anime now have one.`,
      );
      db.close();
    })
    .catch((err: unknown) => {
      console.error('English title backfill failed:', err);
      process.exit(1);
    });
}
