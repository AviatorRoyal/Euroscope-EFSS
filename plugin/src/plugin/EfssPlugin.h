#pragma once

#include <windows.h>

#include <map>
#include <memory>
#include <set>
#include <string>

#pragma warning(push)
#pragma warning(disable : 4100)  // unused parameters in the SDK's inline callbacks
#include "../../sdk/EuroScopePlugIn.h"
#pragma warning(pop)
#include "../core/Bridge.h"
#include "../core/WsServer.h"

namespace efss {

class EfssPlugin;

/** Invisible helper screen: gives access to EuroScope's own TAG functions. */
class HelperScreen : public EuroScopePlugIn::CRadarScreen {
public:
    explicit HelperScreen(EfssPlugin& owner) : owner_(owner) {}
    void OnAsrContentToBeClosed() override;

private:
    EfssPlugin& owner_;
};

class EfssPlugin : public EuroScopePlugIn::CPlugIn, public Backend {
public:
    EfssPlugin();
    ~EfssPlugin() override;

    // ---- EuroScope callbacks (main thread) ----
    void OnTimer(int counter) override;
    void OnRadarTargetPositionUpdate(EuroScopePlugIn::CRadarTarget rt) override;
    void OnFlightPlanDisconnect(EuroScopePlugIn::CFlightPlan fp) override;
    bool OnCompileCommand(const char* command) override;
    EuroScopePlugIn::CRadarScreen* OnRadarScreenCreated(const char* name, bool needRadar, bool geo, bool canSave,
                                                        bool canCreate) override;

    // ---- Backend ----
    Welcome welcome() override;
    void collect(std::vector<FlightRecord>& flights, std::vector<ControllerRecord>& controllers) override;
    CommandResult execute(const Command& cmd) override;

    void screenClosed(HelperScreen* s);

private:
    struct Override {
        std::string state;    // bay shown while EuroScope still reports `carrier`
        std::string carrier;  // EuroScope-derived bay when the override was made ("" = capture next tick)
    };

    std::string airport() const;
    std::string myPosition() const;
    std::string deriveState(const EuroScopePlugIn::CFlightPlan& fp, bool departure) const;
    bool setGroundState(EuroScopePlugIn::CFlightPlan& fp, const char* state);
    bool setClearance(EuroScopePlugIn::CFlightPlan& fp, bool cleared);
    bool amendSidRunway(EuroScopePlugIn::CFlightPlan& fp, const std::string* sid, const std::string* rwy);
    void message(const std::string& text, bool flash = false);

    WsServer server_;
    std::unique_ptr<Bridge> bridge_;
    std::set<HelperScreen*> screens_;
    std::string airportOverride_, positionOverride_;
    std::map<std::string, Override> overrides_;
    std::map<std::string, std::string> stands_;
    std::set<std::string> trashed_;
    int slowTicks_ = 0;
};

}  // namespace efss
