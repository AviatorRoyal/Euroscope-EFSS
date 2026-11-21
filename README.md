# India EFSS

A browser-based Electronic Flight Strip System for India vACC, styled on the Indian EFSS. Talks to a EuroScope plugin over a local WebSocket. EuroScope is the single source of truth.

```
npm install
npm run dev      # http://127.0.0.1:5173
npm test         # layout + automatic rule tests
```

Until the plugin exists, the **Simulator** source (top bar) flies traffic in the page using the same protocol. Pick your position and toggle who else is online to see the top-down layouts.

## Bays per controller (top-down)

| You | Others online | Columns |
|---|---|---|
| DEL | – | Planned · Cleared · Ready for push |
| GND | DEL | Ready for push · Push · Taxi out · Taxi in |
| GND | no DEL | Planned · Cleared · Push · Taxi out · Taxi in |
| TWR | GND | Departures · Local · Arrivals |
| TWR | nobody | Planned · Cleared · Push · Taxi out · Departures · Local · Arrivals · Taxi in |

* READY FOR PUSH is the shared DEL/GND boundary. When one controller covers both, READY strips are shown in CLEARED.
* GND gets a **→ TWR · DEPARTURES** drop zone when TWR is online. TWR gets **→ GND · TAXI IN** when GND is online.

## Strip rules

* IFR departure: Planned → Cleared → Ready → Push → Taxi out → Departures → trash.
* IFR arrival: Arrivals → Taxi in → trash.
* VFR: Planned → Taxi out → Departures → Local ↔ Taxi in. VFR never enters Arrivals.
* Automatic changes, because EuroScope has no DEL/GND/TWR handoff:
  * An arrival below 50 kt on the ground moves to TAXI IN.
  * A VFR aircraft in LOCAL that comes to a full stop moves to TAXI IN.
* Trash eligibility (the bin on the strip turns green). Anything else asks for confirmation.
  * IFR departure: above 190 kt or above 1500 ft AGL.
  * VFR cross-country: beyond 50 nm.
  * Taxi in: on blocks.

Thresholds are in `src/model/autoRules.ts`, and layouts in `src/model/states.ts`.

## Plugin protocol

`ws://127.0.0.1:49200`, JSON, one message per frame. Types are in `src/protocol/types.ts`.

* plugin → app: `welcome`, `snapshot`, `delta` (with `seq`), `remove`, `controllers`, `ack`, `pong`
* app → plugin: `hello`, `cmd` (`setStripState`, `setCfl`, `setSquawk`, `setSid`, `setDepRwy`, `setScratchpad`, `setStand`, `trash`), `requestSnapshot`, `ping`

Every change is a **request**. The strip shows `SYNC` until EuroScope reports the new value. If EuroScope rejects it, or nothing comes back within 5 s, the strip reverts. A gap in `seq` triggers a fresh snapshot.

The plugin must never block the EuroScope main thread: networking runs on a worker thread, and commands are queued and drained in small time-boxed batches.

### Bay → EuroScope mapping (for the plugin; to be confirmed against the SDK)

| Bay | EuroScope |
|---|---|
| PLANNED | clearance flag off, no ground state |
| CLEARED | clearance flag on |
| READY | ground state ST-UP |
| PUSH | ground state PUSH |
| TAXI_OUT | ground state TAXI |
| DEPARTURES | ground state DEPA |
| ARRIVALS | derived: ADES = airport, airborne |
| TAXI_IN | arrival ground state (TXIN / PARK) |
| LOCAL | no native field: needs a scratchpad code or plugin-local storage |

Strip order within a bay is local to each app.
