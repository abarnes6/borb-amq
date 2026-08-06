import { displayTitle, normalizeTitle } from '@borb/shared';

interface RawEntry {
  i: number;
  t: string;
  e?: string;
  a?: string[];
  y?: number;
}

export interface TitleEntry {
  id: number;
  label: string;
  secondary: string | null;
  year?: number;
  keys: string[];
}

export async function loadTitleIndex(): Promise<TitleEntry[]> {
  const res = await fetch('/api/titles');
  if (!res.ok) throw new Error(`title index unavailable (${res.status})`);
  const raw = (await res.json()) as RawEntry[];

  return raw.map((entry) => {
    const { primary, secondary } = displayTitle(entry.e, entry.t);
    return {
      id: entry.i,
      label: primary,
      secondary,
      ...(entry.y === undefined ? {} : { year: entry.y }),
      keys: [primary, entry.t, ...(entry.a ?? [])]
        .map(normalizeTitle)
        .filter((k) => k.length > 0),
    };
  });
}

export function searchTitles(index: readonly TitleEntry[], query: string, limit = 16): TitleEntry[] {
  const q = normalizeTitle(query);
  if (q.length === 0) return [];

  const scored: { entry: TitleEntry; score: number }[] = [];

  for (const entry of index) {
    let best = Infinity;
    for (const key of entry.keys) {
      if (key === q) {
        best = 0;
        break;
      }
      if (key.startsWith(q)) best = Math.min(best, 1);
      else if (key.includes(` ${q}`)) best = Math.min(best, 2);
      else if (key.includes(q)) best = Math.min(best, 3);
    }
    if (best !== Infinity) scored.push({ entry, score: best });
  }

  scored.sort((a, b) => a.score - b.score || a.entry.label.length - b.entry.label.length);
  return scored.slice(0, limit).map((s) => s.entry);
}
