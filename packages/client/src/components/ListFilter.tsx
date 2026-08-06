import { useState } from 'react';
import {
  DEFAULT_MAL_STATUSES,
  MAL_LIST_STATUSES,
  MAL_STATUS_LABEL,
  MAX_MAL_USERS,
  formatNameList,
  possessiveLists,
  type ListFilterSummary,
  type MalListStatus,
} from '@borb/shared';

export interface ListFilterProps {
  active: ListFilterSummary | null;
  iAmHost: boolean;
  pending: boolean;
  result: { ok: boolean; message: string } | null;
  onUse: (users: string[], statuses: MalListStatus[]) => void;
  onClear: () => void;
}

const STORE_KEY = 'borb:mal-users';
const LEGACY_STORE_KEY = 'borb:mal';

function splitNames(raw: string): string[] {
  return raw.split(/[,\s]+/).filter((s) => s.length > 0);
}

function loadStoredUsers(): string[] {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed.filter((u): u is string => typeof u === 'string').slice(0, MAX_MAL_USERS);
      }
    }
    const legacy = localStorage.getItem(LEGACY_STORE_KEY);
    return legacy ? [legacy] : [];
  } catch {
    return [];
  }
}

export function ListFilter({ active, iAmHost, pending, result, onUse, onClear }: ListFilterProps) {
  const [users, setUsers] = useState<string[]>(loadStoredUsers);
  const [draft, setDraft] = useState('');
  const [statuses, setStatuses] = useState<MalListStatus[]>(DEFAULT_MAL_STATUSES);

  if (!iAmHost) {
    return (
      <div className="field">
        <span className="label">Song pool</span>
        <p className="subtle">
          {active
            ? `From ${possessiveLists(active.users.map((u) => u.user))}. ${active.tracks} songs.`
            : 'The whole catalog.'}
        </p>
      </div>
    );
  }

  const full = users.length >= MAX_MAL_USERS;

  const commitDraft = (): string[] => {
    let next = users;
    for (const name of splitNames(draft)) {
      if (next.length >= MAX_MAL_USERS) break;
      if (next.some((u) => u.toLowerCase() === name.toLowerCase())) continue;
      next = [...next, name];
    }
    setUsers(next);
    setDraft('');
    return next;
  };

  const submit = (): void => {
    if (pending) return;
    const all = commitDraft();
    if (all.length === 0) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
    }
    onUse(all, statuses);
  };

  const activeNames = active?.users.map((u) => u.user) ?? [];
  const plural = users.length + splitNames(draft).length > 1;

  return (
    <fieldset className="field">
      <legend>Song pool</legend>

      {active ? (
        <div className="list-active">
          <p>
            Playing from <strong>{formatNameList(activeNames)}</strong>&rsquo;s{' '}
            {activeNames.length === 1 ? 'list' : 'lists'}: {active.tracks} songs across{' '}
            {active.matched} shows.
            {active.matched < active.entries && (
              <span className="subtle">
                {' '}
                {active.entries - active.matched} of {active.entries} shows have no audio here.
              </span>
            )}
          </p>
          <button type="button" className="btn" data-variant="ghost" onClick={onClear}>
            Use whole catalog
          </button>
        </div>
      ) : (
        <p className="subtle">
          Every song in the catalog. Narrow it to what the people playing have actually watched.
        </p>
      )}

      {users.length > 0 && (
        <div className="chips">
          {users.map((user) => (
            <button
              key={user.toLowerCase()}
              type="button"
              className="chip"
              data-role="token"
              onClick={() => setUsers(users.filter((u) => u !== user))}
            >
              {user}
              <span>×</span>
            </button>
          ))}
        </div>
      )}

      <div className="join-row">
        <div className="field">
          <input
            id="mal-user"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              full
                ? `${MAX_MAL_USERS} lists is the limit`
                : users.length > 0
                  ? 'Add another username'
                  : 'MyAnimeList username'
            }
            disabled={full}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (draft.trim() && users.length > 0) commitDraft();
                else submit();
              } else if (e.key === 'Backspace' && draft === '' && users.length > 0) {
                setUsers(users.slice(0, -1));
              }
            }}
          />
        </div>
        <button
          type="button"
          className="btn"
          onClick={submit}
          disabled={pending || (users.length === 0 && !draft.trim())}
        >
          {pending ? 'Loading…' : active ? 'Reload' : plural ? 'Use lists' : 'Use list'}
        </button>
      </div>

      <p className="hint">Count entries with these statuses</p>
      <div className="chips">
        {MAL_LIST_STATUSES.map((status) => {
          const on = statuses.includes(status);
          return (
            <button
              key={status}
              type="button"
              className="chip"
              data-on={on}
              onClick={() => {
                const next = on ? statuses.filter((s) => s !== status) : [...statuses, status];
                if (next.length > 0) setStatuses(next);
              }}
            >
              {MAL_STATUS_LABEL[status]}
            </button>
          );
        })}
      </div>

      {result && (
        <p className="subtle">
          {result.ok ? result.message : `× ${result.message}`}
        </p>
      )}
    </fieldset>
  );
}
