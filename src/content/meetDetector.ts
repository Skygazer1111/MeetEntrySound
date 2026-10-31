// DOM-side meeting observation. Deliberately avoids Meet's obfuscated CSS class names; it relies
// on semantic hooks (aria-labels, Material icon ligature names, headings) and treats every signal
// as best effort. The state machine also requires a media-layer signal before declaring "joined".

const STANDARD_CODE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/;
const NICKNAME = /^\/([a-z0-9][a-z0-9_-]{3,})\/?$/;
const RESERVED_PATHS = new Set(['landing', 'new', 'lookup', 'whoops', 'about', 'start', 'schedule', 'calling', 'home', 'tel', 'check']);

/** Returns the meeting identifier for a meet.google.com pathname, or null if this is not a meeting page. */
export function parseMeetCode(rawPathname: string): string | null {
  // Normalise account-switcher (/u/1/...) and embedded (/_meet/...) prefixes; 1:1 calls use /call/<id>.
  const pathname = rawPathname.replace(/^\/(?:u\/\d+|_meet)(?=\/)/, '');
  const call = /^\/call\/([A-Za-z0-9_-]{4,})/.exec(pathname);
  if (call) return call[1];
  const std = STANDARD_CODE.exec(pathname);
  if (std) return std[1];
  const nick = NICKNAME.exec(pathname);
  if (nick && !RESERVED_PATHS.has(nick[1])) return nick[1];
  return null;
}

export interface DomSignals {
  leaveControl: boolean;
  waitingText: boolean;
  joinButton: boolean;
}

const LEAVE_LABEL = /leave (call|meeting)|end call/i;
const JOIN_TEXT = /\b(join now|ask to join|switch here|join anyway|rejoin)\b/i;
const WAITING_TEXT = /asking to be let in|someone will let you in|waiting for (the host|someone)|you'?ll join when someone lets you in/i;

export function readDomSignals(doc: Document): DomSignals {
  return {
    leaveControl: hasLeaveControl(doc),
    waitingText: hasWaitingText(doc),
    joinButton: hasJoinButton(doc),
  };
}

function hasLeaveControl(doc: Document): boolean {
  for (const el of doc.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
    if (LEAVE_LABEL.test(el.getAttribute('aria-label') ?? '')) return true;
  }
  // Language-independent fallback: the Material icon ligature used on the hang-up button.
  for (const icon of doc.querySelectorAll('button i, [role="button"] i, button .google-material-icons, button .material-icons')) {
    if (icon.textContent?.trim() === 'call_end') return true;
  }
  return false;
}

function hasWaitingText(doc: Document): boolean {
  for (const el of doc.querySelectorAll('h1, h2, h3, [role="heading"], [role="status"], [aria-live]')) {
    if (WAITING_TEXT.test(el.textContent ?? '')) return true;
  }
  return false;
}

function hasJoinButton(doc: Document): boolean {
  for (const el of doc.querySelectorAll('button, [role="button"]')) {
    const text = (el.textContent ?? '').trim();
    if (text.length > 0 && text.length < 40 && JOIN_TEXT.test(text)) return true;
  }
  return false;
}

/** Calls onChange (throttled) whenever the page DOM or URL-relevant state may have changed. */
export class MeetDetector {
  private observer: MutationObserver | null = null;
  private timer: number | undefined;

  constructor(
    private onChange: () => void,
    private throttleMs = 200,
  ) {}

  start(): void {
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
    window.addEventListener('popstate', this.schedule);
    window.addEventListener('hashchange', this.schedule);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener('popstate', this.schedule);
    window.removeEventListener('hashchange', this.schedule);
    window.clearTimeout(this.timer);
  }

  private schedule = (): void => {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.onChange();
    }, this.throttleMs);
  };
}
