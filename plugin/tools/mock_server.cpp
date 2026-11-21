// Standalone test server: the plugin's core (WebSocket server + bridge) with a
// fake backend instead of EuroScope. Lets the app be tested against the real
// C++ protocol implementation.  Usage: efss_mock_server [seconds] [port]

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <thread>

#include "../src/core/Bridge.h"

using namespace efss;

class MockBackend : public Backend {
public:
    MockBackend() {
        add("AIC101", "I", "VIDP", "VABB", "A320", "REBON5B", "1200", 28.5665, 77.1031, 777, 0);
        add("IGO2245", "I", "VIDP", "VOBL", "A20N", "ALI5B", "1210", 28.5670, 77.1040, 777, 0);
        add("SEJ123", "I", "VABB", "VIDP", "B738", "", "1030", 28.70, 77.30, 6000, 220);
        add("VTABC", "V", "VIDP", "VIDP", "C172", "", "1215", 28.5665, 77.1031, 777, 0);
    }

    Welcome welcome() override { return {"mock-server", "VIDP_TWR", "TWR", "VIDP"}; }

    void collect(std::vector<FlightRecord>& out, std::vector<ControllerRecord>& ctrls) override {
        // the inbound flight slows down and lands, to exercise the app's auto rules
        auto& arr = flights_["SEJ123"];
        if (arr.altitude && *arr.altitude > 800) {
            *arr.altitude -= 400;
            *arr.lat -= 0.008;
            *arr.lon -= 0.012;
        } else if (arr.groundSpeed && *arr.groundSpeed > 0) {
            *arr.groundSpeed = std::max(0, *arr.groundSpeed - 40);
            arr.altitude = 777;
        }
        for (auto& [cs, f] : flights_) out.push_back(f);
        ctrls.push_back({"VIDP_GND", "GND", "121.900"});
    }

    CommandResult execute(const Command& c) override {
        auto it = flights_.find(c.callsign);
        if (it == flights_.end()) return {false, "NO_FLIGHT"};
        FlightRecord& f = it->second;
        std::printf("cmd %s %s %s%s\n", c.callsign.c_str(), c.action.c_str(), c.text.c_str(),
                    c.hasNumber ? std::to_string(c.number).c_str() : "");
        if (c.action == "setStripState") f.stripState = c.text;
        else if (c.action == "setCfl") f.cfl = static_cast<int>(c.number);
        else if (c.action == "setSquawk") f.squawk = c.text;
        else if (c.action == "setScratchpad") f.scratchpad = c.text;
        else if (c.action == "setSid") f.sid = c.text;
        else if (c.action == "setDepRwy") f.depRwy = c.text;
        else if (c.action == "setStand") f.stand = c.text;
        else if (c.action == "trash") f.trashed = true;
        else if (c.action == "restore") f.trashed = false;
        else if (c.action == "assignSquawk") f.squawk = "4" + std::to_string(100 + std::rand() % 77);
        else return {false, "UNKNOWN_ACTION"};
        return {};
    }

private:
    void add(const char* cs, const char* rules, const char* adep, const char* ades, const char* type, const char* sid,
             const char* eobt, double lat, double lon, int alt, int gs) {
        FlightRecord f;
        f.callsign = cs;
        f.rules = rules;
        f.adep = adep;
        f.ades = ades;
        f.aircraftType = type;
        f.sid = sid;
        f.depRwy = "28";
        f.arrRwy = "28";
        f.rfl = 35000;
        f.squawk = "2201";
        f.eobt = eobt;
        f.route = "DCT";
        f.lat = lat;
        f.lon = lon;
        f.altitude = alt;
        f.groundSpeed = gs;
        flights_[cs] = f;
    }
    std::map<std::string, FlightRecord> flights_;
};

int main(int argc, char** argv) {
    const int seconds = argc > 1 ? std::atoi(argv[1]) : 600;
    WsOptions opts;
    if (argc > 2) opts.port = static_cast<unsigned short>(std::atoi(argv[2]));

    WsServer server;
    if (!server.start(opts)) {
        std::fprintf(stderr, "start failed: %s\n", server.lastError().c_str());
        return 1;
    }
    std::printf("mock EFSS plugin on ws://127.0.0.1:%u for %d s\n", server.port(), seconds);
    std::fflush(stdout);

    MockBackend backend;
    Bridge bridge(server, backend);
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
    auto nextTick = std::chrono::steady_clock::now();
    while (std::chrono::steady_clock::now() < end) {
        bridge.pump();
        if (std::chrono::steady_clock::now() >= nextTick) {
            bridge.tick();
            nextTick += std::chrono::seconds(1);
            std::fflush(stdout);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    server.stop();
    return 0;
}
