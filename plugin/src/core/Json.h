#pragma once
// Minimal JSON support for the EFSS protocol.
//  - JsonWriter builds objects/arrays incrementally.
//  - parseFlatObject parses a single, flat JSON object (string/number/bool/null
//    values only), which is all the app ever sends to the plugin.

#include <map>
#include <string>

namespace efss {

class JsonWriter {
public:
    JsonWriter& beginObject();
    JsonWriter& endObject();
    JsonWriter& beginArray(const char* key = nullptr);
    JsonWriter& endArray();
    JsonWriter& key(const char* k);
    JsonWriter& str(const char* k, const std::string& v);
    JsonWriter& num(const char* k, double v);
    JsonWriter& integer(const char* k, long long v);
    JsonWriter& boolean(const char* k, bool v);
    JsonWriter& null(const char* k);
    /** Appends a pre-serialised JSON value (object/array) under key k, or as an array element if k is null. */
    JsonWriter& raw(const char* k, const std::string& json);
    const std::string& text() const { return out_; }

private:
    void sep();
    void writeKey(const char* k);
    std::string out_;
    bool needComma_ = false;
};

std::string escapeJson(const std::string& s);

struct JsonValue {
    enum class Type { Null, Bool, Number, String } type = Type::Null;
    bool b = false;
    double n = 0;
    std::string s;
};

using FlatObject = std::map<std::string, JsonValue>;

/** Returns false if the text is not a flat JSON object. */
bool parseFlatObject(const std::string& text, FlatObject& out);

}  // namespace efss
