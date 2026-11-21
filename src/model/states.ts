import type { Flight, Position, StripState } from "../protocol/types";

/** Which positions are online at the airport, excluding the user. */
export interface OnlineSet {
  DEL: boolean;
  GND: boolean;
  TWR: boolean;
}

export const STATE_LABEL: Record<StripState, string> = {
  PLANNED: "PLANNED DEPARTURES",
  CLEARED: "CLEARED",
  READY: "READY FOR PUSH",
  PUSH: "PUSH",
  TAXI_OUT: "TAXI OUT",
  DEPARTURES: "DEPARTURES",
  LOCAL: "LOCAL",
  ARRIVALS: "ARRIVALS",
  TAXI_IN: "TAXI IN",
};

/** Owner of each bay in a fully staffed top-down setup. */
export const STATE_OWNER: Record<StripState, Position> = {
  PLANNED: "DEL",
  CLEARED: "DEL",
  READY: "GND", // DEL places strips here, GND picks them up
  PUSH: "GND",
  TAXI_OUT: "GND",
  DEPARTURES: "TWR",
  LOCAL: "TWR",
  ARRIVALS: "TWR",
  TAXI_IN: "GND",
};

/**
 * Top-down coverage: a position covers itself, and every lower position
 * that is offline, as long as no position between them is online.
 */
export function coverage(me: Position, online: OnlineSet): Record<Position, boolean> {
  return {
    DEL:
      me === "DEL" ||
      (me === "GND" && !online.DEL) ||
      (me === "TWR" && !online.DEL && !online.GND),
    GND: me === "GND" || (me === "TWR" && !online.GND),
    TWR: me === "TWR",
  };
}

export interface ColumnDef {
  id: string;
  title: string;
  /** Drop target state: strips dropped here get this state. */
  state: StripState;
  /** States whose strips are displayed in this column. */
  shows: StripState[];
  /** Consecutive columns with the same group share one column, split top / bottom. */
  group?: string;
  /**
   * Another controller's bay shown for awareness: strips can be dragged out of it
   * (e.g. TWR pulling a taxiing aircraft into DEPARTURES) but nothing can be dropped in.
   */
  readOnly?: boolean;
}

export interface HandoffZone {
  state: StripState;
  label: string;
}

export interface BoardLayout {
  columns: ColumnDef[];
  /** Drop targets for bays owned by another online controller. */
  handoffs: HandoffZone[];
  covers: Record<Position, boolean>;
}

const col = (state: StripState, shows: StripState[] = [state], group?: string): ColumnDef => ({
  id: state,
  title: STATE_LABEL[state],
  state,
  shows,
  group,
});

/**
 * Builds the column layout for a controller.
 *  DEL               : PLANNED | CLEARED | READY
 *  GND (DEL online)  : READY | PUSH | TAXI OUT | TAXI IN
 *  GND (DEL offline) : PLANNED | CLEARED | PUSH | TAXI OUT | TAXI IN
 *  TWR               : adds DEPARTURES | LOCAL | ARRIVALS to whatever it covers;
 *                      with GND online it also sees GND's TAXI OUT read-only
 * PUSH / TAXI OUT and DEPARTURES / LOCAL each share one column, split top / bottom.
 * READY is the shared DEL/GND boundary; when one controller covers both,
 * READY strips fold into CLEARED.
 */
export function buildLayout(me: Position, online: OnlineSet): BoardLayout {
  const covers = coverage(me, online);
  const columns: ColumnDef[] = [];
  const coversBothDelGnd = covers.DEL && covers.GND;

  if (covers.DEL) {
    columns.push(col("PLANNED"));
    columns.push(coversBothDelGnd ? col("CLEARED", ["CLEARED", "READY"]) : col("CLEARED"));
  }
  if (covers.DEL !== covers.GND) columns.push(col("READY"));
  if (covers.GND) {
    columns.push(col("PUSH", ["PUSH"], "push-taxi"));
    columns.push(col("TAXI_OUT", ["TAXI_OUT"], "push-taxi"));
  }
  if (covers.TWR && !covers.GND) {
    // GND is online but nobody sets DEPA there, so TWR watches GND's taxi-out traffic
    // and pulls each strip into DEPARTURES when the pilot calls.
    columns.push({ ...col("TAXI_OUT"), title: "TAXI OUT · GND", readOnly: true });
  }
  if (covers.TWR) {
    columns.push(col("DEPARTURES", ["DEPARTURES"], "dep-local"));
    columns.push(col("LOCAL", ["LOCAL"], "dep-local"));
    columns.push(col("ARRIVALS"));
  }
  if (covers.GND) columns.push(col("TAXI_IN"));

  const handoffs: HandoffZone[] = [];
  if (covers.GND && !covers.TWR && online.TWR)
    handoffs.push({ state: "DEPARTURES", label: "→ TWR · DEPARTURES" });
  if (covers.TWR && !covers.GND)
    handoffs.push({ state: "TAXI_IN", label: "→ GND · TAXI IN" });

  return { columns, handoffs, covers };
}

export function isDeparture(f: Flight, airport: string): boolean {
  return f.adep === airport;
}

const IFR_DEP: StripState[] = ["PLANNED", "CLEARED", "READY", "PUSH", "TAXI_OUT", "DEPARTURES"];
const IFR_ARR: StripState[] = ["ARRIVALS", "TAXI_IN"];
const VFR_DEP: StripState[] = ["PLANNED", "TAXI_OUT", "DEPARTURES", "LOCAL", "TAXI_IN"];
const VFR_ARR: StripState[] = ["LOCAL", "TAXI_IN"];

/** The bays a flight may ever occupy. VFR never enters ARRIVALS or the IFR clearance flow. */
export function pathFor(f: Flight, airport: string): StripState[] {
  const dep = isDeparture(f, airport);
  if (f.rules === "V") return dep ? VFR_DEP : VFR_ARR;
  return dep ? IFR_DEP : IFR_ARR;
}

export function canMoveTo(f: Flight, airport: string, target: StripState): boolean {
  return pathFor(f, airport).includes(target);
}

/** Initial bay for a flight that EuroScope has not placed yet. */
export function initialState(f: Flight, airport: string): StripState {
  if (isDeparture(f, airport)) return "PLANNED";
  return f.rules === "V" ? "LOCAL" : "ARRIVALS";
}

export function effectiveState(f: Flight, airport: string): StripState {
  return f.stripState ?? initialState(f, airport);
}
