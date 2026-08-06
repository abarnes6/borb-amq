const LAMPS = 24;

export interface StripProps {
  elapsedMs: number;
  totalMs: number;
  frozen: boolean;
  idle: boolean;
}

export function Strip({ elapsedMs, totalMs, frozen, idle }: StripProps) {
  const spent = totalMs > 0 ? Math.min(1, Math.max(0, elapsedMs / totalMs)) : 0;
  const out = idle ? LAMPS : Math.round(spent * LAMPS);

  return (
    <div className="strip" data-frozen={frozen} data-idle={idle}>
      {Array.from({ length: LAMPS }, (_, i) => (
        <span key={i} data-lit={!idle && i >= out} />
      ))}
    </div>
  );
}
