import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = "./test/verify-dashboard.mjs";
const layout = "responsive live layout";

function run(pattern: string, env: Record<string, string> = {}) {
  const child = spawn("node", [runner, "--test-name-pattern", pattern], {
    env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, output }));
  });
  return { child, result, output: () => output };
}

function origin(output: string) {
  const match = output.match(/Dashboard fixture server: (http:\/\/127\.0\.0\.1:\d+)/);
  if (!match) throw new Error(`No fixture origin in output:\n${output}`);
  return match[1];
}

async function expectClosed(url: string) {
  expect(await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })
    .then(() => false, () => true)).toBe(true);
}

test("concurrent runs use distinct loopback servers and ignore inherited TEST_ORIGIN", async () => {
  const first = run(layout, { TEST_ORIGIN: "http://127.0.0.1:1" });
  const second = run(layout, { TEST_ORIGIN: "https://invalid.example" });
  const [a, b] = await Promise.all([first.result, second.result]);
  expect([a.code, b.code]).toEqual([0, 0]);
  expect(a.output).toContain("1 pass");
  expect(b.output).toContain("1 pass");
  expect(origin(a.output)).not.toBe(origin(b.output));
  await Promise.all([expectClosed(origin(a.output)), expectClosed(origin(b.output))]);
}, 30000);

test("unmatched and failed tests return nonzero and close their servers", async () => {
  for (const [pattern, env] of [
    ["no-such-dashboard-scenario-93814", {}],
    [layout, { CHROMIUM_PATH: "/no-such-chromium" }],
  ] as const) {
    const result = await run(pattern, env).result;
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Browser tests failed");
    await expectClosed(origin(result.output));
  }
}, 30000);

test("interrupting a running test stops it and closes the server", async () => {
  const running = run("automatic game polling");
  const deadline = Date.now() + 15000;
  while (!running.output().includes("bun test") && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  const url = origin(running.output());
  expect(running.output()).toContain("bun test");
  running.child.kill("SIGTERM");
  const result = await running.result;
  expect(result.code).toBe(143);
  await expectClosed(url);
}, 30000);

test("empty patterns fail instead of running the full suite", async () => {
  const result = await run("  ").result;
  expect(result.code).toBe(2);
  expect(result.output).toContain("must not be empty");
  expect(result.output).not.toContain("Dashboard fixture server:");
}, 10000);

test("a zero-test successful Bun result is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wolfpack-runner-test-"));
  try {
    await writeFile(join(dir, "bun"), "#!/bin/sh\nprintf ' 0 pass\\n 0 fail\\n' >&2\nexit 0\n");
    await chmod(join(dir, "bun"), 0o755);
    const result = await run("no-such-scenario", { PATH: `${dir}:${process.env.PATH}` }).result;
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("refusing a false success");
    await expectClosed(origin(result.output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
