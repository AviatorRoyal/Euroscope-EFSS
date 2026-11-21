import { describe, expect, it } from "vitest";
import { AIRPORTS } from "../config/airports";
import type { Flight } from "../protocol/types";
import { autoTransition, trashEligibility } from "./autoRules";
import { destinationPoint } from "./geo";
import { buildLayout, canMoveTo } from "./states";

const apt = AIRPORTS.VIDP;
const base: Flight = {
  callsign: "AIC101", rules: "I", adep: "VIDP", ades: "VABB", aircraftType: "A320", wake: "M",
  rfl: 35000, cfl: null, squawk: "1234", sid: "REBON5B", depRwy: "28", arrRwy: "", route: "",
  eobt: "1200", ctot: "", remarks: "", scratchpad: "", stand: "12", stripState: null,
  lat: apt.lat, lon: apt.lon, altitude: apt.elevation, groundSpeed: 0,
};
const ids = (me: "DEL" | "GND" | "TWR", online: { DEL: boolean; GND: boolean; TWR: boolean }) =>
  buildLayout(me, online).columns.map((c) => c.id);

describe("column layout (top-down)", () => {
  it("DEL sees planned, cleared, ready", () => {
    expect(ids("DEL", { DEL: false, GND: true, TWR: true })).toEqual(["PLANNED", "CLEARED", "READY"]);
  });
  it("GND with DEL online", () => {
    expect(ids("GND", { DEL: true, GND: false, TWR: true })).toEqual(["READY", "PUSH", "TAXI_OUT", "TAXI_IN"]);
  });
  it("GND covering DEL", () => {
    expect(ids("GND", { DEL: false, GND: false, TWR: true })).toEqual([
      "PLANNED", "CLEARED", "PUSH", "TAXI_OUT", "TAXI_IN",
    ]);
  });
  it("TWR with GND online gets tower bays plus GND's taxi-out, read-only", () => {
    const l = buildLayout("TWR", { DEL: true, GND: true, TWR: false });
    expect(l.columns.map((c) => c.id)).toEqual(["TAXI_OUT", "DEPARTURES", "LOCAL", "ARRIVALS"]);
    expect(l.columns[0].readOnly).toBe(true);
  });
  it("TWR alone covers everything", () => {
    expect(ids("TWR", { DEL: false, GND: false, TWR: false })).toEqual([
      "PLANNED", "CLEARED", "PUSH", "TAXI_OUT", "DEPARTURES", "LOCAL", "ARRIVALS", "TAXI_IN",
    ]);
  });
  it("GND hands departures to an online TWR", () => {
    expect(buildLayout("GND", { DEL: true, GND: false, TWR: true }).handoffs.map((h) => h.state)).toEqual([
      "DEPARTURES",
    ]);
  });
});

describe("allowed bays", () => {
  it("VFR never enters clearance flow or ARRIVALS", () => {
    const vfr = { ...base, rules: "V" as const };
    expect(canMoveTo(vfr, "VIDP", "TAXI_OUT")).toBe(true);
    expect(canMoveTo(vfr, "VIDP", "LOCAL")).toBe(true);
    expect(canMoveTo(vfr, "VIDP", "CLEARED")).toBe(false);
    expect(canMoveTo(vfr, "VIDP", "ARRIVALS")).toBe(false);
  });
  it("IFR departure cannot go to LOCAL", () => {
    expect(canMoveTo(base, "VIDP", "LOCAL")).toBe(false);
  });
});

describe("automatic rules", () => {
  const arr: Flight = { ...base, adep: "VABB", ades: "VIDP", stripState: "ARRIVALS" };
  it("arrival below 50 kt on the ground goes to TAXI IN", () => {
    expect(autoTransition({ ...arr, groundSpeed: 49 }, apt)).toBe("TAXI_IN");
    expect(autoTransition({ ...arr, groundSpeed: 60 }, apt)).toBeNull();
  });
  it("slow arrival still airborne stays in ARRIVALS", () => {
    expect(autoTransition({ ...arr, groundSpeed: 40, altitude: apt.elevation + 2000 }, apt)).toBeNull();
  });
  it("VFR touch-and-go stays LOCAL, full stop goes to TAXI IN", () => {
    const vfr = { ...base, rules: "V" as const, ades: "VIDP", stripState: "LOCAL" as const };
    expect(autoTransition({ ...vfr, groundSpeed: 60 }, apt)).toBeNull();
    expect(autoTransition({ ...vfr, groundSpeed: 20 }, apt)).toBe("TAXI_IN");
  });
  it("departure trash after 190 kt or 1500 ft AGL", () => {
    const d = { ...base, stripState: "DEPARTURES" as const };
    expect(trashEligibility({ ...d, groundSpeed: 150 }, apt).eligible).toBe(false);
    expect(trashEligibility({ ...d, groundSpeed: 191 }, apt).eligible).toBe(true);
    expect(trashEligibility({ ...d, groundSpeed: 150, altitude: apt.elevation + 1600 }, apt).eligible).toBe(true);
  });
  it("VFR cross-country trash after 50 nm", () => {
    const p = destinationPoint(apt.lat, apt.lon, 90, 55);
    const v = { ...base, rules: "V" as const, stripState: "DEPARTURES" as const };
    expect(trashEligibility({ ...v, lat: p.lat, lon: p.lon, altitude: 4500 }, apt).eligible).toBe(true);
    expect(trashEligibility(v, apt).eligible).toBe(false);
  });
  it("TAXI IN can be trashed once on blocks", () => {
    const t = { ...arr, stripState: "TAXI_IN" as const };
    expect(trashEligibility({ ...t, groundSpeed: 12 }, apt).eligible).toBe(false);
    expect(trashEligibility({ ...t, groundSpeed: 0 }, apt).eligible).toBe(true);
  });
});
