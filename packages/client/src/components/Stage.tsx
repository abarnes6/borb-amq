import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { displayTitle, type PublicPlayer } from '@borb/shared';
import type { TitleEntry } from '../titles.ts';
import { elapsedOf, type Game } from '../useGame.ts';
import { Lobby } from './Lobby.tsx';
import { RevealVideo } from './RevealVideo.tsx';
import { TitleInput } from './TitleInput.tsx';

export interface StageProps {
  game: Game;
  titleIndex: readonly TitleEntry[];
}

const REJECT_TEXT: Record<string, string> = {
  not_playing: 'Too early. Wait for the music.',
  already_locked: 'Someone got there first.',
  locked_out: 'You already used your guess this round.',
  spectating: 'You are sitting this round out.',
};

function nameOf(players: readonly PublicPlayer[], id: string | null): string {
  return players.find((p) => p.id === id)?.name ?? 'Someone';
}

function Nameplate({ players, id }: { players: readonly PublicPlayer[]; id: string | null }) {
  const avatar = players.find((p) => p.id === id)?.avatar ?? null;
  return (
    <p className="floor-holder">
      {avatar && (
        <span className="plate-face">
          {avatar}
        </span>
      )}
      {nameOf(players, id)}
    </p>
  );
}

function StageFrame({
  head, main, action, side, className, cutKey, judge,
}: {
  head: ReactNode;
  main: ReactNode;
  action?: ReactNode;
  side?: ReactNode;
  className?: string;
  cutKey?: number;
  judge?: 'right' | 'wrong';
}) {
  return (
    <div
      className={`stage panel${className ? ` ${className}` : ''}`}
      key={cutKey}
      data-cut={cutKey !== undefined}
      data-side={side !== undefined}
      data-judge={judge}
    >
      <div className="stage-head">{head}</div>
      <div className="stage-main">{main}</div>
      <div className="stage-action">{action}</div>
      {side !== undefined && <div className="stage-side">{side}</div>}
    </div>
  );
}

export function Stage({ game, titleIndex }: StageProps) {
  const room = game.room;
  const phase = room?.phase ?? 'LOBBY';

  const players = room?.players ?? [];
  const me = players.find((p) => p.id === game.me);
  const lockedBy = room?.round?.lockedBy ?? null;
  const iHaveFloor = lockedBy !== null && lockedBy === game.me;
  const offline = game.status !== 'open';
  const canBuzz = phase === 'PLAYING' && !offline && !!me && !me.lockedOut && !me.spectating;

  const [pressed, setPressed] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justFired = useRef(false);

  const fire = useCallback(() => {
    if (justFired.current) return;
    justFired.current = true;
    setTimeout(() => {
      justFired.current = false;
    }, 300);
    game.buzz();
    setPressed(true);
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setPressed(false), 200);
  }, [game]);

  useEffect(() => () => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
  }, []);

  useEffect(() => {
    if (!canBuzz) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat) return;
      const el = e.target as HTMLElement | null;
      const typing =
        el?.isContentEditable ||
        el?.matches?.('textarea, input:not([type=range], [type=checkbox], [type=radio], [type=button])');
      if (typing) return;
      e.preventDefault();
      fire();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canBuzz, fire]);

  if (!room) return <div className="stage panel" />;

  if (phase === 'LOBBY') {
    if (!game.starting) {
      return (
        <Lobby
          settings={room.settings}
          iAmHost={room.hostId === game.me}
          playerCount={players.filter((p) => p.connected).length}
          listFilter={room.listFilter}
          listPending={game.listPending}
          listResult={game.listResult}
          onChange={game.updateSettings}
          onUseList={game.useList}
          onClearList={game.clearList}
          onStart={game.start}
        />
      );
    }
  }

  if (phase === 'LOBBY' || (phase === 'LOADING' && !room.round)) {
    return (
      <StageFrame
        head={null}
        main={
          <>
            <h2 className="headline">Cueing up</h2>
            <p className="subtle">Picking a song and cutting the clip.</p>
          </>
        }
      />
    );
  }

  if (phase === 'LOADING') {
    const waiting = players.filter((p) => p.connected && !p.spectating && !p.ready).length;
    return (
      <StageFrame
        head={null}
        main={
          <>
            <h2 className="headline">Buffering</h2>
            <p className="subtle">
              {game.loading
                ? 'Downloading the clip. Everyone starts together.'
                : waiting === 0
                  ? 'Starting…'
                  : `You are ready. Waiting for ${waiting} more.`}
            </p>
          </>
        }
      />
    );
  }

  if (phase === 'REVEAL') {
    const reveal = game.reveal;
    const iWon = reveal?.winnerId === game.me;
    const endsAt = room.round?.revealEndsAtServerMs ?? null;
    const nextInS = endsAt === null ? null : Math.max(0, Math.ceil((endsAt - game.serverNow()) / 1000));
    const votes = room.votes;
    const iVotedSkip = game.me !== null && votes.skipReveal.includes(game.me);
    const isLastRound = (room.round?.n ?? 0) >= room.settings.totalRounds;

    const title = reveal ? displayTitle(reveal.animeEnglishName, reveal.animeName) : null;
    const hasVideo = !!reveal && (reveal.videoStreamUrl !== null || reveal.videoUrl !== null);
    const screen =
      reveal && title && hasVideo ? (
        reveal.videoStreamUrl ? (
          <RevealVideo
            src={reveal.videoStreamUrl}
            startMs={reveal.videoStartMs}
            volume={game.volume}
            hidden={game.hideRevealVideo}
            onHiddenChange={game.setHideRevealVideo}
          />
        ) : (
          <div className="reveal-video is-waiting">
            <span className="shield-hint">Loading the video…</span>
          </div>
        )
      ) : undefined;

    return (
      <StageFrame
        side={screen}
        judge={reveal ? (reveal.winnerId ? 'right' : 'wrong') : undefined}
        head={null}
        main={
          reveal && title ? (
            <div className="reveal-card" data-video={hasVideo}>
              <div className="reveal-titles">
                <h2 className="headline">{title.primary}</h2>
                {title.secondary && <p className="romaji">{reveal.animeName}</p>}
                <p className="song">
                  {reveal.themeSlug}
                  {reveal.songTitle ? ` · ${reveal.songTitle}` : ''}
                  {reveal.artists.length > 0 && <em> by {reveal.artists.join(', ')}</em>}
                  {(reveal.season || reveal.year) && (
                    <em className="year"> · {[reveal.season, reveal.year].filter(Boolean).join(' ')}</em>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <h2 className="headline">Round over</h2>
          )
        }
        action={
          <div className="reveal-footer">
            <span className="next-in">
              {nextInS === null
                ? 'Up next…'
                : isLastRound
                  ? `Back to the lobby in ${nextInS}s`
                  : `Next round in ${nextInS}s`}
            </span>
            <button
              className="btn"
              data-on={iVotedSkip}
              onClick={() => game.vote('skip_reveal', !iVotedSkip)}
            >
              {iVotedSkip ? 'Skipping' : 'Skip'} ({votes.skipReveal.length}/{votes.needed})
            </button>
          </div>
        }
      />
    );
  }

  if (phase === 'ANSWERING') {
    const remainingMs = Math.max(0, (room.round?.answerDeadlineServerMs ?? 0) - game.serverNow());
    const seconds = (remainingMs / 1000).toFixed(1);
    const clock = (
      <p className="clock" data-size="big" data-urgent={remainingMs < 3_000}>
        {seconds}
      </p>
    );

    return (
      <StageFrame
        cutKey={game.cutKey}
        head={<p className="eyebrow">{iHaveFloor ? 'You have the floor' : 'Answering'}</p>}
        main={
          iHaveFloor ? (
            clock
          ) : (
            <>
              <Nameplate players={players} id={lockedBy} />
              {clock}
            </>
          )
        }
        action={
          iHaveFloor ? (
            <TitleInput
              index={titleIndex}
              guesses={game.guesses}
              disabled={false}
              autoFocus
              onSubmit={game.answer}
            />
          ) : (
            <p className="subtle">The music resumes if they miss it.</p>
          )
        }
      />
    );
  }

  const spentMs = elapsedOf(game.playback, game.serverNow());
  const leftS = Math.max(0, Math.ceil((room.settings.guessWindowMs - spentMs) / 1000));

  return (
    <StageFrame
      head={null}
      main={
        <>
          <p className="clock" data-size="small" data-urgent={leftS <= 5}>
            {leftS}s
          </p>
          <button
          className="buzzer"
          data-pressed={pressed}
          onPointerDown={(e) => {
            if (e.isPrimary && e.button === 0) fire();
          }}
          onClick={fire}
          disabled={!canBuzz}
        >
            {offline ? 'Offline' : me?.lockedOut ? 'Out this round' : me?.spectating ? 'Sitting out' : 'Buzz'}
            {canBuzz && <span className="buzzer-legend">space</span>}
          </button>
        </>
      }
      action={
        offline ? (
          <p className="buzz-hint">
            Reconnecting. Buzzes will not register.
          </p>
        ) : me?.lockedOut ? (
          <p className="buzz-hint">Wrong answer. You are out until the next round.</p>
        ) : (
          game.rejected && (
            <p className="buzz-hint">
              {REJECT_TEXT[game.rejected] ?? 'Buzz rejected.'}
            </p>
          )
        )
      }
    />
  );
}
