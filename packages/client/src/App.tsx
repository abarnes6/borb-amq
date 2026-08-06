import { useEffect, useState } from 'react';
import { formatNameList } from '@borb/shared';
import { JoinScreen } from './components/JoinScreen.tsx';
import { Leaderboard } from './components/Leaderboard.tsx';
import { Players } from './components/Players.tsx';
import { RoomActions } from './components/RoomActions.tsx';
import { Stage } from './components/Stage.tsx';
import { Strip } from './components/Strip.tsx';
import { loadTitleIndex, type TitleEntry } from './titles.ts';
import { elapsedOf, useGame, useTick } from './useGame.ts';

function poolLabel(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' + ');
  return `${names[0]} + ${names.length - 1} more`;
}

export function App() {
  const game = useGame();
  const [titleIndex, setTitleIndex] = useState<readonly TitleEntry[]>([]);
  const [copied, setCopied] = useState(false);

  const phase = game.room?.phase ?? 'LOBBY';
  useTick(phase === 'PLAYING' || phase === 'ANSWERING' || phase === 'REVEAL', 100);

  useEffect(() => {
    if (!game.joined) return;
    loadTitleIndex().then(setTitleIndex).catch(() => {
    });
  }, [game.joined]);

  const notice = game.notice && (
    <div className="notice">
      {game.notice}
    </div>
  );

  if (!game.joined) {
    return (
      <div className="app">
        <JoinScreen status={game.status} onJoin={game.join} />
        {notice}
      </div>
    );
  }

  const room = game.room;
  const elapsedMs = elapsedOf(game.playback, game.serverNow());
  const stripIdle = phase !== 'PLAYING' && phase !== 'ANSWERING';
  const inGame = phase !== 'LOBBY' || game.starting;

  return (
    <div
      className="app"
      data-phase={phase}
      data-judge={
        phase === 'REVEAL' && game.reveal ? (game.reveal.winnerId ? 'right' : 'wrong') : undefined
      }
    >
      <header className="topbar">
        <div className="bar-group">
        <h1 className="wordmark">BORB</h1>

        <button
          className="meta btn room-code"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(location.href)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              })
              .catch(() => setCopied(false));
          }}
          title="Copy the invite link"
        >
          <span className="label">{copied ? 'copied' : 'room'}</span>
          <strong>{room?.id ?? '—'}</strong>
        </button>

        {room?.listFilter && (
          <span
            className="meta"
            title={`${room.listFilter.tracks} songs from ${formatNameList(
              room.listFilter.users.map((u) => u.user),
            )}`}
          >
            pool <strong>{poolLabel(room.listFilter.users.map((u) => u.user))}</strong>
          </span>
        )}
        </div>

        <div className="bar-group bar-right">
        <label className="meta volume">
          vol
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(game.volume * 100)}
            onChange={(e) => game.setVolume(Number(e.target.value) / 100)}
          />
        </label>

        <span
          className="bug"
          data-status={game.status}
          title="Buzzes are settled by arrival order, so your round trip to the server is a real handicap."
        >
          {game.status === 'open' ? 'LIVE' : 'OFF AIR'}
          {game.status === 'open' && game.latencyMs !== null && (
            <span className="ping">{game.latencyMs}ms</span>
          )}
        </span>
        </div>
      </header>

      <Strip
        elapsedMs={elapsedMs}
        totalMs={room?.settings.guessWindowMs ?? 30_000}
        frozen={phase === 'ANSWERING'}
        idle={stripIdle}
      />

      <div className="floor">
      {inGame && room && (
        <span className="round-bug">
          round{' '}
          <strong>
            {room.round?.n ?? game.roundInfo?.n ?? 1}/
            {game.roundInfo?.totalRounds ?? room.settings.totalRounds}
          </strong>
        </span>
      )}

      <main className="main">
        <Stage game={game} titleIndex={titleIndex} />

        <Players
          players={room?.players ?? []}
          guesses={game.guesses}
          me={game.me}
          lockedBy={room?.round?.lockedBy ?? null}
          phase={phase}
          onAvatar={game.setAvatar}
        />

        {room && (
          <RoomActions
            votes={room.votes}
            me={game.me}
            phase={phase}
            onVote={(on) => game.vote('to_lobby', on)}
            onLeave={game.leave}
          />
        )}

        <Leaderboard players={room?.players ?? []} me={game.me} />
      </main>
      </div>

      {notice}

      {game.audioBlocked && (
        <div className="blocked-audio">
          <div className="panel" style={{ display: 'grid', gap: '0.75rem', textAlign: 'center' }}>
            <h2 className="headline">Sound is blocked</h2>
            <p className="subtle">Your browser needs a tap before it will play audio.</p>
            <button className="btn" data-variant="primary" onClick={game.resumeAudio}>
              Turn on sound
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
