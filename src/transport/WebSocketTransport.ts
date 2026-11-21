import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from "../protocol/types";
import type { ConnectionStatus, Transport } from "./Transport";

/** Connects to the EuroScope plugin's local WebSocket server, reconnecting with backoff. */
export class WebSocketTransport implements Transport {
  readonly kind = "plugin" as const;
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string) {}

  connect(onMessage: (m: ServerMsg) => void, onStatus: (s: ConnectionStatus) => void) {
    const open = () => {
      if (this.closed) return;
      onStatus("connecting");
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.retry = 0;
        onStatus("connected");
        this.send({ v: PROTOCOL_VERSION, type: "hello", client: "india-efss", version: "0.1.0" });
        this.pingTimer = setInterval(() => this.send({ v: PROTOCOL_VERSION, type: "ping" }), 5000);
      };
      ws.onmessage = (ev) => {
        try {
          onMessage(JSON.parse(ev.data as string) as ServerMsg);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        onStatus("disconnected");
        if (this.closed) return;
        const delay = Math.min(10000, 500 * 2 ** this.retry++);
        this.reconnectTimer = setTimeout(open, delay);
      };
    };
    open();
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
