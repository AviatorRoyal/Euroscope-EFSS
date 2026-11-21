import type { ClientMsg, ServerMsg } from "../protocol/types";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface Transport {
  readonly kind: "sim" | "plugin";
  connect(onMessage: (m: ServerMsg) => void, onStatus: (s: ConnectionStatus) => void): void;
  send(msg: ClientMsg): void;
  close(): void;
}
