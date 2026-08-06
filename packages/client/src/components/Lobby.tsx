import { useState } from 'react';
import {
  THEME_TYPES,
  type ListFilterSummary,
  type MalListStatus,
  type RoomSettings,
  type ThemeType,
} from '@borb/shared';
import { ListFilter } from './ListFilter.tsx';

export interface LobbyProps {
  settings: RoomSettings;
  iAmHost: boolean;
  playerCount: number;
  listFilter: ListFilterSummary | null;
  listPending: boolean;
  listResult: { ok: boolean; message: string } | null;
  onChange: (patch: Partial<RoomSettings>) => void;
  onUseList: (users: string[], statuses: MalListStatus[]) => void;
  onClearList: () => void;
  onStart: () => void;
}

const TYPE_LABEL: Record<ThemeType, string> = {
  OP: 'Openings',
  ED: 'Endings',
  IN: 'Inserts',
};

function Num({
  id, label, unit, value, min, max, placeholder, disabled, onChange,
}: {
  id: string;
  label: string;
  unit?: string;
  value: number | '';
  min: number;
  max: number;
  placeholder?: string;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === '' ? '' : String(value));

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={unit ? 'with-unit' : undefined}>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          placeholder={placeholder}
          disabled={disabled}
          value={shown}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            if (raw === '') return onChange(null);
            const n = Number.parseInt(raw, 10);
            if (Number.isFinite(n) && n >= min && n <= max && String(n) === raw.trim()) onChange(n);
          }}
          onBlur={(e) => {
            const raw = e.target.value;
            setDraft(null);
            if (raw === '') {
              if (value !== '') onChange(null);
              return;
            }
            const n = Number.parseInt(raw, 10);
            if (!Number.isFinite(n)) return;
            const clamped = Math.min(max, Math.max(min, n));
            if (clamped !== value) onChange(clamped);
          }}
        />
        {unit && <span className="unit">{unit}</span>}
      </div>
    </div>
  );
}

export function Lobby({
  settings, iAmHost, playerCount, listFilter, listPending, listResult,
  onChange, onUseList, onClearList, onStart,
}: LobbyProps) {
  const locked = !iAmHost;

  return (
    <div className="stage panel lobby">
      <div>
        <p className="eyebrow">Waiting to start</p>
        <h2 className="headline">Name the anime before anyone else reaches the buzzer.</h2>
        <p className="subtle">
          The music plays for everyone. The first buzz stops it and wins the floor. Guess wrong
          and you are out for the round, while the music picks up again for everyone else.
        </p>
      </div>

      <ListFilter
        active={listFilter}
        iAmHost={iAmHost}
        pending={listPending}
        result={listResult}
        onUse={onUseList}
        onClear={onClearList}
      />

      <div className="settings-grid">
        <Num
          id="f-rounds"
          label="Rounds"
          value={settings.totalRounds}
          min={1}
          max={100}
          disabled={locked}
          onChange={(n) => n !== null && onChange({ totalRounds: n })}
        />
        <Num
          id="f-guess"
          label="Guess window"
          unit="s"
          value={Math.round(settings.guessWindowMs / 1000)}
          min={5}
          max={120}
          disabled={locked}
          onChange={(n) => n !== null && onChange({ guessWindowMs: n * 1000 })}
        />
        <Num
          id="f-answer"
          label="Answer time"
          unit="s"
          value={Math.round(settings.answerMs / 1000)}
          min={3}
          max={60}
          disabled={locked}
          onChange={(n) => n !== null && onChange({ answerMs: n * 1000 })}
        />
        <Num
          id="f-reveal"
          label="Reveal time"
          unit="s"
          value={Math.round(settings.revealMs / 1000)}
          min={2}
          max={30}
          disabled={locked}
          onChange={(n) => n !== null && onChange({ revealMs: n * 1000 })}
        />
        <Num
          id="f-from"
          label="From year"
          value={settings.yearMin ?? ''}
          min={1950}
          max={2100}
          placeholder="any"
          disabled={locked}
          onChange={(yearMin) => onChange({ yearMin })}
        />
        <Num
          id="f-to"
          label="To year"
          value={settings.yearMax ?? ''}
          min={1950}
          max={2100}
          placeholder="any"
          disabled={locked}
          onChange={(yearMax) => onChange({ yearMax })}
        />
      </div>

      <div className="chip-groups">
      <fieldset className="field">
        <legend>Songs</legend>
        <div className="chips">
          {THEME_TYPES.map((type) => {
            const on = settings.themeTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                className="chip"
                data-on={on}
                disabled={locked}
                onClick={() => {
                  const next = on
                    ? settings.themeTypes.filter((t) => t !== type)
                    : [...settings.themeTypes, type];
                  if (next.length > 0) onChange({ themeTypes: next });
                }}
              >
                {TYPE_LABEL[type]}
              </button>
            );
          })}
          <button
            type="button"
            className="chip"
            data-on={settings.excludeNsfw}
            disabled={locked}
            onClick={() => onChange({ excludeNsfw: !settings.excludeNsfw })}
          >
            Hide NSFW
          </button>
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>Reveal</legend>
        <div className="chips">
          <button
            type="button"
            className="chip"
            data-on={settings.revealVideo}
            disabled={locked}
            title="Play the opening or ending during the reveal. Uses noticeably more bandwidth."
            onClick={() => onChange({ revealVideo: !settings.revealVideo })}
          >
            Play the video
          </button>
        </div>
      </fieldset>
      </div>

      {iAmHost ? (
        <button className="btn start" data-variant="primary" onClick={onStart}>
          Start {settings.totalRounds} rounds
          {playerCount > 1 ? ` with ${playerCount} players` : ''}
        </button>
      ) : (
        <p className="subtle">Waiting for the host to start.</p>
      )}
    </div>
  );
}
