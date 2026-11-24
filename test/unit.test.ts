import { describe, expect, test } from "bun:test";
import { normalizeTelemetry, readTelemetry } from "../src/client/telemetry.ts";
import { createRoomKey, isRoomKey, parseClientMessage } from "../src/shared/protocol.ts";
import { inviteKey, inviteUrl } from "../src/client/squad.ts";

describe("flight data", () => {
  test("normalizes only valid, allowlisted aircraft fields", () => {
    expect(normalizeTelemetry(
      { valid: true, "IAS, km/h": 200, "H, m": 1200, "pitch 1, deg": 23, "manifold pressure 1, atm": 1.2, chat: "secret" },
      { valid: true, army: "air", type: "p_51", compass: -5, enemy: 42 },
    )).toEqual({
      aircraft: "p_51", iasKph: 200, tasKph: null, altitudeM: 1200,
      climbMps: null, headingDeg: 355, throttlePct: null, oilTempC: null,
      waterTempC: null, propPitch: 23, manifoldPressure: 1.2,
    });
  });

  test("handles absent and invalid status, keys, and values", () => {
    expect(normalizeTelemetry(null, null)).toBeNull();
    expect(normalizeTelemetry({ valid: false, "IAS, km/h": 200 }, { valid: false, compass: 2 })).toBeNull();
    expect(normalizeTelemetry({ "IAS, km/h": 2 }, {})).toBeNull();
    expect(normalizeTelemetry({ valid: true, "IAS, km/h": 3 }, { valid: true, army: "tank" })).toBeNull();
    expect(normalizeTelemetry({ valid: true, "Vy, m/s": 4, "IAS, km/h": Infinity }, null)?.climbMps).toBe(4);
    expect(normalizeTelemetry(null, { valid: true, type: "air", compass: "4" })).toBeNull();
  });

  test("reads only both loopback endpoints and rejects HTTP errors", async () => {
    const calls: [string, RequestInit][] = [];
    const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
      calls.push([String(url), options!]);
      return Response.json(String(url).endsWith("/state")
        ? { valid: true, "IAS, km/h": 12 } : { valid: false });
    }) as typeof fetch;
    expect((await readTelemetry(new AbortController().signal, fetcher))?.iasKph).toBe(12);
    expect(calls.map(([url]) => url).sort()).toEqual(["http://127.0.0.1:8111/indicators", "http://127.0.0.1:8111/state"]);
    expect(calls.every(([, options]) => options.credentials === "omit" && options.mode === "cors")).toBe(true);
    await expect(readTelemetry(new AbortController().signal, (async () => new Response("", { status: 503 })) as typeof fetch)).rejects.toThrow("503");
  });
});

describe("protocol", () => {
  test("invite uses a 128-bit key only in the fragment", () => {
    const key = createRoomKey();
    expect(isRoomKey(key)).toBe(true);
    const url = inviteUrl(key, "https://example.com");
    expect(url.pathname + url.search).toBe("/");
    expect(inviteKey(url)).toBe(key);
    expect(inviteKey(new URL("https://example.com/#room=bad"))).toBeNull();
  });
  test("validates names and allowlists samples", () => {
    expect(parseClientMessage('{"type":"join","name":"  Ace  "}')).toEqual({ type: "join", name: "Ace" });
    expect(parseClientMessage('{"type":"join","name":"\\u0000"}')).toBeNull();
    expect(parseClientMessage("x".repeat(2049))).toBeNull();
    expect(parseClientMessage('{"type":"telemetry","sample":{"enemy":2}}')).toBeNull();
    expect(parseClientMessage('{"type":"telemetry","sample":{"iasKph":100,"enemy":2}}')).toEqual({
      type: "telemetry",
      sample: { aircraft: null, iasKph: 100, tasKph: null, altitudeM: null, climbMps: null, headingDeg: null, throttlePct: null, oilTempC: null, waterTempC: null, propPitch: null, manifoldPressure: null },
    });
    expect(parseClientMessage('{"type":"telemetry","sample":null}')).toEqual({ type: "telemetry", sample: null });
  });
});
