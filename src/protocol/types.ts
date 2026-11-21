// Wire protocol shared by the EFSS app and the EuroScope plugin.
// The plugin is a WebSocket server on 127.0.0.1; the app is the client.
// EuroScope is the single source of truth: the app never owns network state,
// it only *requests* changes (cmd) and renders what EuroScope reports back.

export const PROTOCOL_VERSION = 1;

/** Strip bays. The plugin maps these onto EuroScope fields (see docs/protocol.md). */
export type StripState =
  | "PLANNED"
  | "CLEARED"
  | "READY"
  | "PUSH"
  | "TAXI_OUT"
  | "DEPARTURES"
  | "LOCAL"
  | "ARRIVALS"
  | "TAXI_IN";

export type FlightRules = "I" | "V";
export type Wake = "L" | "M" | "H" | "J";
export type Position = "DEL" | "GND" | "TWR";

export interface Flight {
  callsign: string;
  rules: FlightRules;
  adep: string;
  ades: string;
  aircraftType: string; // ICAO type, e.g. A320
  wake: Wake;
  rfl: number; // requested level in feet
  cfl: number | null; // cleared level in feet
  squawk: string; // assigned code
  sid: string;
  depRwy: string;
  arrRwy: string;
  route: string;
  eobt: string; // HHMM UTC
  ctot: string; // HHMM UTC or ""
  remarks: string; // ICAO field 18
  scratchpad: string;
  stand: string;
  /** Strip bay as stored in EuroScope by the plugin; null = not yet placed. */
  stripState: StripState | null;
  /** In the stack: hidden from the bays, can be restored. */
  trashed?: boolean;
  // Live radar data (absent until the pilot is connected / in range)
  lat: number | null;
  lon: number | null;
  altitude: number | null; // ft AMSL
  groundSpeed: number | null; // kt
}

export interface Controller {
  callsign: string; // e.g. VIDP_GND
  position: Position | "APP" | "CTR" | "OTHER";
  frequency: string;
}

// ---------- plugin -> app ----------
export interface WelcomeMsg {
  v: number;
  type: "welcome";
  plugin: string;
  callsign: string;
  position: Position;
  airport: string;
}
export interface SnapshotMsg {
  v: number;
  type: "snapshot";
  seq: number;
  flights: Flight[];
  controllers: Controller[];
}
export interface DeltaMsg {
  v: number;
  type: "delta";
  seq: number;
  callsign: string;
  changes: Partial<Flight>;
}
export interface RemoveMsg {
  v: number;
  type: "remove";
  seq: number;
  callsign: string;
}
export interface ControllersMsg {
  v: number;
  type: "controllers";
  seq: number;
  controllers: Controller[];
}
export interface AckMsg {
  v: number;
  type: "ack";
  id: string;
  ok: boolean;
  error?: string;
}
export interface PongMsg {
  v: number;
  type: "pong";
}
export type ServerMsg =
  | WelcomeMsg
  | SnapshotMsg
  | DeltaMsg
  | RemoveMsg
  | ControllersMsg
  | AckMsg
  | PongMsg;

// ---------- app -> plugin ----------
export type CommandAction =
  | { action: "setStripState"; value: StripState }
  | { action: "setCfl"; value: number }
  | { action: "setSquawk"; value: string }
  | { action: "setSid"; value: string }
  | { action: "setDepRwy"; value: string }
  | { action: "setScratchpad"; value: string }
  | { action: "setStand"; value: string }
  | { action: "trash" }
  | { action: "restore" }
  /** Ask TopSky to assign a squawk (TopSky tag function 667). */
  | { action: "assignSquawk" };

export type CommandMsg = { v: number; type: "cmd"; id: string; callsign: string } & CommandAction;

export interface HelloMsg {
  v: number;
  type: "hello";
  client: string;
  version: string;
}
export interface SnapshotRequestMsg {
  v: number;
  type: "requestSnapshot";
}
export interface PingMsg {
  v: number;
  type: "ping";
}
export type ClientMsg = HelloMsg | CommandMsg | SnapshotRequestMsg | PingMsg;
