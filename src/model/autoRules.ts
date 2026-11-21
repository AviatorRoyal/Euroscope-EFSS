import type { AirportConfig } from "../config/airports";
import type { Flight, StripState } from "../protocol/types";
import { distanceNm } from "./geo";
import { effectiveState, isDeparture } from "./states";

// EuroScope has no handoff between DEL, GND and TWR, so bay changes that
// happen "on their own" are inferred from radar data.
export const RULES = {
  /** Arrival below this ground speed is vacating / taxiing: goes to TAXI IN. */
  taxiInBelowKt: 50,
  /** Arrival must be this close to field elevation to count as on the ground. */
  onGroundAglFt: 200,
  /** IFR departure may be trashed once faster than this... */
  departureTrashKt: 190,
  /** ...or higher than this above field elevation. */
  departureTrashAglFt: 1500,
  /** VFR cross-country may be trashed beyond this range. */
  vfrTrashNm: 50,
  /** Arrival in TAXI IN is on blocks at or below this speed. */
  onBlocksKt: 1,
};

export const agl = (f: Flight, apt: AirportConfig) =>
  f.altitude == null ? null : f.altitude - apt.elevation;

export const rangeNm = (f: Flight, apt: AirportConfig) =>
  f.lat == null || f.lon == null || Number.isNaN(apt.lat) ? null : distanceNm(f.lat, f.lon, apt.lat, apt.lon);

const onGround = (f: Flight, apt: AirportConfig) => {
  const h = agl(f, apt);
  return h != null && h < RULES.onGroundAglFt;
};

/**
 * Automatic bay change, or null if none applies.
 *  - IFR arrival in ARRIVALS slowing below 50 kt on the ground -> TAXI IN
 *  - VFR in LOCAL making a full-stop landing (below 50 kt on the ground) -> TAXI IN
 *    (touch-and-goes stay above 50 kt, so they remain in LOCAL)
 */
export function autoTransition(f: Flight, apt: AirportConfig): StripState | null {
  const state = effectiveState(f, apt.icao);
  const gs = f.groundSpeed;
  if (gs == null) return null;
  const slowOnGround = gs < RULES.taxiInBelowKt && onGround(f, apt);

  if (state === "ARRIVALS" && f.rules === "I" && slowOnGround) return "TAXI_IN";
  if (state === "LOCAL" && f.rules === "V" && slowOnGround) return "TAXI_IN";
  return null;
}

export interface TrashCheck {
  eligible: boolean;
  reason: string;
}

/** Whether a strip may be sent to the trash without an override. */
export function trashEligibility(f: Flight, apt: AirportConfig): TrashCheck {
  const state = effectiveState(f, apt.icao);
  const gs = f.groundSpeed ?? 0;
  const h = agl(f, apt);
  const r = rangeNm(f, apt);

  if (state === "TAXI_IN") {
    return gs <= RULES.onBlocksKt && f.groundSpeed != null
      ? { eligible: true, reason: "On blocks" }
      : { eligible: false, reason: "Still taxiing" };
  }

  if (f.rules === "V" && isDeparture(f, apt.icao)) {
    if ((state === "DEPARTURES" || state === "LOCAL") && r != null && r > RULES.vfrTrashNm)
      return { eligible: true, reason: `Beyond ${RULES.vfrTrashNm} nm` };
    return { eligible: false, reason: `VFR: trash after ${RULES.vfrTrashNm} nm` };
  }

  if (f.rules === "I" && state === "DEPARTURES") {
    if (gs > RULES.departureTrashKt) return { eligible: true, reason: `Above ${RULES.departureTrashKt} kt` };
    if (r != null && r > RULES.vfrTrashNm) return { eligible: true, reason: `Beyond ${RULES.vfrTrashNm} nm` };
    if (h != null && h > RULES.departureTrashAglFt)
      return { eligible: true, reason: `Above ${RULES.departureTrashAglFt} ft AGL` };
    return { eligible: false, reason: "Not yet airborne" };
  }

  return { eligible: false, reason: "Not finished" };
}
