#pragma once
// Bridge between the WebSocket server and an ATC backend (EuroScope, or the
// mock backend used for testing). Runs entirely on the owner's thread and
// does bounded work per call, so it is safe to call from EuroScope callbacks.

#include <chrono>
#include <map>
#include <string>
#include <vector>

#include "Protocol.h"
#include "WsServer.h"

namespace efss {

class Backend {
public:
    virtual ~Backend() = default;
    virtual Welcome welcome() = 0;
    /** Fills the current flights (for this airport) and controllers. */
    virtual void collect(std::vector<FlightRecord>& flights, std::vector<ControllerRecord>& controllers) = 0;
    /** Applies one command to the backend; must not block. */
    virtual CommandResult execute(const Command& cmd) = 0;
};

struct BridgeLimits {
    int maxEventsPerPump = 25;
    std::chrono::microseconds maxPumpTime{2000};
};

class Bridge {
public:
    Bridge(WsServer& server, Backend& backend, BridgeLimits limits = {});

    /** Handles queued client messages within the time/event budget. Call often. */
    void pump();
    /** Collects backend state and broadcasts changes. Call about once a second. */
    void tick();
    /** Re-sends welcome + snapshot to every client (position/airport changed). */
    void resync();

    long long lastPumpMicros() const { return lastPumpUs_; }
    long long lastTickMicros() const { return lastTickUs_; }

private:
    void sendSnapshot(int client);

    WsServer& server_;
    Backend& backend_;
    BridgeLimits limits_;
    std::map<std::string, FlightRecord> last_;
    std::vector<ControllerRecord> lastControllers_;
    long long seq_ = 0;
    bool primed_ = false;
    long long lastPumpUs_ = 0, lastTickUs_ = 0;
};

}  // namespace efss
