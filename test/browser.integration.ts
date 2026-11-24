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
    expect(await page.locator(".squad thead th").allTextContents()).toEqual(["Player", "Aircraft", "IAS", "Altitude", "Bearing", "Climb", "Throttle"]);
    expect(await page.locator('#squad-rows td[data-label="Aircraft"]').allTextContents()).toEqual(["Spitfire Mk IX", "P-51D Mustang", "Bf 109 G-6"]);
    await page.locator("#show-own").uncheck();
    expect(await page.locator('#squad-rows td[data-label="Aircraft"]').allTextContents()).toEqual(["P-51D Mustang", "Bf 109 G-6"]);
    await page.locator("#show-own").check();
    expect(await page.locator(".primary-readings > div").count()).toBe(4);
    expect(await page.locator(".secondary-readings > div").count()).toBe(4);
    await page.locator('.map-marker[data-report="0"]').focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    expect(await page.locator("#selected-grid").textContent()).toBe("C5");
    for (const [width, height] of [[1440, 900], [1024, 768], [901, 768], [800, 600], [768, 1024], [390, 844]]) {
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
      if (width === 390) {
        const aircraft = page.locator('#squad-rows td[data-label="Aircraft"]').first();
        expect(await aircraft.evaluate(el => getComputedStyle(el).display)).toBe("flex");
        expect(await aircraft.evaluate(el => getComputedStyle(el, "::before").content)).toBe('"Aircraft"');
      }
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
      const squadBounds = await page.evaluate(() => {
        const panel = document.querySelector(".squad")!.getBoundingClientRect();
        const table = document.querySelector(".squad table")!.getBoundingClientRect();
        return { panelLeft: panel.left, panelRight: panel.right, tableLeft: table.left, tableRight: table.right };
      });
      expect(squadBounds.tableLeft).toBeGreaterThanOrEqual(squadBounds.panelLeft - 1);
      expect(squadBounds.tableRight).toBeLessThanOrEqual(squadBounds.panelRight + 1);
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
  let aircraft: string | undefined = "p_51";
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
      : path === "/indicators" ? { valid: instrumentValid, army: "air", type: aircraft, compass: 90 }
      : path === "/gamechat" ? []
      : null;
    await route.fulfill({ status: body ? 200 : 404, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  await pilot.goto(origin);
  await viewer.goto(origin);
  expect(await pilot.locator("#squad-rows td").getAttribute("colspan")).toBe("7");
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
  const remoteAircraft = viewer.locator("#squad-rows tr").filter({ hasNotText: "(you)" }).locator('td[data-label="Aircraft"]');
  const viewerAircraft = viewer.locator("#squad-rows tr").filter({ hasText: "(you)" }).locator('td[data-label="Aircraft"]');
  const ownAircraft = pilot.locator("#squad-rows tr").filter({ hasText: "(you)" }).locator('td[data-label="Aircraft"]');
  expect(await remoteAircraft.textContent()).toBe("p_51");
  expect(await viewerAircraft.textContent()).toBe("—");
  expect(await ownAircraft.textContent()).toBe("p_51");

  // A missing model is independent of the other readings, and updates propagate.
  aircraft = undefined;
  await remoteAircraft.getByText("—", { exact: true }).waitFor();
  expect(await viewer.locator("#squad-rows").textContent()).toContain("321 km/h");
  aircraft = "long_aircraft_model_".repeat(5);
  await remoteAircraft.getByText(aircraft, { exact: true }).waitFor();
  await viewer.setViewportSize({ width: 390, height: 844 });
  await viewer.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
  expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await remoteAircraft.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await viewer.evaluate(() => { document.documentElement.style.fontSize = ""; });
  await viewer.setViewportSize({ width: 1280, height: 720 });
  aircraft = "p_51";
  await remoteAircraft.getByText("p_51", { exact: true }).waitFor();

  // Save off sends a clear, while local instruments and map remain.
  await pilot.locator("#open-settings").click();
  await pilot.locator('[name="shareInstruments"]').uncheck();
  await pilot.locator('#settings-form button[type="submit"]').click();
  await pilot.waitForFunction(() => JSON.parse(localStorage.getItem("wolfpack-v2-preferences")!).shareInstruments === false);
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  expect(await remoteAircraft.textContent()).toBe("—");
  expect(await ownAircraft.textContent()).toBe("p_51");
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
  expect(requests.every(r => ["/state", "/indicators", "/map_info.json", "/map.img", "/gamechat"].includes(r.path))).toBe(true);
}, 90000);

test("chat is opt-in, local, incremental and recovers without inventing sightings", async () => {
  browser ??= await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext();
  const pilot = await context.newPage(), viewer = await context.newPage();
  let generation: number | null = 1, failChat = false, failMap = false, stallChat = false, chatStalled = false;
  let buffer = [{ id: 10, msg: "Attack Old(P-40)!", sender: "Old scout", enemy: false, mode: "Team" }];
  const requests: Array<{ page: Page; path: string; cursor: string | null }> = [];
  const sent: string[] = [];
  pilot.on("websocket", ws => ws.on("framesent", frame => sent.push(String(frame.payload))));
  await context.route("http://127.0.0.1:8111/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    requests.push({ page: req.frame().page(), path, cursor: url.searchParams.get("lastId") });
    if (path === "/map.img") return void await route.fulfill({ status: 200, contentType: "image/png", body: image });
    if ((path === "/gamechat" && failChat) || (path === "/map_info.json" && failMap)) return void await route.fulfill({ status: 503, headers: { "Access-Control-Allow-Origin": "*" }, body: "unavailable" });
    if (path === "/gamechat" && stallChat) {
      chatStalled = true;
      await new Promise(resolve => setTimeout(resolve, 2500));
      try { await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify([{ id: 999, msg: "Attack Stale(Plane)!", sender: "Scout", enemy: false }]) }); } catch { /* stopped request */ }
      return;
    }
    const body = path === "/gamechat" ? [...buffer.filter(m => m.id > Number(url.searchParams.get("lastId"))), ...buffer.filter(m => m.id === Number(url.searchParams.get("lastId")))]
      : path === "/map_info.json" ? generation === null ? { valid: false } : { valid: true, map_generation: generation }
      : path === "/state" ? { valid: true, "IAS, km/h": 100 }
      : path === "/indicators" ? { valid: true, army: "air", type: "plane" } : null;
    await route.fulfill({ status: body ? 200 : 404, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  await pilot.goto(origin); await viewer.goto(origin);
  await pilot.locator("#mode-toggle").click();
  await pilot.locator('#sighting-rows button[data-report="1"]').click();
  expect(await pilot.locator(".aircraft").isVisible()).toBe(true);
  await pilot.locator("#mode-toggle").click();
  expect(await pilot.locator(".aircraft").isVisible()).toBe(false);
  await pilot.locator("#enter").click(); await waitText(pilot, "#squad-status", "Connected.");
  await viewer.goto((await pilot.locator("#invite").getAttribute("href"))!); await viewer.locator("#enter").click(); await waitText(viewer, "#squad-status", "Connected.");
  expect(requests.length).toBe(0);
  await pilot.locator("#share").click();
  await waitText(pilot, "#chat-list", "Old(P-40)");
  expect(await pilot.locator("#chat-list time").first().textContent()).toBe("—");
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
  await waitText(pilot, "#sighting-empty", "Waiting for a new English named target callout");
  expect(requests.find(r => r.path === "/gamechat")?.cursor).toBe("0");
  buffer.push({ id: 11, msg: "<img src=x onerror=alert(1)> hello", sender: "<Scout>", enemy: false, mode: "Team" },
    { id: 12, msg: "Engaging with Canniballistic(P-40F)! <color=@red>[D4, alt. 4 200 m]</color>", sender: "Scout", enemy: false, mode: "Team" },
    { id: 13, msg: "Destroy =V3PER= *BlazingTiger552(F4U)!", sender: "Wing", enemy: false, mode: "Team" },
    { id: 14, msg: "Attention to the designated grid square! [F7]", sender: "Wing", enemy: false, mode: "Team" },
    { id: 15, msg: "Attack Enemy(Plane)!", sender: "Enemy", enemy: true, mode: "All" });
  await waitText(pilot, "#sighting-rows", "BlazingTiger552");
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(2);
  expect(await pilot.locator("#chat-list img").count()).toBe(0);
  expect(await pilot.locator("#chat-list").textContent()).toContain("<img src=x onerror=alert(1)>");
  expect(await pilot.locator("#chat-list").textContent()).toContain("<Scout>");
  expect(await pilot.locator("#chat-list").textContent()).toContain("[D4, alt. 4 200 m]");
  expect(await pilot.locator("#chat-list").textContent()).not.toContain("<color");
  expect(await pilot.locator("#chat-list").getAttribute("tabindex")).toBe("0");
  expect(requests.some(r => r.path === "/gamechat" && r.cursor === "10")).toBe(true);
  await pilot.getByRole("button", { name: "Canniballistic" }).click();
  expect(await pilot.locator(".aircraft").isVisible()).toBe(false);
  expect(await pilot.locator("#selected-grid").textContent()).toBe("D4");
  expect(await pilot.locator("#selected-reporter").textContent()).toContain("Scout");
  await pilot.getByRole("button", { name: "Canniballistic" }).focus();
  await pilot.waitForTimeout(1200);
  expect(await pilot.evaluate(() => (document.activeElement as HTMLElement)?.textContent)).toBe("Canniballistic");
  buffer.push({ id: 16, msg: "Attack Canniballistic(P-51)! <color=red>[B4, alt. 2,100 ft]</color>", sender: "Wing", enemy: false, mode: "Team" });
  await waitText(pilot, "#selected-aircraft", "P-51");
  expect(await pilot.locator("#selected-grid").textContent()).toBe("B4");
  expect(await pilot.locator("#selected-reporter").textContent()).toContain("Wing");
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(2);
  expect(await viewer.locator("#chat-list").textContent()).not.toContain("Canniballistic");
  expect(sent.join(" ")).not.toContain("Canniballistic");
  expect(requests.some(r => r.page === viewer)).toBe(false);
  failMap = true; failChat = true;
  await waitText(pilot, "#chat-subtitle", "retrying");
  await waitText(pilot, "#map-status", "Retrying");
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(2);
  failMap = false; failChat = false;
  await waitText(pilot, "#chat-subtitle", "initial history is undated");
  expect(requests.filter(r => r.path === "/gamechat" && r.cursor === "0").length).toBeGreaterThanOrEqual(2);
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(2);
  failChat = true; await waitText(pilot, "#chat-subtitle", "retrying");
  buffer = [{ id: 1, msg: "Attack Previous(Plane)!", sender: "Scout", enemy: false, mode: "Team" }];
  failChat = false;
  await waitText(pilot, "#chat-list", "Previous(Plane)");
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
  expect(await pilot.locator("#chat-list time").first().textContent()).toBe("—");
  buffer.push({ id: 2, msg: "Attack Fresh(Plane)!", sender: "Scout", enemy: false, mode: "Team" });
  await waitText(pilot, "#sighting-rows", "Fresh");
  generation = null;
  await waitText(pilot, "#map-status", "waiting for a valid map");
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
  buffer.push({ id: 3, msg: "Attack NoMap(Plane)!", sender: "Scout", enemy: false, mode: "Team" });
  await waitText(pilot, "#sighting-rows", "NoMap");
  generation = 2;
  await pilot.waitForFunction(() => (document.querySelector("#live-map") as HTMLImageElement).src.endsWith("?gen=2"));
  buffer.push({ id: 4, msg: "Attack Next(Plane)!", sender: "Scout", enemy: false, mode: "Team" });
  await waitText(pilot, "#sighting-rows", "Next");
  generation = 3;
  await pilot.waitForFunction(() => (document.querySelector("#live-map") as HTMLImageElement).src.endsWith("?gen=3"));
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
  stallChat = true;
  while (!chatStalled) await pilot.waitForTimeout(50);
  await pilot.locator("#share").click();
  await pilot.waitForTimeout(2700);
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
  expect(await pilot.locator("#chat-list").textContent()).toContain("disconnected");
  expect(await pilot.locator("#chat-list").textContent()).not.toContain("Stale");
  stallChat = false;
  await pilot.locator("#share").click(); await waitText(pilot, "#chat-list", "NoMap");
  await pilot.locator("#mode-toggle").click();
  const count = requests.length;
  await pilot.waitForTimeout(2300);
  expect(requests.length).toBe(count);
  await pilot.locator("#mode-toggle").click();
  expect(await pilot.locator("#chat-list").textContent()).toContain("disconnected");
  expect(requests.every(r => ["/state", "/indicators", "/map_info.json", "/map.img", "/gamechat"].includes(r.path))).toBe(true);
  await context.close();
}, 90000);
