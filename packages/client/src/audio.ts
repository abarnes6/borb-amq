export type AudioBlockedHandler = () => void;

export class RoundAudio {
  readonly el: HTMLAudioElement;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private unlocked = false;

  onBlocked: AudioBlockedHandler | null = null;

  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.autoplay = false;
  }

  async unlock(): Promise<void> {
    if (this.unlocked) return;
    try {
      this.el.muted = true;
      await this.el.play();
      this.el.pause();
      this.el.currentTime = 0;
      this.unlocked = true;
    } catch {
    } finally {
      this.el.muted = false;
    }
  }

  load(url: string): Promise<void> {
    this.cancelScheduled();
    return new Promise((resolve, reject) => {
      const el = this.el;

      const cleanup = (): void => {
        el.removeEventListener('canplaythrough', onReady);
        el.removeEventListener('error', onError);
        clearTimeout(guard);
      };
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error('audio failed to load'));
      };
      const guard = setTimeout(() => {
        if (el.readyState >= 3) onReady();
        else onError();
      }, 15_000);

      el.addEventListener('canplaythrough', onReady, { once: true });
      el.addEventListener('error', onError, { once: true });
      el.src = url;
      el.load();
    });
  }

  scheduleStart(delayMs: number, seekMs: number): void {
    this.cancelScheduled();
    const begin = (): void => {
      const target = seekMs / 1000;
      if (Number.isFinite(target) && target > 0) {
        try {
          this.el.currentTime = target;
        } catch {
        }
      }
      void this.el.play().catch(() => this.onBlocked?.());
    };

    if (delayMs <= 0) begin();
    else this.startTimer = setTimeout(begin, delayMs);
  }

  pause(): void {
    this.cancelScheduled();
    this.el.pause();
  }

  stop(): void {
    this.cancelScheduled();
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
  }

  setVolume(v: number): void {
    this.el.volume = Math.min(1, Math.max(0, v));
  }

  private cancelScheduled(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }
}
