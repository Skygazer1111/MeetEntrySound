// MAIN-world entry point (injected into meet.google.com at document_start, before Meet's scripts).
// Must stay a single synchronous script: see scripts/build-scripts.mjs.

import { MainBridge } from './audioBridge';
import { EntrancePlayer } from './microphoneMixer';
import { PeerTracker } from './peerTracker';

const INSTALLED = Symbol.for('meetentry.injected');
const w = window as unknown as Record<symbol, boolean>;

function bootstrap(): void {
  if (w[INSTALLED]) return;
  w[INSTALLED] = true;

  const tracker = new PeerTracker();
  tracker.install(window);

  // eslint-disable-next-line prefer-const
  let bridge: MainBridge;
  const player = new EntrancePlayer(tracker, {
    onEnded: (reason) => {
      bridge.send({ type: 'playback-ended', reason });
      bridge.send({ type: 'peers', peers: tracker.summary() });
    },
    onRouting: (state, detail) => bridge.send({ type: 'routing', state, detail }),
  });
  bridge = new MainBridge(tracker, player);

  tracker.onChange(() => bridge.send({ type: 'peers', peers: tracker.summary() }));

  // Always give the original track back if the page is going away mid-clip.
  window.addEventListener('pagehide', () => player.stop('pagehide'));

  bridge.start();
}

try {
  bootstrap();
} catch {
  // Fail safe: if anything here breaks, Google Meet must keep working untouched.
}
