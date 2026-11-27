import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/deploy.sh", import.meta.url));

function run(args: string[] = [], overrides: Record<string, string> = {}, missingCurl = false) {
  const dir = mkdtempSync(join(tmpdir(), "wolfpack-deploy-"));
  const log = join(dir, "calls");
  try {
    writeFileSync(log, "");
    writeFileSync(join(dir, "bun"), `#!/bin/sh
printf '%s\\n' "bun $*" >> "$LOG"
case "$*" in
  "install --frozen-lockfile") [ "\${FAIL_INSTALL:-0}" = 0 ] ;;
  "run check") [ "\${FAIL_CHECK:-0}" = 0 ] ;;
  "run cf deploy") [ "\${FAIL_DEPLOY:-0}" = 0 ] ;;
  "run cf deploy --dry-run") [ "\${FAIL_DRY_RUN:-0}" = 0 ] ;;
esac
`);
    if (!missingCurl) writeFileSync(join(dir, "curl"), `#!/bin/sh
printf '%s\\n' "curl $*" >> "$LOG"
[ "\${FAIL_CURL:-0}" = 0 ] || exit 7
if [ "\${BODY+x}" != x ]; then BODY='{"message":"ok"}'; fi
printf '%s\\n%s' "$BODY" "\${STATUS-200}"
`);
    chmodSync(join(dir, "bun"), 0o755);
    if (!missingCurl) chmodSync(join(dir, "curl"), 0o755);
    const result = Bun.spawnSync(["/bin/sh", script, ...args], {
      env: { ...overrides, PATH: dir, LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      out: result.stdout.toString(),
      err: result.stderr.toString(),
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("deploy command", () => {
  const dryCalls = ["bun install --frozen-lockfile", "bun run check", "bun run cf deploy --dry-run"];
  const liveCalls = ["bun install --frozen-lockfile", "bun run check", "bun run cf deploy"];

  test("defaults to dry-run and accepts explicit dry-run", () => {
    for (const args of [[], ["--dry-run"]]) {
      const result = run(args);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(dryCalls);
    }
  });

  test("help and invalid arguments do no work", () => {
    expect(run(["--help"]).status).toBe(0);
    for (const args of [["--help", "--live"], ["--live", "--live"], [""], ["--force"]]) {
      const result = run(args);
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
    }
    expect(run(["--help"]).calls).toEqual([]);
  });

  test("live deploys once and performs a bounded smoke GET", () => {
    const result = run(["--live"]);
    expect(result.status).toBe(0);
    expect(result.calls.slice(0, 3)).toEqual(liveCalls);
    expect(result.calls).toHaveLength(4);
    expect(result.calls[3]).toMatch(/^curl -q -fsS --connect-timeout [1-9]\d* --max-time [1-9]\d* /);
    expect(result.calls[3]).not.toContain("--retry");
    expect(result.calls[3]).toContain("https://wolfpack.sprks.me/api/health");
  });

  test("missing curl stops live mode before any deployment work", () => {
    const result = run(["--live"], {}, true);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.err).toContain("curl is required");
    expect(run([], {}, true).calls).toEqual(dryCalls);
  });

  test("install, check, and deploy failures stop later steps", () => {
    for (const [env, calls] of [
      [{ FAIL_INSTALL: "1" }, liveCalls.slice(0, 1)],
      [{ FAIL_CHECK: "1" }, liveCalls.slice(0, 2)],
      [{ FAIL_DEPLOY: "1" }, liveCalls],
    ] as const) {
      const result = run(["--live"], env);
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual(calls);
      expect(result.err).not.toContain("smoke failed");
    }
    const dryCheckFailure = run(["--dry-run"], { FAIL_CHECK: "1" });
    expect(dryCheckFailure.status).not.toBe(0);
    expect(dryCheckFailure.calls).toEqual(dryCalls.slice(0, 2));
    const dryFailure = run([], { FAIL_DRY_RUN: "1" });
    expect(dryFailure.status).not.toBe(0);
    expect(dryFailure.calls).toEqual(dryCalls);
  });

  test("transport, HTTP, and body failures report a successful deploy and failed smoke", () => {
    for (const env of [{ FAIL_CURL: "1" }, { STATUS: "503" }, { BODY: '{"message":"bad"}' }]) {
      const result = run(["--live"], env);
      expect(result.status).not.toBe(0);
      expect(result.calls.slice(0, 3)).toEqual(liveCalls);
      expect(result.calls).toHaveLength(4);
      expect(result.err).toContain("cf deploy returned success but smoke failed");
    }
  });
});
