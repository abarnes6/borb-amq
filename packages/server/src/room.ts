import type { WebSocket } from 'ws';
import {
  DEFAULT_SETTINGS,
  MAL_LIST_STATUSES,
  matchesAnyTitle,
  possessiveLists,
  sanitizeAvatar,
  type ClientMessage,
  type ListFilterSummary,
  type MalListStatus,
  type PlayerId,
  type PublicPlayer,
  type RevealPayload,
  type RoomPhase,
  type RoomSettings,
  type RoomSnapshot,
  type ServerMessage,
  type VoteKind,
} from '@borb/shared';
import {
  acceptedTitles,
  catalogHasMalIds,
  countPlayable,
  logBuzz,
  pickRandomTrack,
  resolveMalIds,
  type TrackRow,
} from './catalog.ts';
import { fetchMalUnion, MalListError, normalizeMalUsers } from './mal.ts';
import { mediaStore } from './media.ts';

const PLAY_LEAD_IN_MS = 400;

const TOKEN_TTL_MS = 10 * 60_000;

const RECONNECT_GRACE_MS = 3 * 60_000;

const MAX_NAME_LEN = 24;
const MAX_ANSWER_LEN = 200;

const LIST_COOLDOWN_MS = 5_000;

interface ListFilter {
  summary: ListFilterSummary;
  animeIds: number[];
}

interface Player {
  id: PlayerId;
  name: string;
  avatar: string | null;
  sessionKey: string;
  ws: WebSocket | null;
  score: number;
  ready: boolean;
  lockedOut: boolean;
  spectating: boolean;
  disconnectedAt: number | null;
}

interface ActiveRound {
  n: number;
  track: TrackRow;
  token: string;
  seekMs: number;
  sourceOffsetMs: number;
  acceptedNormalized: string[];
  playedMs: number;
  playStartedAt: number | null;
  lockedBy: PlayerId | null;
  answerDeadline: number | null;
  winnerId: PlayerId | null;
  firstPlayAt: number | null;
  revealEndsAt: number | null;
  videoToken: string | null;
  advanced: boolean;
}

export class Room {
  readonly id: string;
  private readonly players = new Map<PlayerId, Player>();
  private phase: RoomPhase = 'LOBBY';
  private settings: RoomSettings = { ...DEFAULT_SETTINGS };
  private hostId: PlayerId | null = null;
  private round: ActiveRound | null = null;
  private playedAnimeIds = new Set<number>();
  private listFilter: ListFilter | null = null;
  private lastListFetchAt = 0;
  private skipRevealVotes = new Set<PlayerId>();
  private toLobbyVotes = new Set<PlayerId>();

  private flowGen = 0;

  private loadTimer: NodeJS.Timeout | null = null;
  private playTimer: NodeJS.Timeout | null = null;
  private answerTimer: NodeJS.Timeout | null = null;
  private revealTimer: NodeJS.Timeout | null = null;

  private disposed = false;

  constructor(id: string) {
    this.id = id;
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  join(
    ws: WebSocket,
    name: string,
    avatar: string | undefined,
    playerId?: PlayerId,
    sessionKey?: string,
  ): { playerId: PlayerId } {
    const cleanName = sanitizeName(name);
    const cleanAvatar = sanitizeAvatar(avatar);

    if (playerId && sessionKey) {
      const existing = this.players.get(playerId);
      if (existing && existing.sessionKey === sessionKey) {
        existing.ws?.close(4000, 'replaced by a newer connection');
        existing.ws = ws;
        existing.disconnectedAt = null;
        existing.name = cleanName || existing.name;
        if (cleanAvatar) existing.avatar = cleanAvatar;
        if (this.hostId === null) this.hostId = existing.id;
        this.send(existing, { t: 'welcome', playerId: existing.id, sessionKey: existing.sessionKey, room: this.snapshot() });
        this.broadcastSnapshot();
        return { playerId: existing.id };
      }
    }

    const player: Player = {
      id: crypto.randomUUID(),
      name: cleanName || `Player ${this.players.size + 1}`,
      avatar: cleanAvatar,
      sessionKey: crypto.randomUUID(),
      ws,
      score: 0,
      ready: false,
      lockedOut: false,
      spectating: this.phase !== 'LOBBY',
      disconnectedAt: null,
    };
    this.players.set(player.id, player);
    if (this.hostId === null) this.hostId = player.id;

    this.send(player, { t: 'welcome', playerId: player.id, sessionKey: player.sessionKey, room: this.snapshot() });

    if (this.round && (this.phase === 'LOADING' || this.phase === 'PLAYING' || this.phase === 'ANSWERING')) {
      this.send(player, {
        t: 'round_start',
        n: this.round.n,
        totalRounds: this.settings.totalRounds,
        mediaUrl: `/media/${this.round.token}`,
        token: this.round.token,
      });
    }
    this.broadcastSnapshot();
    return { playerId: player.id };
  }

  detach(playerId: PlayerId): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.ws = null;
    player.disconnectedAt = Date.now();
    player.ready = false;

    if (this.hostId === playerId) this.hostId = this.pickNewHost();

    if (this.phase === 'LOADING') this.maybeStartPlayback();
    if (this.phase === 'ANSWERING' && this.round?.lockedBy === playerId) {
      this.resolveAnswer(player, '', false, 'disconnected');
    }
    if (this.phase === 'PLAYING') this.endRoundIfAllLockedOut();

    this.recheckVotes();
    this.broadcastSnapshot();
  }

  reapDisconnected(): void {
    const cutoff = Date.now() - RECONNECT_GRACE_MS;
    let changed = false;
    for (const [id, p] of this.players) {
      if (p.ws === null && p.disconnectedAt !== null && p.disconnectedAt < cutoff) {
        this.players.delete(id);
        changed = true;
      }
    }
    if (changed) {
      if (this.hostId && !this.players.has(this.hostId)) this.hostId = this.pickNewHost();
      if (this.players.size === 0) this.dispose();
      else {
        this.recheckVotes();
        this.broadcastSnapshot();
      }
    }
  }

  private pickNewHost(): PlayerId | null {
    for (const p of this.players.values()) if (p.ws) return p.id;
    return null;
  }

  handleMessage(playerId: PlayerId, msg: ClientMessage): void {
    const player = this.players.get(playerId);
    if (!player) return;

    switch (msg.t) {
      case 'ping':
        this.send(player, { t: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
        return;
      case 'avatar': {
        const next = sanitizeAvatar(msg.emoji);
        if (next === player.avatar) return;
        player.avatar = next;
        this.broadcastSnapshot();
        return;
      }
      case 'settings':
        if (!this.isHost(player)) return this.fail(player, 'Only the host can change settings.');
        if (this.phase !== 'LOBBY') return this.fail(player, 'Settings are locked once the game starts.');
        this.settings = sanitizeSettings({ ...this.settings, ...msg.patch });
        if (this.listFilter) {
          this.listFilter.summary.tracks = countPlayable(this.settings, this.listFilter.animeIds);
        }
        this.broadcastSnapshot();
        return;
      case 'start':
        if (!this.isHost(player)) return this.fail(player, 'Only the host can start the game.');
        if (this.phase !== 'LOBBY') return;
        void this.startGame();
        return;
      case 'ready':
        this.onReady(player, msg.token);
        return;
      case 'buzz':
        this.onBuzz(player);
        return;
      case 'answer':
        this.onAnswer(player, msg.text);
        return;
      case 'skip':
        if (!this.isHost(player)) return this.fail(player, 'Only the host can skip.');
        if (this.round && this.phase !== 'REVEAL' && this.phase !== 'LOBBY') this.endRound(null);
        return;
      case 'use_list':
        void this.useList(player, msg.users, msg.statuses);
        return;
      case 'clear_list':
        if (!this.isHost(player)) return this.fail(player, 'Only the host can change the song pool.');
        this.listFilter = null;
        this.send(player, { t: 'list_result', ok: true, message: 'Playing from the whole catalog again.' });
        this.broadcastSnapshot();
        return;
      case 'vote':
        this.onVote(player, msg.kind, msg.on);
        return;
    }
  }

  private isHost(player: Player): boolean {
    return this.hostId === player.id;
  }

  private restrictIds(): readonly number[] | null {
    return this.listFilter?.animeIds ?? null;
  }

  private votesNeeded(): number {
    const connected = [...this.players.values()].filter((p) => p.ws !== null).length;
    return Math.max(1, Math.floor(connected / 2) + 1);
  }

  private onVote(player: Player, kind: VoteKind, on: boolean): void {
    if (kind === 'skip_reveal') {
      if (this.phase !== 'REVEAL') return;
      this.setVote(this.skipRevealVotes, player.id, on);
      this.broadcastSnapshot();
      if (this.skipRevealVotes.size >= this.votesNeeded() && this.round) {
        this.advanceAfterReveal(this.round);
      }
      return;
    }

    if (this.phase === 'LOBBY') return;
    this.setVote(this.toLobbyVotes, player.id, on);
    this.broadcastSnapshot();
    if (this.toLobbyVotes.size >= this.votesNeeded()) this.returnToLobby();
  }

  private setVote(set: Set<PlayerId>, playerId: PlayerId, on: boolean): void {
    if (on) set.add(playerId);
    else set.delete(playerId);
  }

  private returnToLobby(): void {
    this.toLobby('Vote passed. Back to the lobby.');
  }

  private toLobby(announcement: string): void {
    this.clearTimers();
    this.flowGen++;
    const round = this.round;
    if (round && !round.advanced) {
      round.advanced = true;
      void mediaStore.releaseRound(round.token);
      if (round.videoToken) void mediaStore.releaseRound(round.videoToken);
    }
    this.round = null;
    this.phase = 'LOBBY';
    this.skipRevealVotes.clear();
    this.toLobbyVotes.clear();
    for (const p of this.players.values()) {
      p.ready = false;
      p.lockedOut = false;
      p.spectating = false;
    }
    this.broadcast({ t: 'error', message: announcement });
    this.broadcastSnapshot();
  }

  private recheckVotes(): void {
    for (const id of [...this.skipRevealVotes]) {
      if (!this.players.get(id)?.ws) this.skipRevealVotes.delete(id);
    }
    for (const id of [...this.toLobbyVotes]) {
      if (!this.players.get(id)?.ws) this.toLobbyVotes.delete(id);
    }
    const needed = this.votesNeeded();
    if (this.phase === 'REVEAL' && this.round && this.skipRevealVotes.size >= needed) {
      this.advanceAfterReveal(this.round);
    } else if (this.phase !== 'LOBBY' && this.toLobbyVotes.size >= needed) {
      this.returnToLobby();
    }
  }

  private async useList(host: Player, rawUsers: string[], rawStatuses: MalListStatus[]): Promise<void> {
    if (!this.isHost(host)) return this.fail(host, 'Only the host can change the song pool.');

    const reply = (ok: boolean, message: string): void =>
      this.send(host, { t: 'list_result', ok, message });

    if (this.phase !== 'LOBBY') {
      return reply(false, 'Finish this game before changing the song pool.');
    }
    const statuses = [...new Set(rawStatuses.filter((s) => MAL_LIST_STATUSES.includes(s)))];
    if (statuses.length === 0) return reply(false, 'Pick at least one list status.');

    if (!catalogHasMalIds()) {
      return reply(
        false,
        'This catalog has no MyAnimeList ids yet. Re-run `npm run ingest` to add them.',
      );
    }

    let users: string[];
    try {
      users = normalizeMalUsers(rawUsers);
    } catch (err) {
      return reply(false, err instanceof MalListError ? err.message : 'Those usernames are not valid.');
    }

    const waited = Date.now() - this.lastListFetchAt;
    if (waited < LIST_COOLDOWN_MS) {
      return reply(false, `Give MyAnimeList a moment. Try again in ${Math.ceil((LIST_COOLDOWN_MS - waited) / 1000)}s.`);
    }
    this.lastListFetchAt = Date.now();

    try {
      const { users: perUser, malIds } = await fetchMalUnion(users, statuses);
      if (this.disposed) return;

      const { animeIds } = resolveMalIds(malIds);
      if (animeIds.length === 0) {
        return reply(false, `Nothing on ${possessiveLists(users)} has playable audio in this catalog.`);
      }

      const summary: ListFilterSummary = {
        source: 'mal',
        users: perUser,
        statuses,
        entries: malIds.length,
        matched: animeIds.length,
        tracks: countPlayable(this.settings, animeIds),
      };
      this.listFilter = { summary, animeIds };
      reply(
        true,
        `Matched ${summary.matched} of ${summary.entries} shows across ${users.length === 1 ? '1 list' : `${users.length} lists`}: ${summary.tracks} songs in the pool.`,
      );
      this.broadcastSnapshot();
    } catch (err) {
      if (err instanceof MalListError) return reply(false, err.message);
      console.warn('MAL list fetch failed:', err);
      reply(false, 'Could not load that list. Try again in a moment.');
    }
  }

  private async startGame(): Promise<void> {
    const available = countPlayable(this.settings, this.restrictIds());
    if (available === 0) {
      this.broadcast({
        t: 'error',
        message: this.listFilter
          ? `Nothing on ${possessiveLists(this.listFilter.summary.users.map((u) => u.user))} matches the other filters. Widen the years or theme types.`
          : 'No tracks match these filters. Widen them, or run the ingest if the catalog is empty.',
      });
      return;
    }
    for (const p of this.players.values()) {
      p.score = 0;
      p.ready = false;
      p.lockedOut = false;
      p.spectating = false;
    }
    this.playedAnimeIds = new Set();
    this.round = null;
    this.skipRevealVotes.clear();
    this.toLobbyVotes.clear();

    this.phase = 'LOADING';
    this.broadcastSnapshot();

    if (available < this.settings.totalRounds) {
      this.broadcast({
        t: 'error',
        message: `Only ${available} tracks match these filters; the game will be that short.`,
      });
    }

    await this.beginRound(1);
  }

  private async beginRound(n: number): Promise<void> {
    this.clearTimers();

    if (n > this.settings.totalRounds) return this.finish();

    const gen = this.flowGen;

    for (let attempt = 0; attempt < 3; attempt++) {
      const track = pickRandomTrack(this.settings, this.playedAnimeIds, this.restrictIds());
      if (!track) {
        if (this.playedAnimeIds.size > 0) {
          this.playedAnimeIds.clear();
          continue;
        }
        return this.finish('Ran out of tracks matching these filters.');
      }

      try {
        const media = await mediaStore.prepareRound(track, this.settings.guessWindowMs, TOKEN_TTL_MS);
        if (this.disposed || this.flowGen !== gen) {
          void mediaStore.releaseRound(media.token);
          return;
        }

        this.playedAnimeIds.add(track.animeId);
        this.round = {
          n,
          track,
          token: media.token,
          seekMs: media.seekMs,
          sourceOffsetMs: media.sourceOffsetMs,
          acceptedNormalized: acceptedTitles(track.animeId).normalized,
          playedMs: 0,
          playStartedAt: null,
          lockedBy: null,
          answerDeadline: null,
          winnerId: null,
          firstPlayAt: null,
          revealEndsAt: null,
          videoToken: null,
          advanced: false,
        };
        this.phase = 'LOADING';
        this.skipRevealVotes.clear();

        if (this.settings.revealVideo) mediaStore.prefetchVideo(track);
        for (const p of this.players.values()) {
          p.ready = false;
          p.lockedOut = false;
          p.spectating = p.ws === null;
        }

        this.broadcast({
          t: 'round_start',
          n,
          totalRounds: this.settings.totalRounds,
          mediaUrl: `/media/${media.token}`,
          token: media.token,
        });
        this.broadcastSnapshot();

        this.loadTimer = setTimeout(() => this.onLoadTimeout(n), this.settings.loadTimeoutMs);
        return;
      } catch (err) {
        console.warn(`round ${n}: media prepare failed for track ${track.trackId}:`, err);
      }
    }

    if (this.disposed || this.flowGen !== gen) return;
    this.broadcast({ t: 'error', message: 'Could not load audio for this round; skipping.' });
    void this.beginRound(n + 1);
  }

  private onReady(player: Player, token: string): void {
    if (!this.round || this.round.token !== token) return;
    player.ready = true;
    if (this.phase === 'LOADING') player.spectating = false;
    this.broadcastSnapshot();
    this.maybeStartPlayback();
  }

  private onLoadTimeout(n: number): void {
    if (this.phase !== 'LOADING' || this.round?.n !== n) return;
    for (const p of this.players.values()) {
      if (p.ws && !p.ready) p.spectating = true;
    }
    this.startPlayback();
  }

  private maybeStartPlayback(): void {
    if (this.phase !== 'LOADING') return;
    const waiting = [...this.players.values()].filter((p) => p.ws && !p.spectating && !p.ready);
    if (waiting.length === 0) this.startPlayback();
  }

  private startPlayback(): void {
    const round = this.round;
    if (!round) return;
    this.clearTimer('load');
    this.clearTimer('play');

    const remaining = this.settings.guessWindowMs - round.playedMs;
    if (remaining <= 0) return this.endRound(null);

    this.phase = 'PLAYING';
    round.lockedBy = null;
    round.answerDeadline = null;
    round.playStartedAt = Date.now() + PLAY_LEAD_IN_MS;
    if (round.firstPlayAt === null) round.firstPlayAt = round.playStartedAt;

    this.broadcast({
      t: 'play',
      startAtServerMs: round.playStartedAt,
      seekMs: round.seekMs + round.playedMs,
      elapsedMs: round.playedMs,
    });
    this.broadcastSnapshot();

    this.playTimer = setTimeout(() => this.onGuessWindowExpired(round.n), PLAY_LEAD_IN_MS + remaining);
  }

  private onGuessWindowExpired(n: number): void {
    if (this.phase !== 'PLAYING' || this.round?.n !== n) return;
    this.endRound(null);
  }

  // First buzz to arrive wins; client timestamps are never trusted.
  private onBuzz(player: Player): void {
    const round = this.round;
    if (!round) return this.send(player, { t: 'buzz_rejected', reason: 'not_playing' });

    if (player.spectating) return this.send(player, { t: 'buzz_rejected', reason: 'spectating' });
    if (player.lockedOut) return this.send(player, { t: 'buzz_rejected', reason: 'locked_out' });
    if (round.lockedBy !== null) return this.send(player, { t: 'buzz_rejected', reason: 'already_locked' });
    if (this.phase !== 'PLAYING') return this.send(player, { t: 'buzz_rejected', reason: 'not_playing' });
    if (round.playStartedAt === null || Date.now() < round.playStartedAt) {
      return this.send(player, { t: 'buzz_rejected', reason: 'not_playing' });
    }

    const now = Date.now();
    round.playedMs += Math.max(0, now - round.playStartedAt);
    round.playStartedAt = null;
    this.clearTimer('play');

    this.phase = 'ANSWERING';
    round.lockedBy = player.id;
    round.answerDeadline = now + this.settings.answerMs;

    this.broadcast({ t: 'buzz_accepted', playerId: player.id, deadlineServerMs: round.answerDeadline });
    this.broadcastSnapshot();

    this.answerTimer = setTimeout(() => this.onAnswerTimeout(round.n, player.id), this.settings.answerMs);
  }

  private onAnswerTimeout(n: number, playerId: PlayerId): void {
    if (this.phase !== 'ANSWERING' || this.round?.n !== n || this.round.lockedBy !== playerId) return;
    const player = this.players.get(playerId);
    if (player) this.resolveAnswer(player, '', false, 'timeout');
  }

  private onAnswer(player: Player, text: string): void {
    const round = this.round;
    if (!round || this.phase !== 'ANSWERING') return;
    if (round.lockedBy !== player.id) {
      return this.fail(player, 'You do not have the floor.');
    }
    const guess = text.slice(0, MAX_ANSWER_LEN);
    const correct = matchesAnyTitle(guess, round.acceptedNormalized) !== null;
    this.resolveAnswer(player, guess, correct, 'answered');
  }

  private resolveAnswer(
    player: Player,
    text: string,
    correct: boolean,
    _why: 'answered' | 'timeout' | 'disconnected',
  ): void {
    const round = this.round;
    if (!round) return;
    this.clearTimer('answer');
    round.lockedBy = null;
    round.answerDeadline = null;

    logBuzz({
      roomId: this.id,
      roundN: round.n,
      trackId: round.track.trackId,
      playerName: player.name,
      msIntoRound: round.playedMs,
      answer: text || null,
      correct,
    });

    if (correct) {
      player.score += 1;
      round.winnerId = player.id;
      this.broadcast({ t: 'judged', playerId: player.id, text, correct: true, roundOver: true });
      return this.endRound(player.id);
    }

    player.lockedOut = true;
    const everyoneOut = this.activePlayers().every((p) => p.lockedOut);
    this.broadcast({ t: 'judged', playerId: player.id, text, correct: false, roundOver: everyoneOut });

    if (everyoneOut) return this.endRound(null);
    this.startPlayback();
  }

  private endRoundIfAllLockedOut(): void {
    const active = this.activePlayers();
    if (active.length > 0 && active.every((p) => p.lockedOut)) this.endRound(null);
  }

  private endRound(winnerId: PlayerId | null): void {
    const round = this.round;
    if (!round) return;
    this.clearTimers();

    this.phase = 'REVEAL';
    round.winnerId = winnerId;
    round.lockedBy = null;
    round.answerDeadline = null;
    round.playStartedAt = null;
    round.revealEndsAt = Date.now() + this.settings.revealMs;
    this.skipRevealVotes.clear();

    const reveal: RevealPayload = {
      animeName: round.track.animeName,
      animeEnglishName: round.track.animeEnglishName,
      animeTitles: acceptedTitles(round.track.animeId).display,
      year: round.track.year,
      season: round.track.season,
      themeType: round.track.themeType,
      themeSlug: round.track.themeSlug,
      songTitle: round.track.songTitle,
      artists: round.track.artists,
      audioUrl: round.track.audioUrl,
      videoUrl: round.track.videoUrl,
      videoStreamUrl: null,
      videoStartMs: round.sourceOffsetMs,
      winnerId,
    };

    this.broadcast({ t: 'reveal', reveal, nextInMs: this.settings.revealMs });
    this.broadcastSnapshot();
    this.revealTimer = setTimeout(() => this.advanceAfterReveal(round), this.settings.revealMs);

    if (this.settings.revealVideo) void this.attachRevealVideo(round);
  }

  private async attachRevealVideo(round: ActiveRound): Promise<void> {
    const token = await mediaStore.prepareVideo(round.track, TOKEN_TTL_MS);
    if (!token) return;

    if (this.disposed || this.round !== round || round.advanced || this.phase !== 'REVEAL') {
      void mediaStore.releaseRound(token);
      return;
    }
    round.videoToken = token;
    this.broadcast({ t: 'reveal_video', url: `/media/${token}` });
  }

  private advanceAfterReveal(round: ActiveRound): void {
    if (round.advanced || this.disposed) return;
    round.advanced = true;
    this.clearTimer('reveal');

    round.revealEndsAt = null;
    this.broadcastSnapshot();

    void mediaStore.releaseRound(round.token);
    if (round.videoToken) void mediaStore.releaseRound(round.videoToken);

    void this.beginRound(round.n + 1);
  }

  private finish(note?: string): void {
    this.toLobby([note, this.resultLine()].filter(Boolean).join(' '));
  }

  private resultLine(): string {
    const players = [...this.players.values()];
    const best = Math.max(0, ...players.map((p) => p.score));
    if (best === 0) return 'Game over. Nobody scored.';
    const winners = players.filter((p) => p.score === best).map((p) => p.name);
    if (winners.length === 1) return `Game over. ${winners[0]} wins with ${best}.`;
    const names = winners.length === 2 ? winners.join(' and ') : winners.join(', ');
    return `Game over. ${names} tie at ${best}.`;
  }

  private activePlayers(): Player[] {
    return [...this.players.values()].filter((p) => p.ws !== null && !p.spectating);
  }

  private clearTimer(which: 'load' | 'play' | 'answer' | 'reveal'): void {
    const key = `${which}Timer` as const;
    const handle = this[key];
    if (handle) {
      clearTimeout(handle);
      this[key] = null;
    }
  }

  private clearTimers(): void {
    this.clearTimer('load');
    this.clearTimer('play');
    this.clearTimer('answer');
    this.clearTimer('reveal');
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    if (this.round) void mediaStore.releaseRound(this.round.token);
    this.round = null;
  }

  private snapshot(): RoomSnapshot {
    const players: PublicPlayer[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      connected: p.ws !== null,
      ready: p.ready,
      lockedOut: p.lockedOut,
      spectating: p.spectating,
      isHost: p.id === this.hostId,
    }));
    players.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    return {
      id: this.id,
      phase: this.phase,
      settings: this.settings,
      players,
      hostId: this.hostId,
      listFilter: this.listFilter?.summary ?? null,
      votes: {
        skipReveal: [...this.skipRevealVotes],
        toLobby: [...this.toLobbyVotes],
        needed: this.votesNeeded(),
      },
      round: this.round
        ? {
            n: this.round.n,
            lockedBy: this.round.lockedBy,
            answerDeadlineServerMs: this.round.answerDeadline,
            revealEndsAtServerMs: this.phase === 'REVEAL' ? this.round.revealEndsAt : null,
          }
        : null,
      serverNowMs: Date.now(),
    };
  }

  private broadcastSnapshot(): void {
    this.broadcast({ t: 'room', room: this.snapshot() });
  }

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws?.readyState === 1) p.ws.send(payload);
    }
  }

  private send(player: Player, msg: ServerMessage): void {
    if (player.ws?.readyState === 1) player.ws.send(JSON.stringify(msg));
  }

  private fail(player: Player, message: string): void {
    this.send(player, { t: 'error', message });
  }
}

function sanitizeName(raw: string): string {
  return raw.replace(/[\p{C}]/gu, '').trim().slice(0, MAX_NAME_LEN);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function sanitizeSettings(s: RoomSettings): RoomSettings {
  const types = Array.isArray(s.themeTypes)
    ? s.themeTypes.filter((t) => t === 'OP' || t === 'ED' || t === 'IN')
    : [];
  return {
    totalRounds: clampInt(s.totalRounds, 1, 100, DEFAULT_SETTINGS.totalRounds),
    guessWindowMs: clampInt(s.guessWindowMs, 5_000, 120_000, DEFAULT_SETTINGS.guessWindowMs),
    answerMs: clampInt(s.answerMs, 3_000, 60_000, DEFAULT_SETTINGS.answerMs),
    revealMs: clampInt(s.revealMs, 2_000, 90_000, DEFAULT_SETTINGS.revealMs),
    loadTimeoutMs: clampInt(s.loadTimeoutMs, 3_000, 60_000, DEFAULT_SETTINGS.loadTimeoutMs),
    themeTypes: types.length > 0 ? [...new Set(types)] : [...DEFAULT_SETTINGS.themeTypes],
    yearMin: s.yearMin === null ? null : clampInt(s.yearMin, 1950, 2100, 1950),
    yearMax: s.yearMax === null ? null : clampInt(s.yearMax, 1950, 2100, 2100),
    excludeNsfw: s.excludeNsfw !== false,
    revealVideo: s.revealVideo !== false,
  };
}
