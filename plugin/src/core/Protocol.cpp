#include "Protocol.h"

namespace efss {

namespace {

template <typename T>
void optNum(JsonWriter& w, const char* k, const std::optional<T>& v) {
    if (v) w.num(k, static_cast<double>(*v));
    else w.null(k);
}

void stripState(JsonWriter& w, const std::string& s) {
    if (s.empty()) w.null("stripState");
    else w.str("stripState", s);
}

void controllersArray(JsonWriter& w, const std::vector<ControllerRecord>& cs) {
    w.beginArray("controllers");
    for (const auto& c : cs) {
        w.beginObject().str("callsign", c.callsign).str("position", c.position).str("frequency", c.frequency).endObject();
    }
    w.endArray();
}

JsonWriter header(const char* type) {
    JsonWriter w;
    w.beginObject().integer("v", kProtocolVersion).str("type", type);
    return w;
}

}  // namespace

std::string flightJson(const FlightRecord& f) {
    JsonWriter w;
    w.beginObject()
        .str("callsign", f.callsign)
        .str("rules", f.rules)
        .str("adep", f.adep)
        .str("ades", f.ades)
        .str("aircraftType", f.aircraftType)
        .str("wake", f.wake)
        .integer("rfl", f.rfl);
    optNum(w, "cfl", f.cfl);
    w.str("squawk", f.squawk)
        .str("sid", f.sid)
        .str("depRwy", f.depRwy)
        .str("arrRwy", f.arrRwy)
        .str("route", f.route)
        .str("eobt", f.eobt)
        .str("ctot", f.ctot)
        .str("remarks", f.remarks)
        .str("scratchpad", f.scratchpad)
        .str("stand", f.stand);
    stripState(w, f.stripState);
    w.boolean("trashed", f.trashed);
    optNum(w, "lat", f.lat);
    optNum(w, "lon", f.lon);
    optNum(w, "altitude", f.altitude);
    optNum(w, "groundSpeed", f.groundSpeed);
    w.endObject();
    return w.text();
}

std::string flightDiffJson(const FlightRecord& a, const FlightRecord& b) {
    JsonWriter w;
    w.beginObject();
    bool any = false;
#define EFSS_STR(field)                       \
    if (a.field != b.field) {                 \
        w.str(#field, b.field);               \
        any = true;                           \
    }
#define EFSS_OPT(field)                       \
    if (a.field != b.field) {                 \
        optNum(w, #field, b.field);           \
        any = true;                           \
    }
    EFSS_STR(rules) EFSS_STR(adep) EFSS_STR(ades) EFSS_STR(aircraftType) EFSS_STR(wake)
    if (a.rfl != b.rfl) {
        w.integer("rfl", b.rfl);
        any = true;
    }
    EFSS_OPT(cfl)
    EFSS_STR(squawk) EFSS_STR(sid) EFSS_STR(depRwy) EFSS_STR(arrRwy) EFSS_STR(route) EFSS_STR(eobt)
    EFSS_STR(ctot) EFSS_STR(remarks) EFSS_STR(scratchpad) EFSS_STR(stand)
    if (a.stripState != b.stripState) {
        stripState(w, b.stripState);
        any = true;
    }
    if (a.trashed != b.trashed) {
        w.boolean("trashed", b.trashed);
        any = true;
    }
    EFSS_OPT(lat) EFSS_OPT(lon) EFSS_OPT(altitude) EFSS_OPT(groundSpeed)
#undef EFSS_STR
#undef EFSS_OPT
    w.endObject();
    return any ? w.text() : std::string();
}

std::string welcomeMsg(const Welcome& wl) {
    JsonWriter w = header("welcome");
    w.str("plugin", wl.plugin).str("callsign", wl.callsign).str("position", wl.position).str("airport", wl.airport);
    w.endObject();
    return w.text();
}

std::string snapshotMsg(long long seq, const std::vector<FlightRecord>& flights,
                        const std::vector<ControllerRecord>& controllers) {
    JsonWriter w = header("snapshot");
    w.integer("seq", seq).beginArray("flights");
    for (const auto& f : flights) w.raw(nullptr, flightJson(f));
    w.endArray();
    controllersArray(w, controllers);
    w.endObject();
    return w.text();
}

std::string deltaMsg(long long seq, const std::string& callsign, const std::string& changesJson) {
    JsonWriter w = header("delta");
    w.integer("seq", seq).str("callsign", callsign).raw("changes", changesJson).endObject();
    return w.text();
}

std::string removeMsg(long long seq, const std::string& callsign) {
    JsonWriter w = header("remove");
    w.integer("seq", seq).str("callsign", callsign).endObject();
    return w.text();
}

std::string controllersMsg(long long seq, const std::vector<ControllerRecord>& controllers) {
    JsonWriter w = header("controllers");
    w.integer("seq", seq);
    controllersArray(w, controllers);
    w.endObject();
    return w.text();
}

std::string ackMsg(const std::string& id, const CommandResult& r) {
    JsonWriter w = header("ack");
    w.str("id", id).boolean("ok", r.ok);
    if (!r.ok) w.str("error", r.error);
    w.endObject();
    return w.text();
}

std::string pongMsg() {
    JsonWriter w = header("pong");
    w.endObject();
    return w.text();
}

ClientMessage parseClientMessage(const std::string& text) {
    ClientMessage m;
    FlatObject o;
    if (!parseFlatObject(text, o)) return m;
    auto s = [&](const char* k) {
        auto it = o.find(k);
        return it != o.end() && it->second.type == JsonValue::Type::String ? it->second.s : std::string();
    };
    m.type = s("type");
    if (m.type == "cmd") {
        m.cmd.id = s("id");
        m.cmd.callsign = s("callsign");
        m.cmd.action = s("action");
        auto it = o.find("value");
        if (it != o.end()) {
            if (it->second.type == JsonValue::Type::Number) {
                m.cmd.number = it->second.n;
                m.cmd.hasNumber = true;
            } else if (it->second.type == JsonValue::Type::String) {
                m.cmd.text = it->second.s;
            }
        }
    }
    return m;
}

}  // namespace efss
