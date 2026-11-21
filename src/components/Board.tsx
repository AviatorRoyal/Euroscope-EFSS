import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCorners,
  MeasuringStrategy,
  pointerWithin,
  type CollisionDetection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useMemo, useRef, useState } from "react";
import { getAirport } from "../config/airports";
import { rangeNm, trashEligibility } from "../model/autoRules";
import { buildLayout, canMoveTo, STATE_LABEL, type ColumnDef } from "../model/states";
import type { Flight, StripState } from "../protocol/types";
import { displayState, isTrashed, onlineFromControllers, useStore } from "../store/store";
import { SortableStrip, StripView } from "./Strip";

const COL = "col:";
const HANDOFF = "handoff:";
const TRASH = "trash";
const STACK = "stack:";

/**
 * Drop target = what is under the pointer (a strip beats its column), so a wide strip
 * can be dropped on a slim rail. Falls back to the nearest target when over a gap.
 */
const collide: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length) {
    const strip = hits.find((h) => !String(h.id).startsWith(COL));
    return [strip ?? hits[0]];
  }
  return closestCorners(args);
};

/** Groups consecutive columns that share a group id (split top / bottom). */
function groupColumns(columns: ColumnDef[]): ColumnDef[][] {
  const units: ColumnDef[][] = [];
  for (const c of columns) {
    const last = units[units.length - 1];
    if (c.group && last && last[0].group === c.group) last.push(c);
    else units.push([c]);
  }
  return units;
}

function defaultSort(a: Flight, b: Flight, airport: string) {
  const apt = getAirport(airport);
  if (a.adep === airport && b.adep === airport) return a.eobt.localeCompare(b.eobt);
  return (rangeNm(a, apt) ?? 999) - (rangeNm(b, apt) ?? 999);
}

function Column({
  def,
  flights,
  dimmed,
  dragging,
  find,
  pendingSet,
  pairHasStrips,
}: {
  /** Set for a bay that shares its column with another bay: whether either of them has strips. */
  pairHasStrips?: boolean;
  def: ColumnDef;
  flights: { f: Flight; state: StripState }[];
  dimmed: boolean;
  dragging: boolean;
  find: string;
  pendingSet: Set<string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: COL + def.id });
  // Empty bays shrink to a slim rail so busy bays get the width. The rail stays the same
  // size while dragging (no layout jump under the pointer) and lights up as a drop target.
  // In a split column, an empty bay folds to just its header and its partner takes the height.
  const empty = flights.length === 0;
  const headerOnly = empty && pairHasStrips === true;
  const collapsed = empty && !headerOnly;
  return (
    <section
      ref={setNodeRef}
      className={`column${def.readOnly ? " readonly" : ""}${collapsed ? " collapsed" : ""}${headerOnly ? " header-only" : ""}${dragging && !dimmed ? " target" : ""}${dimmed ? " dimmed" : ""}${isOver ? " over" : ""}`}
      title={collapsed ? `${def.title} (empty)` : undefined}
    >
      <header className="col-head">
        <span className="col-title">{def.title}</span>
        <span className="count">{flights.length}</span>
      </header>
      <SortableContext items={flights.map((x) => x.f.callsign)} strategy={verticalListSortingStrategy}>
        <div className="col-body">
          {flights.map(({ f, state }) => (
            <SortableStrip
              key={f.callsign}
              flight={f}
              state={state}
              pending={pendingSet.has(f.callsign)}
              highlight={!!find && f.callsign.includes(find)}
            />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

function DropZone({ id, label, className, dimmed }: { id: string; label: string; className: string; dimmed?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`${className}${isOver ? " over" : ""}${dimmed ? " dimmed" : ""}`}>
      {label}
    </div>
  );
}

/** A trashed strip in the stack: drag it back onto a bay, or press ↩ to restore it where it was. */
function StackItem({ flight, onRestore }: { flight: Flight; onRestore: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: STACK + flight.callsign });
  return (
    <div className="stack-item" ref={setNodeRef} style={{ opacity: isDragging ? 0.35 : 1 }} {...attributes} {...listeners}>
      <span className={`stack-cs stack-${flight.rules === "V" ? "vfr" : "ifr"}`}>{flight.callsign}</span>
      <span className="stack-meta">
        {flight.adep}→{flight.ades} · {flight.aircraftType}
      </span>
      <button
        className="stack-restore"
        title="Restore to its last bay"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRestore}
      >
        ↩
      </button>
    </div>
  );
}

export function Board({ find }: { find: string }) {
  const s = useStore();
  const { airport, myPosition, controllers, flights, order, pending } = s;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stackOpen, setStackOpen] = useState(false);
  const trashedAt = useRef(new Map<string, number>());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );

  const layout = useMemo(
    () => buildLayout(myPosition, onlineFromControllers(controllers)),
    [myPosition, controllers],
  );

  const pendingSet = useMemo(() => new Set(Object.values(pending).map((p) => p.callsign)), [pending]);

  const { byColumn, stack } = useMemo(() => {
    const out: Record<string, { f: Flight; state: StripState }[]> = {};
    const stack: Flight[] = [];
    for (const c of layout.columns) out[c.id] = [];
    for (const f of Object.values(flights)) {
      if (isTrashed(s, f)) {
        if (!trashedAt.current.has(f.callsign)) trashedAt.current.set(f.callsign, Date.now());
        stack.push(f);
        continue;
      }
      trashedAt.current.delete(f.callsign);
      const state = displayState(s, f);
      const c = layout.columns.find((c) => c.shows.includes(state));
      if (c) out[c.id].push({ f, state });
    }
    for (const c of layout.columns) {
      const ord = order[c.id] ?? [];
      out[c.id].sort((a, b) => {
        const ia = ord.indexOf(a.f.callsign);
        const ib = ord.indexOf(b.f.callsign);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return defaultSort(a.f, b.f, airport);
      });
    }
    // most recently trashed first
    stack.sort((a, b) => (trashedAt.current.get(b.callsign) ?? 0) - (trashedAt.current.get(a.callsign) ?? 0));
    return { byColumn: out, stack };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, layout, order, s.optimistic, s.optimisticTrash, airport]);

  const activeCallsign = activeId?.startsWith(STACK) ? activeId.slice(STACK.length) : activeId;
  const active = activeCallsign ? flights[activeCallsign] : null;

  const columnOf = (callsign: string) =>
    layout.columns.find((c) => byColumn[c.id].some((x) => x.f.callsign === callsign));

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const rawId = String(e.active.id);
    const fromStack = rawId.startsWith(STACK);
    const callsign = fromStack ? rawId.slice(STACK.length) : rawId;
    const f = flights[callsign];
    if (!f || !e.over) return;
    const overId = String(e.over.id);

    if (overId === TRASH) {
      if (fromStack) return;
      const t = trashEligibility(f, getAirport(airport));
      if (t.eligible || window.confirm(`${callsign}: ${t.reason}. Trash anyway?`)) s.trash(callsign);
      return;
    }

    if (overId.startsWith(HANDOFF)) {
      const to = overId.slice(HANDOFF.length) as StripState;
      if (!canMoveTo(f, airport, to)) return s.toast(`${callsign} cannot go to ${STATE_LABEL[to]}`);
      if (fromStack) s.restore(callsign, to);
      else s.send(callsign, { action: "setStripState", value: to });
      return;
    }

    // Dropped on a column body or on another strip.
    const target = overId.startsWith(COL)
      ? layout.columns.find((c) => c.id === overId.slice(COL.length))
      : columnOf(overId);
    if (!target) return;

    if (target.readOnly) {
      if (columnOf(callsign)?.id !== target.id)
        s.toast(`${target.title} is GND's bay. Drag strips out of it, not into it.`);
      return;
    }

    if (!canMoveTo(f, airport, target.state)) {
      s.toast(`${callsign} (${f.rules === "V" ? "VFR" : "IFR"}) cannot go to ${target.title}`);
      return;
    }

    const list = byColumn[target.id].map((x) => x.f.callsign).filter((c) => c !== callsign);
    const index = overId.startsWith(COL) ? list.length : Math.max(0, list.indexOf(overId));

    if (fromStack) {
      s.restore(callsign, target.state);
      s.setOrder(target.id, [...list.slice(0, index), callsign, ...list.slice(index)]);
      return;
    }

    const from = columnOf(callsign);
    if (from?.id === target.id) {
      const current = byColumn[target.id].map((x) => x.f.callsign);
      const oldIndex = current.indexOf(callsign);
      const newIndex = overId.startsWith(COL) ? current.length - 1 : current.indexOf(overId);
      const next = [...current];
      next.splice(oldIndex, 1);
      next.splice(newIndex, 0, callsign);
      s.setOrder(target.id, next);
      return;
    }
    s.moveStrip(callsign, target.state, target.id, index);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collide}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="board-wrap">
        <div className="board">
          {groupColumns(layout.columns).map((unit) => {
            const render = (c: ColumnDef, pairHasStrips?: boolean) => (
              <Column
                key={c.id}
                def={c}
                flights={byColumn[c.id]}
                dimmed={!!active && (!!c.readOnly || !canMoveTo(active, airport, c.state))}
                dragging={!!active}
                find={find}
                pendingSet={pendingSet}
                pairHasStrips={pairHasStrips}
              />
            );
            if (unit.length === 1) return render(unit[0]);
            const hasStrips = unit.some((c) => byColumn[c.id].length > 0);
            return (
              <div key={unit.map((c) => c.id).join("+")} className={`col-pair${hasStrips ? "" : " collapsed"}`}>
                {unit.map((c) => render(c, hasStrips))}
              </div>
            );
          })}
        </div>
        {stackOpen && (
          <aside className="stack-panel">
            <header className="col-head">
              <span>STACK</span>
              <span className="count">{stack.length}</span>
            </header>
            <p className="stack-hint">Trashed strips. Drag one onto a bay, or press ↩.</p>
            <div className="stack-list">
              {stack.map((f) => (
                <StackItem key={f.callsign} flight={f} onRestore={() => s.restore(f.callsign)} />
              ))}
              {stack.length === 0 && <div className="empty">Nothing trashed</div>}
            </div>
          </aside>
        )}
      </div>
      <div className="dropbar">
        {layout.handoffs.map((h) => (
          <DropZone
            key={h.state}
            id={HANDOFF + h.state}
            label={h.label}
            className="handoff"
            dimmed={!!active && !canMoveTo(active, airport, h.state)}
          />
        ))}
        <DropZone id={TRASH} label="🗑 TRASH" className="trashzone" />
        <button className={`stack-btn${stackOpen ? " open" : ""}`} onClick={() => setStackOpen((o) => !o)}>
          STACK <span className="count">{stack.length}</span>
        </button>
      </div>
      <DragOverlay dropAnimation={null}>
        {active ? <StripView flight={active} state={displayState(s, active)} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}
