import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeTitle } from '@borb/shared';
import { searchTitles, type TitleEntry } from '../titles.ts';
import type { Guess } from '../useGame.ts';

export interface TitleInputProps {
  index: readonly TitleEntry[];
  guesses: readonly Guess[];
  disabled: boolean;
  onSubmit: (text: string) => void;
  autoFocus?: boolean;
}

interface Placement {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

const GAP = 6;
const EDGE = 12;
const MAX_HEIGHT = 360;
const MIN_HEIGHT = 120;

function placeAgainst(input: HTMLElement): Placement {
  const r = input.getBoundingClientRect();
  const vv = window.visualViewport;
  const vh = vv?.height ?? window.innerHeight;
  const vTop = vv?.offsetTop ?? 0;
  const below = vTop + vh - r.bottom - GAP - EDGE;
  const above = r.top - vTop - GAP - EDGE;
  const flip = below < MIN_HEIGHT && above > below;
  const room = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, flip ? above : below));
  return {
    left: r.left,
    width: r.width,
    maxHeight: room,
    ...(flip ? { bottom: vTop + vh - r.top + GAP } : { top: r.bottom + GAP }),
  };
}

export function TitleInput({ index, guesses, disabled, onSubmit, autoFocus }: TitleInputProps) {
  const [text, setText] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const suggestions = useMemo(
    () => (open && text.trim() ? searchTitles(index, text) : []),
    [index, text, open],
  );

  const burned = useMemo(
    () =>
      new Set(
        guesses
          .filter((g) => !g.correct)
          .map((g) => normalizeTitle(g.text))
          .filter((k) => k.length > 0),
      ),
    [guesses],
  );

  const active = suggestions[highlight];

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => setHighlight(0), [text]);

  useEffect(() => {
    setHost(inputRef.current?.closest<HTMLElement>('.app') ?? document.body);
  }, []);

  const place = useCallback(() => {
    if (inputRef.current) setPlacement(placeAgainst(inputRef.current));
  }, []);

  useLayoutEffect(() => {
    if (suggestions.length === 0) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    const stage = inputRef.current?.closest('.stage');
    const observer = stage ? new ResizeObserver(place) : null;
    if (stage && observer) observer.observe(stage);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
      observer?.disconnect();
    };
  }, [place, suggestions.length]);

  useEffect(() => {
    listRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight, suggestions]);

  const submit = (value: string): void => {
    const answer = value.trim();
    if (!answer) return;
    onSubmit(answer);
    setText('');
    setOpen(false);
  };

  return (
    <div className="answer">
      <input
        ref={inputRef}
        type="text"
        value={text}
        disabled={disabled}
        placeholder="Name the anime"
        autoComplete="off"
        spellCheck={false}
       
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const picked = suggestions[highlight];
            submit(picked && open ? picked.label : text);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />

      {suggestions.length > 0 &&
        host &&
        placement &&
        createPortal(
          <ul
            className="suggestions"
            id="answer-suggestions"
           
            ref={listRef}
            style={placement}
          >
            {suggestions.map((entry, i) => {
              const dead = entry.keys.some((k) => burned.has(k));
              return (
                <li
                  key={entry.id}
                  id={`sug-${entry.id}`}
                 
                  data-active={i === highlight}
                  data-dead={dead}
                  onMouseMove={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    submit(entry.label);
                  }}
                >
                  <span className="suggestion-title">
                    {entry.label}
                    {entry.secondary && <em>{entry.secondary}</em>}
                  </span>
                  {dead ? (
                    <span className="dead-tag">ruled out</span>
                  ) : (
                    entry.year !== undefined && <span>{entry.year}</span>
                  )}
                </li>
              );
            })}
          </ul>,
          host,
        )}
    </div>
  );
}
