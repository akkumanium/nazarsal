import OpeningHours from "opening_hours";
import type { OpeningState, Poi } from "@/lib/types";

// opening_hours uses local Date getters. All city calculations use Astana's zone.
process.env.TZ = "Asia/Almaty";
const parsers = new Map<string, OpeningHours | null>();
function parser(poi: Pick<Poi, "openingHours" | "point">): OpeningHours | null {
  const rule = poi.openingHours;
  if (!rule || /\b(PH|SH)\b/.test(rule)) return null; // No verified Kazakhstan holiday calendar.
  const key = `${rule}:${poi.point.lat.toFixed(3)}:${poi.point.lon.toFixed(3)}`;
  if (parsers.has(key)) return parsers.get(key)!;
  try {
    const instance = new OpeningHours(rule, { lat: poi.point.lat, lon: poi.point.lon, address: { country_code: "kz", state: "Astana" } });
    if (parsers.size > 1000) parsers.clear();
    parsers.set(key, instance); return instance;
  } catch { parsers.set(key, null); return null; }
}
export function openingState(poi: Pick<Poi, "openingHours" | "point">, from: Date, to: Date): OpeningState {
  const oh = parser(poi);
  if (!oh || to <= from) return "unknown";
  try {
    const [open, unknown] = oh.getOpenDuration(from, to);
    if (unknown > 0) return "unknown";
    return open >= to.getTime() - from.getTime() - 1 ? "open_by_schedule" : "closed_by_schedule";
  } catch { return "unknown"; }
}
export function canOpenDuring(poi: Pick<Poi, "openingHours" | "point">, from: Date, to: Date): boolean {
  const oh = parser(poi);
  if (!oh) return true;
  try { const [open, unknown] = oh.getOpenDuration(from, to); return open + unknown > 0; } catch { return true; }
}
