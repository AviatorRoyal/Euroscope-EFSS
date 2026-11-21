#include "WsServer.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>

#include <algorithm>
#include <cctype>
#include <memory>

#include "Sha1.h"

#pragma comment(lib, "Ws2_32.lib")

namespace efss {

struct WsServer::Client {
    int id = 0;
    SOCKET sock = INVALID_SOCKET;
    bool handshakeDone = false;
    bool closing = false;
    std::string in;        // unparsed received bytes
    std::string out;       // unsent bytes
    std::string fragment;  // continuation-frame accumulator
};

namespace {

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    return s;
}

std::string header(const std::string& req, const std::string& name) {
    const std::string l = lower(req);
    const std::string key = "\r\n" + lower(name) + ":";
    size_t p = l.find(key);
    if (p == std::string::npos) return {};
    p += key.size();
    size_t e = req.find("\r\n", p);
    std::string v = req.substr(p, e - p);
    v.erase(0, v.find_first_not_of(" \t"));
    v.erase(v.find_last_not_of(" \t") + 1);
    return v;
}

/** Browsers send Origin; only local pages may drive EuroScope. Non-browser clients send none. */
bool originAllowed(const std::string& origin) {
    if (origin.empty() || origin == "null") return true;
    const std::string o = lower(origin);
    for (const char* ok : {"http://localhost", "http://127.0.0.1", "https://localhost", "https://127.0.0.1"}) {
        const std::string p(ok);
        if (o == p || o.rfind(p + ":", 0) == 0) return true;
    }
    return false;
}

std::string frame(uint8_t opcode, const std::string& payload) {
    std::string f;
    f += static_cast<char>(0x80 | opcode);
    const size_t n = payload.size();
    if (n < 126) {
        f += static_cast<char>(n);
    } else if (n <= 0xFFFF) {
        f += static_cast<char>(126);
        f += static_cast<char>((n >> 8) & 0xFF);
        f += static_cast<char>(n & 0xFF);
    } else {
        f += static_cast<char>(127);
        for (int i = 7; i >= 0; --i) f += static_cast<char>((uint64_t(n) >> (i * 8)) & 0xFF);
    }
    f += payload;
    return f;
}

}  // namespace

WsServer::~WsServer() { stop(); }

std::string WsServer::lastError() const {
    std::lock_guard<std::mutex> lk(mu_);
    return lastError_;
}

bool WsServer::start(const WsOptions& opts) {
    if (running_) return true;
    opts_ = opts;

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        lastError_ = "WSAStartup failed";
        return false;
    }

    for (int attempt = 0; attempt < opts_.portAttempts; ++attempt) {
        const unsigned short port = static_cast<unsigned short>(opts_.port + attempt);
        SOCKET s = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (s == INVALID_SOCKET) break;
        BOOL exclusive = TRUE;
        ::setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof exclusive);

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);
        addr.sin_addr.s_addr = htonl(opts_.listenOnAllInterfaces ? INADDR_ANY : INADDR_LOOPBACK);
        if (::bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof addr) == 0 && ::listen(s, 8) == 0) {
            u_long nb = 1;
            ::ioctlsocket(s, FIONBIO, &nb);
            listenSock_ = static_cast<uintptr_t>(s);
            boundPort_ = port;
            running_ = true;
            worker_ = std::thread(&WsServer::run, this);
            return true;
        }
        ::closesocket(s);
    }
    lastError_ = "could not bind ports " + std::to_string(opts_.port) + "-" +
                 std::to_string(opts_.port + opts_.portAttempts - 1);
    WSACleanup();
    return false;
}

void WsServer::stop() {
    if (!running_.exchange(false)) return;
    if (worker_.joinable()) worker_.join();  // worker wakes every 50 ms, so this is bounded
    WSACleanup();
}

void WsServer::send(int client, std::string text) {
    sendLazy(client, [t = std::move(text)]() { return t; });
}

void WsServer::sendLazy(int client, std::function<std::string()> build) {
    std::lock_guard<std::mutex> lk(mu_);
    outbound_.emplace_back(client, std::move(build));
}

void WsServer::broadcast(std::string text) { send(0, std::move(text)); }

bool WsServer::poll(WsEvent& out) {
    std::lock_guard<std::mutex> lk(mu_);
    if (inbound_.empty()) return false;
    out = std::move(inbound_.front());
    inbound_.pop_front();
    return true;
}

void WsServer::run() {
    const SOCKET listener = static_cast<SOCKET>(listenSock_);
    std::map<int, std::unique_ptr<Client>> clients;
    int nextId = 1;

    auto pushEvent = [&](WsEvent ev) {
        std::lock_guard<std::mutex> lk(mu_);
        if (inbound_.size() < opts_.maxInbound || ev.kind != WsEvent::Kind::Message) inbound_.push_back(std::move(ev));
    };

    auto dropClient = [&](Client& c) {
        ::closesocket(c.sock);
        const bool announced = c.handshakeDone;
        const int id = c.id;
        clients.erase(id);
        clientCount_ = clients.size();
        if (announced) pushEvent({WsEvent::Kind::Disconnected, id, {}});
    };

    while (running_) {
        // 1. Move queued outbound messages into client write buffers.
        std::vector<std::pair<int, std::function<std::string()>>> out;
        {
            std::lock_guard<std::mutex> lk(mu_);
            out.swap(outbound_);
        }
        for (auto& [target, build] : out) {
            std::string text;
            try {
                text = build();
            } catch (...) {
                continue;
            }
            const std::string f = frame(0x1, text);
            for (auto& [id, c] : clients) {
                if (!c->handshakeDone || c->closing) continue;
                if (target != 0 && target != id) continue;
                c->out += f;
            }
        }

        // 2. Wait for socket activity (bounded, so stop() is always prompt).
        fd_set rd, wr;
        FD_ZERO(&rd);
        FD_ZERO(&wr);
        FD_SET(listener, &rd);
        for (auto& [id, c] : clients) {
            FD_SET(c->sock, &rd);
            if (!c->out.empty()) FD_SET(c->sock, &wr);
        }
        timeval tv{0, 50 * 1000};
        if (::select(0, &rd, &wr, nullptr, &tv) == SOCKET_ERROR) continue;

        // 3. Accept new connections.
        if (FD_ISSET(listener, &rd) && clients.size() < 16) {
            SOCKET s = ::accept(listener, nullptr, nullptr);
            if (s != INVALID_SOCKET) {
                u_long nb = 1;
                ::ioctlsocket(s, FIONBIO, &nb);
                BOOL nodelay = TRUE;
                ::setsockopt(s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nodelay), sizeof nodelay);
                auto c = std::make_unique<Client>();
                c->id = nextId++;
                c->sock = s;
                clients[c->id] = std::move(c);
                clientCount_ = clients.size();
            }
        }

        // 4. Read and parse.
        std::vector<int> ids;
        for (auto& [id, c] : clients) ids.push_back(id);
        for (int id : ids) {
            auto it = clients.find(id);
            if (it == clients.end()) continue;
            Client& c = *it->second;

            if (FD_ISSET(c.sock, &rd)) {
                char buf[8192];
                int n = ::recv(c.sock, buf, sizeof buf, 0);
                if (n <= 0) {
                    if (n == 0 || WSAGetLastError() != WSAEWOULDBLOCK) {
                        dropClient(c);
                        continue;
                    }
                } else {
                    c.in.append(buf, n);
                }
            }

            if (!c.handshakeDone) {
                size_t end = c.in.find("\r\n\r\n");
                if (end == std::string::npos) {
                    if (c.in.size() > 16384) dropClient(c);
                    continue;
                }
                const std::string req = c.in.substr(0, end + 4);
                c.in.erase(0, end + 4);
                const std::string key = header(req, "Sec-WebSocket-Key");
                const std::string origin = header(req, "Origin");
                if (key.empty() || lower(header(req, "Upgrade")) != "websocket") {
                    c.out = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
                    c.closing = true;
                } else if (!originAllowed(origin)) {
                    c.out = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
                    c.closing = true;
                } else {
                    c.out = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                            "Sec-WebSocket-Accept: " + websocketAccept(key) + "\r\n\r\n";
                    c.handshakeDone = true;
                    pushEvent({WsEvent::Kind::Connected, c.id, {}});
                }
            }

            // Parse complete frames.
            while (c.handshakeDone && !c.closing && c.in.size() >= 2) {
                const auto* p = reinterpret_cast<const uint8_t*>(c.in.data());
                const bool fin = p[0] & 0x80;
                const uint8_t opcode = p[0] & 0x0F;
                const bool masked = p[1] & 0x80;
                uint64_t len = p[1] & 0x7F;
                size_t pos = 2;
                if (len == 126) {
                    if (c.in.size() < 4) break;
                    len = (uint64_t(p[2]) << 8) | p[3];
                    pos = 4;
                } else if (len == 127) {
                    if (c.in.size() < 10) break;
                    len = 0;
                    for (int i = 0; i < 8; ++i) len = (len << 8) | p[2 + i];
                    pos = 10;
                }
                if (!masked || len > opts_.maxMessageBytes) {  // clients must mask (RFC 6455 5.1)
                    c.closing = true;
                    c.out += frame(0x8, "");
                    break;
                }
                if (c.in.size() < pos + 4 + len) break;
                const uint8_t* mask = p + pos;
                pos += 4;
                std::string payload(c.in.data() + pos, static_cast<size_t>(len));
                for (size_t i = 0; i < payload.size(); ++i) payload[i] = char(payload[i] ^ mask[i % 4]);
                c.in.erase(0, pos + static_cast<size_t>(len));

                if (opcode == 0x8) {  // close
                    c.out += frame(0x8, "");
                    c.closing = true;
                } else if (opcode == 0x9) {  // ping
                    c.out += frame(0xA, payload);
                } else if (opcode == 0x1 || opcode == 0x0) {  // text / continuation
                    c.fragment += payload;
                    if (c.fragment.size() > opts_.maxMessageBytes) {
                        c.closing = true;
                        break;
                    }
                    if (fin) {
                        pushEvent({WsEvent::Kind::Message, c.id, std::move(c.fragment)});
                        c.fragment.clear();
                    }
                }
                // binary (0x2) and pong (0xA) are ignored
            }
        }

        // 5. Write pending data; drop slow or finished clients.
        ids.clear();
        for (auto& [id, c] : clients) ids.push_back(id);
        for (int id : ids) {
            auto it = clients.find(id);
            if (it == clients.end()) continue;
            Client& c = *it->second;
            if (c.out.size() > opts_.maxClientBacklog) {
                dropClient(c);
                continue;
            }
            if (!c.out.empty()) {
                int n = ::send(c.sock, c.out.data(), static_cast<int>(std::min<size_t>(c.out.size(), 1 << 20)), 0);
                if (n > 0) c.out.erase(0, n);
                else if (WSAGetLastError() != WSAEWOULDBLOCK) {
                    dropClient(c);
                    continue;
                }
            }
            if (c.closing && c.out.empty()) dropClient(c);
        }
    }

    for (auto& [id, c] : clients) ::closesocket(c->sock);
    clients.clear();
    clientCount_ = 0;
    ::closesocket(listener);
}


}  // namespace efss
