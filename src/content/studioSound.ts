// Best-effort automation of Meet's "Studio sound" (also called noise cancellation) switch.
//
// Why: Studio sound "filters out sound from your mic that isn't speech", i.e. it destroys music.
// Meet has no API for it, so we open Settings > Audio, flip the switch, and close the dialog again.
// Everything here is best effort and FAILS SAFE: any missing element, timeout or error cleans up
// (hidden-dialog style removed, dialog closed with Escape) and reports 'failed'. It never touches
// anything except that one switch, and it never un-mutes the microphone.

export type StudioResult = { status: 'changed' | 'unchanged' | 'failed'; detail: string };

export interface StudioOptions {
  /** How long to wait for the "More options" button (the toolbar may still be rendering after admission). */
  moreOptionsWaitMs?: number;
  /** Pause before the single retry of a failed switch-off. */
  retryDelayMs?: number;
}

const SWITCH_SELECTOR = '[role="switch"], input[type="checkbox"], button[aria-checked]';
const LABEL = /studio sound|noise cancell?ation/i;
const OVERALL_TIMEOUT_MS = 6000;
const STEP_TIMEOUT_MS = 1500;
const MORE_OPTIONS_WAIT_MS = 2500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const HIDE_STYLE_ID = 'meetentry-hide-settings';
const PENDING_KEY = 'meetentry:studioSoundOff';

class StepError extends Error {}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Resolves with the first truthy result of `probe` (re-checked on DOM changes and every 50 ms), or null on timeout. */
function waitFor<T>(doc: Document, probe: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const first = probe();
    if (first) return resolve(first);
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(v);
    };
    const check = () => {
      const v = probe();
      if (v) finish(v);
    };
    const observer = new MutationObserver(check);
    observer.observe(doc, { childList: true, subtree: true, attributes: true });
    const poll = setInterval(check, 50);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Full pointer sequence: some Material controls ignore a bare click(). */
function press(el: Element): void {
  const win = el.ownerDocument.defaultView;
  if (!win) return (el as HTMLElement).click();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true }));
  }
  (el as HTMLElement).click();
}

function pressEscape(doc: Document): void {
  const win = doc.defaultView;
  if (!win) return;
  for (const target of [doc.activeElement ?? doc.body, doc]) {
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new win.KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    }
  }
}

// ---- finders ---------------------------------------------------------------------------------

export function findMoreOptionsButton(doc: Document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]')) {
    if (/^more options$/i.test(norm(el.getAttribute('aria-label')))) return el;
  }
  for (const icon of doc.querySelectorAll('button i, [role="button"] i, button .google-material-icons, button .material-icons')) {
    if (norm(icon.textContent) === 'more_vert') return icon.closest<HTMLElement>('button, [role="button"]');
  }
  return null;
}

function findSettingsMenuItem(doc: Document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="option"], li, button')) {
    const t = norm(el.textContent).toLowerCase();
    if (t.length > 30 || /audio|video|host|call|caption|accessib/.test(t)) continue;
    // The visible label is "Settings"; the icon ligature text ("settings") may be glued to it.
    if (/^(settings\s*)+$/.test(t) || (/settings$/.test(t) && t.length <= 20)) return el;
  }
  return null;
}

function findSettingsDialog(doc: Document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>('[role="dialog"]')) {
    if (el.querySelector('[role="tab"]') || el.querySelector(SWITCH_SELECTOR)) return el;
  }
  return null;
}

function findAudioTab(dialog: HTMLElement): HTMLElement | null {
  for (const tab of dialog.querySelectorAll<HTMLElement>('[role="tab"]')) {
    if (/audio$/i.test(norm(tab.textContent))) return tab;
  }
  return null;
}

function labelOf(sw: Element): string {
  const aria = norm(sw.getAttribute('aria-label'));
  if (aria) return aria;
  const by = sw.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => norm(sw.ownerDocument.getElementById(id)?.textContent))
      .join(' ')
      .trim();
    if (text) return text;
  }
  // Fall back to the text of the smallest surrounding container that has real text and holds only this switch.
  let el = sw.parentElement;
  for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
    if (el.querySelectorAll(SWITCH_SELECTOR).length !== 1) break;
    const t = norm(el.textContent);
    if (t.length >= 6) return t.slice(0, 240);
  }
  return '';
}

export function findStudioSwitch(root: ParentNode): HTMLElement | null {
  for (const sw of root.querySelectorAll<HTMLElement>(SWITCH_SELECTOR)) {
    if (LABEL.test(labelOf(sw))) return sw;
  }
  return null;
}

export function isSwitchOn(sw: Element): boolean | null {
  const aria = sw.getAttribute('aria-checked');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  if (sw instanceof (sw.ownerDocument.defaultView?.HTMLInputElement ?? HTMLInputElement)) return sw.checked;
  return null;
}

// ---- core ------------------------------------------------------------------------------------

/**
 * Opens Settings > Audio, makes the Studio sound switch match `desired`, closes the dialog.
 * Resolves 'changed' only if the switch really flipped, 'unchanged' if it was already right.
 */
export async function setStudioSound(desired: boolean, doc: Document = document, opts: StudioOptions = {}): Promise<StudioResult> {
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  const budget = (ms = STEP_TIMEOUT_MS) => Math.max(50, Math.min(ms, deadline - Date.now()));
  const need = async <T>(what: string, probe: () => T | null | undefined | false, ms?: number): Promise<T> => {
    const v = await waitFor(doc, probe, budget(ms));
    if (!v) throw new StepError(`could not find ${what}`);
    return v;
  };

  const style = doc.createElement('style');
  style.id = HIDE_STYLE_ID;
  // Visually hide Meet's menu and dialog while we drive them (they stay in the DOM and clickable by script).
  style.textContent = '[role="menu"], [role="dialog"] { opacity: 0 !important; transition: none !important; animation: none !important; }';
  (doc.head ?? doc.documentElement).appendChild(style);
  const watchdog = setTimeout(() => style.remove(), OVERALL_TIMEOUT_MS + 500);

  let dialog: HTMLElement | null = null;
  let status: StudioResult['status'] = 'failed';
  let detail = '';
  try {
    // Step 1: the call toolbar. Right after admission from a waiting room it may still be rendering.
    const more = await need('the "More options" button', () => findMoreOptionsButton(doc), opts.moreOptionsWaitMs ?? MORE_OPTIONS_WAIT_MS);
    press(more);

    // Step 2: Settings entry in the menu.
    const settingsItem = await need('the "Settings" menu item', () => findSettingsMenuItem(doc));
    press(settingsItem);

    // Step 3: the settings dialog and its Audio tab.
    dialog = await need('the settings dialog', () => findSettingsDialog(doc));
    const tab = findAudioTab(dialog);
    if (tab && tab.getAttribute('aria-selected') !== 'true') press(tab);

    // Step 4: the switch itself.
    const sw = await need('the "Studio sound" switch', () => findStudioSwitch(doc));
    const before = isSwitchOn(sw);
    if (before === null) throw new StepError('could not read the Studio sound switch state');
    if (before === desired) {
      status = 'unchanged';
      detail = `Studio sound was already ${desired ? 'on' : 'off'}.`;
    } else {
      press(sw);
      const flipped = await waitFor(doc, () => isSwitchOn(sw) === desired, budget());
      if (!flipped) throw new StepError('the Studio sound switch did not change');
      status = 'changed';
      detail = `Studio sound turned ${desired ? 'on' : 'off'}.`;
    }
  } catch (e) {
    status = 'failed';
    detail = e instanceof Error ? e.message : 'unexpected error';
  } finally {
    await closeDialog(doc, dialog);
    clearTimeout(watchdog);
    style.remove();
  }
  return { status, detail };
}

/** Closes the settings dialog (Close button first, Escape as fallback) and any leftover menu. */
async function closeDialog(doc: Document, dialog: HTMLElement | null): Promise<void> {
  const open = () => findSettingsDialog(doc) !== null || doc.querySelector('[role="menu"]') !== null;
  const buttons = dialog ? [...dialog.querySelectorAll<HTMLElement>('button[aria-label]')] : [];
  const close = buttons.find((b) => /^close$/i.test(norm(b.getAttribute('aria-label'))));
  if (close) press(close);
  if (await waitFor(doc, () => !open(), 400)) return;
  for (let i = 0; i < 2; i++) {
    pressEscape(doc);
    if (await waitFor(doc, () => !open(), 400)) return;
  }
}

// ---- controller ------------------------------------------------------------------------------

/**
 * Owns the "we switched it off, so we must switch it back on" bookkeeping. The flag lives in
 * sessionStorage so a stale "off" is still repaired after a reload or the next meeting in this tab.
 */
export class StudioSoundController {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private doc: Document = document,
    private store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = sessionStorage,
    private opts: StudioOptions = {},
  ) {}

  /** True when we turned Studio sound off earlier and have not restored it yet. */
  get pendingRestore(): boolean {
    return this.store.getItem(PENDING_KEY) === '1';
  }

  /** Turns Studio sound off. If it was off already (and not by us) nothing is changed and nothing will be restored. */
  disableForEntrance(): Promise<StudioResult> {
    return this.run(async () => {
      let r = await setStudioSound(false, this.doc, this.opts);
      if (r.status === 'failed') {
        // The call UI can be busy right after joining (panels opening, toolbar re-rendering): try once more.
        await sleep(this.opts.retryDelayMs ?? 1000);
        const retry = await setStudioSound(false, this.doc, this.opts);
        r = retry.status === 'failed' ? { status: 'failed', detail: `${r.detail}; retry: ${retry.detail}` } : retry;
      }
      if (r.status === 'changed') this.store.setItem(PENDING_KEY, '1');
      return r;
    });
  }

  /** Turns Studio sound back on, but only if we were the ones who turned it off. */
  restore(): Promise<StudioResult> {
    return this.run(async () => {
      if (!this.pendingRestore) return { status: 'unchanged', detail: 'Nothing to restore.' } as StudioResult;
      const r = await setStudioSound(true, this.doc, this.opts);
      if (r.status !== 'failed') this.store.removeItem(PENDING_KEY);
      return r;
    });
  }

  /** Mutex: dialogs cannot be driven twice at once. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }
}