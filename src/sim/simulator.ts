// In-browser stand-in for the EuroScope plugin. It speaks the same protocol
// (snapshot / delta / ack) and flies simple traffic so the strip board and its
// automatic rules can be exercised without EuroScope.

import { AIRPORTS, type AirportConfig } from "../config/airports";
import { destinationPoint, distanceNm } from "../model/geo";
import {
  PROTOCOL_VERSION,
  type ClientMsg,
  type CommandMsg,
  type Controller,
  type Flight,
  type Position,
  type ServerMsg,
  type Wake,
} from "../protocol/types";

interface SimExtra {
  heading: number;
  timer: number; // seconds in the current phase
  phase: string;
  circuits: number;
  /** Seconds spent in the stack; stacked flights are dropped after a while. */
  trashedFor?: number;
}

const AIRLINES = ["AIC", "IGO", "VTI", "SEJ", "AKJ", "AXB", "IAD"];
const TYPES: [string, Wake][] = [
  ["A320", "M"], ["A20N", "M"], ["A21N", "M"], ["B738", "M"], ["B38M", "M"],
  ["A319", "M"], ["B77W", "H"], ["B788", "H"], ["AT76", "M"], ["DH8D", "M"],
];
const DOMESTIC = ["VABB", "VOBL", "VOMM", "VECC", "VOHS", "VAAH", "VIJP", "VILK", "VOCI", "VEGT", "VAGO", "VIDP"];
const VFR_TYPES: [string, Wake][] = [["C172", "L"], ["DA40", "L"], ["P28A", "L"], ["C152", "L"]];

const rnd = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const hhmm = (minutesFromNow: number) => {
  const d = new Date(Date.now() + minutesFromNow * 60000);
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

export interface SimOptions {
  airport: string;
  position: Position;
  online: Record<Position, boolean>;
}

export class Simulator {
  private flights = new Map<string, Flight>();
  private extra = new Map<string, SimExtra>();
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private apt: AirportConfig;
  private emit: (m: ServerMsg) => void = () => {};
  private speed = 1;

  constructor(private opts: SimOptions) {
    this.apt = AIRPORTS[opts.airport];
  }

  start(emit: (m: ServerMsg) => void) {
    this.emit = emit;
    this.seed();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setSpeed(x: number) {
    this.speed = x;
  }

  /** Simulator-only: change who is "logged in" and who else is online. */
  configure(opts: Partial<SimOptions>) {
    const airportChanged = opts.airport && opts.airport !== this.opts.airport;
    this.opts = { ...this.opts, ...opts };
    if (airportChanged) {
      this.apt = AIRPORTS[this.opts.airport];
      this.flights.clear();
      this.extra.clear();
      this.seed();
    }
    this.sendWelcome();
    this.sendSnapshot();
  }

  handle(msg: ClientMsg) {
    switch (msg.type) {
      case "hello":
        this.sendWelcome();
        this.sendSnapshot();
        break;
      case "requestSnapshot":
        this.sendSnapshot();
        break;
      case "ping":
        this.emit({ v: PROTOCOL_VERSION, type: "pong" });
        break;
      case "cmd":
        this.command(msg);
        break;
    }
  }

  // ---------------- protocol output ----------------

  private sendWelcome() {
    this.emit({
      v: PROTOCOL_VERSION,
      type: "welcome",
      plugin: "simulator",
      callsign: `${this.opts.airport}_${this.opts.position}`,
      position: this.opts.position,
      airport: this.opts.airport,
    });
  }

  private controllers(): Controller[] {
    const list: Controller[] = [];
    const freq: Record<Position, string> = { DEL: "121.950", GND: "121.900", TWR: "118.100" };
    (["DEL", "GND", "TWR"] as Position[]).forEach((p) => {
      if (p !== this.opts.position && this.opts.online[p])
        list.push({ callsign: `${this.opts.airport}_${p}`, position: p, frequency: freq[p] });
    });
    return list;
  }

  private sendSnapshot() {
    this.emit({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      seq: ++this.seq,
      flights: [...this.flights.values()].map((f) => ({ ...f })),
      controllers: this.controllers(),
    });
  }

  private delta(callsign: string, changes: Partial<Flight>) {
    const f = this.flights.get(callsign);
    if (!f) return;
    Object.assign(f, changes);
    this.emit({ v: PROTOCOL_VERSION, type: "delta", seq: ++this.seq, callsign, changes });
  }

  private command(cmd: CommandMsg) {
    const f = this.flights.get(cmd.callsign);
    // Simulate the round trip through EuroScope.
    setTimeout(() => {
      if (!f) {
        this.emit({ v: PROTOCOL_VERSION, type: "ack", id: cmd.id, ok: false, error: "NO_FLIGHT" });
        return;
      }
      switch (cmd.action) {
        case "setStripState":
          this.delta(f.callsign, { stripState: cmd.value });
          this.resetPhase(f.callsign);
          break;
        case "setCfl":
          this.delta(f.callsign, { cfl: cmd.value });
          break;
        case "setSquawk":
          this.delta(f.callsign, { squawk: cmd.value });
          break;
        case "setSid":
          this.delta(f.callsign, { sid: cmd.value });
          break;
        case "setDepRwy":
          this.delta(f.callsign, { depRwy: cmd.value });
          break;
        case "setScratchpad":
          this.delta(f.callsign, { scratchpad: cmd.value });
          break;
        case "setStand":
          this.delta(f.callsign, { stand: cmd.value });
          break;
        case "trash":
          this.delta(f.callsign, { trashed: true });
          this.extra.get(f.callsign)!.trashedFor = 0;
          break;
        case "restore":
          this.delta(f.callsign, { trashed: false });
          break;
        case "assignSquawk":
          // stand-in for TopSky: a code from a domestic-looking range
          this.delta(f.callsign, { squawk: `${randInt(4, 5)}${randInt(1, 7)}${randInt(0, 7)}${randInt(0, 7)}` });
          break;
      }
      this.emit({ v: PROTOCOL_VERSION, type: "ack", id: cmd.id, ok: true });
    }, 120 + Math.random() * 200);
  }

  private remove(callsign: string) {
    this.flights.delete(callsign);
    this.extra.delete(callsign);
    this.emit({ v: PROTOCOL_VERSION, type: "remove", seq: ++this.seq, callsign });
  }

  // ---------------- traffic ----------------

  private uniqueCallsign(prefix: string) {
    for (;;) {
      const cs = `${prefix}${randInt(10, 999)}`;
      if (!this.flights.has(cs)) return cs;
    }
  }

  private squawk() {
    return `${randInt(0, 7)}${randInt(0, 7)}${randInt(0, 7)}${randInt(0, 7)}`;
  }

  private add(f: Flight, extra: Partial<SimExtra> = {}) {
    this.flights.set(f.callsign, f);
    this.extra.set(f.callsign, { heading: 0, timer: 0, phase: "", circuits: 0, ...extra });
  }

  private spawnDeparture(minutesAhead: number) {
    const [type, wake] = rnd(TYPES);
    const callsign = this.uniqueCallsign(rnd(AIRLINES));
    const ades = rnd(DOMESTIC.filter((d) => d !== this.apt.icao));
    const sid = rnd(this.apt.sids);
    this.add({
      callsign,
      rules: "I",
      adep: this.apt.icao,
      ades,
      aircraftType: type,
      wake,
      rfl: randInt(25, 41) * 1000,
      cfl: null,
      squawk: this.squawk(),
      sid,
      depRwy: this.apt.depRunways[0],
      arrRwy: "",
      route: `${sid.replace(/\d.*$/, "")} W33 ${ades.slice(1)} DCT`,
      eobt: hhmm(minutesAhead),
      ctot: Math.random() < 0.2 ? hhmm(minutesAhead + 15) : "",
      remarks: "PBN/A1B1C1D1O1S1 NAV/GPSRNAV DOF/" + new Date().toISOString().slice(2, 10).replace(/-/g, ""),
      scratchpad: "",
      stand: rnd(this.apt.stands),
      stripState: null,
      lat: this.apt.lat + (Math.random() - 0.5) * 0.01,
      lon: this.apt.lon + (Math.random() - 0.5) * 0.01,
      altitude: this.apt.elevation,
      groundSpeed: 0,
    });
  }

  private spawnArrival() {
    const [type, wake] = rnd(TYPES);
    const callsign = this.uniqueCallsign(rnd(AIRLINES));
    const bearing = randInt(0, 359);
    const dist = randInt(25, 70);
    const p = destinationPoint(this.apt.lat, this.apt.lon, bearing, dist);
    this.add(
      {
        callsign,
        rules: "I",
        adep: rnd(DOMESTIC.filter((d) => d !== this.apt.icao)),
        ades: this.apt.icao,
        aircraftType: type,
        wake,
        rfl: randInt(28, 39) * 1000,
        cfl: null,
        squawk: this.squawk(),
        sid: "",
        depRwy: "",
        arrRwy: this.apt.depRunways[0],
        route: "",
        eobt: hhmm(-90),
        ctot: "",
        remarks: "PBN/A1B1C1D1 NAV/GPSRNAV",
        scratchpad: "",
        stand: "",
        stripState: null,
        lat: p.lat,
        lon: p.lon,
        altitude: this.apt.elevation + dist * 300,
        groundSpeed: 250,
      },
      { heading: (bearing + 180) % 360, phase: "inbound" },
    );
  }

  private spawnVfr(local: boolean) {
    const [type, wake] = rnd(VFR_TYPES);
    const callsign = `VT${String.fromCharCode(65 + randInt(0, 25))}${String.fromCharCode(65 + randInt(0, 25))}${String.fromCharCode(65 + randInt(0, 25))}`;
    if (this.flights.has(callsign)) return;
    const ades = local ? this.apt.icao : rnd(DOMESTIC.filter((d) => d !== this.apt.icao));
    this.add({
      callsign,
      rules: "V",
      adep: this.apt.icao,
      ades,
      aircraftType: type,
      wake,
      rfl: local ? 1500 : 4500,
      cfl: null,
      squawk: "7000",
      sid: "",
      depRwy: this.apt.depRunways[0],
      arrRwy: "",
      route: local ? "LOCAL CIRCUITS" : "VFR DCT " + ades,
      eobt: hhmm(randInt(5, 30)),
      ctot: "",
      remarks: local ? "RMK/CIRCUIT TRAINING" : "RMK/VFR NAV",
      scratchpad: "",
      stand: rnd(this.apt.stands),
      stripState: null,
      lat: this.apt.lat,
      lon: this.apt.lon,
      altitude: this.apt.elevation,
      groundSpeed: 0,
    });
  }

  private seed() {
    for (let i = 0; i < 8; i++) this.spawnDeparture(5 + i * 6);
    for (let i = 0; i < 4; i++) this.spawnArrival();
    this.spawnVfr(true);
    this.spawnVfr(false);
  }

  private resetPhase(callsign: string) {
    const x = this.extra.get(callsign);
    if (x) x.timer = 0;
  }

  /** Move a flight along its heading for dt seconds. */
  private fly(f: Flight, x: SimExtra, dt: number) {
    if (f.lat == null || f.lon == null || !f.groundSpeed) return { lat: f.lat, lon: f.lon };
    return destinationPoint(f.lat, f.lon, x.heading, (f.groundSpeed * dt) / 3600);
  }

  private tick() {
    const dt = this.speed;
    const apt = this.apt;
    const rwyHdg = (parseInt(apt.depRunways[0], 10) || 28) * 10;

    for (const f of [...this.flights.values()]) {
      const x = this.extra.get(f.callsign)!;
      x.timer += dt;
      if (f.trashed) {
        x.trashedFor = (x.trashedFor ?? 0) + dt;
        if (x.trashedFor > 20 * 60) {
          this.remove(f.callsign); // like a pilot disconnecting long after
          continue;
        }
      }
      const state = f.stripState;
      const ch: Partial<Flight> = {};
      const gs = f.groundSpeed ?? 0;
      const alt = f.altitude ?? apt.elevation;

      if (f.adep === apt.icao) {
        // ---------- departures ----------
        if (state === "PUSH") {
          ch.groundSpeed = x.timer < 60 ? 3 : 0;
        } else if (state === "TAXI_OUT") {
          ch.groundSpeed = 15;
          x.heading = rwyHdg;
        } else if (state === "DEPARTURES") {
          x.heading = rwyHdg;
          if (x.timer < 20) ch.groundSpeed = 0; // lining up
          else if (alt - apt.elevation < 50 && gs < 150) ch.groundSpeed = gs + 6 * dt; // take-off roll
          else {
            ch.groundSpeed = Math.min(f.rules === "V" ? 110 : 280, gs + 3 * dt);
            const target = f.rules === "V" ? apt.elevation + 1000 : apt.elevation + 12000;
            ch.altitude = Math.min(target, alt + (f.rules === "V" ? 10 : 40) * dt);
            if (f.rules === "V" && f.ades === apt.icao) {
              // circuit traffic turns around and stays near the field
              if (x.timer % 120 < dt) x.heading = (x.heading + 180) % 360;
            }
          }
        } else if (state === "LOCAL" && f.rules === "V") {
          this.circuit(f, x, ch, dt);
        } else if (state === "TAXI_IN") {
          ch.groundSpeed = x.timer < 40 ? 12 : 0;
          ch.altitude = apt.elevation;
        } else if (state === null || state === "PLANNED" || state === "CLEARED" || state === "READY") {
          ch.groundSpeed = 0;
        }
      } else {
        // ---------- arrivals ----------
        const dist = f.lat != null && f.lon != null ? distanceNm(f.lat, f.lon, apt.lat, apt.lon) : 0;
        if (state === "TAXI_IN") {
          ch.groundSpeed = x.timer < 45 ? 15 : 0;
          ch.altitude = apt.elevation;
        } else if (f.rules === "V") {
          this.circuit(f, x, ch, dt);
        } else if (x.phase === "inbound") {
          if (dist > 0.6) {
            const bearingTo =
              (Math.atan2(apt.lon - (f.lon ?? 0), apt.lat - (f.lat ?? 0)) * 180) / Math.PI;
            x.heading = (bearingTo + 360) % 360;
            ch.groundSpeed = Math.max(140, Math.min(250, dist * 8));
            ch.altitude = Math.max(apt.elevation + 50, apt.elevation + dist * 300);
          } else {
            x.phase = "rollout";
            x.heading = rwyHdg;
            ch.altitude = apt.elevation;
            ch.groundSpeed = 135;
          }
        } else if (x.phase === "rollout") {
          ch.altitude = apt.elevation;
          ch.groundSpeed = Math.max(18, gs - 6 * dt);
        }
      }

      const merged = { ...f, ...ch };
      const pos = this.fly(merged, x, dt);
      if (pos.lat !== f.lat) ch.lat = pos.lat;
      if (pos.lon !== f.lon) ch.lon = pos.lon;
      for (const k of Object.keys(ch) as (keyof Flight)[]) {
        if (ch[k] === f[k]) delete ch[k];
        else if (typeof ch[k] === "number") (ch as Record<string, unknown>)[k] = Math.round((ch[k] as number) * 1e5) / 1e5;
      }
      if (Object.keys(ch).length) this.delta(f.callsign, ch);
    }

    // keep traffic flowing
    const deps = [...this.flights.values()].filter((f) => f.adep === apt.icao && f.rules === "I").length;
    const arrs = [...this.flights.values()].filter((f) => f.ades === apt.icao && f.adep !== apt.icao).length;
    if (deps < 7 && Math.random() < 0.05 * dt) this.addAndAnnounce(() => this.spawnDeparture(randInt(20, 50)));
    if (arrs < 4 && Math.random() < 0.03 * dt) this.addAndAnnounce(() => this.spawnArrival());
  }

  /** VFR circuit: touch-and-goes keep >50 kt; after a few circuits, full stop. */
  private circuit(f: Flight, x: SimExtra, ch: Partial<Flight>, dt: number) {
    const apt = this.apt;
    const lap = 90; // seconds per circuit
    const t = x.timer % lap;
    if (t < dt && x.timer > dt) {
      x.circuits++;
      x.heading = (x.heading + 180) % 360;
    }
    const fullStop = x.circuits > 3;
    if (t > lap - 15) {
      // on the runway
      ch.altitude = apt.elevation;
      ch.groundSpeed = fullStop ? Math.max(10, (f.groundSpeed ?? 60) - 5 * dt) : 60;
    } else {
      ch.altitude = apt.elevation + 1000;
      ch.groundSpeed = 90;
    }
  }

  private addAndAnnounce(spawn: () => void) {
    const before = new Set(this.flights.keys());
    spawn();
    for (const [cs, f] of this.flights) {
      if (!before.has(cs)) this.emit({ v: PROTOCOL_VERSION, type: "delta", seq: ++this.seq, callsign: cs, changes: { ...f } });
    }
  }
}
