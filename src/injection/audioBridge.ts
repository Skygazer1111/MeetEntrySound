// MAIN-world side of the bridge. Receives a MessagePort from the content script, then speaks the
// validated protocol in src/types/bridge.ts over it. The page's own scripts can see the one-time
// handoff message but cannot read or write the port afterwards, and every command is validated.

import { BRIDGE_SOURCE, MAIN_READY_EVENT, parseBridgeCommand, type BridgeEvent } from '@/types/bridge';
import type { EntrancePlayer, PlayOutcome } from './microphoneMixer';
import type { PeerTracker } from './peerTracker';

export class MainBridge {
  private port: MessagePort | null = null;

  constructor(
    private tracker: PeerTracker,
    private player: EntrancePlayer,
  ) {}

  start(): void {
    window.addEventListener('message', (e: MessageEvent) => {
      if (this.port) return; // first valid handoff wins
      if (e.source !== window || e.origin !== window.location.origin) return;
      const d = e.data as { source?: unknown; type?: unknown } | null;
      if (!d || d.source !== BRIDGE_SOURCE || d.type !== 'init-port') return;
      const port = e.ports[0];
      if (!port) return;
      this.port = port;
      port.onmessage = (m) => this.handle(m.data);
      this.send({ type: 'hello' });
      this.send({ type: 'peers', peers: this.tracker.summary() });
    });
    // Tell an already-running content script that we are ready to receive the port.
    window.dispatchEvent(new CustomEvent(MAIN_READY_EVENT));
  }

  send(ev: BridgeEvent): void {
    try {
      this.port?.postMessage(ev);
    } catch {
      /* port closed */
    }
  }

  private handle(data: unknown): void {
    const cmd = parseBridgeCommand(data);
    if (!cmd) return;
    switch (cmd.type) {
      case 'load-clip':
        this.player.setClip(cmd.clipKey, cmd.wav);
        this.send({ type: 'clip-loaded', clipKey: cmd.clipKey });
        break;
      case 'play':
        void this.player
          .play(cmd)
          .catch((): PlayOutcome => ({ ok: false, reason: 'internal-error', message: 'Unexpected error.' }))
          .then((o) =>
            this.send(
              o.ok
                ? { type: 'play-result', requestId: cmd.requestId, ok: true }
                : { type: 'play-result', requestId: cmd.requestId, ok: false, reason: o.reason, message: o.message },
            ),
          );
        break;
      case 'stop':
        this.player.stop(cmd.reason);
        break;
      case 'query':
        this.send({ type: 'peers', peers: this.tracker.summary() });
        break;
    }
  }
}
