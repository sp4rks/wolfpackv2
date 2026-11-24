import { spawn } from "node:child_process";
import { createServer } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// Accept only a test-name filter, not arbitrary test flags or extra test files.
const args = process.argv.slice(2);
let pattern;
if (args.length === 2 && (args[0] === "--test-name-pattern" || args[0] === "-t")) {
  pattern = args[1];
} else if (args.length === 1 && args[0].startsWith("--test-name-pattern=")) {
  pattern = args[0].slice("--test-name-pattern=".length);
} else if (args.length !== 0) {
  console.error("Usage: bun run verify:dashboard [--test-name-pattern <non-empty regex>]");
  process.exit(2);
}
if (pattern !== undefined && !pattern.trim()) {
  console.error("The test-name pattern must not be empty.");
  process.exit(2);
}

let server;
let child;
let interrupted = false;
let interrupt;
const interruption = new Promise((_, reject) => { interrupt = reject; });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    interrupt(new Error(`Interrupted by ${signal}`));
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    interruption,
  ]).finally(() => clearTimeout(timer));
}

async function waitForHealth(origin) {
  const deadline = Date.now() + 20_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).message === "ok") return;
      lastError = `unexpected health response: HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Health check timed out at ${origin}/api/health: ${lastError}`);
}

try {
  // The same plugin as vite.config.ts, with local, ephemeral bindings and no inspector.
  // Binding port 0 directly avoids ever connecting to another process on a guessed port.
  const creating = createServer({
    configFile: false,
    plugins: [cloudflare({ persistState: false, inspectorPort: false, remoteBindings: false, types: { generate: false } })],
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  }).then(created => { server = created; return created; });
  await withTimeout(creating, 30_000, "Timed out creating the local Vite server");
  await withTimeout(server.listen(), 30_000, "Timed out starting the local Vite server");
  const address = server.httpServer?.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    throw new Error(`Unexpected server address: ${JSON.stringify(address)}`);
  }
  const origin = `http://127.0.0.1:${address.port}`;
  console.log(`Dashboard fixture server: ${origin}`);
  await withTimeout(waitForHealth(origin), 22_000, `Health check timed out at ${origin}/api/health`);
  const testArgs = ["test", "--no-orphans", "./test/browser.integration.ts"];
  if (pattern !== undefined) testArgs.push("--test-name-pattern", pattern);
  let testOutput = "";
  child = spawn("bun", testArgs, {
    stdio: ["inherit", "inherit", "pipe"],
    env: { ...process.env, TEST_ORIGIN: origin },
  });
  child.stderr.on("data", chunk => {
    process.stderr.write(chunk);
    testOutput = (testOutput + chunk.toString()).slice(-32_768);
  });
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    interruption,
  ]);
  if (result.code !== 0) {
    console.error(`Browser tests failed (${result.signal ?? `exit ${result.code}`}).`);
    process.exitCode = result.code || 1;
  } else {
    // Some Bun versions can exit successfully when no tests match. Fail closed if
    // the normal test summary is missing or reports no passing tests.
    const summary = testOutput.replace(/\x1b\[[0-9;]*m/g, "").match(/^\s*(\d+) pass(?:es)?\s*$/m);
    if (!summary || Number(summary[1]) === 0) {
      throw new Error("Bun did not report any passing browser tests; refusing a false success.");
    }
  }
} catch (error) {
  console.error(`Dashboard verification: ${error.message}`);
  if (!interrupted) process.exitCode = 1;
} finally {
  // Bound cleanup even if the dev server or a browser test becomes stuck.
  const watchdog = setTimeout(() => {
    console.error("Dashboard verification: cleanup timed out; forcing exit.");
    process.exit(process.exitCode || 1);
  }, 5000);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const exited = new Promise(resolve => child.once("exit", resolve));
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (server) await server.close().catch(error => {
    console.error(`Dashboard verification: server cleanup failed: ${error.message}`);
    process.exitCode ||= 1;
  });
  clearTimeout(watchdog);
}
// Pending startup/health work must not keep an interrupted or timed-out runner alive.
process.exit(process.exitCode || 0);
