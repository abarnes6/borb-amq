export interface FetchStats {
  requests: number;
  retries: number;
  lastRemaining: number | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AnimeThemesClient {
  readonly stats: FetchStats = { requests: 0, retries: 0, lastRemaining: null };
  private nextAllowedAt = 0;
  private readonly minIntervalMs: number;

  constructor(
    private readonly userAgent: string,
    requestsPerMinute: number,
  ) {
    this.minIntervalMs = Math.ceil(60_000 / Math.max(1, requestsPerMinute));
  }

  async getJson<T>(url: string): Promise<T> {
    const maxAttempts = 5;
    let attempt = 0;

    for (;;) {
      attempt++;
      await this.throttle();

      let res: Response;
      try {
        res = await fetch(url, {
          headers: { accept: 'application/json', 'user-agent': this.userAgent },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        this.stats.retries++;
        await sleep(backoffMs(attempt));
        continue;
      }

      this.stats.requests++;
      const remaining = res.headers.get('x-ratelimit-remaining');
      this.stats.lastRemaining = remaining === null ? null : Number.parseInt(remaining, 10);

      if (this.stats.lastRemaining !== null && this.stats.lastRemaining <= 5) {
        this.nextAllowedAt = Date.now() + 20_000;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) {
          throw new Error(`AnimeThemes ${res.status} after ${attempt} attempts: ${url}`);
        }
        const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
        const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffMs(attempt);
        this.stats.retries++;
        console.warn(`  ${res.status} from API, retrying in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`AnimeThemes ${res.status} ${res.statusText}: ${url}`);
      }

      return (await res.json()) as T;
    }
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    if (now < this.nextAllowedAt) await sleep(this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(Date.now(), this.nextAllowedAt) + this.minIntervalMs;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 2 ** attempt * 1000) + Math.floor(Math.random() * 500);
}

export interface ApiAudio {
  id: number;
  link: string;
  basename: string;
  size: number | null;
}

export interface ApiVideo {
  id: number;
  link: string;
  basename: string;
  overlap: string | null;
  source: string | null;
  audio: ApiAudio | null;
}

export interface ApiEntry {
  id: number;
  version: number | null;
  nsfw: boolean;
  spoiler: boolean;
  videos: ApiVideo[];
}

export interface ApiTheme {
  id: number;
  type: string;
  sequence: number | null;
  slug: string;
  song: { id: number; title: string | null; artists?: { name: string }[] } | null;
  animethemeentries: ApiEntry[];
}

export interface ApiResource {
  id: number;
  site: string;
  external_id: number | null;
}

export interface ApiAnime {
  id: number;
  name: string;
  slug: string;
  year: number | null;
  season: string | null;
  media_format: string | null;
  animethemes: ApiTheme[];
  animesynonyms: { id: number; text: string }[];
  resources: ApiResource[];
}

export interface AnimePage {
  anime: ApiAnime[];
  links: { next: string | null };
}
