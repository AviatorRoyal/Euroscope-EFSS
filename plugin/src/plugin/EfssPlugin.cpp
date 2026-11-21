#include "EfssPlugin.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <sstream>
#include <vector>

using namespace EuroScopePlugIn;

namespace efss {

namespace {

constexpr const char* kName = "India EFSS";
constexpr const char* kVersion = "0.1.0";
constexpr unsigned short kPort = 49200;

// TopSky integration (as used by the open-source DelHel plugin).
constexpr const char* kTopSkyPlugin = "TopSky plugin";
constexpr const char* kTopSkyDll = "TopSky.dll";
constexpr int kTopSkyAssignSquawk = 667;

// An aircraft counts as "at the airport" (ground states apply) within this distance...
constexpr double kNearAirportNm = 8.0;
// ...and below this ground speed. Faster = airborne or on the take-off / landing roll.
constexpr int kGroundMaxKt = 80;

// ---------------------------------------------------------------------------
// Strip bay <-> EuroScope mapping. EuroScope exposes no setter for the ground
// state, so it is set the way other plugins do it: by writing one of the
// ground-state keywords into the scratchpad (EuroScope intercepts it), then
// restoring the previous scratchpad text. VERIFY these keywords in EuroScope.
// ---------------------------------------------------------------------------
constexpr const char* GS_NONE = "NSTS";
constexpr const char* GS_STARTUP = "ST-UP";
constexpr const char* GS_PUSH = "PUSH";
constexpr const char* GS_TAXI = "TAXI";
constexpr const char* GS_DEPA = "DEPA";
constexpr const char* GS_TAXI_IN = "TXIN";

std::string upper(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return char(std::toupper(c)); });
    return s;
}

std::string safe(const char* s) { return s ? std::string(s) : std::string(); }

std::vector<std::string> split(const std::string& s) {
    std::istringstream is(s);
    std::vector<std::string> out;
    std::string t;
    while (is >> t) out.push_back(t);
    return out;
}

std::string facilityToPosition(int facility) {
    switch (facility) {
        case 2: return "DEL";
        case 3: return "GND";
        case 4: return "TWR";
        case 5: return "APP";
        case 6: return "CTR";
        default: return "OTHER";
    }
}

}  // namespace

// ---------------------------------------------------------------------------

void HelperScreen::OnAsrContentToBeClosed() {
    owner_.screenClosed(this);
    delete this;
}

EfssPlugin::EfssPlugin()
    : CPlugIn(COMPATIBILITY_CODE, kName, kVersion, "India vACC", "India vACC EFSS") {
    WsOptions opts;
    opts.port = kPort;
    if (server_.start(opts)) {
        bridge_ = std::make_unique<Bridge>(server_, *this);
        message("Listening on ws://127.0.0.1:" + std::to_string(server_.port()) + ". Open the EFSS app and pick 'EuroScope plugin'.");
    } else {
        message("Could not start: " + server_.lastError(), true);
    }
}

EfssPlugin::~EfssPlugin() {
    bridge_.reset();
    server_.stop();
}

void EfssPlugin::message(const std::string& text, bool flash) {
    DisplayUserMessage(kName, "EFSS", text.c_str(), true, true, false, flash, false);
}

void EfssPlugin::screenClosed(HelperScreen* s) { screens_.erase(s); }

CRadarScreen* EfssPlugin::OnRadarScreenCreated(const char*, bool, bool, bool, bool) {
    auto* s = new HelperScreen(*this);
    screens_.insert(s);
    return s;
}

// ---------------------------------------------------------------------------
// Callbacks: every one is short, bounded and exception-safe.
// ---------------------------------------------------------------------------

void EfssPlugin::OnTimer(int) {
    if (!bridge_) return;
    try {
        bridge_->pump();
        bridge_->tick();
        if (bridge_->lastTickMicros() > 5000 && ++slowTicks_ % 60 == 1)
            message("Warning: strip update took " + std::to_string(bridge_->lastTickMicros() / 1000) + " ms");
    } catch (...) {
    }
}

void EfssPlugin::OnRadarTargetPositionUpdate(CRadarTarget) {
    // Fires often: use it to answer commands sooner than the 1 s timer.
    if (!bridge_) return;
    try {
        bridge_->pump();
    } catch (...) {
    }
}

void EfssPlugin::OnFlightPlanDisconnect(CFlightPlan fp) {
    try {
        const std::string cs = safe(fp.GetCallsign());
        trashed_.erase(cs);
        overrides_.erase(cs);
        stands_.erase(cs);
    } catch (...) {
    }
}

bool EfssPlugin::OnCompileCommand(const char* command) {
    try {
        const auto args = split(upper(safe(command)));
        if (args.empty() || args[0] != ".EFSS") return false;
        if (args.size() >= 3 && args[1] == "AIRPORT" && args[2].size() == 4) {
            airportOverride_ = args[2];
            if (bridge_) bridge_->resync();
            message("Airport set to " + airportOverride_);
        } else if (args.size() >= 3 && args[1] == "POSITION" &&
                   (args[2] == "DEL" || args[2] == "GND" || args[2] == "TWR")) {
            positionOverride_ = args[2];
            if (bridge_) bridge_->resync();
            message("Position set to " + positionOverride_);
        } else if (args.size() >= 2 && args[1] == "AUTO") {
            airportOverride_.clear();
            positionOverride_.clear();
            if (bridge_) bridge_->resync();
            message("Airport and position follow your login again");
        } else {
            message("Airport " + airport() + ", position " + myPosition() + ", port " + std::to_string(server_.port()) +
                    ", clients " + std::to_string(server_.clientCount()) + ", last update " +
                    std::to_string(bridge_ ? bridge_->lastTickMicros() : 0) + " us. Commands: .efss airport VIDP | "
                    ".efss position TWR | .efss auto");
        }
        return true;
    } catch (...) {
        return true;
    }
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

std::string EfssPlugin::airport() const {
    if (!airportOverride_.empty()) return airportOverride_;
    const std::string cs = upper(safe(ControllerMyself().GetCallsign()));
    if (cs.size() >= 5 && cs[4] == '_' && std::all_of(cs.begin(), cs.begin() + 4, ::isalpha)) return cs.substr(0, 4);
    return "VIDP";
}

std::string EfssPlugin::myPosition() const {
    if (!positionOverride_.empty()) return positionOverride_;
    const std::string p = facilityToPosition(ControllerMyself().GetFacility());
    return (p == "DEL" || p == "GND" || p == "TWR") ? p : "TWR";
}

Welcome EfssPlugin::welcome() {
    Welcome w;
    w.plugin = std::string("euroscope-efss ") + kVersion;
    w.callsign = safe(ControllerMyself().GetCallsign());
    w.position = myPosition();
    w.airport = airport();
    return w;
}

std::string EfssPlugin::deriveState(const CFlightPlan& fp, bool departure) const {
    // EuroScope keeps a ground state after the aircraft leaves the airport where it was
    // set (e.g. "TAXI" from the departure airport is still there at FL390). So a ground
    // state only counts while the aircraft is slow and close to *this* airport.
    CRadarTarget rt = fp.GetCorrelatedRadarTarget();
    const int speed = rt.IsValid() ? rt.GetGS() : 0;
    const bool fast = speed > kGroundMaxKt;

    if (!departure) {
        const bool atDestination = !fast && fp.GetDistanceToDestination() < kNearAirportNm;
        if (!atDestination) return "";  // still inbound: ARRIVALS / LOCAL
        const std::string gs = upper(safe(fp.GetGroundState()));
        return (gs == "TXIN" || gs == "PARK" || gs == "TAXI") ? "TAXI_IN" : "";
    }

    // Departed (airborne or well away from the field): it is a departure, whatever
    // ground state was or wasn't set on the way out.
    if (fast || fp.GetDistanceFromOrigin() > kNearAirportNm) return "DEPARTURES";

    const std::string gs = upper(safe(fp.GetGroundState()));
    if (gs == "TXIN" || gs == "PARK") return "TAXI_IN";
    if (gs == "DEPA" || gs == "LINEUP") return "DEPARTURES";
    if (gs == "TAXI") return "TAXI_OUT";
    if (gs == "PUSH") return "PUSH";
    if (gs == "ST-UP" || gs == "STUP") return "READY";
    if (fp.GetClearenceFlag()) return "CLEARED";
    return "";  // app places it: PLANNED / ARRIVALS / LOCAL
}

void EfssPlugin::collect(std::vector<FlightRecord>& flights, std::vector<ControllerRecord>& controllers) {
    const std::string apt = airport();

    for (CFlightPlan fp = FlightPlanSelectFirst(); fp.IsValid(); fp = FlightPlanSelectNext(fp)) {
        CFlightPlanData d = fp.GetFlightPlanData();
        const std::string adep = upper(safe(d.GetOrigin()));
        const std::string ades = upper(safe(d.GetDestination()));
        if (adep != apt && ades != apt) continue;

        FlightRecord f;
        f.callsign = safe(fp.GetCallsign());
        if (f.callsign.empty()) continue;
        f.trashed = trashed_.count(f.callsign) > 0;  // kept so the app's stack can restore it

        const std::string plan = upper(safe(d.GetPlanType()));
        const bool departure = adep == apt;
        // Y = IFR then VFR, Z = VFR then IFR: use the rules that apply at this airport.
        f.rules = (plan == "V" || (plan == "Z" && departure) || (plan == "Y" && !departure)) ? "V" : "I";
        f.adep = adep;
        f.ades = ades;
        f.aircraftType = safe(d.GetAircraftFPType());
        const char wtc = d.GetAircraftWtc();
        f.wake = std::string(1, (wtc == 'L' || wtc == 'M' || wtc == 'H' || wtc == 'J') ? wtc : 'M');
        f.rfl = fp.GetFinalAltitude();

        CFlightPlanControllerAssignedData a = fp.GetControllerAssignedData();
        const int cfl = a.GetClearedAltitude();
        if (cfl > 2) f.cfl = cfl;  // 0 = none, 1/2 = approach clearances
        f.squawk = safe(a.GetSquawk());
        f.scratchpad = safe(a.GetScratchPadString());
        f.sid = safe(d.GetSidName());
        f.depRwy = safe(d.GetDepartureRwy());
        f.arrRwy = safe(d.GetArrivalRwy());
        f.route = safe(d.GetRoute());
        f.eobt = safe(d.GetEstimatedDepartureTime());
        f.remarks = safe(d.GetRemarks());
        auto st = stands_.find(f.callsign);
        if (st != stands_.end()) f.stand = st->second;

        // Bay: EuroScope first; a local override holds only while EuroScope is unchanged.
        std::string state = deriveState(fp, departure);
        auto ov = overrides_.find(f.callsign);
        if (ov != overrides_.end()) {
            if (ov->second.carrier == "\x01") ov->second.carrier = state;  // capture after our own change
            if (ov->second.carrier == state) state = ov->second.state;
            else overrides_.erase(ov);  // someone changed EuroScope since: EuroScope wins
        }
        f.stripState = state;

        CRadarTarget rt = fp.GetCorrelatedRadarTarget();
        if (rt.IsValid()) {
            CRadarTargetPositionData p = rt.GetPosition();
            if (p.IsValid()) {
                f.lat = p.GetPosition().m_Latitude;
                f.lon = p.GetPosition().m_Longitude;
                f.altitude = p.GetPressureAltitude();
                f.groundSpeed = rt.GetGS();
            }
        }
        flights.push_back(std::move(f));
    }

    const std::string me = safe(ControllerMyself().GetCallsign());
    for (CController c = ControllerSelectFirst(); c.IsValid(); c = ControllerSelectNext(c)) {
        if (!c.IsController()) continue;
        const std::string cs = upper(safe(c.GetCallsign()));
        if (cs == upper(me) || cs.rfind(apt + "_", 0) != 0) continue;
        if (cs.size() >= 5 && cs.compare(cs.size() - 5, 5, "_ATIS") == 0) continue;  // ATIS is not a position
        ControllerRecord r;
        r.callsign = cs;
        r.position = facilityToPosition(c.GetFacility());
        char buf[16];
        std::snprintf(buf, sizeof buf, "%.3f", c.GetPrimaryFrequency());
        r.frequency = buf;
        controllers.push_back(r);
    }
    std::sort(controllers.begin(), controllers.end(),
              [](const ControllerRecord& x, const ControllerRecord& y) { return x.callsign < y.callsign; });
}

bool EfssPlugin::setGroundState(CFlightPlan& fp, const char* state) {
    CFlightPlanControllerAssignedData a = fp.GetControllerAssignedData();
    const std::string previous = safe(a.GetScratchPadString());
    const bool ok = a.SetScratchPadString(state);
    a.SetScratchPadString(previous.c_str());
    return ok;
}

bool EfssPlugin::setClearance(CFlightPlan& fp, bool cleared) {
    if (fp.GetClearenceFlag() == cleared) return true;
    if (screens_.empty()) return false;
    // EuroScope's own "set cleared flag" TAG function toggles the flag of the ASEL aircraft.
    CFlightPlan previous = FlightPlanSelectASEL();
    SetASELAircraft(fp);
    POINT pt{0, 0};
    RECT area{0, 0, 0, 0};
    (*screens_.begin())->StartTagFunction(fp.GetCallsign(), nullptr, TAG_ITEM_TYPE_CLEARENCE, "", nullptr,
                                          TAG_ITEM_FUNCTION_SET_CLEARED_FLAG, pt, area);
    if (previous.IsValid()) SetASELAircraft(previous);
    return fp.GetClearenceFlag() == cleared;
}

bool EfssPlugin::amendSidRunway(CFlightPlan& fp, const std::string* sid, const std::string* rwy) {
    CFlightPlanData d = fp.GetFlightPlanData();
    const std::string adep = upper(safe(d.GetOrigin()));
    const std::string oldSid = upper(safe(d.GetSidName()));
    const std::string newSid = sid ? upper(*sid) : oldSid;
    const std::string newRwy = rwy ? upper(*rwy) : upper(safe(d.GetDepartureRwy()));

    // Drop leading "ADEP/RWY", "SID" or "SID/RWY" tokens, then prefix the new ones.
    auto tokens = split(upper(safe(d.GetRoute())));
    while (!tokens.empty()) {
        const std::string& t = tokens.front();
        const std::string head = t.substr(0, t.find('/'));
        if (head == adep || (!oldSid.empty() && head == oldSid)) tokens.erase(tokens.begin());
        else break;
    }
    std::string route = adep + (newRwy.empty() ? "" : "/" + newRwy);
    if (!newSid.empty()) route += " " + newSid;
    for (const auto& t : tokens) route += " " + t;

    if (!d.SetRoute(route.c_str())) return false;
    return d.AmendFlightPlan();
}

CommandResult EfssPlugin::execute(const Command& cmd) {
    CFlightPlan fp = FlightPlanSelect(cmd.callsign.c_str());
    if (!fp.IsValid()) return {false, "NO_FLIGHT"};
    CFlightPlanControllerAssignedData a = fp.GetControllerAssignedData();
    const bool departure = upper(safe(fp.GetFlightPlanData().GetOrigin())) == airport();
    auto fail = [](const char* e) { return CommandResult{false, e}; };

    if (cmd.action == "setStripState") {
        const std::string& s = cmd.text;
        overrides_.erase(cmd.callsign);
        bool ok = true;
        if (s == "PLANNED") ok = setGroundState(fp, GS_NONE) && setClearance(fp, false);
        else if (s == "CLEARED") ok = setGroundState(fp, GS_NONE) && setClearance(fp, true);
        else if (s == "READY") ok = setGroundState(fp, GS_STARTUP);
        else if (s == "PUSH") ok = setGroundState(fp, GS_PUSH);
        else if (s == "TAXI_OUT") ok = setGroundState(fp, GS_TAXI);
        else if (s == "DEPARTURES") ok = setGroundState(fp, GS_DEPA);
        else if (s == "TAXI_IN") ok = setGroundState(fp, GS_TAXI_IN);
        else if (s == "ARRIVALS") ok = departure ? false : setGroundState(fp, GS_NONE);
        else if (s == "LOCAL") overrides_[cmd.callsign] = {"LOCAL", "\x01"};  // no EuroScope field
        else return fail("BAD_STATE");
        return ok ? CommandResult{} : fail("ES_REFUSED");
    }
    if (cmd.action == "setCfl") {
        if (!cmd.hasNumber) return fail("BAD_VALUE");
        return a.SetClearedAltitude(static_cast<int>(cmd.number)) ? CommandResult{} : fail("ES_REFUSED");
    }
    if (cmd.action == "setSquawk") return a.SetSquawk(cmd.text.c_str()) ? CommandResult{} : fail("ES_REFUSED");
    if (cmd.action == "setScratchpad")
        return a.SetScratchPadString(cmd.text.c_str()) ? CommandResult{} : fail("ES_REFUSED");
    if (cmd.action == "setSid") return amendSidRunway(fp, &cmd.text, nullptr) ? CommandResult{} : fail("ES_REFUSED");
    if (cmd.action == "setDepRwy") return amendSidRunway(fp, nullptr, &cmd.text) ? CommandResult{} : fail("ES_REFUSED");
    if (cmd.action == "setStand") {
        stands_[cmd.callsign] = upper(cmd.text);
        return {};
    }
    if (cmd.action == "trash") {
        trashed_.insert(cmd.callsign);
        overrides_.erase(cmd.callsign);
        return {};
    }
    if (cmd.action == "restore") {
        trashed_.erase(cmd.callsign);
        return {};
    }
    if (cmd.action == "assignSquawk") {
        // TopSky's own "assign squawk" TAG function (same call DelHel uses). TopSky picks
        // the code from TopSkySSRcodes.txt; the new code arrives with the next update.
        if (!GetModuleHandleA(kTopSkyDll)) return fail("TOPSKY_NOT_LOADED");
        if (screens_.empty()) return fail("NO_RADAR_SCREEN");
        const std::string cs = fp.GetCallsign();
        (*screens_.begin())->StartTagFunction(cs.c_str(), nullptr, 0, cs.c_str(), kTopSkyPlugin,
                                              kTopSkyAssignSquawk, POINT{0, 0}, RECT{0, 0, 0, 0});
        return {};
    }
    return fail("UNKNOWN_ACTION");
}

}  // namespace efss

// ---------------------------------------------------------------------------
// DLL entry points
// ---------------------------------------------------------------------------

static efss::EfssPlugin* g_plugin = nullptr;

void __declspec(dllexport) EuroScopePlugInInit(EuroScopePlugIn::CPlugIn** ppPlugInInstance) {
    *ppPlugInInstance = g_plugin = new efss::EfssPlugin();
}

void __declspec(dllexport) EuroScopePlugInExit(void) {
    delete g_plugin;
    g_plugin = nullptr;
}
