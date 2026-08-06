import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  sanitizeAvatar,
  type BuzzRejectReason,
  type MalListStatus,
  type PlayerId,
  type RevealPayload,
  type RoomSettings,
  type RoomSnapshot,
  type VoteKind,
} from '@borb/shared';
import { RoundAudio } from './audio.ts';
import { GameSocket, websocketUrl, type ConnectionStatus } from './net.ts';

export interface Guess {
  playerId: PlayerId;
  text: string;
  correct: boolean;
  atMs: number;
}

interface Seat {
  playerId: PlayerId;
  sessionKey: string;
}

export interface Playback {
  elapsedMs: number;
  startAtServerMs: number;
  running: boolean;
}

export function elapsedOf(playback: Playback | null, serverNow: number): number {
  if (!playback) return 0;
  if (!playback.running) return playback.elapsedMs;
  return playback.elapsedMs + Math.max(0, serverNow - playback.startAtServerMs);
}

function seatKey(roomId: string): string {
  return `borb:seat:${roomId.toUpperCase()}`;
}

const VOLUME_KEY = 'borb:volume';
const DEFAULT_VOLUME = 0.8;
const HIDE_VIDEO_KEY = 'borb:hide-reveal-video';
const AVATAR_KEY = 'borb:avatar';

export function loadAvatar(): string | null {
  try {
    return sanitizeAvatar(localStorage.getItem(AVATAR_KEY));
  } catch {
    return null;
  }
}

export function saveAvatar(emoji: string | null): void {
  try {
    if (emoji) localStorage.setItem(AVATAR_KEY, emoji);
    else localStorage.removeItem(AVATAR_KEY);
  } catch {
  }
}

function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw === null) return DEFAULT_VOLUME;
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function loadHideVideo(): boolean {
  try {
    return localStorage.getItem(HIDE_VIDEO_KEY) === '1';
  } catch {
    return false;
  }
}

function loadSeat(roomId: string): Seat | null {
  try {
    const raw = localStorage.getItem(seatKey(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Seat>;
    return parsed.playerId && parsed.sessionKey
      ? { playerId: parsed.playerId, sessionKey: parsed.sessionKey }
      : null;
  } catch {
    return null;
  }
}

export interface Game {
  status: ConnectionStatus;
  joined: boolean;
  me: PlayerId | null;
  room: RoomSnapshot | null;
  roundInfo: { n: number; totalRounds: number } | null;
  playback: Playback | null;
  loading: boolean;
  reveal: RevealPayload | null;
  starting: boolean;
  guesses: readonly Guess[];
  rejected: BuzzRejectReason | null;
  notice: string | null;
  audioBlocked: boolean;
  latencyMs: number | null;
  cutKey: number;
  volume: number;
  hideRevealVideo: boolean;
  listPending: boolean;
  listResult: { ok: boolean; message: string } | null;
  serverNow: () => number;

  join: (roomId: string, name: string, avatar: string | null) => void;
  leave: () => void;
  setAvatar: (emoji: string | null) => void;
  start: () => void;
  buzz: () => void;
  answer: (text: string) => void;
  updateSettings: (patch: Partial<RoomSettings>) => void;
  useList: (users: string[], statuses: MalListStatus[]) => void;
  clearList: () => void;
  vote: (kind: VoteKind, on: boolean) => void;
  resumeAudio: () => void;
  setVolume: (v: number) => void;
  setHideRevealVideo: (on: boolean) => void;
}

export function useGame(): Game {
  const socketRef = useRef<GameSocket | null>(null);
  const audioRef = useRef<RoundAudio | null>(null);
  const loadGen = useRef(0);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>('closed');
  const [joined, setJoined] = useState(false);
  const [me, setMe] = useState<PlayerId | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [roundInfo, setRoundInfo] = useState<{ n: number; totalRounds: number } | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [reveal, setReveal] = useState<RevealPayload | null>(null);
  const [guesses, setGuesses] = useState<readonly Guess[]>([]);
  const [rejected, setRejected] = useState<BuzzRejectReason | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [cutKey, setCutKey] = useState(0);
  const [listPending, setListPending] = useState(false);
  const [listResult, setListResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [volume, setVolumeState] = useState(loadVolume);
  const [hideRevealVideo, setHideRevealVideoState] = useState(loadHideVideo);

  const playbackRef = useRef<Playback | null>(null);
  const buzzAtMs = useRef(0);
  const avatarRef = useRef<string | null>(null);

  if (audioRef.current === null) audioRef.current = new RoundAudio();

  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  useEffect(() => {
    const audio = audioRef.current;
    audio!.onBlocked = () => setAudioBlocked(true);
    return () => {
      audio?.stop();
    };
  }, []);

  useEffect(() => {
    audioRef.current?.setVolume(volume);
  }, [volume]);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolumeState(clamped);
    try {
      localStorage.setItem(VOLUME_KEY, String(clamped));
    } catch {
    }
  }, []);

  const setHideRevealVideo = useCallback((on: boolean) => {
    setHideRevealVideoState(on);
    try {
      localStorage.setItem(HIDE_VIDEO_KEY, on ? '1' : '0');
    } catch {
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setLatencyMs(socketRef.current?.latencyMs ?? null), 2_000);
    return () => clearInterval(timer);
  }, []);

  const endStarting = useCallback(() => {
    if (startTimer.current !== null) {
      clearTimeout(startTimer.current);
      startTimer.current = null;
    }
    setStarting(false);
  }, []);

  const join = useCallback((roomIdRaw: string, name: string, avatar: string | null) => {
    if (socketRef.current) return;
    const roomId = roomIdRaw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    const audio = audioRef.current!;
    void audio.unlock();
    avatarRef.current = avatar;

    const socket = new GameSocket(websocketUrl(), () => {
      const seat = loadSeat(roomId);
      return {
        t: 'join',
        roomId,
        name,
        ...(avatarRef.current ? { avatar: avatarRef.current } : {}),
        ...(seat ? { playerId: seat.playerId, sessionKey: seat.sessionKey } : {}),
      };
    });
    socketRef.current = socket;
    socket.onStatus = setStatus;

    socket.subscribe((msg) => {
      switch (msg.t) {
        case 'welcome':
          setMe(msg.playerId);
          setRoom(msg.room);
          setJoined(true);
          endStarting();
          try {
            localStorage.setItem(
              seatKey(roomId),
              JSON.stringify({ playerId: msg.playerId, sessionKey: msg.sessionKey }),
            );
          } catch {
          }
          break;

        case 'room':
          if (msg.room.phase === 'LOBBY') {
            loadGen.current++;
            audio.stop();
            setPlayback(null);
            setLoading(false);
            setNotice(null);
            setRoundInfo(null);
          } else {
            endStarting();
          }
          setRoom(msg.room);
          break;

        case 'round_start': {
          setRoundInfo({ n: msg.n, totalRounds: msg.totalRounds });
          setReveal(null);
          setGuesses([]);
          setRejected(null);
          setPlayback(null);
          setLoading(true);
          setNotice(null);
          const gen = ++loadGen.current;
          audio
            .load(msg.mediaUrl)
            .then(() => socket.send({ t: 'ready', token: msg.token }))
            .catch(() => {
              if (gen === loadGen.current) setNotice('No audio this round. You can still buzz.');
            })
            .finally(() => {
              if (gen === loadGen.current) setLoading(false);
            });
          break;
        }

        case 'play':
          setLoading(false);
          setPlayback({ elapsedMs: msg.elapsedMs, startAtServerMs: msg.startAtServerMs, running: true });
          audio.scheduleStart(msg.startAtServerMs - socket.serverNow(), msg.seekMs);
          break;

        case 'buzz_accepted':
          audio.pause();
          buzzAtMs.current = elapsedOf(playbackRef.current, socket.serverNow());
          setPlayback((p) => (p ? { ...p, elapsedMs: elapsedOf(p, socket.serverNow()), running: false } : p));
          setRejected(null);
          setCutKey((k) => k + 1);
          break;

        case 'buzz_rejected':
          setRejected(msg.reason);
          setTimeout(() => setRejected(null), 1_600);
          break;

        case 'judged':
          setGuesses((g) => [
            ...g,
            { playerId: msg.playerId, text: msg.text, correct: msg.correct, atMs: buzzAtMs.current },
          ]);
          break;

        case 'reveal':
          audio.pause();
          setPlayback((p) => (p ? { ...p, elapsedMs: elapsedOf(p, socket.serverNow()), running: false } : p));
          setReveal(msg.reveal);
          break;

        case 'reveal_video':
          setReveal((r) => (r ? { ...r, videoStreamUrl: msg.url } : r));
          break;

        case 'list_result':
          setListPending(false);
          setListResult({ ok: msg.ok, message: msg.message });
          break;

        case 'error':
          endStarting();
          setNotice(msg.message);
          setTimeout(() => setNotice(null), 6_000);
          break;
      }
    });

    socket.connect();
  }, [endStarting]);

  const leave = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    loadGen.current++;
    audioRef.current?.stop();
    if (startTimer.current !== null) clearTimeout(startTimer.current);
    setJoined(false);
    setRoom(null);
    setRoundInfo(null);
    setReveal(null);
    setMe(null);
    setPlayback(null);
    setGuesses([]);
    setLoading(false);
    setStarting(false);
    setRejected(null);
    setNotice(null);
  }, []);

  useEffect(() => () => {
    socketRef.current?.close();
    if (startTimer.current !== null) clearTimeout(startTimer.current);
  }, []);

  const send = useCallback((fn: (s: GameSocket) => void) => {
    const s = socketRef.current;
    if (s) fn(s);
  }, []);

  return useMemo<Game>(
    () => ({
      status,
      joined,
      me,
      room,
      roundInfo,
      playback,
      loading,
      starting,
      reveal,
      guesses,
      rejected,
      notice,
      audioBlocked,
      latencyMs,
      cutKey,
      volume,
      hideRevealVideo,
      listPending,
      listResult,
      serverNow: () => socketRef.current?.serverNow() ?? Date.now(),

      join,
      leave,
      setAvatar: (emoji) => {
        const clean = sanitizeAvatar(emoji);
        avatarRef.current = clean;
        saveAvatar(clean);
        send((s) => s.send({ t: 'avatar', emoji: clean ?? '' }));
      },
      start: () =>
        send((s) => {
          s.send({ t: 'start' });
          setStarting(true);
          if (startTimer.current !== null) clearTimeout(startTimer.current);
          startTimer.current = setTimeout(() => setStarting(false), 15_000);
        }),
      buzz: () => send((s) => s.send({ t: 'buzz' })),
      answer: (text) => send((s) => s.send({ t: 'answer', text })),
      updateSettings: (patch) => send((s) => s.send({ t: 'settings', patch })),
      useList: (users, statuses) => {
        setListPending(true);
        setListResult(null);
        send((s) => s.send({ t: 'use_list', users, statuses }));
      },
      clearList: () => send((s) => s.send({ t: 'clear_list' })),
      vote: (kind, on) => send((s) => s.send({ t: 'vote', kind, on })),
      resumeAudio: () => {
        setAudioBlocked(false);
        void audioRef.current?.el.play().catch(() => setAudioBlocked(true));
      },
      setVolume,
      setHideRevealVideo,
    }),
    [
      status, joined, me, room, roundInfo, playback, loading, starting, reveal, guesses, rejected,
      notice, audioBlocked, latencyMs, cutKey, volume, hideRevealVideo, listPending, listResult,
      join, leave, send, setVolume, setHideRevealVideo,
    ],
  );
}

export function useTick(active: boolean, intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return tick;
}
