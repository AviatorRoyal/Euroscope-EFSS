import { create } from "zustand";
import { getAirport, SIM_AIRPORTS } from "../config/airports";
import { autoTransition } from "../model/autoRules";
import { effectiveState, type OnlineSet } from "../model/states";
import {
  PROTOCOL_VERSION,
  type CommandAction,
  type Controller,
  type Flight,
  type Position,
  type ServerMsg,
  type StripState,
} from "../protocol/types";
import { SimTransport } from "../transport/SimTransport";
import type { ConnectionStatus, Transport } from "../transport/Transport";
import { WebSocketTransport } from "../transport/WebSocketTransport";

export const PLUGIN_URL = "ws://127.0.0.1:49200";
const PENDING_TIMEOUT_MS = 5000;

interface Pending {
  callsign: string;
  action: CommandAction;
  sentAt: number;
}

interface Toast {
  id: number;
  text: string;
}

interface State {
  source: "sim" | "plugin";
  status: ConnectionStatus;
  airport: string;
  myCallsign: string;
  myPosition: Position;
  flights: Record<string, Flight>;
  controllers: Controller[];
  /** Strip bays changed locally but not yet confirmed by EuroScope. */
  optimistic: Record<string, StripState>;
  /** Trash / restore sent but not yet confirmed (true = in the stack). */
  optimisticTrash: Record<string, boolean>;
  pending: Record<string, Pending>;
  /** Local strip order per column (not stored in EuroScope). */
  order: Record<string, string[]>;
  selected: string | null;
  toasts: Toast[];
  lastSeq: number;
  // simulator-only controls
  simOnline: OnlineSet;
  simSpeed: number;

  connect(source: "sim" | "plugin"): void;
  send(callsign: string, action: CommandAction): void;
  moveStrip(callsign: string, to: StripState, columnId: string, index: number): void;
  setOrder(columnId: string, ids: string[]): void;
  trash(callsign: string): void;
  /** Takes a strip out of the stack, optionally straight into a bay. */
  restore(callsign: string, to?: StripState): void;
  select(callsign: string | null): void;
  toast(text: string): void;
  dismissToast(id: number): void;
  configureSim(opts: { position?: Position; online?: OnlineSet; airport?: string; speed?: number }): void;
}

let transport: Transport | null = null;
let cmdCounter = 0;
let toastCounter = 0;

export const onlineFromControllers = (controllers: Controller[]): OnlineSet => ({
  DEL: controllers.some((c) => c.position === "DEL"),
  GND: controllers.some((c) => c.position === "GND"),
  TWR: controllers.some((c) => c.position === "TWR"),
});

/** Whether a strip is in the stack (local pending change first, then EuroScope). */
export const isTrashed = (s: Pick<State, "optimisticTrash">, f: Flight): boolean =>
  s.optimisticTrash[f.callsign] ?? !!f.trashed;

/** The bay shown for a flight: local optimistic change first, then EuroScope. */
export const displayState = (s: Pick<State, "optimistic" | "airport">, f: Flight): StripState =>
  s.optimistic[f.callsign] ?? effectiveState(f, s.airport);

export const useStore = create<State>((set, get) => {
  const handle = (m: ServerMsg) => {
    const s = get();
    switch (m.type) {
      case "welcome":
        set({ myCallsign: m.callsign, myPosition: m.position, airport: m.airport });
        break;
      case "snapshot": {
        const flights: Record<string, Flight> = {};
        m.flights.forEach((f) => (flights[f.callsign] = f));
        set({ flights, controllers: m.controllers, lastSeq: m.seq, optimistic: {}, optimisticTrash: {}, pending: {} });
        break;
      }
      case "delta": {
        if (s.lastSeq && m.seq !== s.lastSeq + 1) {
          // Missed a message: resync from a fresh snapshot.
          transport?.send({ v: PROTOCOL_VERSION, type: "requestSnapshot" });
        }
        const prev = s.flights[m.callsign];
        if (!prev && !m.changes.adep) break; // partial update for a flight we never saw
        const next = { ...(prev ?? {}), ...m.changes } as Flight;
        const optimistic = { ...s.optimistic };
        // EuroScope wins: any reported bay replaces our local guess.
        if (m.changes.stripState !== undefined) delete optimistic[m.callsign];
        const optimisticTrash = { ...s.optimisticTrash };
        if (m.changes.trashed !== undefined) delete optimisticTrash[m.callsign];
        set({ flights: { ...s.flights, [m.callsign]: next }, optimistic, optimisticTrash, lastSeq: m.seq });
        break;
      }
      case "remove": {
        const flights = { ...s.flights };
        delete flights[m.callsign];
        const optimistic = { ...s.optimistic };
        delete optimistic[m.callsign];
        set({
          flights,
          optimistic,
          lastSeq: m.seq,
          selected: s.selected === m.callsign ? null : s.selected,
        });
        break;
      }
      case "controllers":
        set({ controllers: m.controllers, lastSeq: m.seq });
        break;
      case "ack": {
        const p = s.pending[m.id];
        if (!p) break;
        const pending = { ...s.pending };
        delete pending[m.id];
        if (!m.ok) {
          const optimistic = { ...s.optimistic };
          const optimisticTrash = { ...s.optimisticTrash };
          if (p.action.action === "setStripState") delete optimistic[p.callsign];
          if (p.action.action === "trash" || p.action.action === "restore") delete optimisticTrash[p.callsign];
          set({ pending, optimistic, optimisticTrash });
          get().toast(`${p.callsign}: EuroScope rejected ${p.action.action} (${m.error ?? "error"})`);
        } else set({ pending });
        break;
      }
      case "pong":
        break;
    }
  };

  // Housekeeping once a second: automatic bay changes and pending timeouts.
  setInterval(() => {
    const s = get();
    const apt = getAirport(s.airport);
    if (!apt || s.status !== "connected") return;

    for (const f of Object.values(s.flights)) {
      if (s.optimistic[f.callsign] || isTrashed(s, f)) continue;
      const to = autoTransition(f, apt);
      if (to && to !== effectiveState(f, s.airport)) s.send(f.callsign, { action: "setStripState", value: to });
    }

    const now = Date.now();
    const stale = Object.entries(s.pending).filter(([, p]) => now - p.sentAt > PENDING_TIMEOUT_MS);
    if (stale.length) {
      const pending = { ...s.pending };
      const optimistic = { ...s.optimistic };
      const optimisticTrash = { ...s.optimisticTrash };
      for (const [id, p] of stale) {
        delete pending[id];
        if (p.action.action === "setStripState") delete optimistic[p.callsign];
        if (p.action.action === "trash" || p.action.action === "restore") delete optimisticTrash[p.callsign];
        get().toast(`${p.callsign}: no reply from EuroScope, change reverted`);
      }
      set({ pending, optimistic, optimisticTrash });
    }
  }, 1000);

  return {
    source: "sim",
    status: "disconnected",
    airport: "VIDP",
    myCallsign: "",
    myPosition: "GND",
    flights: {},
    controllers: [],
    optimistic: {},
    optimisticTrash: {},
    pending: {},
    order: {},
    selected: null,
    toasts: [],
    lastSeq: 0,
    simOnline: { DEL: true, GND: false, TWR: true },
    simSpeed: 1,

    connect(source) {
      transport?.close();
      // The simulator can only fly airports with SIDs and stands configured.
      const airport = source === "sim" && !SIM_AIRPORTS.includes(get().airport) ? SIM_AIRPORTS[0] : get().airport;
      set({ source, airport, status: "connecting", flights: {}, controllers: [], optimistic: {}, optimisticTrash: {}, pending: {}, lastSeq: 0, selected: null });
      const s = get();
      const t: Transport =
        source === "sim"
          ? new SimTransport({ airport: s.airport, position: s.myPosition, online: s.simOnline })
          : new WebSocketTransport(PLUGIN_URL);
      transport = t;
      // Ignore late events from a connection we already replaced (e.g. its close event).
      t.connect(
        (m) => transport === t && handle(m),
        (status) => transport === t && set({ status }),
      );
    },

    send(callsign, action) {
      const id = `c-${++cmdCounter}`;
      set((s) => ({
        pending: { ...s.pending, [id]: { callsign, action, sentAt: Date.now() } },
        optimistic:
          action.action === "setStripState" ? { ...s.optimistic, [callsign]: action.value } : s.optimistic,
        optimisticTrash:
          action.action === "trash" || action.action === "restore"
            ? { ...s.optimisticTrash, [callsign]: action.action === "trash" }
            : s.optimisticTrash,
        selected: action.action === "trash" && s.selected === callsign ? null : s.selected,
      }));
      transport?.send({ v: PROTOCOL_VERSION, type: "cmd", id, callsign, ...action });
    },

    moveStrip(callsign, to, columnId, index) {
      const s = get();
      const f = s.flights[callsign];
      if (!f) return;
      const order = { ...s.order };
      for (const k of Object.keys(order)) order[k] = order[k].filter((c) => c !== callsign);
      const list = [...(order[columnId] ?? [])];
      list.splice(Math.max(0, Math.min(index, list.length)), 0, callsign);
      order[columnId] = list;
      set({ order });
      if (displayState(s, f) !== to) s.send(callsign, { action: "setStripState", value: to });
    },

    setOrder(columnId, ids) {
      set((s) => ({ order: { ...s.order, [columnId]: ids } }));
    },

    trash(callsign) {
      get().send(callsign, { action: "trash" });
    },

    restore(callsign, to) {
      const s = get();
      s.send(callsign, { action: "restore" });
      const f = s.flights[callsign];
      if (to && f && displayState(s, f) !== to) s.send(callsign, { action: "setStripState", value: to });
    },

    select(callsign) {
      set({ selected: callsign });
    },

    toast(text) {
      const id = ++toastCounter;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text }] }));
      setTimeout(() => get().dismissToast(id), 5000);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    configureSim(opts) {
      const s = get();
      const next = {
        myPosition: opts.position ?? s.myPosition,
        simOnline: opts.online ?? s.simOnline,
        airport: opts.airport ?? s.airport,
        simSpeed: opts.speed ?? s.simSpeed,
      };
      set({ ...next, order: opts.airport ? {} : s.order });
      if (transport instanceof SimTransport) {
        transport.sim.setSpeed(next.simSpeed);
        transport.sim.configure({ position: next.myPosition, online: next.simOnline, airport: next.airport });
      }
    },
  };
});
