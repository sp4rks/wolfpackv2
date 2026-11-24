import type { Telemetry } from "../shared/protocol.ts";

export const sampleOwn: Telemetry = { aircraft: "Spitfire Mk IX", iasKph: 286, tasKph: 304, altitudeM: 2450, headingDeg: 74, climbMps: 4.2, throttlePct: 87, waterTempC: 91, oilTempC: 78, propPitch: null, manifoldPressure: null };
export const sampleSquad = [
  { id: "moss", name: "Moss", sample: { ...sampleOwn, iasKph: 278, altitudeM: 2310, headingDeg: 71, climbMps: 3.8, throttlePct: 84 } },
  { id: "raven", name: "Raven", sample: { ...sampleOwn, iasKph: 301, altitudeM: 2640, headingDeg: 82, climbMps: -1.6, throttlePct: 91 }, out: true },
];
export const reports = [
  { player: "Rook", aircraft: "Bf 109 G-6", grid: "B4", altitude: 2100 as number | null, age: "24 sec", out: false, path: "M10 66 31 61 49 60 77 57 88 47 108 44 124 40 142 39 149 27 158 26 168 41 205 43 234 47 260 49 269 44 278 45 279 53 291 56 291 61 278 63 265 62 240 66 197 68 164 68 143 75 132 75 137 68 89 68 58 71 28 71 10 69Z M88 47l-10-13 6-1 20 12Z" },
  { player: "Vesper", aircraft: "Fw 190 A-5", grid: "C5", altitude: null as number | null, age: "1 min", out: false, path: "M8 65 25 62 58 60 79 57 91 48 113 44 137 43 148 30 157 29 168 43 199 45 233 47 265 49 270 43 278 44 278 52 291 56 291 61 279 63 267 62 236 67 197 69 169 69 145 76 133 76 138 69 89 70 54 72 23 71 8 68Z M90 48 81 35l6-1 18 12Z" },
  { player: "Finch", aircraft: "P-51D Mustang", grid: "D3", altitude: 1800 as number | null, age: "2 min", out: true, path: "M9 65 29 61 62 59 90 56 105 48 126 44 144 43 151 31 160 30 171 43 202 45 230 49 264 51 270 44 279 44 279 53 292 57 292 62 279 64 266 63 236 67 195 69 166 69 143 76 133 76 137 69 91 70 56 72 25 71 9 68Z M103 48 94 36l6-1 17 11Z" },
];
