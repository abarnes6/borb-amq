import { MAX_MAL_USERS, type ListFilterUser, type MalListStatus } from '@borb/shared';
import { config } from './config.ts';

const STATUS_CODE: Record<MalListStatus, number> = {
  watching: 1,
  completed: 2,
  onhold: 3,
  dropped: 4,
  plantowatch: 6,
};

const USERNAME_RE = /^[A-Za-z0-9_-]{2,32}$/;

const PAGE_SIZE = 300;
const MAX_PAGES = 40;
const REQUEST_GAP_MS = 400;
const CACHE_TTL_MS = 10 * 60_000;

export class MalListError extends Error {}

interface MalEntry {
  anime_id: number;
  status: number;
}

interface CacheHit {
  at: number;
  malIds: number[];
  entries: number;
}

const cache = new Map<string, CacheHit>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = REQUEST_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export function normalizeMalUser(raw: string): string {
  const user = raw.trim();
  if (!USERNAME_RE.test(user)) {
    throw new MalListError(
      'That does not look like a MyAnimeList username (letters, numbers, _ and - only).',
    );
  }
  return user;
}

export function normalizeMalUsers(raw: readonly string[]): string[] {
  const users: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (entry.trim() === '') continue;
    const user = normalizeMalUser(entry);
    const key = user.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    users.push(user);
  }

  if (users.length === 0) throw new MalListError('Enter at least one MyAnimeList username.');
  if (users.length > MAX_MAL_USERS) {
    throw new MalListError(`That is more than ${MAX_MAL_USERS} lists. Remove a few.`);
  }
  return users;
}

async function fetchPage(user: string, offset: number): Promise<MalEntry[]> {
  await throttle();

  // The endpoint MAL's own list page calls. Undocumented; status=7 means all.
  const url = `https://myanimelist.net/animelist/${encodeURIComponent(user)}/load.json?offset=${offset}&status=7`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': config.ingestUserAgent },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MalListError('Could not reach MyAnimeList. Try again in a moment.');
  }

  if (res.status === 400 || res.status === 404) {
    throw new MalListError(`No public list for "${user}". Check the spelling, and that the list is public.`);
  }
  if (res.status === 429 || res.status === 403) {
    throw new MalListError('MyAnimeList is rate limiting us. Wait a minute and try again.');
  }
  if (!res.ok) {
    throw new MalListError(`MyAnimeList returned ${res.status}. Try again later.`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new MalListError('MyAnimeList sent something unreadable. The endpoint may have changed.');
  }
  if (!Array.isArray(body)) {
    throw new MalListError('MyAnimeList sent an unexpected shape. The endpoint may have changed.');
  }

  return body.filter(
    (e): e is MalEntry =>
      typeof e === 'object' && e !== null &&
      typeof (e as MalEntry).anime_id === 'number' &&
      typeof (e as MalEntry).status === 'number',
  );
}

export async function fetchMalAnimeIds(
  rawUser: string,
  statuses: readonly MalListStatus[],
): Promise<{ malIds: number[]; entries: number }> {
  const user = normalizeMalUser(rawUser);
  if (statuses.length === 0) {
    throw new MalListError('Pick at least one list status.');
  }

  const key = `${user.toLowerCase()}|${[...statuses].sort().join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { malIds: hit.malIds, entries: hit.entries };
  }

  const wanted = new Set(statuses.map((s) => STATUS_CODE[s]));
  const ids = new Set<number>();
  let entries = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await fetchPage(user, page * PAGE_SIZE);

    for (const row of rows) {
      if (!wanted.has(row.status)) continue;
      entries++;
      ids.add(row.anime_id);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  const malIds = [...ids];
  cache.set(key, { at: Date.now(), malIds, entries });
  return { malIds, entries };
}

export async function fetchMalUnion(
  rawUsers: readonly string[],
  statuses: readonly MalListStatus[],
): Promise<{ users: ListFilterUser[]; malIds: number[] }> {
  const names = normalizeMalUsers(rawUsers);
  const ids = new Set<number>();
  const users: ListFilterUser[] = [];

  for (const user of names) {
    const { malIds, entries } = await fetchMalAnimeIds(user, statuses);
    for (const id of malIds) ids.add(id);
    users.push({ user, entries });
  }

  return { users, malIds: [...ids] };
}
