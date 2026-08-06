import { normalizeTitle } from '@borb/shared';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { AnimeThemesClient, type AnimePage, type ApiAnime, type ApiTheme, type ApiVideo } from './client.ts';
import { backfillEnglishTitles, englishTitleCoverage } from './english.ts';

const API = 'https://api.animethemes.moe';

function firstPageUrl(pageSize: number): string {
  const p = new URLSearchParams();
  p.set('page[size]', String(pageSize));
  p.set('filter[has]', 'animethemes');
  p.set(
    'include',
    'animesynonyms,resources,animethemes.song.artists,animethemes.animethemeentries.videos.audio',
  );
  p.set('fields[anime]', 'id,name,slug,year,season,media_format');
  p.set('fields[synonym]', 'id,text'); // not 'animesynonym', which 422s the whole request
  p.set('fields[resource]', 'id,site,external_id');
  p.set('fields[animetheme]', 'id,type,sequence,slug');
  p.set('fields[song]', 'id,title');
  p.set('fields[artist]', 'id,name');
  p.set('fields[animethemeentry]', 'id,version,nsfw,spoiler');
  p.set('fields[video]', 'id,basename,link,overlap,source');
  p.set('fields[audio]', 'id,basename,link,size');
  return `${API}/anime?${p.toString()}`;
}

const upsertAnime = db.prepare(`
  INSERT INTO anime (id, slug, name, year, season, media_format, mal_id)
  VALUES (@id, @slug, @name, @year, @season, @media_format, @mal_id)
  ON CONFLICT(id) DO UPDATE SET
    slug = excluded.slug, name = excluded.name, year = excluded.year,
    season = excluded.season, media_format = excluded.media_format,
    mal_id = excluded.mal_id`);

const deleteTitles = db.prepare('DELETE FROM anime_title WHERE anime_id = ?');
const insertTitle = db.prepare(`
  INSERT OR IGNORE INTO anime_title (anime_id, title, normalized, kind)
  VALUES (?, ?, ?, ?)`);

const upsertTheme = db.prepare(`
  INSERT INTO theme (id, anime_id, type, sequence, slug, song_title, artists)
  VALUES (@id, @anime_id, @type, @sequence, @slug, @song_title, @artists)
  ON CONFLICT(id) DO UPDATE SET
    anime_id = excluded.anime_id, type = excluded.type, sequence = excluded.sequence,
    slug = excluded.slug, song_title = excluded.song_title, artists = excluded.artists`);

const deleteThemeTracks = db.prepare('DELETE FROM track WHERE theme_id = ?');
const upsertTrack = db.prepare(`
  INSERT INTO track (id, theme_id, video_id, audio_url, video_url, audio_bytes, nsfw, spoiler)
  VALUES (@id, @theme_id, @video_id, @audio_url, @video_url, @audio_bytes, @nsfw, @spoiler)
  ON CONFLICT(id) DO UPDATE SET
    theme_id = excluded.theme_id, video_id = excluded.video_id,
    audio_url = excluded.audio_url, video_url = excluded.video_url,
    audio_bytes = excluded.audio_bytes, nsfw = excluded.nsfw, spoiler = excluded.spoiler`);

const setIngestState = db.prepare(`
  INSERT INTO ingest_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

interface Chosen {
  video: ApiVideo;
  nsfw: boolean;
  spoiler: boolean;
}

function chooseTrack(theme: ApiTheme): Chosen | null {
  const candidates: Chosen[] = [];
  for (const entry of theme.animethemeentries ?? []) {
    for (const video of entry.videos ?? []) {
      if (!video.audio?.link) continue;
      candidates.push({ video, nsfw: entry.nsfw, spoiler: entry.spoiler });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const rank = (c: Chosen) =>
      (c.nsfw ? 8 : 0) + (c.spoiler ? 4 : 0) + (c.video.overlap === 'None' ? 0 : 1);
    return rank(a) - rank(b);
  });
  return candidates[0] ?? null;
}

function themeType(raw: string): 'OP' | 'ED' | 'IN' | null {
  return raw === 'OP' || raw === 'ED' || raw === 'IN' ? raw : null;
}

function malIdOf(anime: ApiAnime): number | null {
  for (const r of anime.resources ?? []) {
    if (r.site === 'MyAnimeList' && typeof r.external_id === 'number') return r.external_id;
  }
  return null;
}

const writePage = db.transaction((animeList: ApiAnime[]) => {
  let themes = 0;
  let tracks = 0;
  let mapped = 0;

  for (const anime of animeList) {
    const malId = malIdOf(anime);
    if (malId !== null) mapped++;
    upsertAnime.run({
      id: anime.id,
      slug: anime.slug,
      name: anime.name,
      year: anime.year,
      season: anime.season,
      media_format: anime.media_format,
      mal_id: malId,
    });

    deleteTitles.run(anime.id);
    const mainNorm = normalizeTitle(anime.name);
    if (mainNorm) insertTitle.run(anime.id, anime.name, mainNorm, 'main');
    for (const syn of anime.animesynonyms ?? []) {
      const n = normalizeTitle(syn.text ?? '');
      if (n) insertTitle.run(anime.id, syn.text, n, 'synonym');
    }

    for (const theme of anime.animethemes ?? []) {
      const type = themeType(theme.type);
      if (!type) continue;

      upsertTheme.run({
        id: theme.id,
        anime_id: anime.id,
        type,
        sequence: theme.sequence,
        slug: theme.slug,
        song_title: theme.song?.title ?? null,
        artists: JSON.stringify((theme.song?.artists ?? []).map((a) => a.name)),
      });
      themes++;

      const chosen = chooseTrack(theme);
      deleteThemeTracks.run(theme.id);
      if (!chosen?.video.audio) continue;

      upsertTrack.run({
        id: chosen.video.audio.id,
        theme_id: theme.id,
        video_id: chosen.video.id,
        audio_url: chosen.video.audio.link,
        video_url: chosen.video.link,
        audio_bytes: chosen.video.audio.size,
        nsfw: chosen.nsfw ? 1 : 0,
        spoiler: chosen.spoiler ? 1 : 0,
      });
      tracks++;
    }
  }
  return { themes, tracks, mapped };
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pagesFlag = args.indexOf('--pages');
  const maxPages = pagesFlag >= 0 ? Number.parseInt(args[pagesFlag + 1] ?? '', 10) : Infinity;
  const pageSize = 100;

  if (config.ingestUserAgent.includes('set INGEST_USER_AGENT')) {
    console.warn(
      'INGEST_USER_AGENT is unset. Please set a contact address in .env so AnimeThemes\n' +
        'can reach you about this traffic rather than blocking it.\n',
    );
  }

  const client = new AnimeThemesClient(config.ingestUserAgent, config.ingestRpm);
  let url: string | null = firstPageUrl(pageSize);
  let page = 0;
  let animeCount = 0;
  let themeCount = 0;
  let trackCount = 0;
  let malCount = 0;
  const startedAt = Date.now();

  console.log(`Ingesting from AnimeThemes at ~${config.ingestRpm} req/min into ${config.dbPath}`);

  while (url && page < maxPages) {
    const body: AnimePage = await client.getJson<AnimePage>(url);
    page++;

    const { themes, tracks, mapped } = writePage(body.anime);
    animeCount += body.anime.length;
    themeCount += themes;
    trackCount += tracks;
    malCount += mapped;

    const budget = client.stats.lastRemaining ?? '?';
    console.log(
      `  page ${page}: +${body.anime.length} anime, +${themes} themes, +${tracks} tracks ` +
        `(total ${animeCount}/${themeCount}/${trackCount}, rate budget ${budget})`,
    );

    url = body.links?.next ?? null;
  }

  const elapsedS = Math.round((Date.now() - startedAt) / 1000);
  setIngestState.run('last_completed_at', new Date().toISOString());
  setIngestState.run('last_anime_count', String(animeCount));

  console.log(
    `\nDone in ${elapsedS}s — ${animeCount} anime, ${themeCount} themes, ${trackCount} playable tracks ` +
      `across ${client.stats.requests} requests (${client.stats.retries} retries).`,
  );
  console.log(`${malCount} anime carry a MyAnimeList id, so list filters can match them.`);
  if (Number.isFinite(maxPages)) {
    console.log('Partial ingest (--pages). Run without --pages for the full catalog.');
  }

  if (args.includes('--skip-english')) {
    console.log('\nSkipping English titles (--skip-english). Run `npm run ingest:english` later.');
  } else {
    console.log('');
    try {
      const result = await backfillEnglishTitles();
      const coverage = englishTitleCoverage();
      console.log(
        `${result.matched} English titles added — ${coverage.withEnglish} of ${coverage.total} anime have one.`,
      );
    } catch (err) {
      console.warn('English titles could not be fetched; the catalog still works.', err);
      console.warn('Retry with `npm run ingest:english`.');
    }
  }

  db.close();
}

main().catch((err: unknown) => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
