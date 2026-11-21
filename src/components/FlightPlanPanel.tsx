import { useEffect, useState, type ReactNode } from "react";
import { getAirport } from "../config/airports";
import { rangeNm, trashEligibility } from "../model/autoRules";
import { isDeparture, STATE_LABEL } from "../model/states";
import type { CommandAction } from "../protocol/types";
import { displayState, useStore } from "../store/store";

const TELEPHONY: Record<string, string> = {
  AIC: "AIR INDIA",
  IGO: "IFLY",
  VTI: "VISTARA",
  SEJ: "SPICEJET",
  AKJ: "AKASA AIR",
  AXB: "EXPRESS INDIA",
  IAD: "ARIF",
};

/** Options list that always contains EuroScope's current value. */
const withCurrent = (list: string[], current: string) => (list.includes(current) ? list : [current, ...list]);

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`fp-field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Text field that sends a command to EuroScope on Enter / blur. */
function EditField({
  value,
  onCommit,
  maxLength,
  pattern,
}: {
  value: string;
  onCommit: (v: string) => void;
  maxLength?: number;
  pattern?: RegExp;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v === value) return;
    if (pattern && !pattern.test(v)) return setV(value);
    onCommit(v);
  };
  return (
    <input
      value={v}
      maxLength={maxLength}
      onChange={(e) => setV(e.target.value.toUpperCase())}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(value);
      }}
    />
  );
}

export function FlightPlanPanel() {
  const s = useStore();
  const f = s.selected ? s.flights[s.selected] : null;
  if (!f) return null;
  const apt = getAirport(s.airport);
  const dep = isDeparture(f, s.airport);
  const state = displayState(s, f);
  const t = trashEligibility(f, apt);
  const range = rangeNm(f, apt);
  const send = (a: CommandAction) => s.send(f.callsign, a);
  const squawkPending = Object.values(s.pending).some(
    (p) => p.callsign === f.callsign && p.action.action === "assignSquawk",
  );

  return (
    <aside className="fp-panel">
      <div className="fp-title">
        <span>FLIGHT PLAN · {f.callsign}</span>
        <button onClick={() => s.select(null)} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="fp-grid">
        <Field label="FLIGHT ID">
          <output>{f.callsign}</output>
        </Field>
        <Field label="RADIO CALLSIGN">
          <output>{TELEPHONY[f.callsign.slice(0, 3)] ?? f.callsign}</output>
        </Field>
        <Field label="A/C TYPE">
          <output>
            {f.aircraftType}/{f.wake}
          </output>
        </Field>
        <Field label="RULES">
          <output>{f.rules === "V" ? "VFR" : "IFR"}</output>
        </Field>

        <Field label="ADEP">
          <output>{f.adep}</output>
        </Field>
        <Field label="ADES">
          <output>{f.ades}</output>
        </Field>
        <Field label="EOBT">
          <output>{f.eobt}</output>
        </Field>
        <Field label="CTOT">
          <output>{f.ctot || "—"}</output>
        </Field>

        {dep && (
          <>
            <Field label="RWY">
              <select value={f.depRwy} onChange={(e) => send({ action: "setDepRwy", value: e.target.value })}>
                {withCurrent(apt.depRunways, f.depRwy).map((r) => (
                  <option key={r} value={r}>
                    {r || "—"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="SID">
              {apt.sids.length ? (
                <select
                  value={f.sid}
                  disabled={f.rules === "V"}
                  onChange={(e) => send({ action: "setSid", value: e.target.value })}
                >
                  {withCurrent(apt.sids, f.sid).map((r) => (
                    <option key={r} value={r}>
                      {r || "—"}
                    </option>
                  ))}
                </select>
              ) : (
                <EditField value={f.sid} maxLength={9} onCommit={(v) => send({ action: "setSid", value: v })} />
              )}
            </Field>
          </>
        )}
        <Field label="CFL">
          <EditField
            value={f.cfl ? String(f.cfl / 100).padStart(3, "0") : ""}
            maxLength={3}
            pattern={/^\d{1,3}$/}
            onCommit={(v) => send({ action: "setCfl", value: parseInt(v, 10) * 100 })}
          />
        </Field>
        <Field label="SQUAWK">
          <div className="fp-inline">
            <EditField
              value={f.squawk}
              maxLength={4}
              pattern={/^[0-7]{4}$/}
              onCommit={(v) => send({ action: "setSquawk", value: v })}
            />
            <button
              type="button"
              className="fp-btn"
              title="Assign a squawk with TopSky"
              disabled={squawkPending}
              onClick={() => send({ action: "assignSquawk" })}
            >
              {squawkPending ? "…" : "AUTO"}
            </button>
          </div>
        </Field>
        <Field label="STAND">
          <EditField value={f.stand} maxLength={5} onCommit={(v) => send({ action: "setStand", value: v })} />
        </Field>
        <Field label="RFL">
          <output>{f.rules === "V" ? "VFR" : `F${f.rfl / 100}`}</output>
        </Field>

        <Field label="FREE TEXT (SCRATCHPAD)" wide>
          <EditField value={f.scratchpad} maxLength={40} onCommit={(v) => send({ action: "setScratchpad", value: v })} />
        </Field>
        <Field label="ROUTE" wide>
          <output className="mono">{f.route || "—"}</output>
        </Field>
        <Field label="FIELD 18" wide>
          <output className="mono">{f.remarks || "—"}</output>
        </Field>

        <Field label="BAY">
          <output>{STATE_LABEL[state]}</output>
        </Field>
        <Field label="GS / ALT">
          <output>
            {Math.round(f.groundSpeed ?? 0)} KT / {f.altitude ?? "—"} FT
          </output>
        </Field>
        <Field label="RANGE">
          <output>{range != null ? `${range.toFixed(1)} NM` : "—"}</output>
        </Field>
        <Field label="TRASH">
          <output className={t.eligible ? "ok" : ""}>{t.reason}</output>
        </Field>
      </div>
    </aside>
  );
}
