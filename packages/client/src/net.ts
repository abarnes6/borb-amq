import type { ClientMessage, ServerMessage } from '@borb/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

const PING_INTERVAL_MS = 5_000;
const CLOCK_SAMPLES = 8;

interface ClockSample {
  rtt: number;
  offset: number;
}

export class GameSocket {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private samples: ClockSample[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private pending: ClientMessage[] = [];

  onStatus: ((status: ConnectionStatus) => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly hello: () => ClientMessage,
  ) {}

  connect(): void {
    if (this.stopped) return;
    this.onStatus?.('connecting');

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.samples = [];
      this.onStatus?.('open');
      ws.send(JSON.stringify(this.hello()));
      for (const msg of this.pending.splice(0)) ws.send(JSON.stringify(msg));
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        this.recordSample(msg.clientTime, msg.serverTime);
        return;
      }
      for (const listener of this.listeners) listener(msg);
    };

    ws.onclose = () => {
      this.clearPing();
      this.ws = null;
      this.onStatus?.('closed');
      if (this.stopped) return;
      const delay = Math.min(8_000, 400 * 2 ** this.attempts++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => ws.close();
  }

  close(): void {
    this.stopped = true;
    this.clearPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private static readonly REPLAYABLE = new Set(['join', 'settings', 'use_list', 'clear_list', 'ready']);

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (GameSocket.REPLAYABLE.has(msg.t) && this.pending.length < 16) this.pending.push(msg);
  }

  subscribe(listener: (msg: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  get clockOffset(): number {
    let best: ClockSample | null = null;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best?.offset ?? 0;
  }

  get latencyMs(): number | null {
    let best: ClockSample | null = null;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best ? Math.round(best.rtt) : null;
  }

  private ping(): void {
    this.send({ t: 'ping', clientTime: Date.now() });
  }

  private recordSample(clientTime: number, serverTime: number): void {
    const now = Date.now();
    const rtt = now - clientTime;
    if (rtt < 0) return;
    this.samples.push({ rtt, offset: serverTime + rtt / 2 - now });
    if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export function websocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
