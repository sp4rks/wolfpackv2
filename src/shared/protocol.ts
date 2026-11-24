export const SOCKET_PATH = "/api/squad";
export const SOCKET_PROTOCOL = "wolfpack.v1";
export const SAMPLE_LIFETIME_MS = 12_000;

const readings = [
  "iasKph", "tasKph", "altitudeM", "climbMps", "headingDeg", "throttlePct",
  "oilTempC", "waterTempC", "propPitch", "manifoldPressure",
] as const;

export type Telemetry = Record<typeof readings[number], number | null> & {
  aircraft: string | null;
};

export type Member = {
  id: string;
  name: string;
  sample: Telemetry | null;
};

export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "telemetry"; sample: Telemetry | null };

export type ServerMessage =
  | { type: "welcome"; selfId: string; members: Member[] }
  | { type: "member"; member: Member }
  | { type: "left"; id: string };

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function reading(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000
    ? value
    : null;
}

export function aircraftId(value: unknown): string | null {
  return typeof value === "string" && /^[\w-]{1,100}$/.test(value) ? value : null;
}

export function displayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 32 && !/\p{C}/u.test(name) ? name : null;
}

export function isRoomKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function createRoomKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 2048) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const message = record(value);
  if (message?.type === "join") {
    const name = displayName(message.name);
    return name ? { type: "join", name } : null;
  }
  if (message?.type !== "telemetry") return null;
  if (message.sample === null) return { type: "telemetry", sample: null };
  const values = record(message.sample);
  if (!values) return null;

  const sample = { aircraft: aircraftId(values.aircraft) } as Telemetry;
  let hasReading = false;
  for (const key of readings) {
    sample[key] = reading(values[key]);
    hasReading ||= sample[key] !== null;
  }
  if (!hasReading) return null;
  return { type: "telemetry", sample };
}
