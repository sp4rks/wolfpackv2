import { nickname } from "../shared/player-stats.ts";
import type { PublicStats } from "../shared/player-stats.ts";
import { spectrum } from "./colour.ts";

export type StatsState = "pending" | "unavailable" | PublicStats;
export function statsLookup(onChange: () => void) {
  const values = new Map<string, StatsState>();
  const queue: string[] = []; let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined, generation = 0, busy = false;
  const pump = () => {
    if (busy || timer || !queue.length) return;
    busy = true; const name = queue.shift()!, token = generation;
    controller = new AbortController();
    void fetch("/api/player-stats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname: name }), credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
      .then(async response => { if (!response.ok) throw new Error("Unavailable"); return await response.json() as PublicStats; })
      .then(result => { if (token === generation) values.set(name, result); })
      .catch(() => { if (token === generation) values.set(name, "unavailable"); })
      .finally(() => { if (token !== generation) return; busy = false; onChange(); timer = setTimeout(() => { timer = undefined; pump(); }, 2000); });
  };
  return {
    add(player: string) { const name = nickname(player); if (!name || values.has(name) || values.size >= 100) return; values.set(name, "pending"); queue.push(name); pump(); },
    get(player: string) { const name = nickname(player); return name ? values.get(name) : undefined; },
    clear() { generation++; controller?.abort(); clearTimeout(timer); timer = undefined; queue.length = 0; values.clear(); busy = false; },
  };
}
// Descriptive thresholds, not percentiles: typical 1 kill/battle or 1.5 K/D.
export function statColour(value: number | null, metric: "kills" | "kd", battles: number): { color: string; label: string } | null {
  if (value === null || !Number.isFinite(value) || value < 0 || battles < 20) return null;
  const mid = metric === "kills" ? 1 : 1.5, high = metric === "kills" ? 2 : 3;
  const amount = value < mid ? Math.max(0, 1 - value / mid) : Math.min(1, (value - mid) / (high - mid));
  return { color: spectrum(value < mid ? -amount : amount), label: value < mid * .75 ? "low" : value > mid * 1.25 ? "high" : "typical" };
}

// Logarithmic, illustrative experience bands rather than population percentiles.
export function experienceColour(battles: number): { color: string; label: string } | null {
  if (!Number.isFinite(battles) || battles <= 0) return null;
  const log = Math.log(battles), middle = Math.log(300);
  const position = log < middle ? Math.max(-1, (log - middle) / (middle - Math.log(20)))
    : Math.min(1, (log - middle) / (Math.log(1500) - middle));
  return { color: spectrum(position), label: battles < 150 ? "low" : battles > 600 ? "high" : "typical" };
}
