import {
  MAL_LIST_STATUSES,
  MAX_AVATAR_LENGTH,
  type ClientMessage,
  type MalListStatus,
  type RoomSettings,
  type ThemeType,
} from '@borb/shared';

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseSettingsPatch(raw: unknown): Partial<RoomSettings> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const src = raw as Record<string, unknown>;
  const patch: Partial<RoomSettings> = {};

  for (const key of ['totalRounds', 'guessWindowMs', 'answerMs', 'revealMs', 'loadTimeoutMs'] as const) {
    if (isNum(src[key])) patch[key] = src[key] as number;
  }
  if (Array.isArray(src.themeTypes)) {
    patch.themeTypes = src.themeTypes.filter(
      (t): t is ThemeType => t === 'OP' || t === 'ED' || t === 'IN',
    );
  }
  for (const key of ['yearMin', 'yearMax'] as const) {
    if (src[key] === null || isNum(src[key])) patch[key] = src[key] as number | null;
  }
  if (typeof src.excludeNsfw === 'boolean') patch.excludeNsfw = src.excludeNsfw;
  if (typeof src.revealVideo === 'boolean') patch.revealVideo = src.revealVideo;

  return patch;
}

export function parseClientMessage(data: string): ClientMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'join':
      if (!isStr(m.roomId) || !isStr(m.name)) return null;
      return {
        t: 'join',
        roomId: m.roomId,
        name: m.name,
        ...(isStr(m.avatar) ? { avatar: m.avatar.slice(0, MAX_AVATAR_LENGTH) } : {}),
        ...(isStr(m.playerId) ? { playerId: m.playerId } : {}),
        ...(isStr(m.sessionKey) ? { sessionKey: m.sessionKey } : {}),
      };
    case 'avatar':
      return isStr(m.emoji) ? { t: 'avatar', emoji: m.emoji.slice(0, MAX_AVATAR_LENGTH) } : null;
    case 'ping':
      return isNum(m.clientTime) ? { t: 'ping', clientTime: m.clientTime } : null;
    case 'settings': {
      const patch = parseSettingsPatch(m.patch);
      return patch ? { t: 'settings', patch } : null;
    }
    case 'start':
      return { t: 'start' };
    case 'ready':
      return isStr(m.token) ? { t: 'ready', token: m.token } : null;
    case 'buzz':
      return { t: 'buzz' };
    case 'answer':
      return isStr(m.text) ? { t: 'answer', text: m.text } : null;
    case 'skip':
      return { t: 'skip' };
    case 'use_list': {
      if (!Array.isArray(m.users)) return null;
      const statuses = Array.isArray(m.statuses)
        ? m.statuses.filter((s): s is MalListStatus =>
            typeof s === 'string' && (MAL_LIST_STATUSES as string[]).includes(s),
          )
        : [];
      const users = m.users.filter(isStr).slice(0, 32).map((u) => u.slice(0, 64));
      return { t: 'use_list', users, statuses };
    }
    case 'clear_list':
      return { t: 'clear_list' };
    case 'vote':
      return (m.kind === 'skip_reveal' || m.kind === 'to_lobby') && typeof m.on === 'boolean'
        ? { t: 'vote', kind: m.kind, on: m.on }
        : null;
    default:
      return null;
  }
}

export class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity = 40,
    private readonly perSecond = 15,
  ) {
    this.tokens = capacity;
  }

  allow(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
