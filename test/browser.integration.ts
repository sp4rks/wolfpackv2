import { afterAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

// Run against cf dev. Every game request is intercepted: never touches port 8111.
const origin = process.env.TEST_ORIGIN ?? "http://127.0.0.1:5178";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmq0AAAAASUVORK5CYII=", "base64");
let browser: Browser | undefined;
afterAll(async () => { await browser?.close(); });
const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([s, t]) => document.querySelector(s)?.textContent?.includes(t), [selector, text], { timeout: 9000 });
const waitVisible = (page: Page, selector: string, visible: boolean) => page.waitForFunction(([s, v]) => (document.querySelector(s) as HTMLElement)?.hidden === !v, [selector, visible] as const, { timeout: 9000 });

test("readability layout, keyboard selection and native map aspect", async () => {
  const instance = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  try {
    const page = await instance.newPage();
    await page.route("http://127.0.0.1:8111/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/map.img") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024"/>' });
      return route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(path === "/map_info.json" ? { map_generation: 1 } : { valid: false }) });
    });
    await page.goto(origin);
    await page.locator("#mode-toggle").click();
    expect(await page.locator(".primary-readings > div").count()).toBe(4);
    expect(await page.locator(".secondary-readings > div").count()).toBe(4);
    await page.locator('.map-marker[data-report="0"]').focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    expect(await page.locator("#selected-grid").textContent()).toBe("C5");
    for (const [width, height] of [[1440, 900], [1024, 768], [800, 600], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return {
          map: rect("#map").toJSON(), report: rect("#selected-report").toJSON(),
          legend: rect("#map-legend").toJSON(), primary: rect(".instruments").toJSON(),
          support: rect(".supporting").toJSON(), chat: rect(".chat").toJSON(),
          brand: rect(".brand").toJSON(), title: rect(".mast-title h1").toJSON(),
          settings: rect("#open-settings").toJSON(), ias: getComputedStyle(document.querySelector('[data-value="ias"]')!).fontSize,
        };
      });
      expect(layout.report.top).toBeGreaterThanOrEqual(layout.map.bottom - 1);
      expect(layout.legend.top).toBeGreaterThanOrEqual(layout.report.bottom - 1);
      if (width >= 701 && width > height) {
        expect(layout.primary.left).toBeGreaterThan(layout.map.right - 1);
        expect(layout.chat.left).toBeGreaterThan(layout.map.right - 1);
      } else {
        expect(layout.primary.bottom).toBeLessThanOrEqual(layout.map.top);
        expect(layout.support.top).toBeGreaterThanOrEqual(layout.legend.bottom);
      }
      if (width === 1440) {
        expect(layout.ias).toBe("52px");
        expect(layout.brand.right).toBeLessThan(layout.title.left);
        expect(layout.title.right).toBeLessThan(layout.settings.left);
      }
      await page.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#mode-toggle").click();
    await page.locator("#share").click();
    await waitVisible(page, "#live-map", true);
    const ratio = await page.locator("#live-map").evaluate(el => { const r = el.getBoundingClientRect(); return r.width / r.height; });
    expect(ratio).toBeCloseTo(2, 2);
    expect(await page.locator(".map-art").isVisible()).toBe(false);
    expect(await page.locator(".sample-marker:visible").count()).toBe(0);
  } finally { await instance.close(); }
}, 30000);

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
