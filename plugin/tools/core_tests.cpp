// Unit tests for the EuroScope-independent core. Exit code 0 = all passed.
#include <cstdio>
#include <string>

#include "../src/core/Json.h"
#include "../src/core/Protocol.h"
#include "../src/core/Sha1.h"

using namespace efss;

static int failures = 0;
#define CHECK(cond)                                                     \
    do {                                                                \
        if (!(cond)) {                                                  \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
            ++failures;                                                 \
        }                                                               \
    } while (0)

int main() {
    // RFC 6455 section 1.3 example
    CHECK(websocketAccept("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");

    // command parsing
    auto m = parseClientMessage(R"({"v":1,"type":"cmd","id":"c-7","callsign":"AIC101","action":"setCfl","value":5000})");
    CHECK(m.type == "cmd");
    CHECK(m.cmd.id == "c-7" && m.cmd.callsign == "AIC101" && m.cmd.action == "setCfl");
    CHECK(m.cmd.hasNumber && m.cmd.number == 5000);
    m = parseClientMessage(R"({"type":"cmd","id":"c-8","callsign":"VT\"X","action":"setScratchpad","value":"RWY 28"})");
    CHECK(m.cmd.callsign == "VT\"X" && m.cmd.text == "RWY 28" && !m.cmd.hasNumber);
    CHECK(parseClientMessage("not json").type.empty());
    CHECK(parseClientMessage(R"({"type":"hello","client":"x"})").type == "hello");

    // flight diff
    FlightRecord a;
    a.callsign = "AIC101";
    a.squawk = "1234";
    FlightRecord b = a;
    CHECK(flightDiffJson(a, b).empty());
    b.squawk = "4321";
    b.stripState = "PUSH";
    b.groundSpeed = 3;
    CHECK(flightDiffJson(a, b) == R"({"squawk":"4321","stripState":"PUSH","groundSpeed":3})");
    b.stripState.clear();
    CHECK(flightDiffJson(a, b).find(R"("stripState")") == std::string::npos);
    a.stripState = "PUSH";
    CHECK(flightDiffJson(a, b).find(R"("stripState":null)") != std::string::npos);

    // messages
    CHECK(ackMsg("c-1", {false, "NO_FLIGHT"}) == R"({"v":1,"type":"ack","id":"c-1","ok":false,"error":"NO_FLIGHT"})");
    std::string snap = snapshotMsg(5, {a}, {{"VIDP_GND", "GND", "121.900"}});
    CHECK(snap.rfind(R"({"v":1,"type":"snapshot","seq":5,"flights":[{"callsign":"AIC101")", 0) == 0);
    CHECK(snap.find(R"("controllers":[{"callsign":"VIDP_GND","position":"GND","frequency":"121.900"}]})") !=
          std::string::npos);
    CHECK(escapeJson("a\nb\"c") == "a\\nb\\\"c");

    std::printf(failures ? "%d FAILED\n" : "all core tests passed\n", failures);
    return failures ? 1 : 0;
}
