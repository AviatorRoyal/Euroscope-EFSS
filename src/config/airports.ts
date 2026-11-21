// Airport reference data. In production this should be generated from the
// India vACC EuroScope sector package rather than maintained by hand.

export interface AirportConfig {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number; // ft AMSL
  depRunways: string[];
  sids: string[];
  stands: string[];
}

export const AIRPORTS: Record<string, AirportConfig> = {
  VIDP: {
    icao: "VIDP",
    name: "Delhi / Indira Gandhi Intl",
    lat: 28.5665,
    lon: 77.1031,
    elevation: 777,
    depRunways: ["28", "29R", "29L", "27", "10", "11L", "11R", "09"],
    sids: ["REBON5B", "REBON5C", "ALI5B", "ALI5C", "PEKIX5B", "SP5H", "BUTOP5B", "GUDUM5B"],
    stands: ["1", "2", "5", "8", "12", "15", "21", "28", "33", "42", "51", "54", "60", "103", "108", "214"],
  },
  VABB: {
    icao: "VABB",
    name: "Mumbai / Chhatrapati Shivaji Maharaj Intl",
    lat: 19.0887,
    lon: 72.8679,
    elevation: 39,
    depRunways: ["27", "09", "14", "32"],
    sids: ["ANDHE1A", "GUDAS1A", "LIBDI1A", "NOPAN1A", "PARAR1A"],
    stands: ["A1", "A4", "B2", "C5", "D3", "E7", "F1", "G2", "H4", "J6"],
  },
  // Reference point and elevation only; SIDs and stands come from EuroScope.
  VOBL: { icao: "VOBL", name: "Bengaluru / Kempegowda Intl", lat: 13.1979, lon: 77.7063, elevation: 3000, depRunways: ["09L", "27R", "09R", "27L"], sids: [], stands: [] },
  VOMM: { icao: "VOMM", name: "Chennai Intl", lat: 12.99, lon: 80.1693, elevation: 52, depRunways: ["07", "25", "12", "30"], sids: [], stands: [] },
  VECC: { icao: "VECC", name: "Kolkata / Netaji Subhas Chandra Bose Intl", lat: 22.6547, lon: 88.4467, elevation: 16, depRunways: ["01R", "19L", "01L", "19R"], sids: [], stands: [] },
  VOHS: { icao: "VOHS", name: "Hyderabad / Rajiv Gandhi Intl", lat: 17.2313, lon: 78.4298, elevation: 2024, depRunways: ["09L", "27R", "09R", "27L"], sids: [], stands: [] },
  VAAH: { icao: "VAAH", name: "Ahmedabad / Sardar Vallabhbhai Patel Intl", lat: 23.0772, lon: 72.6347, elevation: 189, depRunways: ["05", "23"], sids: [], stands: [] },
  VOCI: { icao: "VOCI", name: "Kochi Intl", lat: 10.152, lon: 76.4019, elevation: 30, depRunways: ["09", "27"], sids: [], stands: [] },
};

/** Airports the in-page simulator can fly (needs SIDs and stands). */
export const SIM_AIRPORTS = Object.values(AIRPORTS)
  .filter((a) => a.sids.length && a.stands.length)
  .map((a) => a.icao);

const fallbacks: Record<string, AirportConfig> = {};

/**
 * Config for any airport. Unknown airports get a placeholder with no reference
 * point: range-based rules (VFR 50 nm) are then disabled, the rest still work.
 */
export function getAirport(icao: string): AirportConfig {
  return (
    AIRPORTS[icao] ??
    (fallbacks[icao] ??= {
      icao,
      name: icao,
      lat: NaN,
      lon: NaN,
      elevation: 0,
      depRunways: [],
      sids: [],
      stands: [],
    })
  );
}
