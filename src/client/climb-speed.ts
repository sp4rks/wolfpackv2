import { spectrum } from "./colour.ts";

export type ClimbSpeeds = { normalKph: number | null; wepKph: number | null };
const valid = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

// Cache only successful reference lookups. Aircraft IDs are the only data sent.
export function climbSpeedLookup(onChange: (value: ClimbSpeeds | null) => void) {
  const cache = new Map<string, { value: ClimbSpeeds; expires: number }>();
  let current: string | null = null, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  function set(aircraft: string | null): void {
    if (aircraft === current) return;
    current = aircraft; version++; controller?.abort(); clearTimeout(timer); onChange(null);
    if (!aircraft) return;
    const cached = cache.get(aircraft);
    if (cached && cached.expires > Date.now()) { onChange(cached.value); return; }
    const token = version;
    const load = async (attempt: number): Promise<void> => {
      controller = new AbortController();
      try {
        const response = await fetch(`/api/climb-speed?aircraft=${encodeURIComponent(aircraft)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), credentials: "omit" });
        if (!response.ok) throw new Error("Reference unavailable");
        const body = await response.json() as Record<string, unknown>;
        if (!body || !("normalKph" in body) || !("wepKph" in body)) throw new Error("Invalid reference");
        if (version !== token) return;
        const value = { normalKph: valid(body.normalKph), wepKph: valid(body.wepKph) };
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(aircraft, { value, expires: Date.now() + (value.normalKph || value.wepKph ? 3600000 : 300000) });
        onChange(value);
      } catch {
        if (version === token && attempt < 2) timer = setTimeout(() => void load(attempt + 1), 2000 * (attempt + 1));
      }
    };
    void load(0);
  }
  return { set };
}

export function iasComparison(ias: number | null, throttle: number | null, reference: ClimbSpeeds | null): { color: string; description: string } | null {
  if (ias === null || !Number.isFinite(ias) || ias < 0 || !reference) return null;
  const wep = throttle !== null && Number.isFinite(throttle) && throttle > 100 && reference.wepKph !== null;
  const target = wep ? reference.wepKph : reference.normalKph;
  if (target === null || !Number.isFinite(target) || target <= 0) return null;
  const diff = ias - target;
  const amount = Math.min(1, Math.max(0, (Math.abs(diff) - 2) / Math.max(1, target * .15 - 2)));
  const deviation = Math.abs(diff) <= 2 ? "within 2 km/h of" : `${Math.abs(diff).toFixed(1)} km/h ${diff < 0 ? "below" : "above"}`;
  return { color: spectrum(diff < 0 ? -amount : amount), description: `${deviation} your aircraft’s ${wep ? "WEP" : "100%"} Vy (${target} km/h)${!wep && throttle !== null && throttle > 100 ? "; WEP reference unavailable" : ""}.` };
}
