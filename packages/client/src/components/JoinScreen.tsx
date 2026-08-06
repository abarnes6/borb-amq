import { useState } from 'react';
import { firstGrapheme } from '@borb/shared';
import type { ConnectionStatus } from '../net.ts';
import { loadAvatar, saveAvatar } from '../useGame.ts';
import { AvatarPicker } from './AvatarPicker.tsx';

export interface JoinScreenProps {
  status: ConnectionStatus;
  onJoin: (roomId: string, name: string, avatar: string | null) => void;
}

function initialRoom(): string {
  const fromUrl = new URLSearchParams(location.search).get('room');
  return (fromUrl ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

export function JoinScreen({ status, onJoin }: JoinScreenProps) {
  const [name, setName] = useState(() => localStorage.getItem('borb:name') ?? '');
  const [avatar, setAvatar] = useState(loadAvatar);
  const [room, setRoom] = useState(initialRoom);
  const [busy, setBusy] = useState(false);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const cleanName = name.trim();
    const cleanRoom = room.trim().toUpperCase();
    if (!cleanName || !cleanRoom) return;
    try {
      localStorage.setItem('borb:name', cleanName);
    } catch {
    }
    saveAvatar(avatar);
    const url = new URL(location.href);
    url.searchParams.set('room', cleanRoom);
    history.replaceState(null, '', url);
    onJoin(cleanRoom, cleanName, avatar);
  };

  const createRoom = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch('/api/room/new');
      const body = (await res.json()) as { roomId: string };
      setRoom(body.roomId);
    } catch {
      setRoom(Math.random().toString(36).slice(2, 7).toUpperCase());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="join-screen">
      <form className="join-card panel" onSubmit={submit}>
        <div>
          <p className="eyebrow" lang="ja-Latn">
            早押し · anime music buzzer
          </p>
          <h1 className="headline">The music stops for whoever gets there first.</h1>
        </div>

        <div className="join-row">
          <AvatarPicker
            value={avatar}
            monogram={firstGrapheme(name.trim()) || '?'}
            onChange={setAvatar}
            variant="field"
          />
          <div className="field">
            <label htmlFor="j-name">Your name</label>
            <input
              id="j-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={24}
              autoComplete="nickname"
              required
            />
          </div>
        </div>

        <div className="join-row">
          <div className="field">
            <label htmlFor="j-room">Room code</label>
            <input
              id="j-room"
              value={room}
              onChange={(e) => setRoom(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              maxLength={12}
              placeholder="GXKQT"
              required
            />
          </div>
          <button type="button" className="btn" onClick={() => void createRoom()} disabled={busy}>
            New room
          </button>
        </div>

        <button className="btn" data-variant="primary" type="submit" disabled={!name.trim() || !room.trim()}>
          {status === 'connecting' ? 'Connecting…' : 'Join room'}
        </button>

        <p className="subtle join-note">
          Share the room code with friends, or send them the link once you are in.
        </p>
      </form>
    </div>
  );
}
