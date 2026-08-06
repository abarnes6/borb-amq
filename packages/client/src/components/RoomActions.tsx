import type { PlayerId, RoomPhase, VoteState } from '@borb/shared';

export interface RoomActionsProps {
  votes: VoteState;
  me: PlayerId | null;
  phase: RoomPhase;
  onVote: (on: boolean) => void;
  onLeave: () => void;
}

export function RoomActions({ votes, me, phase, onVote, onLeave }: RoomActionsProps) {
  const mine = me !== null && votes.toLobby.includes(me);
  const count = votes.toLobby.length;

  return (
    <div className="room-actions">
      <div className="row">
        {phase !== 'LOBBY' && (
          <button className="btn" data-variant="ghost" data-on={mine} onClick={() => onVote(!mine)}>
            {mine ? 'Voted to end' : 'End game'}
            {count > 0 && ` ${count}/${votes.needed}`}
          </button>
        )}
        <button className="btn" data-variant="ghost" onClick={onLeave}>
          Leave room
        </button>
      </div>
      <span className="subtle">
        {count > 0 && !mine
          ? `${count === 1 ? '1 player wants' : `${count} players want`} to end the game.`
          : ' '}
      </span>
    </div>
  );
}
