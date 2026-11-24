import { afterAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

// Run against cf dev. Every game request is intercepted: never touches port 8111.
const origin = process.env.TEST_ORIGIN ?? "http://127.0.0.1:5178";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmq0AAAAASUVORK5CYII=", "base64");
let browser: Browser | undefined;
afterAll(async () => { await browser?.close(); });
const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([s, t]) => document.querySelector(s)?.textContent?.includes(t), [selector, text], { timeout: 9000 });
const waitVisible = (page: Page, selector: string, visible: boolean) => page.waitForFunction(([s, v]) => (document.querySelector(s) as HTMLElement)?.hidden === !v, [selector, visible] as const, { timeout: 9000 });

test("responsive live layout, accessible icon controls and native map aspect", async () => {
  const instance = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  try {
    const page = await instance.newPage();
    await page.route("http://127.0.0.1:8111/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/map.img") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024"/>' });
      return route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(path === "/map_info.json" ? { map_generation: 1 } : { valid: false }) });
    });
    await page.goto(origin);
    await waitVisible(page, "#live-map", true);
    expect(await page.locator(".squad thead th").allTextContents()).toEqual(["Player", "Aircraft", "IAS", "Altitude", "Bearing", "Climb", "Throttle"]);
    expect(await page.locator(".primary-readings > div").count()).toBe(4);
    expect(await page.locator(".secondary-readings > div").count()).toBe(4);
    expect(await page.locator("#mode-toggle, #share, .connection-bar, .sample-marker").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Settings", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Reconnect game and squad" }).count()).toBe(1);
    for (const [width, height] of [[1440, 900], [1024, 768], [901, 768], [800, 600], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return {
          map: rect("#map").toJSON(), primary: rect(".instruments").toJSON(),
          support: rect(".supporting").toJSON(), chat: rect(".chat").toJSON(),
          brand: rect(".brand").toJSON(), title: rect(".mast-title h1").toJSON(),
          settings: rect("#open-settings").toJSON(), reconnect: rect("#reconnect").toJSON(), ias: getComputedStyle(document.querySelector('[data-value="ias"]')!).fontSize,
        };
      });
      expect(layout.settings.width).toBe(44); expect(layout.settings.height).toBe(44);
      expect(layout.reconnect.width).toBe(44); expect(layout.reconnect.height).toBe(44);
      expect(layout.settings.right).toBeLessThanOrEqual(layout.reconnect.left);
      expect(layout.title.right).toBeLessThanOrEqual(layout.settings.left);
      expect(layout.reconnect.right).toBeLessThanOrEqual(width);
      if (width >= 701 && width > height) {
        expect(layout.primary.left).toBeGreaterThan(layout.map.right - 1);
        expect(layout.chat.left).toBeGreaterThan(layout.map.right - 1);
      } else {
        expect(layout.primary.bottom).toBeLessThanOrEqual(layout.map.top);
        expect(layout.support.top).toBeGreaterThanOrEqual(layout.map.bottom);
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
    const ratio = await page.locator("#live-map").evaluate(el => { const r = el.getBoundingClientRect(); return r.width / r.height; });
    expect(ratio).toBeCloseTo(2, 2);
  } finally { await instance.close(); }
}, 30000);

test("automatic game polling, reconnect and squad publishing remain independent", async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const pilot = await context.newPage();
  const viewer = await context.newPage();
  const requests: Array<{ page: Page; path: string }> = [];
  let generation: number | null = null;
  let instrumentValid = true;
  let aircraft: string | undefined = "p_51";
  let imageError = false;
  let stalled = false;
  const stalledPaths = new Set<string>();
  const releaseStalls: Array<() => void> = [];
  await context.route("http://127.0.0.1:8111/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    requests.push({ page: req.frame().page(), path });
    if (stalled && req.frame().page() === pilot && path !== "/map.img") {
      stalledPaths.add(path);
      await new Promise<void>(resolve => releaseStalls.push(resolve));
      try { await route.abort(); } catch { /* The browser may already have timed out. */ }
      return;
    }
    if (path === "/map.img") {
      if (imageError) await route.fulfill({ status: 503, body: "unavailable" });
      else await route.fulfill({ status: 200, contentType: "image/png", body: image }); // deliberately no CORS header
      return;
    }
    const body = path === "/map_info.json" ? generation === null ? { valid: false } : { map_generation: String(generation) }
      : path === "/state" ? { valid: instrumentValid && req.frame().page() === pilot, "IAS, km/h": 321, "H, m": 1000 }
      : path === "/indicators" ? { valid: instrumentValid && req.frame().page() === pilot, army: "air", type: aircraft, compass: 90 }
      : path === "/gamechat" ? []
      : null;
    await route.fulfill({ status: body ? 200 : 404, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  await pilot.goto(origin);
  await viewer.goto(origin);
  await waitText(pilot, "#feed-status", "Connected to local game instruments");
  expect(await pilot.locator("#squad-rows td").getAttribute("colspan")).toBe("7");
  expect(await pilot.locator("#feed-status").textContent()).toContain("p_51 · recent history");
  expect(await pilot.locator("#instrument-subtitle").count()).toBe(0);
  const unchangedAnnouncements = await pilot.evaluate(() => new Promise<number>(resolve => {
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.length; });
    for (const selector of ["#feed-status", "#publish-status"]) observer.observe(document.querySelector(selector)!, { childList: true, characterData: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(changes); }, 2300);
  }));
  expect(unchangedAnnouncements).toBe(0);
  await waitText(viewer, "#feed-status", "aircraft instruments are unavailable");
  expect(requests.some(r => r.page === viewer && r.path === "/state")).toBe(true);
  await pilot.locator("#open-settings").click();
  expect(await pilot.locator('[name="shareInstruments"]').isChecked()).toBe(true);
  await pilot.locator('[name="shareInstruments"]').uncheck();
  await pilot.locator("#cancel-settings").click();
  await pilot.locator("#open-settings").click();
  expect(await pilot.locator('[name="shareInstruments"]').isChecked()).toBe(true);
  await pilot.locator("#cancel-settings").click();

  // Game works without a room, and no map image is requested for invalid metadata.
  await waitText(pilot, "#feed-status", "Connected to local game instruments");
  await waitText(pilot, "#map-status", "waiting for a valid map");
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("321");
  expect(requests.some(r => r.path === "/map.img")).toBe(false);
  expect(requests.some(r => r.path === "/map_obj.json")).toBe(false);

  generation = 7;
  await waitVisible(pilot, "#live-map", true);
  expect(await pilot.locator("#live-map").getAttribute("src")).toBe("http://127.0.0.1:8111/map.img?gen=7");
  expect(await pilot.locator("#live-map").getAttribute("crossorigin")).toBeNull();
  expect(await pilot.locator("#live-map").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  generation = 8;
  await pilot.waitForFunction(() => (document.querySelector("#live-map") as HTMLImageElement).src.endsWith("?gen=8"));
  await waitVisible(pilot, "#live-map", true);

  // A viewer must explicitly join, even when the invite is open.
  await pilot.locator("#enter").click();
  await waitText(pilot, "#squad-status", "Connected.");
  const invite = await pilot.locator("#invite").getAttribute("href");
  expect(invite).toContain("#room=");
  await pilot.locator("#copy-invite").click();
  expect(await pilot.evaluate(() => navigator.clipboard.readText())).toBe(invite);
  await waitText(pilot, "#squad-status", "Invite copied");
  await viewer.goto(invite!);
  expect(await viewer.locator("#squad-status").textContent()).toContain("Not connected");
  await viewer.locator("#reconnect").click();
  expect(await viewer.locator("#squad-status").textContent()).toContain("Not connected");
  await viewer.locator("#enter").click();
  await waitText(viewer, "#squad-status", "Connected.");
  await waitText(viewer, "#squad-rows", "321 km/h");
  const remoteAircraft = viewer.locator("#squad-rows tr").filter({ hasNotText: "(you)" }).locator('td[data-label="Aircraft"]');
  const viewerAircraft = viewer.locator("#squad-rows tr").filter({ hasText: "(you)" }).locator('td[data-label="Aircraft"]');
  const ownAircraft = pilot.locator("#squad-rows tr").filter({ hasText: "(you)" }).locator('td[data-label="Aircraft"]');
  expect(await remoteAircraft.textContent()).toBe("p_51");
  expect(await viewerAircraft.textContent()).toBe("—");
  expect(await ownAircraft.textContent()).toBe("p_51");
  await pilot.locator("#show-own").uncheck();
  expect(await ownAircraft.count()).toBe(0);
  expect(await remoteAircraft.textContent()).toBe("p_51");
  await pilot.locator("#show-own").check();
  expect(await ownAircraft.textContent()).toBe("p_51");

  // A missing model is independent of the other readings, and updates propagate.
  aircraft = undefined;
  await remoteAircraft.getByText("—", { exact: true }).waitFor();
  expect(await viewer.locator("#squad-rows").textContent()).toContain("321 km/h");
  aircraft = "long_aircraft_model_".repeat(5);
  await remoteAircraft.getByText(aircraft, { exact: true }).waitFor();
  for (const [width, height] of [[901, 768], [390, 844]]) {
    await viewer.setViewportSize({ width, height });
    await viewer.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await remoteAircraft.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (width === 390) {
      expect(await remoteAircraft.evaluate(el => getComputedStyle(el).display)).toBe("flex");
      expect(await remoteAircraft.evaluate(el => getComputedStyle(el, "::before").content)).toBe('"Aircraft"');
    }
    await viewer.evaluate(() => { document.documentElement.style.fontSize = ""; });
  }
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
  await pilot.locator("#show-own").uncheck();
  expect(await ownAircraft.count()).toBe(0);
  expect(await remoteAircraft.textContent()).toBe("—");
  await pilot.locator("#show-own").check();
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
  releaseStalls.splice(0).forEach(release => release());
  await pilot.evaluate(() => { delete (performance as Performance & { now?: () => number }).now; });
  await pilot.locator("#reconnect").click();
  await waitVisible(pilot, "#live-map", true);
  await waitText(viewer, "#squad-rows", "321 km/h");

  // Reconnect clears current readings, history and map before new requests finish.
  stalledPaths.clear(); stalled = true;
  while (!stalledPaths.has("/state") || !stalledPaths.has("/map_info.json")) await pilot.waitForTimeout(50);
  await pilot.locator("#reconnect").click();
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("—");
  expect(await pilot.locator('[data-trace="ias"] svg').count()).toBe(0);
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  stalled = false;
  releaseStalls.splice(0).forEach(release => release());
  await pilot.locator("#reconnect").click();
  await waitText(pilot, "#feed-status", "Connected to local game instruments");
  await waitText(pilot, "#squad-status", "Connected.");
  await waitText(viewer, "#squad-rows", "321 km/h");

  await pilot.locator("#leave").click();
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("321");
  expect(await pilot.locator("#live-map").isVisible()).toBe(true);
  await pilot.locator("#enter").click();
  await waitText(viewer, "#squad-rows", "321 km/h");
  // Reconnect restarts both while preserving the same private room.
  const count = requests.filter(r => r.page === pilot && r.path === "/state").length;
  await pilot.locator("#reconnect").click();
  await waitText(pilot, "#squad-status", "Connected.");
  expect(await pilot.locator("#invite").getAttribute("href")).toBe(invite);
  expect(requests.filter(r => r.page === pilot && r.path === "/state").length).toBeGreaterThan(count);
  await waitText(viewer, "#squad-rows", "321 km/h");
  await pilot.locator("#leave").click();
  await pilot.locator("#reconnect").click();
  await waitText(pilot, "#feed-status", "Connected to local game instruments");
  expect(await pilot.locator("#squad-status").textContent()).toContain("Disconnected");
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  expect(requests.every(r => ["/state", "/indicators", "/map_info.json", "/map.img", "/gamechat"].includes(r.path))).toBe(true);
}, 90000);

test("chat is local, incremental and recovers without inventing sightings", async () => {
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
    if (path === "/gamechat" && stallChat && req.frame().page() === pilot) {
      chatStalled = true;
      await new Promise(resolve => setTimeout(resolve, 2500));
      try { await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify([{ id: 999, msg: "Attack Stale(Plane)!", sender: "Scout", enemy: false }]) }); } catch { /* stopped request */ }
      return;
    }
    const body = path === "/gamechat" ? req.frame().page() === viewer ? [] : [...buffer.filter(m => m.id > Number(url.searchParams.get("lastId"))), ...buffer.filter(m => m.id === Number(url.searchParams.get("lastId")))]
      : path === "/map_info.json" ? generation === null ? { valid: false } : { valid: true, map_generation: generation }
      : path === "/state" ? { valid: true, "IAS, km/h": 100 }
      : path === "/indicators" ? { valid: true, army: "air", type: "plane" } : null;
    await route.fulfill({ status: body ? 200 : 404, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  await pilot.goto(origin); await viewer.goto(origin);
  await pilot.locator("#enter").click(); await waitText(pilot, "#squad-status", "Connected.");
  await viewer.goto((await pilot.locator("#invite").getAttribute("href"))!); await viewer.locator("#enter").click(); await waitText(viewer, "#squad-status", "Connected.");
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
  expect(requests.some(r => r.page === viewer)).toBe(true);
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
  buffer.push({ id: 5, msg: "Attack BeforeRefresh(Plane)!", sender: "Scout", enemy: false, mode: "Team" });
  await waitText(pilot, "#sighting-rows", "BeforeRefresh");
  stallChat = true;
  while (!chatStalled) await pilot.waitForTimeout(50);
  stallChat = false;
  await pilot.locator("#reconnect").click();
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
  await pilot.waitForTimeout(2700);
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
  expect(await pilot.locator("#chat-list").textContent()).not.toContain("Stale");
  await waitText(pilot, "#chat-list", "NoMap");
  expect(requests.every(r => ["/state", "/indicators", "/map_info.json", "/map.img", "/gamechat"].includes(r.path))).toBe(true);
  await context.close();
}, 90000);

test("game retries transient errors and permission denial requires reconnect", async () => {
  browser ??= await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let failing = true, stateRequests = 0;
  await page.addInitScript(() => {
    Object.defineProperty(navigator.permissions, "query", { value: async () => ({ state: (window as any).denied ? "denied" : "prompt" }) });
  });
  await page.route("http://127.0.0.1:8111/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/state") stateRequests++;
    if (failing) return void await route.fulfill({ status: 503, headers: { "Access-Control-Allow-Origin": "*" } });
    const body = path === "/state" ? { valid: true, "IAS, km/h": 123 }
      : path === "/indicators" ? { valid: false } : path === "/gamechat" ? [] : { valid: false };
    await route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  await page.goto(origin);
  await waitText(page, "#feed-status", "retrying");
  failing = false;
  await waitText(page, "#feed-status", "Connected to local game instruments");
  expect(stateRequests).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => { (window as any).denied = true; });
  failing = true;
  await waitText(page, "#feed-status", "Loopback access denied");
  expect(await page.locator("#map-status").textContent()).toContain("loopback access denied");
  expect(await page.locator("#feed-status").textContent()).toContain("site settings");
  expect(await page.locator("#feed-status").textContent()).toContain("Reconnect");
  const deniedCount = stateRequests;
  await page.waitForTimeout(2200);
  expect(stateRequests).toBe(deniedCount);
  failing = false;
  await page.evaluate(() => { (window as any).denied = false; });
  await page.locator("#reconnect").click();
  await waitText(page, "#feed-status", "Connected to local game instruments");
  expect(await page.locator('[data-value="ias"]').textContent()).toBe("123");
  await context.close();
}, 30000);

test("reconnect preserves a requested room through joining or failure and ignores old sockets", async () => {
  browser ??= await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      bufferedAmount = 0;
      constructor(public url: string, public protocols: string[]) {
        super();
        if (String(url).includes("/api/squad")) ((window as any).sockets ??= []).push(this);
      }
      send() {}
      close() { this.readyState = 3; }
    }
    (window as any).WebSocket = FakeSocket;
  });
  await page.route("http://127.0.0.1:8111/**", async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(path === "/gamechat" ? [] : { valid: false }) });
  });
  await page.goto(`${origin}/#room=0123456789abcdef0123456789abcdef`);
  await waitText(page, "#enter", "Join squad");
  await page.evaluate(() => { location.hash = ""; });
  await waitText(page, "#enter", "Create squad");
  await page.locator("#reconnect").click();
  expect(await page.evaluate(() => ((window as any).sockets ?? []).length)).toBe(0);
  await page.locator("#enter").click();
  expect(await page.locator("#squad-status").textContent()).toContain("Connecting");
  await page.locator("#reconnect").click();
  expect(await page.evaluate(() => (window as any).sockets.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).sockets[0].protocols[1] === (window as any).sockets[1].protocols[1])).toBe(true);
  await page.evaluate(() => {
    const sockets = (window as any).sockets;
    const welcome = JSON.stringify({ type: "welcome", selfId: "old", members: [{ id: "old", name: "Stale member", sample: null }] });
    sockets[0].dispatchEvent(new MessageEvent("message", { data: welcome }));
    sockets[0].dispatchEvent(new Event("close"));
  });
  expect(await page.locator("#squad-status").textContent()).toContain("Connecting");
  expect(await page.locator("#squad-rows").textContent()).not.toContain("Stale member");
  await page.evaluate(() => (window as any).sockets[1].dispatchEvent(new Event("close")));
  expect(await page.locator("#squad-status").textContent()).toContain("disconnected");
  await page.locator("#reconnect").click();
  expect(await page.evaluate(() => (window as any).sockets.length)).toBe(3);
  expect(await page.evaluate(() => (window as any).sockets[1].protocols[1] === (window as any).sockets[2].protocols[1])).toBe(true);
  await page.evaluate(() => {
    const socket = (window as any).sockets[2];
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "welcome", selfId: "new", members: [{ id: "new", name: "Pilot", sample: null }] }) }));
  });
  await waitText(page, "#squad-status", "Connected.");
  await page.locator("#leave").click();
  await page.locator("#reconnect").click();
  expect(await page.evaluate(() => (window as any).sockets.length)).toBe(3);
  await page.locator("#enter").click();
  expect(await page.evaluate(() => (window as any).sockets[3].protocols[1] === (window as any).sockets[2].protocols[1])).toBe(true);
  await context.close();
}, 30000);
