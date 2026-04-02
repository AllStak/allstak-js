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

interface SnapshotNode {
  tag: string;
  id?: string;
  classes: string[];
  text?: string;
  rect: { x: number; y: number; w: number; h: number };
  styles: {
    bg: string;
    color: string;
    borderRadius: string;
    fontSize: string;
    fontWeight: string;
    border: string;
    display: string;
  };
  children: SnapshotNode[];
}

const INGEST_PATH = '/ingest/v1/replay';
const FLUSH_INTERVAL_MS = 10_000;
const BATCH_SIZE_THRESHOLD = 50;
const SKIP_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'head', 'noscript',
  'template', 'svg', 'path', 'defs', 'clippath',
]);

/**
 * Normalized keywords that trigger input masking.
 * Matched against field name, id, autocomplete, placeholder, aria-label
 * after stripping hyphens, underscores, and spaces (case-insensitive).
 */
const SENSITIVE_FIELD_KEYWORDS = [
  'password', 'passwd', 'pass',
  'cardnumber', 'ccnumber', 'ccnum', 'creditcard', 'debitcard',
  'cvv', 'cvc', 'cvc2', 'cvv2', 'csc', 'securitycode', 'cardcode',
  'expiry', 'expdate', 'cardexpiry', 'cardexp', 'expirationdate', 'expirydate',
  'ssn', 'socialsecurity', 'socialsecuritynumber',
  'pin',
  'secret',
  'token',
  'cardholder', 'nameoncredit', 'nameoncard',
  'bankaccount', 'routingnumber', 'accountnumber',
];

// Normalize a string for sensitive keyword matching (remove separators, lowercase)
function normalizeForMasking(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, '');
}

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

    // Capture DOM snapshot first so visual replay can reconstruct the page layout
    this.captureSnapshot();
    this.flush(); // Send snapshot immediately as its own batch

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

    // Input events — capture phase so we see all inputs before propagation
    document.addEventListener('input', this.handleInput, { capture: true });
  }

  private captureSnapshot(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const nodes = this.serializeVisibleDOM(document.body, 0);

    this.pushEvent({
      type: 'snapshot',
      timestamp: new Date().toISOString(),
      data: {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        title: document.title,
        nodes,
      },
    });
  }

  private serializeVisibleDOM(element: Element, depth: number): SnapshotNode[] {
    if (depth > 6) return [];
    const result: SnapshotNode[] = [];

    for (const child of Array.from(element.children)) {
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;

      const rect = child.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Include elements up to 2× viewport height to capture below-fold content
      if (rect.bottom < 0 || rect.top > window.innerHeight * 2) continue;

      const cs = window.getComputedStyle(child);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      // Collect direct text nodes only (not descendant element text).
      // Input values are NOT text nodes — they are attribute values — so they
      // are never captured in the snapshot, making the snapshot privacy-safe
      // for user-typed content by design.
      const directText = Array.from(child.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent?.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 150);

      const node: SnapshotNode = {
        tag,
        id: child.id || undefined,
        classes: Array.from(child.classList).slice(0, 6),
        text: directText || undefined,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        styles: {
          bg: cs.backgroundColor,
          color: cs.color,
          borderRadius: cs.borderRadius,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          border: cs.border,
          display: cs.display,
        },
        children: depth < 5 ? this.serializeVisibleDOM(child, depth + 1) : [],
      };
      result.push(node);
    }
    return result;
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
    const target = e.target as HTMLInputElement | HTMLTextAreaElement | null;
    if (!target) return;

    const shouldMask = this.shouldMaskInput(target);
    const value = shouldMask ? '[MASKED]' : (target as HTMLInputElement).value;

    this.pushEvent({
      type: 'input',
      timestamp: new Date().toISOString(),
      data: {
        target: this.serializeElement(target),
        value,
        masked: shouldMask,
      },
    });
  };

  /**
   * Determines whether an input field's value should be masked in replay events.
   *
   * Masking applies when ANY of the following are true:
   * 1. `maskAllInputs: true` is set in SDK config
   * 2. The input has `type="password"`
   * 3. The element has a `data-allstak-mask` attribute
   * 4. The field's name, id, autocomplete, placeholder, or aria-label contains
   *    a sensitive keyword (card, cvv, ssn, pin, password, expiry, etc.)
   */
  private shouldMaskInput(el: HTMLInputElement | HTMLTextAreaElement): boolean {
    if (this.maskAllInputs) return true;

    const inputEl = el as HTMLInputElement;

    // Always mask password fields
    if (inputEl.type?.toLowerCase() === 'password') return true;

    // Respect explicit masking attribute
    if (el.hasAttribute('data-allstak-mask')) return true;

    // Build a normalized composite string from all field identifiers
    const identifiers = normalizeForMasking([
      inputEl.name ?? '',
      el.id ?? '',
      inputEl.getAttribute('autocomplete') ?? '',
      inputEl.placeholder ?? '',
      el.getAttribute('aria-label') ?? '',
      el.getAttribute('data-field') ?? '',
    ].join(' '));

    return SENSITIVE_FIELD_KEYWORDS.some((kw) => identifiers.includes(kw));
  }

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
