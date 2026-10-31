// Minimal in-page notification (shadow DOM so Meet's styles cannot affect it and ours cannot leak).
// Used to explain why entrance music was skipped, e.g. "you are muted".

let host: HTMLElement | null = null;

export function showToast(message: string, level: 'info' | 'warn' | 'error' = 'info', ms = 6000): void {
  const parent = document.documentElement;
  if (!parent) return;
  host?.remove();
  host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;bottom:96px;transform:translateX(-50%);';
  const root = host.attachShadow({ mode: 'closed' });
  const accent = level === 'error' ? '#f87171' : level === 'warn' ? '#fbbf24' : '#8b5cf6';
  const style = document.createElement('style');
  style.textContent = `
    .t{font:13px/1.4 'Google Sans',Roboto,Arial,sans-serif;color:#e8eaf6;background:#151728;border:1px solid ${accent};
       border-left-width:4px;border-radius:10px;padding:10px 14px;max-width:360px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
    .n{font-weight:700;color:${accent};margin-right:6px}`;
  const box = document.createElement('div');
  box.className = 't';
  const name = document.createElement('span');
  name.className = 'n';
  name.textContent = 'MeetEntry';
  box.append(name, document.createTextNode(message));
  root.append(style, box);
  parent.appendChild(host);
  const mine = host;
  window.setTimeout(() => {
    if (host === mine) {
      mine.remove();
      host = null;
    }
  }, ms);
}
