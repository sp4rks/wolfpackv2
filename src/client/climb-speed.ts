import { spectrum } from "./colour.ts";

export type ClimbSpeeds = { normalKph: number | null; wepKph: number | null; estimatedKph?: number | null };
type ActiveLookup = { controller?: AbortController; timer?: ReturnType<typeof setTimeout> };
const valid = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

// A bounded shared cache and one in-flight lookup per active aircraft ID.
export function climbSpeedLookup(onChange: () => void) {
  const cache = new Map<string, { value: ClimbSpeeds; expires: number }>();
  const active = new Map<string, ActiveLookup>();
  function load(id: string, state: ActiveLookup, attempt: number): void {
    if (active.get(id) !== state) return;
    state.controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/climb-speed?aircraft=${encodeURIComponent(id)}`, { signal: AbortSignal.any([state.controller!.signal, AbortSignal.timeout(5000)]), credentials: "omit" });
        if (!response.ok) throw new Error("Reference unavailable");
        const body = await response.json() as Record<string, unknown>;
        if (!body || !("normalKph" in body) || !("wepKph" in body)) throw new Error("Invalid reference");
        if (active.get(id) !== state) return;
        const value = { normalKph: valid(body.normalKph), wepKph: valid(body.wepKph), estimatedKph: valid(body.estimatedKph) };
        if (!cache.has(id) && cache.size >= 100) {
          const evict = [...cache.keys()].find(key => !active.has(key)) ?? cache.keys().next().value!;
          cache.delete(evict);
        }
        const lifetime = value.normalKph || value.wepKph || value.estimatedKph ? 3600000 : 300000;
        cache.set(id, { value, expires: Date.now() + lifetime });
        state.timer = setTimeout(() => { cache.delete(id); onChange(); load(id, state, 0); }, lifetime);
        onChange();
      } catch {
        if (active.get(id) === state && attempt < 2) state.timer = setTimeout(() => load(id, state, attempt + 1), 2000 * (attempt + 1));
      }
    })();
  }
  function setActive(ids: Iterable<string | null | undefined>): void {
    const wanted = new Set([...ids].filter((id): id is string => !!id));
    for (const [id, state] of active) if (!wanted.has(id)) {
      active.delete(id); state.controller?.abort(); clearTimeout(state.timer);
    }
    for (const id of wanted) if (!active.has(id)) {
      const state: ActiveLookup = {}; active.set(id, state);
      const cached = cache.get(id);
      if (cached && cached.expires > Date.now()) {
        state.timer = setTimeout(() => { cache.delete(id); onChange(); load(id, state, 0); }, cached.expires - Date.now());
      } else { cache.delete(id); load(id, state, 0); }
    }
  }
  function get(id: string | null | undefined): ClimbSpeeds | null {
    const entry = id && active.has(id) ? cache.get(id) : undefined;
    return entry && entry.expires > Date.now() ? entry.value : null;
  }
  return { setActive, get };
}

export function iasComparison(ias: number | null, throttle: number | null, reference: ClimbSpeeds | null): { color: string; description: string } | null {
  if (ias === null || !Number.isFinite(ias) || ias < 0 || !reference) return null;
  const estimate = reference.normalKph === null && reference.wepKph === null ? reference.estimatedKph ?? null : null;
  const wep = throttle !== null && Number.isFinite(throttle) && throttle > 100 && reference.wepKph !== null;
  const target = estimate ?? (wep ? reference.wepKph : reference.normalKph);
  if (target === null || !Number.isFinite(target) || target <= 0) return null;
  const diff = ias - target;
  const amount = Math.min(1, Math.max(0, (Math.abs(diff) - 2) / Math.max(1, target * .15 - 2)));
  const deviation = Math.abs(diff) <= 2 ? "within 2 km/h of" : `${Math.abs(diff).toFixed(1)} km/h ${diff < 0 ? "below" : "above"}`;
  return { color: spectrum(diff < 0 ? -amount : amount), description: estimate !== null
    ? `${deviation} your aircraft’s estimated sea-level Vy (${target} km/h).`
    : `${deviation} your aircraft’s ${wep ? "WEP" : "100%"} Vy (${target} km/h)${!wep && throttle !== null && throttle > 100 ? "; WEP reference unavailable" : ""}.` };
}
