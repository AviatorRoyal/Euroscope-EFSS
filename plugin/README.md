# India EFSS – EuroScope plugin

A 32-bit EuroScope plugin (`IndiaEFSS.dll`). It serves EuroScope's flight data to the EFSS web app over a local WebSocket (`ws://127.0.0.1:49200`) and applies the strip changes the app requests.

## Build

You need Visual Studio 2022 Build Tools with the C++ workload (MSVC x86) and CMake.

```
powershell -ExecutionPolicy Bypass -File plugin\build.ps1
```

* It generates `sdk/EuroScopePlugInDll.lib` from the `EuroScopePlugInDll.dll` shipped with your EuroScope install. Pass `-EuroScopeDir` if EuroScope isn't in `C:\Program Files (x86)\EuroScope`.
* It builds `build/Release/IndiaEFSS.dll`, `efss_mock_server.exe` and `efss_core_tests.exe`, then runs the tests.

`sdk/EuroScopePlugIn.h` comes from the EuroScope plugin SDK. This copy was taken from VATSIM UK's UK-Controller-Plugin (`third_party/euroscope/EuroScopePlugIn.h`).

## Use

1. In EuroScope, open Other SET → Plug-ins → Load and pick `IndiaEFSS.dll`.
2. Open the EFSS app and choose **Source: EuroScope plugin**.
3. Chat commands:
   * `.efss` shows the status.
   * `.efss airport VOBL` and `.efss position TWR` override the airport and position.
   * `.efss auto` makes both follow your login again.

The airport comes from your callsign (`VIDP_TWR` → VIDP) and the position from your facility.

## Design

```
EuroScope main thread                              worker thread
OnTimer (1 s)        -> Bridge.pump + tick         WsServer: select() every 50 ms,
OnRadarTarget...     -> Bridge.pump (bounded)      accept / handshake / frames / send,
                                                   snapshot JSON built here
```

* **Never blocks EuroScope.**
  * No socket calls on the EuroScope thread.
  * Each pump handles at most 25 messages or 2 ms.
  * Snapshots are copied as plain structs and serialised on the worker.
  * Every callback is wrapped in try/catch.
  * Unloading joins the worker, which wakes every 50 ms.
* **Security.**
  * Binds to 127.0.0.1 only.
  * Browser connections are accepted only from `localhost` / `127.0.0.1` pages, so a random website can't drive EuroScope.
* **EuroScope is the truth.** Each tick re-reads EuroScope and sends field-level deltas. The app keeps a change pending until EuroScope reports it back.

### Bay ↔ EuroScope mapping (`src/plugin/EfssPlugin.cpp`)

| Bay | Written as | Read back from |
|---|---|---|
| PLANNED | ground state `NSTS`, clearance off | no state, not cleared |
| CLEARED | ground state `NSTS`, clearance on | clearance flag |
| READY | `ST-UP` | `ST-UP` |
| PUSH | `PUSH` | `PUSH` |
| TAXI_OUT | `TAXI` | `TAXI` (departure) |
| DEPARTURES | `DEPA` | `DEPA` / `LINEUP` |
| TAXI_IN | `TXIN` | `TXIN` / `PARK`, or `TAXI` on an arrival |
| ARRIVALS | `NSTS` | arrival with no ground state |
| LOCAL | plugin-local only | kept while EuroScope's state is unchanged |

* Ground states are set by writing the keyword to the scratchpad and then restoring the old scratchpad text. That's the method other plugins use, because the SDK has no setter.
* The clearance flag is toggled with EuroScope's own "set cleared flag" TAG function. The plugin briefly ASELs the aircraft and then restores the previous ASEL.
* SID and runway are changed by amending the route (`VIDP/28 REBON5B …`).
* Stand and "trash" are plugin-local, because EuroScope has no field for them.
* **Stack:**
  * Trashed flights stay in every update with `"trashed": true`, so the app's stack survives an app reload.
  * `restore` takes a flight out of the stack.
  * A flight drops out entirely when its flight plan disconnects.
* **AUTO squawk (`assignSquawk`):** calls TopSky's own assign-squawk TAG function.
  * The call is `StartTagFunction(cs, nullptr, 0, cs, "TopSky plugin", 667, …)`, the same one the open-source DelHel plugin uses.
  * TopSky chooses the code from its `TopSkySSRcodes.txt`.
  * The plugin returns `TOPSKY_NOT_LOADED` if `TopSky.dll` isn't loaded in EuroScope.

**Not yet verified inside EuroScope:** the keywords `NSTS`, `TXIN` and `LINEUP`, and the clearance toggle. Check them on a sweatbox or offline session first.
