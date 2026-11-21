import { useEffect, useState } from "react";
import { SIM_AIRPORTS } from "../config/airports";
import { coverage } from "../model/states";
import type { Position } from "../protocol/types";
import { onlineFromControllers, PLUGIN_URL, useStore } from "../store/store";

const POSITIONS: Position[] = ["DEL", "GND", "TWR"];

function UtcClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="clock">{now.toISOString().slice(11, 19)}Z</span>;
}

export function TopBar({ find, setFind }: { find: string; setFind: (s: string) => void }) {
  const s = useStore();
  const online = onlineFromControllers(s.controllers);
  const covers = coverage(s.myPosition, online);
  const isSim = s.source === "sim";

  return (
    <header className="topbar">
      <div className="brand">
        EFSS <span className="apt">{s.airport}</span>
      </div>

      <div className="group">
        <label>Source</label>
        <select value={s.source} onChange={(e) => s.connect(e.target.value as "sim" | "plugin")}>
          <option value="sim">Simulator</option>
          <option value="plugin">EuroScope plugin</option>
        </select>
        <span className={`dot ${s.status}`} title={s.source === "plugin" ? PLUGIN_URL : "in-page simulator"} />
        <span className="status">{s.status}</span>
      </div>

      <div className="group">
        <label>Me</label>
        {isSim ? (
          <>
            <select value={s.airport} onChange={(e) => s.configureSim({ airport: e.target.value })}>
              {SIM_AIRPORTS.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <select
              value={s.myPosition}
              onChange={(e) => s.configureSim({ position: e.target.value as Position })}
            >
              {POSITIONS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </>
        ) : (
          <span className="me">{s.myCallsign || "—"}</span>
        )}
      </div>

      <div className="group">
        <label>Online</label>
        {POSITIONS.filter((p) => p !== s.myPosition).map((p) =>
          isSim ? (
            <button
              key={p}
              className={`chip${s.simOnline[p] ? " on" : ""}`}
              onClick={() => s.configureSim({ online: { ...s.simOnline, [p]: !s.simOnline[p] } })}
              title="Simulator: toggle whether this position is online"
            >
              {p}
            </button>
          ) : (
            <span key={p} className={`chip${online[p] ? " on" : ""}`}>
              {p}
            </span>
          ),
        )}
      </div>

      <div className="group covering" title="Top-down: positions you are covering">
        <label>Covering</label>
        {POSITIONS.filter((p) => covers[p]).join(" + ")}
      </div>

      {isSim && (
        <div className="group">
          <label>Sim</label>
          <select value={s.simSpeed} onChange={(e) => s.configureSim({ speed: Number(e.target.value) })}>
            {[1, 2, 4, 8].map((x) => (
              <option key={x} value={x}>
                {x}×
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="group find">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value.toUpperCase())}
          placeholder="Callsign"
          aria-label="Find callsign"
        />
        <span className="find-btn">FIND</span>
      </div>

      <UtcClock />
    </header>
  );
}
