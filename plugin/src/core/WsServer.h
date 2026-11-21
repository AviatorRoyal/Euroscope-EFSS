#pragma once
// Minimal RFC 6455 WebSocket server on its own thread.
//
// Threading contract (EuroScope is single-threaded and must never block):
//  - All socket work happens on the worker thread.
//  - The owner thread only calls send()/broadcast() (enqueue, O(1) under a
//    short lock) and poll() (dequeue). Neither call ever touches a socket.

#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace efss {

struct WsEvent {
    enum class Kind { Connected, Message, Disconnected } kind;
    int client = 0;
    std::string text;
};

struct WsOptions {
    unsigned short port = 49200;
    /** Try this many successive ports if the first is taken. */
    int portAttempts = 10;
    /** false = 127.0.0.1 only (default). true = all interfaces (LAN / tablet). */
    bool listenOnAllInterfaces = false;
    /** Max queued inbound events before new ones are dropped. */
    size_t maxInbound = 2000;
    /** Max unsent bytes per client before it is disconnected as too slow. */
    size_t maxClientBacklog = 8 * 1024 * 1024;
    size_t maxMessageBytes = 64 * 1024;
};

class WsServer {
public:
    WsServer() = default;
    ~WsServer();
    WsServer(const WsServer&) = delete;
    WsServer& operator=(const WsServer&) = delete;

    /** Binds and starts the worker. Returns false and sets lastError() on failure. */
    bool start(const WsOptions& opts);
    /** Signals the worker and joins it. The worker wakes at least every 50 ms. */
    void stop();

    void send(int client, std::string text);
    void broadcast(std::string text);
    /**
     * Queues a message whose text is produced on the worker thread, so that
     * serialising large payloads (snapshots) never runs on EuroScope's thread.
     * The function must only use data it owns (capture copies by value).
     */
    void sendLazy(int client, std::function<std::string()> build);
    /** Pops one event; returns false when the queue is empty. */
    bool poll(WsEvent& out);

    unsigned short port() const { return boundPort_; }
    std::string lastError() const;
    size_t clientCount() const { return clientCount_.load(); }

private:
    struct Client;
    void run();

    WsOptions opts_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    std::atomic<size_t> clientCount_{0};
    unsigned short boundPort_ = 0;
    uintptr_t listenSock_ = ~uintptr_t(0);

    mutable std::mutex mu_;  // guards everything below
    std::deque<WsEvent> inbound_;
    std::vector<std::pair<int, std::function<std::string()>>> outbound_;  // client 0 = broadcast
    std::string lastError_;
};

}  // namespace efss
