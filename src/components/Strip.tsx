import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo } from "react";
import { getAirport } from "../config/airports";
import { agl, rangeNm, trashEligibility } from "../model/autoRules";
import { isDeparture } from "../model/states";
import type { Flight, StripState } from "../protocol/types";
import { useStore } from "../store/store";

const fl = (ft: number | null) => (ft == null ? "" : ft >= 10000 ? `F${Math.round(ft / 100)}` : `A${Math.round(ft / 100).toString().padStart(3, "0")}`);

/** EOBT + 15 min taxi, as a rough estimated take-off time when no CTOT exists. */
const etot = (eobt: string) => {
  if (eobt.length !== 4) return "";
  const m = (parseInt(eobt.slice(0, 2), 10) * 60 + parseInt(eobt.slice(2), 10) + 15) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}`;
};

interface StripProps {
  flight: Flight;
  state: StripState;
  pending?: boolean;
  highlight?: boolean;
  overlay?: boolean;
}

export const StripView = memo(function StripView({ flight: f, state, pending, highlight, overlay }: StripProps) {
  const airport = useStore((s) => s.airport);
  const selected = useStore((s) => s.selected === f.callsign);
  const select = useStore((s) => s.select);
  const trash = useStore((s) => s.trash);
  const apt = getAirport(airport);
  const dep = isDeparture(f, airport);
  const kind = f.rules === "V" ? "vfr" : dep ? "dep" : "arr";
  const t = trashEligibility(f, apt);
  const range = rangeNm(f, apt);
  const height = agl(f, apt);
  const airborne = height != null && height > 200;

  return (
    <div
      className={`strip strip-${kind}${selected ? " selected" : ""}${pending ? " pending" : ""}${highlight ? " found" : ""}${overlay ? " overlay" : ""}`}
      onClick={() => select(f.callsign)}
      title={`${f.callsign} · ${f.adep} → ${f.ades}`}
    >
      <div className="c c-rwy">{dep ? f.depRwy : f.arrRwy}</div>
      <div className="c c-type">
        {f.aircraftType}/{f.wake}
      </div>
      <div className="c c-time">{dep ? f.eobt : range != null ? `${range.toFixed(0)}NM` : ""}</div>

      <div className="c c-sid">{dep ? (f.rules === "V" ? "VFR" : f.sid) : f.stand || "—"}</div>
      <div className={`c c-slot${f.ctot ? " ctot" : ""}`} title={f.ctot ? "CTOT" : "Estimated take-off"}>
        {dep ? f.ctot || etot(f.eobt) : fl(f.altitude)}
      </div>
      <div className="c c-live">
        {airborne || (f.groundSpeed ?? 0) > 0 ? `${Math.round(f.groundSpeed ?? 0)}KT` : dep ? f.stand : ""}
      </div>

      <div className="c c-id">
        <div className="id-top">
          <span>{f.adep}</span>
          <span>{f.rules === "V" ? "VFR" : fl(f.rfl)}</span>
          <span>{f.ades}</span>
        </div>
        <div className="id-cs">{f.callsign}</div>
        <div className="id-bot">
          <span className="tags">
            {f.rules === "V" && <span className="tag">VFR</span>}
            {f.ctot && <span className="tag">CTOT</span>}
            {pending && <span className="tag tag-pending">SYNC</span>}
          </span>
          <span>{f.squawk}</span>
        </div>
      </div>

      <div className="c c-cfl" title="Cleared level">
        {f.cfl ? fl(f.cfl) : ""}
      </div>
      <div className="c c-pad" title="Scratchpad">
        {f.scratchpad}
      </div>
      <button
        className={`c c-bin${t.eligible ? " ready" : ""}`}
        title={t.eligible ? `Trash (${t.reason})` : t.reason}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (t.eligible || window.confirm(`${f.callsign}: ${t.reason}. Trash anyway?`)) trash(f.callsign);
        }}
      >
        ✕
      </button>
      <span className="sr-state" hidden>
        {state}
      </span>
    </div>
  );
});

export function SortableStrip(props: StripProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.flight.callsign,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      {...attributes}
      {...listeners}
    >
      <StripView {...props} />
    </div>
  );
}
