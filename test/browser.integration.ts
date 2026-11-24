import { afterAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

// Run against cf dev. Every game request is intercepted: never touches port 8111.
const origin = process.env.TEST_ORIGIN ?? "http://127.0.0.1:5178";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmq0AAAAASUVORK5CYII=", "base64");
let browser: Browser | undefined;
afterAll(async () => { await browser?.close(); });
const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([s, t]) => document.querySelector(s)?.textContent?.includes(t), [selector, text], { timeout: 9000 });
const waitVisible = (page: Page, selector: string, visible: boolean) => page.waitForFunction(([s, v]) => (document.querySelector(s) as HTMLElement)?.hidden === !v, [selector, visible] as const, { timeout: 9000 });

test("local map and default publishing stay separate, opt-in and isolated", async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext();
  const pilot = await context.newPage();
  const viewer = await context.newPage();
  const requests: Array<{ page: Page; path: string }> = [];
  let generation: number | null = null;
  let instrumentValid = true;
  let imageError = false;
  let stalled = false;
  const stalledPaths = new Set<string>();
  await context.route("http://127.0.0.1:8111/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    requests.push({ page: req.frame().page(), path });
    if (stalled && path !== "/map.img") {
      stalledPaths.add(path);
      await new Promise(resolve => setTimeout(resolve, 4500));
      try { await route.abort(); } catch { /* The browser may already have timed out. */ }
      return;
    }
    if (path === "/map.img") {
      if (imageError) await route.fulfill({ status: 503, body: "unavailable" });
      else await route.fulfill({ status: 200, contentType: "image/png", body: image }); // deliberately no CORS header
      return;
    }
    const body = path === "/map_info.json" ? generation === null ? { valid: false } : { map_generation: String(generation) }
      : path === "/state" ? { valid: instrumentValid, "IAS, km/h": 321, "H, m": 1000 }
      : path === "/indicators" ? { valid: instrumentValid, army: "air", type: "p_51", compass: 90 }
      : null;
    await route.fulfill({ status: body ? 200 : 404, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  await pilot.goto(origin);
  await viewer.goto(origin);
  expect(requests).toHaveLength(0);
  expect(await pilot.locator("#share").textContent()).toBe("Connect game");
  await pilot.locator("#open-settings").click();
  expect(await pilot.locator('[name="shareInstruments"]').isChecked()).toBe(true);
  await pilot.locator('[name="shareInstruments"]').uncheck();
  await pilot.locator("#cancel-settings").click();
  await pilot.locator("#open-settings").click();
  expect(await pilot.locator('[name="shareInstruments"]').isChecked()).toBe(true);
  await pilot.locator("#cancel-settings").click();
  expect(requests).toHaveLength(0);

  // Game works without a room, and no map image is requested for invalid metadata.
  await pilot.locator("#share").click();
  await waitText(pilot, "#feed-status", "Connected to local game instruments");
  await waitText(pilot, "#map-status", "waiting for a valid map");
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("321");
  expect(requests.some(r => r.path === "/map.img")).toBe(false);
  expect(requests.some(r => r.page === viewer)).toBe(false);
  expect(requests.some(r => r.path === "/map_obj.json")).toBe(false);

  generation = 7;
  await waitVisible(pilot, "#live-map", true);
  expect(await pilot.locator("#live-map").getAttribute("src")).toBe("http://127.0.0.1:8111/map.img?gen=7");
  expect(await pilot.locator("#live-map").getAttribute("crossorigin")).toBeNull();
  expect(await pilot.locator("#live-map").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  expect(await pilot.locator(".map-art").isVisible()).toBe(false);
  expect(await pilot.locator(".sample-marker:visible").count()).toBe(0);
  generation = 8;
  await pilot.waitForFunction(() => (document.querySelector("#live-map") as HTMLImageElement).src.endsWith("?gen=8"));
  await waitVisible(pilot, "#live-map", true);

  // A viewer joins the real local Durable Object without polling the game.
  await pilot.locator("#enter").click();
  await waitText(pilot, "#squad-status", "Connected.");
  const invite = await pilot.locator("#invite").getAttribute("href");
  expect(invite).toContain("#room=");
  await viewer.goto(invite!);
  await viewer.locator("#enter").click();
  await waitText(viewer, "#squad-status", "Connected.");
  await waitText(viewer, "#squad-rows", "321 km/h");
  expect(requests.some(r => r.page === viewer)).toBe(false);

  // Save off sends a clear, while local instruments and map remain.
  await pilot.locator("#open-settings").click();
  await pilot.locator('[name="shareInstruments"]').uncheck();
  await pilot.locator('#settings-form button[type="submit"]').click();
  await pilot.waitForFunction(() => JSON.parse(localStorage.getItem("wolfpack-v2-preferences")!).shareInstruments === false);
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("321");
  expect(await pilot.locator("#live-map").isVisible()).toBe(true);
  await pilot.locator("#open-settings").click();
  await pilot.locator('[name="shareInstruments"]').check();
  await pilot.locator('#settings-form button[type="submit"]').click();
  await waitText(viewer, "#squad-rows", "321 km/h");

  // Invalid data clears, image error has no stale map, and generation recovers.
  instrumentValid = false; generation = null;
  await waitText(pilot, "#map-status", "waiting for a valid map");
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  imageError = true; generation = 9;
  await waitText(pilot, "#map-status", "Could not load");
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  imageError = false; generation = 10; instrumentValid = true;
  await waitVisible(pilot, "#live-map", true);
  await waitText(viewer, "#squad-rows", "321 km/h");

  // Freeze fixture responses and advance the page's monotonic clock to exercise expiry.
  stalled = true;
  while (!stalledPaths.has("/map_info.json") || !stalledPaths.has("/state")) await pilot.waitForTimeout(50);
  await pilot.evaluate(() => {
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, "now", { configurable: true, value: () => now() + 20_000 });
  });
  await waitText(pilot, "#feed-status", "Readings are stale");
  await waitText(pilot, "#map-status", "Game map is stale");
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("—");
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  stalled = false;
  await pilot.evaluate(() => { delete (performance as Performance & { now?: () => number }).now; });
  await waitVisible(pilot, "#live-map", true);
  await waitText(viewer, "#squad-rows", "321 km/h");

  await pilot.locator("#leave").click();
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("321");
  expect(await pilot.locator("#live-map").isVisible()).toBe(true);
  await pilot.locator("#enter").click();
  await waitText(viewer, "#squad-rows", "321 km/h");
  // Enter sample while actively connected; neither the game nor the room resumes.
  await pilot.locator("#mode-toggle").click();
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  const count = requests.length;
  await pilot.waitForTimeout(2200);
  await pilot.locator("#mode-toggle").click();
  await pilot.waitForTimeout(2200);
  expect(requests.length).toBe(count);
  expect(await pilot.locator("#share").textContent()).toBe("Connect game");
  // The reverse order (room first, game second) also publishes.
  await pilot.locator("#enter").click();
  await waitText(pilot, "#squad-status", "Connected.");
  await pilot.locator("#share").click();
  await waitText(viewer, "#squad-rows", "321 km/h");
  await pilot.locator("#share").click();
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("—");
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  expect(requests.every(r => ["/state", "/indicators", "/map_info.json", "/map.img"].includes(r.path))).toBe(true);
}, 90000);
