import { useEffect, useState } from "react";
import { Board } from "./components/Board";
import { FlightPlanPanel } from "./components/FlightPlanPanel";
import { TopBar } from "./components/TopBar";
import { useStore } from "./store/store";

export function App() {
  const [find, setFind] = useState("");
  const connect = useStore((s) => s.connect);
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const select = useStore((s) => s.select);

  useEffect(() => {
    connect("sim");
  }, [connect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && select(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  return (
    <div className="app">
      <TopBar find={find} setFind={setFind} />
      <main className="main">
        <div className="bay">
          <Board find={find} />
        </div>
        <FlightPlanPanel />
      </main>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast" onClick={() => dismiss(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
