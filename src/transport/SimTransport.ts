import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from "../protocol/types";
import { Simulator, type SimOptions } from "../sim/simulator";
import type { ConnectionStatus, Transport } from "./Transport";

/** Runs the traffic simulator in the page, behind the same interface as the plugin. */
export class SimTransport implements Transport {
  readonly kind = "sim" as const;
  readonly sim: Simulator;

  constructor(opts: SimOptions) {
    this.sim = new Simulator(opts);
  }

  connect(onMessage: (m: ServerMsg) => void, onStatus: (s: ConnectionStatus) => void) {
    onStatus("connected");
    // Deliver asynchronously, like a socket would.
    this.sim.start((m) => queueMicrotask(() => onMessage(m)));
    this.send({ v: PROTOCOL_VERSION, type: "hello", client: "india-efss", version: "0.1.0" });
  }

  send(msg: ClientMsg) {
    this.sim.handle(msg);
  }

  close() {
    this.sim.stop();
  }
}
