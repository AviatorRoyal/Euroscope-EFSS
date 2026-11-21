#include "Bridge.h"

namespace efss {

using Clock = std::chrono::steady_clock;

Bridge::Bridge(WsServer& server, Backend& backend, BridgeLimits limits)
    : server_(server), backend_(backend), limits_(limits) {}

void Bridge::sendSnapshot(int client) {
    // Copy plain records now (cheap); serialise later on the worker thread.
    std::vector<FlightRecord> flights;
    flights.reserve(last_.size());
    for (const auto& [cs, f] : last_) flights.push_back(f);
    std::vector<ControllerRecord> controllers = lastControllers_;
    const long long seq = seq_;
    const Welcome w = backend_.welcome();
    server_.send(client, welcomeMsg(w));
    server_.sendLazy(client, [seq, flights = std::move(flights), controllers = std::move(controllers)]() {
        return snapshotMsg(seq, flights, controllers);
    });
}

void Bridge::pump() {
    const auto start = Clock::now();
    if (!primed_) tick();  // make sure a first snapshot has data

    WsEvent ev;
    int handled = 0;
    while (handled < limits_.maxEventsPerPump && Clock::now() - start < limits_.maxPumpTime && server_.poll(ev)) {
        ++handled;
        if (ev.kind != WsEvent::Kind::Message) continue;
        const ClientMessage m = parseClientMessage(ev.text);
        if (m.type == "hello" || m.type == "requestSnapshot") {
            sendSnapshot(ev.client);
        } else if (m.type == "ping") {
            server_.send(ev.client, pongMsg());
        } else if (m.type == "cmd") {
            CommandResult r;
            if (m.cmd.id.empty() || m.cmd.callsign.empty() || m.cmd.action.empty()) {
                r = {false, "BAD_COMMAND"};
            } else {
                try {
                    r = backend_.execute(m.cmd);
                } catch (...) {
                    r = {false, "INTERNAL_ERROR"};
                }
            }
            server_.send(ev.client, ackMsg(m.cmd.id, r));
        }
    }
    lastPumpUs_ = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - start).count();
}

void Bridge::tick() {
    const auto start = Clock::now();
    std::vector<FlightRecord> flights;
    std::vector<ControllerRecord> controllers;
    backend_.collect(flights, controllers);
    primed_ = true;

    std::map<std::string, FlightRecord> next;
    for (auto& f : flights) next.emplace(f.callsign, std::move(f));

    const bool broadcast = server_.clientCount() > 0;
    for (const auto& [cs, f] : next) {
        auto it = last_.find(cs);
        std::string changes = it == last_.end() ? flightJson(f) : flightDiffJson(it->second, f);
        if (!changes.empty() && broadcast) server_.broadcast(deltaMsg(++seq_, cs, changes));
    }
    for (const auto& [cs, f] : last_) {
        if (!next.count(cs) && broadcast) server_.broadcast(removeMsg(++seq_, cs));
    }
    if (controllers != lastControllers_ && broadcast) server_.broadcast(controllersMsg(++seq_, controllers));

    last_ = std::move(next);
    lastControllers_ = std::move(controllers);
    lastTickUs_ = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - start).count();
}

void Bridge::resync() { sendSnapshot(0); }

}  // namespace efss
