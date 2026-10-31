// Isolated-world side of the bridge to the MAIN-world script.
// Hands a MessagePort to the page-context script and retries until it answers "hello"
// (the two scripts run at the same moment, so either could be first).

import { BRIDGE_SOURCE, MAIN_READY_EVENT, parseBridgeEvent, type BridgeCommand, type BridgeEvent } from '@/types/bridge';

export class BridgeClient {
  connected = false;
  private port: MessagePort | null = null;
  private pending: MessagePort[] = [];
  private attempts = 0;
  private timer: number | undefined;

  constructor(
    private onEvent: (e: BridgeEvent) => void,
    private onConnected: () => void,
  ) {}

  connect(): void {
    window.addEventListener(MAIN_READY_EVENT, this.attempt);
    this.attempt();
    this.timer = window.setInterval(() => {
      if (this.connected || ++this.attempts > 40) {
        window.clearInterval(this.timer);
        return;
      }
      this.attempt();
    }, 500);
  }

  send(cmd: BridgeCommand, transfer: Transferable[] = []): boolean {
    if (!this.port) return false;
    try {
      this.port.postMessage(cmd, transfer);
      return true;
    } catch {
      return false;
    }
  }

  private attempt = (): void => {
    if (this.connected) return;
    const channel = new MessageChannel();
    this.pending.push(channel.port1);
    channel.port1.onmessage = (m) => {
      const ev = parseBridgeEvent(m.data);
      if (!ev) return;
      if (ev.type === 'hello' && !this.connected) {
        this.connected = true;
        this.port = channel.port1;
        this.pending.filter((p) => p !== channel.port1).forEach((p) => p.close());
        this.pending = [];
        window.removeEventListener(MAIN_READY_EVENT, this.attempt);
        this.onConnected();
      }
      if (this.port === channel.port1) this.onEvent(ev);
    };
    window.postMessage({ source: BRIDGE_SOURCE, type: 'init-port' }, window.location.origin, [channel.port2]);
  };
}
