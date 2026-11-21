#include "Json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace efss {

std::string escapeJson(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 2);
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    o += buf;
                } else {
                    o += static_cast<char>(c);
                }
        }
    }
    return o;
}

void JsonWriter::sep() {
    if (needComma_) out_ += ',';
    needComma_ = true;
}

void JsonWriter::writeKey(const char* k) {
    sep();
    if (k) {
        out_ += '"';
        out_ += escapeJson(k);
        out_ += "\":";
    }
}

JsonWriter& JsonWriter::beginObject() {
    sep();
    out_ += '{';
    needComma_ = false;
    return *this;
}

JsonWriter& JsonWriter::endObject() {
    out_ += '}';
    needComma_ = true;
    return *this;
}

JsonWriter& JsonWriter::beginArray(const char* k) {
    writeKey(k);
    out_ += '[';
    needComma_ = false;
    return *this;
}

JsonWriter& JsonWriter::endArray() {
    out_ += ']';
    needComma_ = true;
    return *this;
}

JsonWriter& JsonWriter::key(const char* k) {
    writeKey(k);
    needComma_ = false;
    return *this;
}

JsonWriter& JsonWriter::str(const char* k, const std::string& v) {
    writeKey(k);
    out_ += '"';
    out_ += escapeJson(v);
    out_ += '"';
    return *this;
}

JsonWriter& JsonWriter::num(const char* k, double v) {
    writeKey(k);
    if (!std::isfinite(v)) {
        out_ += "null";
        return *this;
    }
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.6f", v);
    // trim trailing zeros
    std::string s(buf);
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
    out_ += s;
    return *this;
}

JsonWriter& JsonWriter::integer(const char* k, long long v) {
    writeKey(k);
    out_ += std::to_string(v);
    return *this;
}

JsonWriter& JsonWriter::boolean(const char* k, bool v) {
    writeKey(k);
    out_ += v ? "true" : "false";
    return *this;
}

JsonWriter& JsonWriter::null(const char* k) {
    writeKey(k);
    out_ += "null";
    return *this;
}

JsonWriter& JsonWriter::raw(const char* k, const std::string& json) {
    writeKey(k);
    out_ += json;
    return *this;
}

// ---------------- parser ----------------

namespace {

struct Parser {
    const std::string& t;
    size_t i = 0;

    void ws() {
        while (i < t.size() && (t[i] == ' ' || t[i] == '\n' || t[i] == '\r' || t[i] == '\t')) ++i;
    }

    bool lit(const char* s) {
        size_t n = 0;
        while (s[n]) ++n;
        if (t.compare(i, n, s) != 0) return false;
        i += n;
        return true;
    }

    static void appendUtf8(std::string& o, unsigned cp) {
        if (cp < 0x80) {
            o += static_cast<char>(cp);
        } else if (cp < 0x800) {
            o += static_cast<char>(0xC0 | (cp >> 6));
            o += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            o += static_cast<char>(0xE0 | (cp >> 12));
            o += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            o += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }

    bool string(std::string& o) {
        if (i >= t.size() || t[i] != '"') return false;
        ++i;
        while (i < t.size()) {
            char c = t[i++];
            if (c == '"') return true;
            if (c == '\\') {
                if (i >= t.size()) return false;
                char e = t[i++];
                switch (e) {
                    case '"': o += '"'; break;
                    case '\\': o += '\\'; break;
                    case '/': o += '/'; break;
                    case 'b': o += '\b'; break;
                    case 'f': o += '\f'; break;
                    case 'n': o += '\n'; break;
                    case 'r': o += '\r'; break;
                    case 't': o += '\t'; break;
                    case 'u': {
                        if (i + 4 > t.size()) return false;
                        unsigned cp = std::strtoul(t.substr(i, 4).c_str(), nullptr, 16);
                        i += 4;
                        appendUtf8(o, cp);
                        break;
                    }
                    default: return false;
                }
            } else {
                o += c;
            }
        }
        return false;
    }

    bool value(JsonValue& v) {
        ws();
        if (i >= t.size()) return false;
        char c = t[i];
        if (c == '"') {
            v.type = JsonValue::Type::String;
            return string(v.s);
        }
        if (lit("true")) { v.type = JsonValue::Type::Bool; v.b = true; return true; }
        if (lit("false")) { v.type = JsonValue::Type::Bool; v.b = false; return true; }
        if (lit("null")) { v.type = JsonValue::Type::Null; return true; }
        if (c == '-' || (c >= '0' && c <= '9')) {
            const char* start = t.c_str() + i;
            char* end = nullptr;
            v.n = std::strtod(start, &end);
            if (end == start) return false;
            i += static_cast<size_t>(end - start);
            v.type = JsonValue::Type::Number;
            return true;
        }
        return false;  // nested objects/arrays are not part of the client protocol
    }
};

}  // namespace

bool parseFlatObject(const std::string& text, FlatObject& out) {
    Parser p{text};
    p.ws();
    if (p.i >= text.size() || text[p.i] != '{') return false;
    ++p.i;
    p.ws();
    if (p.i < text.size() && text[p.i] == '}') return true;
    while (p.i < text.size()) {
        p.ws();
        std::string k;
        if (!p.string(k)) return false;
        p.ws();
        if (p.i >= text.size() || text[p.i] != ':') return false;
        ++p.i;
        JsonValue v;
        if (!p.value(v)) return false;
        out[k] = v;
        p.ws();
        if (p.i < text.size() && text[p.i] == ',') { ++p.i; continue; }
        if (p.i < text.size() && text[p.i] == '}') return true;
        return false;
    }
    return false;
}

}  // namespace efss
