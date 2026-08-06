import { firstGrapheme, type PlayerId, type PublicPlayer, type RoomPhase } from '@borb/shared';
import type { Guess } from '../useGame.ts';
import { AvatarPicker } from './AvatarPicker.tsx';

export interface PlayersProps {
  players: readonly PublicPlayer[];
  guesses: readonly Guess[];
  me: PlayerId | null;
  lockedBy: PlayerId | null;
  phase: RoomPhase;
  onAvatar: (emoji: string | null) => void;
}

type State = 'wrong' | 'right' | 'answering' | 'out' | 'idle';

const EMOTE: Partial<Record<State, string>> = {
  answering: '‼️',
  right: '🎉',
  wrong: '💧',
};

function tagFor(p: PublicPlayer, phase: RoomPhase): string | null {
  if (!p.connected) return 'away';
  if (p.spectating && phase !== 'LOBBY') return 'spectating';
  if (p.lockedOut) return 'out';
  if (phase === 'LOADING') return p.ready ? 'ready' : 'loading';
  if (p.isHost) return 'host';
  return null;
}

function answerOf(
  p: PublicPlayer,
  guesses: readonly Guess[],
  lockedBy: PlayerId | null,
  phase: RoomPhase,
): { state: State; text: string; atS: number | null } {
  const guess = [...guesses].reverse().find((g) => g.playerId === p.id);

  if (p.id === lockedBy) return { state: 'answering', text: 'answering…', atS: null };
  if (guess) {
    const atS = Math.max(0, Math.round(guess.atMs / 1000));
    if (guess.correct) return { state: 'right', text: guess.text.trim(), atS };
    return { state: 'wrong', text: guess.text.trim() || 'no answer', atS };
  }
  if (phase === 'LOBBY') return { state: 'idle', text: '', atS: null };
  if (!p.connected) return { state: 'out', text: 'away', atS: null };
  if (p.spectating) return { state: 'out', text: 'sitting out', atS: null };
  return { state: 'idle', text: '', atS: null };
}

export function Players({ players, guesses, me, lockedBy, phase, onAvatar }: PlayersProps) {
  return (
    <section className="panel players">

      <ul className="player-cards">
        {players.map((p) => {
          const tag = tagFor(p, phase);
          const answer = answerOf(p, guesses, lockedBy, phase);
          const emote = EMOTE[answer.state];
          const mine = p.id === me;
          const monogram = firstGrapheme(p.name.trim()) || '?';
          return (
            <li
              key={p.id}
              className="player-card"
              data-me={mine}
              data-floor={p.id === lockedBy}
              data-out={p.lockedOut}
              data-offline={!p.connected}
              data-state={answer.state}
            >
              <div className="portrait">
                {tag && <span className="tag">{tag}</span>}
                {mine ? (
                  <AvatarPicker value={p.avatar} monogram={monogram} onChange={onAvatar} />
                ) : (
                  <span className="avatar" data-empty={p.avatar === null}>
                    {p.avatar ?? monogram}
                  </span>
                )}
                {emote && (
                  <span className="emote" data-state={answer.state} key={answer.state}>
                    {emote}
                  </span>
                )}
              </div>
              <p className="name">{p.name}</p>
              {phase !== 'LOBBY' && (
                <p className="what" title={answer.text || undefined}>
                  {answer.text}
                  {answer.atS !== null && <span className="at">{answer.atS}s</span>}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
