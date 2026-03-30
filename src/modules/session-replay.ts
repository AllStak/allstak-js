import { HttpTransport } from '../transport/http';
import { AllStakConfig } from '../client';

export interface DOMEvent {
  type: string;
  timestamp: string;
  data: unknown;
}

// Matches backend ReplayIngestRequest DTO exactly
interface ReplayIngestPayload {
  fingerprint: string;
  sessionId: string;
  events: ReplayEventItem[];
}

interface ReplayEventItem {
  eventType: string;
  eventData: string; // JSON-encoded event data
  url?: string;
  timestampMillis: number;
}

/** @deprecated — kept for backwards compat; internal format changed to match backend */
export interface ReplayEvent {
  type: 'replay';
  dsn: string;
  sessionId: string;
  timestamp: string;
  events: DOMEvent[];
  environment: string;
}

const INGEST_PATH = '/ingest/v1/replay';
const FLUSH_INTERVAL_MS = 10_000;
const BATCH_SIZE_THRESHOLD = 50;

export class SessionReplayModule {
  private events: DOMEvent[] = [];
  private observer: MutationObserver | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private maskAllInputs: boolean;

  constructor(
    private transport: HttpTransport,
    private config: AllStakConfig,
    private sessionId: string,
  ) {
    this.maskAllInputs = config.sessionReplay?.maskAllInputs ?? false;

    const sampleRate = config.sessionReplay?.sampleRate ?? 1.0;
    if (Math.random() > sampleRate) return;

    this.startRecording();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  private startRecording(): void {
    if (typeof document === 'undefined') return;

    // DOM mutations
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        this.pushEvent({
          type: 'mutation',
          timestamp: new Date().toISOString(),
          data: {
            mutationType: mutation.type,
            target: this.serializeNode(mutation.target),
            addedNodes: mutation.addedNodes.length,
            removedNodes: mutation.removedNodes.length,
          },
        });
      }
    });

    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    // Click events
    document.addEventListener('click', this.handleClick);

    // Scroll events
    document.addEventListener('scroll', this.handleScroll, { passive: true });

    // Input events
    document.addEventListener('input', this.handleInput, { capture: true });
  }

  private handleClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    this.pushEvent({
      type: 'click',
      timestamp: new Date().toISOString(),
      data: {
        x: e.clientX,
        y: e.clientY,
        target: target ? this.serializeElement(target) : null,
      },
    });
  };

  private handleScroll = (): void => {
    this.pushEvent({
      type: 'scroll',
      timestamp: new Date().toISOString(),
      data: {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    });
  };

  private handleInput = (e: Event): void => {
    const target = e.target as HTMLInputElement | null;
    if (!target) return;

    const value = this.maskAllInputs ? '***' : target.value;
    this.pushEvent({
      type: 'input',
      timestamp: new Date().toISOString(),
      data: {
        target: this.serializeElement(target),
        value,
      },
    });
  };

  private pushEvent(event: DOMEvent): void {
    this.events.push(event);
    if (this.events.length >= BATCH_SIZE_THRESHOLD) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.events.length === 0) return;

    const batch = this.events.splice(0, this.events.length);
    const currentUrl = typeof window !== 'undefined' ? window.location.href : undefined;

    const payload: ReplayIngestPayload = {
      // Use sessionId as the fingerprint — ties browser session to any captured errors
      fingerprint: this.sessionId,
      sessionId: this.sessionId,
      events: batch.map((e) => ({
        eventType: e.type,
        eventData: JSON.stringify(e.data),
        url: currentUrl,
        timestampMillis: new Date(e.timestamp).getTime(),
      })),
    };

    this.transport.send(INGEST_PATH, payload);
  }

  private serializeNode(node: Node): string {
    if (node instanceof Element) {
      return this.serializeElement(node);
    }
    return node.nodeName;
  }

  private serializeElement(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const classes = el.className
      ? `.${String(el.className).split(' ').join('.')}`
      : '';
    return `${tag}${id}${classes}`;
  }

  destroy(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('click', this.handleClick);
      document.removeEventListener('scroll', this.handleScroll);
      document.removeEventListener('input', this.handleInput, { capture: true } as EventListenerOptions);
    }
    // Flush remaining events
    this.flush();
  }
}
