import type { PlayerId, PublicPlayer } from '@borb/shared';

export interface LeaderboardProps {
  players: readonly PublicPlayer[];
  me: PlayerId | null;
}

function ranks(players: readonly PublicPlayer[]): number[] {
  const out: number[] = [];
  players.forEach((p, i) => {
    out.push(i > 0 && players[i - 1]!.score === p.score ? out[i - 1]! : i + 1);
  });
  return out;
}

export function Leaderboard({ players, me }: LeaderboardProps) {
  const rank = ranks(players);

  return (
    <section className="panel leaderboard">
      <h2 className="section-title">Scores</h2>

      <ol className="board-rows">
        {players.map((p, i) => (
          <li
            key={p.id}
            className="board-row"
            data-me={p.id === me}
            data-offline={!p.connected}
            data-lead={rank[i] === 1 && p.score > 0}
          >
            <span className="pos">{rank[i]}</span>
            <span className="who">{p.name}</span>
            <span className="pts">{p.score}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
