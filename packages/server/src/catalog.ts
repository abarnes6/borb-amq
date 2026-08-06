import type { RoomSettings, ThemeType } from '@borb/shared';
import { db } from './db.ts';

export interface TrackRow {
  trackId: number;
  themeId: number;
  animeId: number;
  audioUrl: string;
  videoUrl: string | null;
  durationS: number | null;
  animeName: string;
  animeEnglishName: string | null;
  year: number | null;
  season: string | null;
  themeType: ThemeType;
  themeSlug: string;
  songTitle: string | null;
  artists: string[];
}

interface RawTrackRow {
  trackId: number;
  themeId: number;
  animeId: number;
  audio_url: string;
  video_url: string | null;
  duration_s: number | null;
  name: string;
  english_name: string | null;
  year: number | null;
  season: string | null;
  type: ThemeType;
  slug: string;
  song_title: string | null;
  artists: string;
}

function parseArtists(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function hydrate(r: RawTrackRow): TrackRow {
  return {
    trackId: r.trackId,
    themeId: r.themeId,
    animeId: r.animeId,
    audioUrl: r.audio_url,
    videoUrl: r.video_url,
    durationS: r.duration_s,
    animeName: r.name,
    animeEnglishName: r.english_name,
    year: r.year,
    season: r.season,
    themeType: r.type,
    themeSlug: r.slug,
    songTitle: r.song_title,
    artists: parseArtists(r.artists),
  };
}

const SELECT_TRACK = `
  SELECT t.id AS trackId, t.theme_id AS themeId, th.anime_id AS animeId,
         t.audio_url, t.video_url, t.duration_s,
         a.name, a.english_name, a.year, a.season,
         th.type, th.slug, th.song_title, th.artists
  FROM track t
  JOIN theme th ON th.id = t.theme_id
  JOIN anime a  ON a.id  = th.anime_id
`;

function poolWhere(
  settings: RoomSettings,
  excludeAnimeIds: ReadonlySet<number>,
  restrictAnimeIds: readonly number[] | null,
): { where: string[]; params: (string | number)[] } {
  const types = settings.themeTypes.length > 0 ? settings.themeTypes : (['OP', 'ED', 'IN'] as ThemeType[]);
  const params: (string | number)[] = [];
  const where: string[] = [];

  where.push(`th.type IN (${types.map(() => '?').join(',')})`);
  params.push(...types);

  if (settings.yearMin !== null) {
    where.push('a.year >= ?');
    params.push(settings.yearMin);
  }
  if (settings.yearMax !== null) {
    where.push('a.year <= ?');
    params.push(settings.yearMax);
  }
  if (settings.excludeNsfw) {
    where.push('t.nsfw = 0');
  }

  if (restrictAnimeIds !== null) {
    where.push('th.anime_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(restrictAnimeIds));
  }

  const excluded = [...excludeAnimeIds];
  if (excluded.length > 0) {
    where.push(`th.anime_id NOT IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(excluded));
  }

  return { where, params };
}

export function pickRandomTrack(
  settings: RoomSettings,
  excludeAnimeIds: ReadonlySet<number>,
  restrictAnimeIds: readonly number[] | null = null,
): TrackRow | null {
  const { where, params } = poolWhere(settings, excludeAnimeIds, restrictAnimeIds);
  const sql = `${SELECT_TRACK} WHERE ${where.join(' AND ')} ORDER BY RANDOM() LIMIT 1`;
  const row = db.prepare(sql).get(...params) as RawTrackRow | undefined;
  return row ? hydrate(row) : null;
}

export function countPlayable(
  settings: RoomSettings,
  restrictAnimeIds: readonly number[] | null = null,
): number {
  const { where, params } = poolWhere(settings, new Set(), restrictAnimeIds);
  const sql = `
    SELECT COUNT(*) AS n
    FROM track t
    JOIN theme th ON th.id = t.theme_id
    JOIN anime a  ON a.id  = th.anime_id
    WHERE ${where.join(' AND ')}`;
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function catalogHasMalIds(): boolean {
  const row = db.prepare('SELECT EXISTS(SELECT 1 FROM anime WHERE mal_id IS NOT NULL) AS ok').get() as
    | { ok: number }
    | undefined;
  return row?.ok === 1;
}

export function resolveMalIds(malIds: readonly number[]): { animeIds: number[] } {
  if (malIds.length === 0) return { animeIds: [] };
  const rows = db
    .prepare(
      `SELECT DISTINCT a.id AS id
       FROM anime a
       JOIN theme th ON th.anime_id = a.id
       JOIN track t  ON t.theme_id  = th.id
       WHERE a.mal_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(malIds)) as { id: number }[];
  return { animeIds: rows.map((r) => r.id) };
}

export function acceptedTitles(animeId: number): { normalized: string[]; display: string[] } {
  const rows = db
    .prepare('SELECT title, normalized FROM anime_title WHERE anime_id = ?')
    .all(animeId) as { title: string; normalized: string }[];
  return {
    normalized: rows.map((r) => r.normalized).filter((s) => s.length > 0),
    display: rows.map((r) => r.title),
  };
}

export function setTrackDuration(trackId: number, seconds: number): void {
  db.prepare('UPDATE track SET duration_s = ? WHERE id = ?').run(seconds, trackId);
}

export interface TitleIndexEntry {
  i: number;
  t: string;
  e?: string;
  a?: string[];
  y?: number;
}

export function buildTitleIndex(): TitleIndexEntry[] {
  const anime = db
    .prepare(
      `SELECT DISTINCT a.id, a.name, a.english_name, a.year
       FROM anime a
       JOIN theme th ON th.anime_id = a.id
       JOIN track t  ON t.theme_id  = th.id
       ORDER BY a.name`,
    )
    .all() as { id: number; name: string; english_name: string | null; year: number | null }[];

  const synRows = db
    .prepare(`SELECT anime_id, title FROM anime_title WHERE kind = 'synonym'`)
    .all() as { anime_id: number; title: string }[];

  const syns = new Map<number, string[]>();
  for (const r of synRows) {
    const list = syns.get(r.anime_id);
    if (list) list.push(r.title);
    else syns.set(r.anime_id, [r.title]);
  }

  return anime.map((a) => {
    const entry: TitleIndexEntry = { i: a.id, t: a.name };
    if (a.english_name) entry.e = a.english_name;
    const alt = syns.get(a.id);
    if (alt && alt.length > 0) entry.a = alt;
    if (a.year !== null) entry.y = a.year;
    return entry;
  });
}

export function logBuzz(row: {
  roomId: string;
  roundN: number;
  trackId: number | null;
  playerName: string;
  msIntoRound: number;
  answer: string | null;
  correct: boolean | null;
}): void {
  db.prepare(
    `INSERT INTO buzz_log
       (room_id, round_n, track_id, player_name, ms_into_round, answer, correct, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.roomId,
    row.roundN,
    row.trackId,
    row.playerName,
    Math.round(row.msIntoRound),
    row.answer,
    row.correct === null ? null : row.correct ? 1 : 0,
    Date.now(),
  );
}

export function catalogStats(): { anime: number; themes: number; tracks: number; lastIngest: string | null } {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const state = db.prepare('SELECT value FROM ingest_state WHERE key = ?').get('last_completed_at') as
    | { value: string }
    | undefined;
  return {
    anime: one('SELECT COUNT(*) AS n FROM anime'),
    themes: one('SELECT COUNT(*) AS n FROM theme'),
    tracks: one('SELECT COUNT(*) AS n FROM track'),
    lastIngest: state?.value ?? null,
  };
}
