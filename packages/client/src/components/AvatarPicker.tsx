import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sanitizeAvatar } from '@borb/shared';

const CHOICES = [
  '😀', '😎', '🤓', '🥳', '😴', '🤖', '👻', '💀',
  '🤡', '😈', '🥺', '😤', '🥷', '🧙', '🦸', '👑',
  '🐦', '🐧', '🦉', '🐱', '🐶', '🦊', '🐸', '🐢',
  '🐙', '🦈', '🐝', '🐼', '🦖', '🐉', '🦆', '🐈‍⬛',
  '🎵', '🎧', '🎤', '🎸', '🎹', '🥁', '🎺', '📻',
  '🔔', '🚨', '📺', '🏆', '🥇', '⭐', '💡', '❓',
  '🎯', '🎲', '🃏', '🎬', '💎', '🔥', '⚡', '🌊',
  '🌸', '🌙', '☄️', '🚀', '🛸', '🗿', '🎌', '⛩️',
  '🍜', '🍣', '🍙', '🍥', '🍡', '🍩', '🍵', '🍉',
];

interface Placement {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

const GAP = 6;
const EDGE = 12;
const PANEL_W = 292;
const PANEL_H = 320;
const MIN_H = 180;

function placeAgainst(anchor: HTMLElement): Placement {
  const r = anchor.getBoundingClientRect();
  const vv = window.visualViewport;
  const vw = window.innerWidth;
  const vh = vv?.height ?? window.innerHeight;
  const vTop = vv?.offsetTop ?? 0;
  const width = Math.min(PANEL_W, vw - 2 * EDGE);
  const below = vTop + vh - r.bottom - GAP - EDGE;
  const above = r.top - vTop - GAP - EDGE;
  const flip = below < PANEL_H && above > below;
  return {
    left: Math.min(Math.max(EDGE, r.left + r.width / 2 - width / 2), vw - EDGE - width),
    width,
    maxHeight: Math.max(MIN_H, Math.min(PANEL_H, flip ? above : below)),
    ...(flip ? { bottom: vTop + vh - r.top + GAP } : { top: r.bottom + GAP }),
  };
}

export interface AvatarPickerProps {
  value: string | null;
  monogram: string;
  onChange: (emoji: string | null) => void;
  variant?: 'tile' | 'field';
}

export function AvatarPicker({ value, monogram, onChange, variant = 'tile' }: AvatarPickerProps) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [typed, setTyped] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHost(buttonRef.current?.closest<HTMLElement>('.app') ?? document.body);
  }, []);

  const place = useCallback(() => {
    if (buttonRef.current) setPlacement(placeAgainst(buttonRef.current));
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && placement) panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open, placement]);

  const choose = (emoji: string | null): void => {
    onChange(emoji);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="avatar-btn"
        data-variant={variant}
        onClick={() => setOpen((o) => !o)}
      >
        {variant === 'field' && <span className="avatar-caption">Avatar</span>}
        <span className="avatar" data-empty={value === null}>
          {value ?? monogram}
        </span>
      </button>

      {open &&
        host &&
        placement &&
        createPortal(
          <div
            className="emoji-panel"
           
            ref={panelRef}
            style={placement}
          >
            <div className="emoji-grid">
              {CHOICES.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="emoji-choice"
                  data-on={emoji === value}
                  onClick={() => choose(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>

            <div className="emoji-foot">
              <input
                type="text"
                value={typed}
                placeholder="or paste one"
                onChange={(e) => {
                  setTyped(e.target.value);
                  const one = sanitizeAvatar(e.target.value);
                  if (one) {
                    setTyped('');
                    choose(one);
                  }
                }}
              />
              <button type="button" className="btn" onClick={() => choose(null)} disabled={value === null}>
                Clear
              </button>
            </div>
          </div>,
          host,
        )}
    </>
  );
}
