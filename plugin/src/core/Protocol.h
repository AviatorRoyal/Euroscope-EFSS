#pragma once
// EFSS wire protocol, mirroring src/protocol/types.ts in the app.

#include <optional>
#include <string>
#include <vector>

#include "Json.h"

namespace efss {

constexpr int kProtocolVersion = 1;

/** Plain copy of one flight; never holds EuroScope objects. */
struct FlightRecord {
    std::string callsign;
    std::string rules = "I";  // "I" | "V"
    std::string adep, ades;
    std::string aircraftType;
    std::string wake = "M";
    int rfl = 0;
    std::optional<int> cfl;
    std::string squawk;
    std::string sid, depRwy, arrRwy;
    std::string route;
    std::string eobt, ctot;
    std::string remarks, scratchpad, stand;
    std::string stripState;  // "" = not placed yet (null on the wire)
    bool trashed = false;    // in the stack (hidden from the bays, restorable)
    std::optional<double> lat, lon;
    std::optional<int> altitude, groundSpeed;
};

struct ControllerRecord {
    std::string callsign;
    std::string position;  // DEL | GND | TWR | APP | CTR | OTHER
    std::string frequency;
    bool operator==(const ControllerRecord& o) const {
        return callsign == o.callsign && position == o.position && frequency == o.frequency;
    }
};

struct Welcome {
    std::string plugin, callsign, position, airport;
};

struct Command {
    std::string id, callsign, action;
    std::string text;      // string value
    double number = 0;     // numeric value
    bool hasNumber = false;
};

struct CommandResult {
    bool ok = true;
    std::string error;
};

/** Writes all fields of a flight as a JSON object. */
std::string flightJson(const FlightRecord& f);
/** Writes only fields that differ; returns empty string if nothing changed. */
std::string flightDiffJson(const FlightRecord& before, const FlightRecord& after);

std::string welcomeMsg(const Welcome& w);
std::string snapshotMsg(long long seq, const std::vector<FlightRecord>& flights,
                        const std::vector<ControllerRecord>& controllers);
std::string deltaMsg(long long seq, const std::string& callsign, const std::string& changesJson);
std::string removeMsg(long long seq, const std::string& callsign);
std::string controllersMsg(long long seq, const std::vector<ControllerRecord>& controllers);
std::string ackMsg(const std::string& id, const CommandResult& r);
std::string pongMsg();

/** Parsed client message. type is "" if the text could not be parsed. */
struct ClientMessage {
    std::string type;
    Command cmd;
};
ClientMessage parseClientMessage(const std::string& text);

}  // namespace efss
