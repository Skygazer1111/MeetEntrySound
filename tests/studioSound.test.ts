// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { StudioSoundController, findStudioSwitch, setStudioSound } from '@/content/studioSound';
import { sanitizeSettings } from '@/storage/settings';

interface Fixture {
  switchOn: boolean;
  withSwitch?: boolean;
  withCloseButton?: boolean;
  withMoreOptions?: boolean;
}

/** Minimal imitation of Meet's call toolbar -> More options -> Settings -> Audio -> Studio sound flow. */
function mountMeet(opts: Fixture) {
  const { withSwitch = true, withCloseButton = true, withMoreOptions = true } = opts;
  const state = { on: opts.switchOn, clicks: 0, dialogOpen: false };
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root')!;

  const closeDialog = () => {
    document.querySelector('[role="dialog"]')?.remove();
    state.dialogOpen = false;
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelector('[role="menu"]')?.remove();
      closeDialog();
    }
  });

  if (withMoreOptions) {
    const more = document.createElement('button');
    more.setAttribute('aria-label', 'More options');
    more.addEventListener('click', () => {
      if (document.querySelector('[role="menu"]')) return;
      const menu = document.createElement('ul');
      menu.setAttribute('role', 'menu');
      const item = document.createElement('li');
      item.setAttribute('role', 'menuitem');
      item.innerHTML = '<i class="google-material-icons">settings</i><span>Settings</span>';
      item.addEventListener('click', () => {
        menu.remove();
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = `
          <button role="tab" aria-selected="false">Video</button>
          <button role="tab" aria-selected="true">Audio</button>
          <div class="row"><div>Microphone</div><button role="combobox"></button></div>
          ${
            withSwitch
              ? `<div><div>Studio sound</div><div>Filters out sound from your mic that isn't speech</div>
                   <button role="switch" aria-checked="${state.on}"></button></div>`
              : ''
          }
          ${withCloseButton ? '<button aria-label="Close">x</button>' : ''}`;
        const sw = dialog.querySelector('[role="switch"]');
        sw?.addEventListener('click', () => {
          state.on = !state.on;
          state.clicks++;
          sw.setAttribute('aria-checked', String(state.on));
        });
        dialog.querySelector('[aria-label="Close"]')?.addEventListener('click', closeDialog);
        root.appendChild(dialog);
        state.dialogOpen = true;
      });
      menu.appendChild(item);
      root.appendChild(menu);
    });
    root.appendChild(more);
  }
  return state;
}

const memoryStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('setStudioSound', () => {
  it('turns Studio sound off, closes the dialog and removes the hiding style', async () => {
    const meet = mountMeet({ switchOn: true });
    const r = await setStudioSound(false);
    expect(r.status).toBe('changed');
    expect(meet.on).toBe(false);
    expect(meet.dialogOpen).toBe(false);
    expect(document.getElementById('meetentry-hide-settings')).toBeNull();
  });

  it('leaves it alone when it is already in the wanted state', async () => {
    const meet = mountMeet({ switchOn: false });
    const r = await setStudioSound(false);
    expect(r.status).toBe('unchanged');
    expect(meet.clicks).toBe(0);
    expect(meet.dialogOpen).toBe(false);
  });

  it('falls back to Escape when there is no Close button', async () => {
    const meet = mountMeet({ switchOn: true, withCloseButton: false });
    const r = await setStudioSound(false);
    expect(r.status).toBe('changed');
    expect(meet.dialogOpen).toBe(false);
  });

  it('fails fast and safe when the More options button is missing', async () => {
    mountMeet({ switchOn: true, withMoreOptions: false });
    const started = Date.now();
    const r = await setStudioSound(false);
    expect(r.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(document.getElementById('meetentry-hide-settings')).toBeNull();
  });

  it('fails safe and cleans up when the switch is not in the dialog', async () => {
    const meet = mountMeet({ switchOn: true, withSwitch: false });
    const r = await setStudioSound(false);
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/Studio sound/);
    expect(meet.dialogOpen).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.getElementById('meetentry-hide-settings')).toBeNull();
  });
});

describe('findStudioSwitch', () => {
  it('finds the switch by its surrounding label text', () => {
    document.body.innerHTML = `<div><div>Studio sound</div><div>Filters out sound from your mic that isn't speech</div><button role="switch" aria-checked="true"></button></div>
      <div><div>Something else entirely</div><button role="switch" aria-checked="false"></button></div>`;
    expect(findStudioSwitch(document)?.getAttribute('aria-checked')).toBe('true');
  });

  it('also accepts a noise cancellation label via aria-label', () => {
    document.body.innerHTML = '<input type="checkbox" aria-label="Noise cancellation" checked>';
    expect(findStudioSwitch(document)).not.toBeNull();
  });
});

describe('StudioSoundController', () => {
  it('restores only what it switched off', async () => {
    const meet = mountMeet({ switchOn: true });
    const c = new StudioSoundController(document, memoryStore());
    expect((await c.disableForEntrance()).status).toBe('changed');
    expect(meet.on).toBe(false);
    expect(c.pendingRestore).toBe(true);
    expect((await c.restore()).status).toBe('changed');
    expect(meet.on).toBe(true);
    expect(c.pendingRestore).toBe(false);
  });

  it('does not turn it on if the user already had it off', async () => {
    const meet = mountMeet({ switchOn: false });
    const c = new StudioSoundController(document, memoryStore());
    expect((await c.disableForEntrance()).status).toBe('unchanged');
    expect(c.pendingRestore).toBe(false);
    expect((await c.restore()).status).toBe('unchanged');
    expect(meet.on).toBe(false);
    expect(meet.clicks).toBe(0);
  });

  it('keeps the pending flag when a restore fails, so it is retried later', async () => {
    mountMeet({ switchOn: true });
    const c = new StudioSoundController(document, memoryStore());
    await c.disableForEntrance();
    document.body.innerHTML = ''; // Meet UI gone (e.g. left the meeting)
    expect((await c.restore()).status).toBe('failed');
    expect(c.pendingRestore).toBe(true);
  });
});

describe('autoDisableStudioSound setting', () => {
  it('defaults to on and only accepts real booleans', () => {
    expect(sanitizeSettings({}).autoDisableStudioSound).toBe(true);
    expect(sanitizeSettings({ autoDisableStudioSound: false }).autoDisableStudioSound).toBe(false);
    expect(sanitizeSettings({ autoDisableStudioSound: 'no' }).autoDisableStudioSound).toBe(true);
  });
});
