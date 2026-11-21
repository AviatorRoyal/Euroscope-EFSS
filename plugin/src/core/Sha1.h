#pragma once
// SHA-1 and Base64, only for the WebSocket opening handshake (RFC 6455).
#include <array>
#include <cstdint>
#include <string>

namespace efss {

std::array<uint8_t, 20> sha1(const std::string& data);
std::string base64(const uint8_t* data, size_t len);
/** Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
std::string websocketAccept(const std::string& clientKey);

}  // namespace efss
