import { describe, expect, test } from "bun:test";
import { normalizeTelemetry, readTelemetry } from "../src/client/telemetry.ts";
import { createRoomKey, isRoomKey, parseClientMessage } from "../src/shared/protocol.ts";
import { inviteKey, inviteUrl } from "../src/client/squad.ts";
import { addHistory, altitude, bearing, climb, climbAngle, defaults, emptyHistories, preferences, speed, temperature } from "../src/client/derived.ts";
import { sampleOwn } from "../src/client/sample.ts";

describe("dashboard readings and settings", () => {
  test("converts units, preserves missing readings, and validates stored preferences", () => {
    const prefs = preferences({ speed: "mph", altitude: "ft", climb: "ftmin", temp: "f", distance: "nm", player: "  Ace  " });
    expect(prefs.player).toBe("Ace");
    expect(speed(100, prefs)).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(62.1371));
    expect(altitude(100, prefs)).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(328.084));
    expect(climb(1, prefs)).toBe("+197");
    expect(temperature(100, prefs)).toBe("212");
    expect(speed(null, prefs)).toBe("—");
    expect(preferences({ speed: "invalid", player: "bad\u0000name", endpoint: "https://elsewhere" })).toEqual(defaults);
  });
  test("derives compass and meaningful IAS-based angle", () => {
    expect(bearing(null)).toBe("—");
    expect(bearing(359)).toBe("359° N");
    expect(bearing(-90)).toBe("270° W");
    expect(bearing(74)).toBe("074° ENE");
    expect(climbAngle(0, 4)).toBeNull();
    expect(climbAngle(null, 4)).toBeNull();
    expect(climbAngle(360, 10)).toBeCloseTo(5.7106, 3);
  });
  test("histories are bounded and break on missing data", () => {
    const history = emptyHistories();
    for (let i = 0; i < 20; i++) addHistory(history, { ...sampleOwn, iasKph: i });
    expect(history.iasKph).toHaveLength(12);
    expect(history.iasKph[0]).toBe(8);
    addHistory(history, { ...sampleOwn, iasKph: null });
    expect(history.iasKph).toEqual([]);
    expect("headingDeg" in history).toBe(false);
  });
});

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
