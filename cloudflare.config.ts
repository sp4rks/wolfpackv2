import { bindings, defineConfig, exports as workerExports } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "wolfpack",
    compatibilityDate: "2026-11-23",
    entrypoint,
    domains: ["wolfpack.sprks.me"],
    workersDev: false,
    previewUrls: false,
    assets: { runWorkerFirst: ["/api/*"] },
    env: {
      PLAYER_STATS_LIMIT: bindings.rateLimit({ namespace: "634105714", simple: { limit: 20, period: 60 } }),
      REFERENCE: bindings.d1({ id: "366ef216-0345-47c0-a432-561f2c40e7a8", name: "wolfpack-reference" }),
      SQUADS: bindings.durableObject({ worker: "wolfpack", exportName: "SquadRoom" }),
    },
    exports: {
      SquadRoom: workerExports.durableObject({ storage: "sqlite" }),
    },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: true, headSamplingRate: 0.01 },
    },
  },
});
