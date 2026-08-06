export type PlayerId = string;
export type ThemeType = 'OP' | 'ED' | 'IN';

export const THEME_TYPES: ThemeType[] = ['OP', 'ED', 'IN'];

export type MalListStatus = 'watching' | 'completed' | 'onhold' | 'dropped' | 'plantowatch';

export const MAL_LIST_STATUSES: MalListStatus[] = [
  'watching',
  'completed',
  'onhold',
  'dropped',
  'plantowatch',
];

export const MAL_STATUS_LABEL: Record<MalListStatus, string> = {
  watching: 'Watching',
  completed: 'Completed',
  onhold: 'On hold',
  dropped: 'Dropped',
  plantowatch: 'Plan to watch',
};

export const DEFAULT_MAL_STATUSES: MalListStatus[] = ['watching', 'completed'];

export const MAX_MAL_USERS = 8;

export interface ListFilterUser {
  user: string;
  entries: number;
}

export interface ListFilterSummary {
  source: 'mal';
  users: ListFilterUser[];
  statuses: MalListStatus[];
  entries: number;
  matched: number;
  tracks: number;
}

export function formatNameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function possessiveLists(names: readonly string[]): string {
  return `${formatNameList(names)}'s ${names.length === 1 ? 'list' : 'lists'}`;
}

export type RoomPhase =
  | 'LOBBY'
  | 'LOADING'
  | 'PLAYING'
  | 'ANSWERING'
  | 'REVEAL';

export interface RoomSettings {
  totalRounds: number;
  guessWindowMs: number;
  answerMs: number;
  revealMs: number;
  loadTimeoutMs: number;
  themeTypes: ThemeType[];
  yearMin: number | null;
  yearMax: number | null;
  excludeNsfw: boolean;
  revealVideo: boolean;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  totalRounds: 10,
  guessWindowMs: 30_000,
  answerMs: 10_000,
  revealMs: 15_000,
  loadTimeoutMs: 10_000,
  themeTypes: ['OP', 'ED'],
  yearMin: null,
  yearMax: null,
  excludeNsfw: true,
  revealVideo: true,
};

export interface PublicPlayer {
  id: PlayerId;
  name: string;
  avatar: string | null;
  score: number;
  connected: boolean;
  ready: boolean;
  lockedOut: boolean;
  spectating: boolean;
  isHost: boolean;
}

export interface RoundPublicState {
  n: number;
  lockedBy: PlayerId | null;
  answerDeadlineServerMs: number | null;
  revealEndsAtServerMs: number | null;
}

export type VoteKind = 'skip_reveal' | 'to_lobby';

export interface VoteState {
  skipReveal: PlayerId[];
  toLobby: PlayerId[];
  needed: number;
}

export interface RoomSnapshot {
  id: string;
  phase: RoomPhase;
  settings: RoomSettings;
  players: PublicPlayer[];
  hostId: PlayerId | null;
  listFilter: ListFilterSummary | null;
  votes: VoteState;
  round: RoundPublicState | null;
  serverNowMs: number;
}

export interface RevealPayload {
  animeName: string;
  animeEnglishName: string | null;
  animeTitles: string[];
  year: number | null;
  season: string | null;
  themeType: ThemeType;
  themeSlug: string;
  songTitle: string | null;
  artists: string[];
  audioUrl: string;
  videoUrl: string | null;
  videoStreamUrl: string | null;
  videoStartMs: number;
  winnerId: PlayerId | null;
}

export type ClientMessage =
  | {
      t: 'join';
      roomId: string;
      name: string;
      avatar?: string;
      playerId?: PlayerId;
      sessionKey?: string;
    }
  | { t: 'avatar'; emoji: string }
  | { t: 'ping'; clientTime: number }
  | { t: 'settings'; patch: Partial<RoomSettings> }
  | { t: 'start' }
  | { t: 'ready'; token: string }
  | { t: 'buzz' }
  | { t: 'answer'; text: string }
  | { t: 'skip' }
  | { t: 'use_list'; users: string[]; statuses: MalListStatus[] }
  | { t: 'clear_list' }
  | { t: 'vote'; kind: VoteKind; on: boolean };

export type BuzzRejectReason =
  | 'not_playing'
  | 'already_locked'
  | 'locked_out'
  | 'spectating';

export type ServerMessage
  = { t: 'welcome'; playerId: PlayerId; sessionKey: string; room: RoomSnapshot }
  | { t: 'room'; room: RoomSnapshot }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'round_start'; n: number; totalRounds: number; mediaUrl: string; token: string }
  | { t: 'play'; startAtServerMs: number; seekMs: number; elapsedMs: number }
  | { t: 'buzz_accepted'; playerId: PlayerId; deadlineServerMs: number }
  | { t: 'buzz_rejected'; reason: BuzzRejectReason }
  | { t: 'judged'; playerId: PlayerId; text: string; correct: boolean; roundOver: boolean }
  | { t: 'reveal'; reveal: RevealPayload; nextInMs: number }
  | { t: 'reveal_video'; url: string }
  | { t: 'list_result'; ok: boolean; message: string }
  | { t: 'error'; message: string };

export const MAX_AVATAR_LENGTH = 24;

let segmenter: Intl.Segmenter | null | undefined;

// [...text][0] would split ZWJ emoji and flags mid-sequence.
export function firstGrapheme(text: string): string {
  if (!text) return '';
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter() : null;
  }
  if (!segmenter) return [...text][0] ?? '';
  for (const { segment } of segmenter.segment(text)) return segment;
  return '';
}

// Escapes rather than literals: half of these characters are invisible.
const AVATAR_KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/u;
const AVATAR_FLAG = /^\p{RI}\p{RI}$/u;
const AVATAR_EMOJI =
  /^[\p{Extended_Pictographic}\u200D\uFE0E\uFE0F\p{Emoji_Modifier}\u{E0020}-\u{E007F}]+$/u;

export function sanitizeAvatar(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const one = firstGrapheme(raw.trim());
  if (!one || one.length > MAX_AVATAR_LENGTH) return null;
  if (AVATAR_KEYCAP.test(one) || AVATAR_FLAG.test(one)) return one;
  if (!/\p{Extended_Pictographic}/u.test(one)) return null;
  return AVATAR_EMOJI.test(one) ? one : null;
}

export function displayTitle(
  englishName: string | null | undefined,
  romajiName: string,
): { primary: string; secondary: string | null } {
  const english = englishName?.trim();
  if (!english) return { primary: romajiName, secondary: null };
  const secondary = normalizeTitle(english) === normalizeTitle(romajiName) ? null : romajiName;
  return { primary: english, secondary };
}

export function normalizeTitle(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’ʼ`´']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function editDistance(a: string, b: string, max = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const row = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let diag = row[0] as number;
    row[0] = i;
    let left = i;
    let rowMin = i;
    const ai = a.charCodeAt(i - 1);

    for (let j = 1; j <= b.length; j++) {
      const up = row[j] as number;
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const val = Math.min(up + 1, left + 1, diag + cost);
      row[j] = val;
      diag = up;
      left = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > max) return max + 1;
  }
  return row[b.length] as number;
}

export function typoBudget(normalizedTitle: string): number {
  const n = normalizedTitle.length;
  if (n <= 6) return 0;
  if (n <= 14) return 1;
  return 2;
}

export function matchesAnyTitle(
  guess: string,
  acceptedNormalized: readonly string[],
): string | null {
  const g = normalizeTitle(guess);
  if (!g) return null;

  for (const title of acceptedNormalized) {
    if (title === g) return title;
  }
  for (const title of acceptedNormalized) {
    const budget = typoBudget(title);
    if (budget > 0 && editDistance(g, title, budget) <= budget) return title;
  }
  return null;
}
