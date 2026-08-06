import { Room } from './room.ts';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeRoomId(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return cleaned || randomRoomCode();
}

export function randomRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join('');
}

export class Hub {
  private readonly rooms = new Map<string, Room>();

  constructor() {
    setInterval(() => this.sweep(), 30_000).unref();
  }

  getOrCreate(id: string): Room {
    const roomId = normalizeRoomId(id);
    const existing = this.rooms.get(roomId);
    if (existing && !existing.isDisposed) return existing;

    const room = new Room(roomId);
    this.rooms.set(roomId, room);
    return room;
  }

  get count(): number {
    return this.rooms.size;
  }

  private sweep(): void {
    for (const [id, room] of this.rooms) {
      room.reapDisconnected();
      if (room.isEmpty) {
        room.dispose();
        this.rooms.delete(id);
      }
    }
  }
}

export const hub = new Hub();
