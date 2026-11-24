import type { Telemetry } from "../shared/protocol.ts";

export type Preferences = {
  player: string; squad: string; speed: "kmh" | "mph" | "kn";
  altitude: "m" | "ft"; distance: "km" | "mi" | "ft" | "yd" | "nm";
  climb: "ms" | "ftmin"; temp: "c" | "f"; showOwn: boolean;
};
export const defaults: Preferences = { player: "You", squad: "Wolf Pack", speed: "kmh", altitude: "m", distance: "km", climb: "ms", temp: "c", showOwn: true };
export const choices = { speed: ["kmh", "mph", "kn"], altitude: ["m", "ft"], distance: ["km", "mi", "ft", "yd", "nm"], climb: ["ms", "ftmin"], temp: ["c", "f"] } as const;
export function preferences(value: unknown): Preferences {
  const result = { ...defaults };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const data = value as Record<string, unknown>;
  for (const key of ["player", "squad"] as const) if (typeof data[key] === "string" && data[key].trim() && data[key].length <= 32 && !/\p{C}/u.test(data[key])) result[key] = data[key].trim();
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
    if ((choices[key] as readonly unknown[]).includes(data[key])) Object.assign(result, { [key]: data[key] });
  }
  if (typeof data.showOwn === "boolean") result.showOwn = data.showOwn;
  return result;
}
const number = (n: number, digits = 0) => new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
export const speedUnit = (p: Preferences) => ({ kmh: "km/h", mph: "mph", kn: "kn" })[p.speed];
export const altitudeUnit = (p: Preferences) => p.altitude;
export const climbUnit = (p: Preferences) => p.climb === "ms" ? "m/s" : "ft/min";
export const tempUnit = (p: Preferences) => p.temp === "c" ? "°C" : "°F";
export function speed(n: number | null, p: Preferences): string { return n === null ? "—" : number(n * ({ kmh: 1, mph: 0.621371, kn: 0.539957 })[p.speed]); }
export function altitude(n: number | null, p: Preferences): string { return n === null ? "—" : number(n * (p.altitude === "ft" ? 3.28084 : 1)); }
export function climb(n: number | null, p: Preferences): string { return n === null ? "—" : `${n > 0 ? "+" : ""}${number(n * (p.climb === "ftmin" ? 196.8504 : 1), p.climb === "ms" ? 1 : 0)}`; }
export function temperature(n: number | null, p: Preferences): string { return n === null ? "—" : number(p.temp === "f" ? n * 9 / 5 + 32 : n); }
export function bearing(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const normalized = (n % 360 + 360) % 360;
  const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return `${String(Math.round(normalized) % 360).padStart(3, "0")}° ${directions[Math.round(normalized / 22.5) % 16]}`;
}
export function climbAngle(ias: number | null, vertical: number | null): number | null {
  if (ias === null || vertical === null || !Number.isFinite(ias) || !Number.isFinite(vertical) || ias <= 0) return null;
  return Math.atan2(vertical, ias / 3.6) * 180 / Math.PI;
}
export type HistoryKey = "iasKph" | "tasKph" | "altitudeM" | "climbMps" | "throttlePct" | "waterTempC" | "oilTempC";
export const historyKeys: HistoryKey[] = ["iasKph", "tasKph", "altitudeM", "climbMps", "throttlePct", "waterTempC", "oilTempC"];
export type Histories = Record<HistoryKey, number[]>;
export function emptyHistories(): Histories { return { iasKph: [], tasKph: [], altitudeM: [], climbMps: [], throttlePct: [], waterTempC: [], oilTempC: [] }; }
export function addHistory(histories: Histories, sample: Telemetry): void {
  for (const key of historyKeys) {
    const value = sample[key];
    // Break the line when a field disappears; do not bridge an unknown interval.
    if (value === null) histories[key] = [];
    else { histories[key].push(value); if (histories[key].length > 12) histories[key].shift(); }
  }
}
