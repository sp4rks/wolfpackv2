import { aircraftId, reading, record } from "../shared/protocol.ts";
import type { Telemetry } from "../shared/protocol.ts";

export const GAME_ORIGIN = "http://127.0.0.1:8111";
export const POLL_MS = 2_000;

export type FeedUpdate =
  | { status: "live"; sample: Telemetry }
  | { status: "waiting" | "denied" | "unreachable"; sample: null };

export function normalizeTelemetry(stateValue: unknown, indicatorsValue: unknown): Telemetry | null {
  const rawState = record(stateValue);
  const rawIndicators = record(indicatorsValue);
  const state = rawState?.valid === true ? rawState : null;
  const indicators = rawIndicators?.valid === true ? rawIndicators : null;

  if (indicators?.army && indicators.army !== "air") return null;
  const iasKph = reading(state?.["IAS, km/h"]);
  const altitudeM = reading(state?.["H, m"]);
  const heading = reading(indicators?.compass);
  const sample: Telemetry = {
    aircraft: aircraftId(indicators?.type),
    iasKph,
    tasKph: reading(state?.["TAS, km/h"]),
    altitudeM,
    climbMps: reading(state?.["Vy, m/s"]),
    headingDeg: heading === null ? null : (heading % 360 + 360) % 360,
    throttlePct: reading(state?.["throttle 1, %"]),
    oilTempC: reading(state?.["oil temp 1, C"]),
    waterTempC: reading(state?.["water temp 1, C"]) ?? reading(indicators?.water_temperature),
    propPitch: reading(state?.["pitch 1, deg"]),
    manifoldPressure: reading(state?.["manifold pressure 1, atm"]),
  };
  return Object.entries(sample).some(([key, value]) => key !== "aircraft" && value !== null)
    ? sample : null;
}

export async function readTelemetry(signal: AbortSignal, fetcher = fetch): Promise<Telemetry | null> {
  const options: RequestInit & { targetAddressSpace: "loopback" } = {
    signal,
    targetAddressSpace: "loopback",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  };
  const get = async (path: "/state" | "/indicators"): Promise<unknown> => {
    const response = await fetcher(GAME_ORIGIN + path, options);
    if (!response.ok) throw new Error(`War Thunder responded with HTTP ${response.status}`);
    return response.json();
  };
  const [state, indicators] = await Promise.all([get("/state"), get("/indicators")]);
  return normalizeTelemetry(state, indicators);
}

async function permissionDenied(): Promise<boolean> {
  try {
    const permission = await navigator.permissions.query({ name: "loopback-network" as PermissionName });
    return permission.state === "denied";
  } catch {
    return false;
  }
}

// The dashboard starts polling on page load and aborts it on reconnect.
export function watchTelemetry(onUpdate: (update: FeedUpdate) => void): () => void {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = true;
  const poll = async (): Promise<void> => {
    let update: FeedUpdate;
    try {
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(first ? 30_000 : 3_000)]);
      const sample = await readTelemetry(signal);
      update = sample ? { status: "live", sample } : { status: "waiting", sample: null };
    } catch {
      if (stop.signal.aborted) return;
      const denied = await permissionDenied();
      update = { status: denied ? "denied" : "unreachable", sample: null };
    }
    if (stop.signal.aborted) return;
    first = false;
    onUpdate(update);
    if (!stop.signal.aborted && update.status !== "denied") timer = setTimeout(poll, POLL_MS);
  };
  void poll();
  return () => {
    stop.abort();
    clearTimeout(timer);
  };
}
