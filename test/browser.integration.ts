import { afterAll, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// Run against cf dev. Every game request is intercepted: never touches port 8111.
const origin = process.env.TEST_ORIGIN ?? "http://127.0.0.1:5178";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmq0AAAAASUVORK5CYII=", "base64");
let browser: Browser | undefined;
afterAll(async () => { await browser?.close(); });
const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([s, t]) => document.querySelector(s)?.textContent?.includes(t), [selector, text], { timeout: 9000 });
const waitVisible = (page: Page, selector: string, visible: boolean) => page.waitForFunction(([s, v]) => (document.querySelector(s) as HTMLElement)?.hidden === !v, [selector, visible] as const, { timeout: 9000 });
const openSquad = async (page: Page) => {
  if (!await page.locator("#squad-popover").evaluate(el => el.matches(":popover-open"))) await page.locator("#open-squad").click();
};
const referenceFixtures = (context: BrowserContext) => context.route("**/api/climb-speed?**", route => route.fulfill({ json: { normalKph: null, wepKph: null } }));

test("squad sidebar popover is bounded, dismissible, and saves only its own preferences", async () => {
  const instance = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  try {
    const page = await instance.newPage();
    await referenceFixtures(page.context());
    await page.route("http://127.0.0.1:8111/**", route => route.fulfill({ json: { valid: false }, headers: { "Access-Control-Allow-Origin": "*" } }));
    await page.goto(origin);
    expect(await page.locator(".squad > *").evaluateAll(els => els.map(el => el.className))).toEqual(["section-head", "table-wrap"]);
    expect(await page.locator(".squad .section-head").innerText()).toContain("Squad");
    expect(await page.locator(".sidebar #squad-popover #enter, .sidebar #squad-popover #leave, .sidebar #squad-popover #invite, .sidebar #squad-popover #copy-invite, .sidebar #squad-popover #squad-status, .sidebar #squad-popover #publish-status, .sidebar #squad-popover .awards, .sidebar #squad-form").count()).toBe(8);
    expect(await page.locator("#squad-popover").getAttribute("role")).toBe("region");
    expect(await page.locator("#publish-status").textContent()).toBe("Sharing starts when the game and squad are connected.");
    expect(await page.locator("#settings-form [name=squad], #settings-form [name=shareInstruments]").count()).toBe(0);
    expect(await page.locator("#settings-form [name=player], #settings-form [name=playerStats], #settings-form [name=speed]").count()).toBe(3);
    for (const [width, height] of [[1440, 900], [320, 640], [640, 320]]) {
      await page.setViewportSize({ width, height });
      await openSquad(page);
      expect(await page.locator(".sidebar").getByRole("region", { name: "Squad" }).count()).toBe(1);
      const bounds = await page.locator("#squad-popover").boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
      expect(await page.locator("#squad-popover").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (width === 320) {
        const fit = await page.evaluate(() => {
          const popover = document.querySelector("#squad-popover")!.getBoundingClientRect();
          const sharing = document.querySelector("#squad-form .sharing-preference")!.getBoundingClientRect();
          const save = document.querySelector("#squad-form button")!.getBoundingClientRect();
          const help = document.querySelector("#sharing-help")!.getBoundingClientRect();
          return { popoverBottom: popover.bottom, sharingBottom: sharing.bottom, saveBottom: save.bottom, helpWidth: help.width, sharingWidth: sharing.width };
        });
        expect(fit.sharingBottom).toBeLessThanOrEqual(fit.popoverBottom);
        expect(fit.saveBottom).toBeLessThanOrEqual(fit.popoverBottom);
        expect(fit.helpWidth).toBe(fit.sharingWidth);
      }
      if (process.env.SQUAD_SCREENSHOTS && width !== 640) await page.screenshot({ path: `${process.env.SQUAD_SCREENSHOTS}/squad-${width}.png` });
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.querySelector("#squad-popover")!.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      expect(await page.locator("#squad-popover").evaluate(el => el.matches(":popover-open"))).toBe(false);
      expect(await page.locator("#open-squad").evaluate(el => document.activeElement === el)).toBe(true);
      if (process.env.SQUAD_SCREENSHOTS && width !== 640) await page.screenshot({ path: `${process.env.SQUAD_SCREENSHOTS}/squad-closed-${width}.png` });
      if (width === 320) {
        await openSquad(page);
        await page.getByRole("button", { name: "Close squad" }).focus();
        await page.keyboard.press("Enter");
        expect(await page.locator("#squad-popover").evaluate(el => el.matches(":popover-open"))).toBe(false);
        expect(await page.locator("#open-squad").evaluate(el => document.activeElement === el)).toBe(true);
        await openSquad(page);
        await page.getByRole("button", { name: "Save squad preferences" }).focus();
        await page.keyboard.press("Enter");
        expect(await page.locator("#squad-popover").evaluate(el => el.matches(":popover-open"))).toBe(false);
        expect(await page.locator("#open-squad").evaluate(el => document.activeElement === el)).toBe(true);
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator("#open-settings").click();
    await page.locator('[name=player]').fill("Pilot");
    await page.locator('[name=playerStats]').uncheck();
    await page.locator('#settings-form button[type=submit]').click();
    await openSquad(page);
    await page.locator('#squad-form [name=squad]').fill("Discarded");
    await page.locator('#squad-form [name=shareInstruments]').uncheck();
    await page.keyboard.press("Escape");
    await openSquad(page);
    expect(await page.locator('#squad-form [name=squad]').inputValue()).toBe("Wolf Pack");
    expect(await page.locator('#squad-form [name=shareInstruments]').isChecked()).toBe(true);
    await page.locator('#squad-form [name=shareInstruments]').uncheck();
    await page.locator('#squad-form [name=squad]').fill("   ");
    await page.locator('#squad-form button[type=submit]').click();
    expect(await page.locator('#squad-form [name=squad]').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
    await page.locator('#squad-form [name=squad]').fill("Wing");
    await page.locator('#squad-form button[type=submit]').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-v2-preferences")!))).toMatchObject({ player: "Pilot", playerStats: false, squad: "Wing", shareInstruments: false });
    expect(await page.locator("#publish-status").textContent()).toBe("Instrument sharing is off.");
    await page.locator("#open-settings").click();
    await page.locator('[name=player]').fill("Pilot two");
    await page.locator('#settings-form button[type=submit]').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-v2-preferences")!))).toMatchObject({ player: "Pilot two", playerStats: false, squad: "Wing", shareInstruments: false });
    await openSquad(page);
    await page.locator('#squad-form [name=squad]').fill("Dismissed");
    await page.locator("#main").click({ position: { x: 5, y: 5 } });
    expect(await page.locator("#squad-popover").evaluate(el => el.matches(":popover-open"))).toBe(false);
    await openSquad(page);
    expect(await page.locator('#squad-form [name=squad]').inputValue()).toBe("Wing");
  } finally { await instance.close(); }
}, 30000);

test("responsive live layout, accessible icon controls and native map aspect", async () => {
  const instance = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  try {
    const page = await instance.newPage();
    await referenceFixtures(page.context());
    await page.route("http://127.0.0.1:8111/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/map.img") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024"/>' });
      return route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(path === "/map_info.json" ? { map_generation: 1 } : { valid: false }) });
    });
    await page.goto(origin);
    await waitVisible(page, "#live-map", true);
    expect(await page.locator(".squad thead th").allTextContents()).toEqual(["Player", "Aircraft", "Vy 100%", "Vy WEP", "IAS", "Altitude", "Bearing", "Climb", "Throttle"]);
    expect(await page.locator(".instrument-readings > div").count()).toBe(8);
    expect(await page.locator(".trace").count()).toBe(7);
    expect(await page.locator("#show-own, #mode-toggle, #share, .connection-bar, .sample-marker").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Settings", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Reconnect game and squad" }).count()).toBe(1);
    expect(await page.locator(".connection-dot").count()).toBe(2);
    for (const [width, height] of [[1440, 900], [1024, 768], [901, 768], [800, 600], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return { map: rect("#map").toJSON(), instruments: rect(".instruments").toJSON(), sightings: rect(".sightings").toJSON(), squad: rect(".squad").toJSON(), chat: rect(".chat").toJSON(), sidebar: rect(".sidebar").toJSON(), mark: rect(".brand img").toJSON(), ias: getComputedStyle(document.querySelector('[data-value="ias"]')!).fontSize };
      });
      expect(layout.sidebar.width).toBe(width <= 700 ? 78 : width <= 1100 ? 102 : 132);
      expect(layout.mark.width).toBe(width <= 700 ? 45 : 52.5);
      expect(layout.squad.bottom).toBeLessThanOrEqual(layout.sightings.top);
      expect(layout.sightings.bottom).toBeLessThanOrEqual(layout.map.top);
      expect(layout.chat.top).toBeGreaterThanOrEqual(layout.instruments.bottom);
      if (width >= 701 && width > height) {
        expect(layout.instruments.left).toBeGreaterThan(layout.map.right - 1);
        expect(layout.chat.left).toBeGreaterThan(layout.map.right - 1);
      } else expect(layout.instruments.top).toBeGreaterThanOrEqual(layout.map.bottom);
      expect(layout.ias).toBe(width <= 700 ? "32px" : "40px");
      if (width === 1440) expect(await page.locator(".squad table").evaluate(el => getComputedStyle(el).display)).toBe("table");
      if (width === 1024 || width === 390) expect(await page.locator(".squad table").evaluate(el => getComputedStyle(el).display)).toBe("block");
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

test("local map aircraft contacts are anonymous, current, generation-bound and independent of radio reports", async () => {
  const instance = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await instance.newContext();
  try {
    await referenceFixtures(context);
    const pilot = await context.newPage(), viewer = await context.newPage();
    const calls: Array<{ page: Page; path: string }> = [];
    let generation: number | null = null;
    let failObjects = false;
    let holdObjects = false;
    let releaseObjects: (() => void) | undefined;
    let notifyHeld: (() => void) | undefined;
    let held = new Promise<void>(resolve => { notifyHeld = resolve; });
    const chat: Array<{ id: number; msg: string; sender: string; enemy: boolean; mode: string }> = [];
    const initialObjects = [
      { type: "aircraft", icon: "Player", color: "#24D921", x: .25, y: .75 },
      { type: "aircraft", icon: "Fighter", "color[]": [24, 90, 255], x: .75, y: .25 },
      { type: "aircraft", icon: "Fighter", color: "#fa3200", x: .5, y: .6 },
      { type: "ground_model", color: "#fa3200", x: .5, y: .5 },
    ];
    let objects: unknown = initialObjects;
    await context.addInitScript(() => localStorage.setItem("wolfpack-v2-preferences", JSON.stringify({ playerStats: false })));
    await context.route("http://127.0.0.1:8111/**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname, page = req.frame().page();
      calls.push({ page, path });
      if (path === "/map.img") return void await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"/>' });
      if (path === "/map_obj.json" && holdObjects) {
        const snapshot = objects;
        notifyHeld?.();
        await new Promise<void>(resolve => { releaseObjects = resolve; });
        try { await route.fulfill({ json: snapshot, headers: { "Access-Control-Allow-Origin": "*" } }); } catch { /* aborted on reconnect */ }
        return;
      }
      if (path === "/map_obj.json" && failObjects) return void await route.fulfill({ status: 503, headers: { "Access-Control-Allow-Origin": "*" } });
      const body = path === "/map_info.json" ? page === viewer || generation === null ? { valid: false } : { map_generation: generation }
        : path === "/map_obj.json" ? objects : path === "/gamechat" ? chat : { valid: false };
      await route.fulfill({ json: body, headers: { "Access-Control-Allow-Origin": "*" } });
    });
    await pilot.goto(origin); await viewer.goto(origin);
    await waitText(pilot, "#map-status", "waiting for a valid map");
    expect(calls.some(call => call.path === "/map_obj.json")).toBe(false);
    holdObjects = true; generation = 1;
    await held;
    await waitVisible(pilot, "#live-map", true);
    expect(await pilot.locator(".live-contact").count()).toBe(0);
    holdObjects = false; releaseObjects!();
    await waitText(pilot, "#contacts-status", "1 ownship · 1 friendly · 1 enemy");
    expect(await pilot.locator(".live-contact").count()).toBe(3);
    expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
    expect(calls.some(call => call.page === viewer && call.path === "/map_obj.json")).toBe(false);
    await waitText(pilot, "#chat-list", "No messages received.");
    chat.push({ id: 1, msg: "Attack RadioTarget(Plane)! [D4, alt. 4 200 m]", sender: "Scout", enemy: false, mode: "Team" });
    await waitText(pilot, "#sighting-rows", "RadioTarget");
    expect(await pilot.locator("#selected-player").textContent()).toBe("RadioTarget");
    expect(await pilot.locator("#selected-grid").textContent()).toBe("D4");
    for (const [width, height] of [[1440, 900], [800, 600], [390, 844]]) {
      await pilot.setViewportSize({ width, height });
      const position = await pilot.evaluate(() => {
        const image = document.querySelector("#live-map")!.getBoundingClientRect();
        const marker = document.querySelector(".live-contact.friendly")!.getBoundingClientRect();
        const map = document.querySelector("#map")!.getBoundingClientRect();
        return { x: (marker.left + marker.width / 2 - image.left) / image.width, y: (marker.top + marker.height / 2 - image.top) / image.height, ratio: image.width / image.height, width: image.width / map.width };
      });
      expect(position.ratio).toBeCloseTo(2, 2);
      expect(position.width).toBeCloseTo(1, 2);
      expect(position.x).toBeCloseTo(.75, 2); expect(position.y).toBeCloseTo(.25, 2);
    }
    objects = [{ type: "aircraft", icon: "Fighter", color: "#fa3200", x: .6, y: .4 }];
    await pilot.waitForFunction(() => (document.querySelector(".live-contact.enemy") as HTMLElement | null)?.style.left === "60%");
    expect(await pilot.locator(".live-contact").count()).toBe(1);
    objects = [];
    await waitText(pilot, "#contacts-status", "No recognized aircraft");
    expect(await pilot.locator(".live-contact").count()).toBe(0);
    failObjects = true;
    await waitText(pilot, "#contacts-status", "feed unavailable");
    expect(await pilot.locator("#live-map").isVisible()).toBe(true);
    expect(await pilot.locator("#selected-player").textContent()).toBe("RadioTarget");
    expect(await pilot.locator("#sighting-rows tr").count()).toBe(1);
    failObjects = false; objects = initialObjects;
    await waitText(pilot, "#contacts-status", "1 ownship · 1 friendly · 1 enemy");
    // A response started on one map must never populate another generation.
    holdObjects = true; releaseObjects = undefined;
    held = new Promise<void>(resolve => { notifyHeld = resolve; });
    await held;
    generation = 2; objects = [];
    holdObjects = false; releaseObjects!();
    await pilot.waitForFunction(() => (document.querySelector("#live-map") as HTMLImageElement).src.endsWith("?gen=2"));
    expect(await pilot.locator(".live-contact").count()).toBe(0);
    expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
    await waitText(pilot, "#contacts-status", "No recognized aircraft");
    objects = initialObjects;
    await waitText(pilot, "#contacts-status", "1 ownship · 1 friendly · 1 enemy");
    // Cancellation cannot publish a held old response after reconnect.
    holdObjects = true; releaseObjects = undefined;
    held = new Promise<void>(resolve => { notifyHeld = resolve; });
    await held;
    generation = null;
    await pilot.locator("#reconnect").click();
    expect(await pilot.locator(".live-contact").count()).toBe(0);
    holdObjects = false; releaseObjects!();
    await waitText(pilot, "#map-status", "waiting for a valid map");
    expect(await pilot.locator(".live-contact").count()).toBe(0);
  } finally { await context.close(); await instance.close(); }
}, 60000);

test("automatic game polling, reconnect and squad publishing remain independent", async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext();
  await referenceFixtures(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await context.addInitScript(() => {
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = descriptor => descriptor.name === ("loopback-network" as PermissionName)
      ? Promise.resolve({ state: "prompt" } as PermissionStatus) : query(descriptor);
  });
  const pilot = await context.newPage();
  const viewer = await context.newPage();
  const requests: Array<{ page: Page; path: string }> = [];
  let generation: number | null = null;
  let instrumentValid = true;
  let aircraft: string | undefined = "p-51_mk1a_usaaf";
  let imageError = false;
  let stalled = false;
  const chat: Array<{ id: number; msg: string; sender: string; enemy: boolean }> = [];
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
      : path === "/map_obj.json" ? req.frame().page() === pilot ? [{ type: "aircraft", icon: "Fighter", color: "#fa3200", x: .5, y: .5 }] : []
      : path === "/state" ? { valid: instrumentValid && req.frame().page() === pilot, "IAS, km/h": 321, "H, m": 1000 }
      : path === "/indicators" ? { valid: instrumentValid && req.frame().page() === pilot, army: "air", type: aircraft, compass: 90 }
      : path === "/gamechat" ? chat
      : null;
    await route.fulfill({ status: body ? 200 : 404, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  await pilot.goto(origin);
  await viewer.goto(origin);
  await waitText(pilot, "#feed-status", "Connected to local game instruments");
  expect(await pilot.locator("#feed-status").isVisible()).toBe(false);
  expect(await pilot.locator("#squad-rows tr").count()).toBe(1);
  expect(await pilot.locator("#squad-rows").textContent()).toContain("(you)");
  expect(await pilot.locator("#feed-status").textContent()).toContain("p-51_mk1a_usaaf · recent history");
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
  await openSquad(pilot);
  expect(await pilot.locator('[name="shareInstruments"]').isChecked()).toBe(true);
  await pilot.locator('[name="shareInstruments"]').uncheck();
  await pilot.keyboard.press("Escape");
  await openSquad(pilot);
  expect(await pilot.locator('[name="shareInstruments"]').isChecked()).toBe(true);
  await pilot.keyboard.press("Escape");

  // Game works without a room, and no map image is requested for invalid metadata.
  await waitText(pilot, "#feed-status", "Connected to local game instruments");
  await waitText(pilot, "#map-status", "waiting for a valid map");
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("321");
  expect(requests.some(r => r.path === "/map.img")).toBe(false);
  expect(requests.some(r => r.path === "/map_obj.json")).toBe(false);

  generation = 7;
  await waitVisible(pilot, "#live-map", true);
  await waitText(pilot, "#contacts-status", "1 enemy");
  expect(await pilot.locator("#live-map").getAttribute("src")).toBe("http://127.0.0.1:8111/map.img?gen=7");
  expect(await pilot.locator("#live-map").getAttribute("crossorigin")).toBeNull();
  expect(await pilot.locator("#live-map").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  generation = 8;
  await pilot.waitForFunction(() => (document.querySelector("#live-map") as HTMLImageElement).src.endsWith("?gen=8"));
  await waitVisible(pilot, "#live-map", true);

  // A viewer must explicitly join, even when the invite is open.
  await openSquad(pilot); await pilot.locator("#enter").click();
  await waitText(pilot, "#squad-status", "Connected.");
  await waitText(pilot, "#publish-status", "Sharing your flight instruments with the squad.");
  const invite = await pilot.locator("#invite").getAttribute("href");
  expect(invite).toContain("#room=");
  await openSquad(pilot); await pilot.locator("#copy-invite").click();
  expect(await pilot.evaluate(() => navigator.clipboard.readText())).toBe(invite);
  await waitText(pilot, "#squad-status", "Invite copied");
  await viewer.goto(invite!);
  expect(await viewer.locator("#squad-status").textContent()).toContain("Not connected");
  expect(await viewer.locator("#open-squad").innerText()).toBe("Join squad");
  await viewer.locator("#reconnect").click();
  expect(await viewer.locator("#squad-status").textContent()).toContain("Not connected");
  await openSquad(viewer); await viewer.locator("#enter").click();
  await waitText(viewer, "#squad-status", "Connected.");
  await waitText(viewer, "#squad-rows", "321 km/h");
  expect(await viewer.locator(".live-contact").count()).toBe(0);
  const remoteAircraft = viewer.locator("#squad-rows tr").filter({ hasNotText: "(you)" }).locator('td[data-label="Aircraft"]');
  const viewerAircraft = viewer.locator("#squad-rows tr").filter({ hasText: "(you)" }).locator('td[data-label="Aircraft"]');
  const ownAircraft = pilot.locator("#squad-rows tr").filter({ hasText: "(you)" }).locator('td[data-label="Aircraft"]');
  expect(await remoteAircraft.textContent()).toBe("p-51_mk1a_usaaf");
  expect(await viewerAircraft.textContent()).toBe("—");
  expect(await ownAircraft.textContent()).toBe("p-51_mk1a_usaaf");
  expect(await pilot.locator("#show-own").count()).toBe(0);

  // A missing model is independent of the other readings, and updates propagate.
  aircraft = undefined;
  await remoteAircraft.getByText("—", { exact: true }).waitFor();
  expect(await viewer.locator("#squad-rows").textContent()).toContain("321 km/h");
  aircraft = "long_aircraft_model_".repeat(5);
  await remoteAircraft.getByText(aircraft, { exact: true }).waitFor();
  for (const [width, height] of [[1440, 900], [1024, 768], [901, 768], [390, 844]]) {
    await viewer.setViewportSize({ width, height });
    if (width === 1440) {
      expect(await viewer.locator(".squad table").evaluate(el => getComputedStyle(el).display)).toBe("table");
      expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await remoteAircraft.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
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
  aircraft = "p-51_mk1a_usaaf";
  await remoteAircraft.getByText("p-51_mk1a_usaaf", { exact: true }).waitFor();

  // Save off sends a clear, while local instruments and map remain.
  await openSquad(pilot);
  await pilot.locator('[name="shareInstruments"]').uncheck();
  await pilot.locator('#squad-form button[type="submit"]').click();
  await pilot.waitForFunction(() => JSON.parse(localStorage.getItem("wolfpack-v2-preferences")!).shareInstruments === false);
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  expect(await remoteAircraft.textContent()).toBe("—");
  expect(await ownAircraft.textContent()).toBe("p-51_mk1a_usaaf");
  expect(await ownAircraft.textContent()).toBe("p-51_mk1a_usaaf");
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("321");
  expect(await pilot.locator("#live-map").isVisible()).toBe(true);
  await openSquad(pilot);
  await pilot.locator('[name="shareInstruments"]').check();
  await pilot.locator('#squad-form button[type="submit"]').click();
  await waitText(viewer, "#squad-rows", "321 km/h");

  // Invalid data clears, image error has no stale map, and generation recovers.
  instrumentValid = false; generation = null;
  await waitText(pilot, "#map-status", "waiting for a valid map");
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  expect(await pilot.locator(".live-contact").count()).toBe(0);
  imageError = true; generation = 9;
  await waitText(pilot, "#map-status", "Could not load");
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  imageError = false; generation = 10; instrumentValid = true;
  await waitVisible(pilot, "#live-map", true);
  await waitText(viewer, "#squad-rows", "321 km/h");
  await waitText(pilot, "#contacts-status", "1 enemy");

  // Freeze fixture responses and advance the page's monotonic clock to exercise expiry.
  chat.push({ id: 1, msg: "Attack StaleMapTarget(Plane)!", sender: "Scout", enemy: false });
  await waitText(pilot, "#sighting-rows", "StaleMapTarget");
  stalled = true;
  while (!stalledPaths.has("/map_info.json") || !stalledPaths.has("/state")) await pilot.waitForTimeout(50);
  await pilot.evaluate(() => {
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, "now", { configurable: true, value: () => now() + 20_000 });
  });
  await waitText(pilot, "#feed-status", "Readings are stale");
  await waitText(pilot, "#map-status", "Game map is stale");
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  expect(await pilot.locator(".live-contact").count()).toBe(0);
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("—");
  expect(await pilot.locator("#sighting-rows").textContent()).toContain("StaleMapTarget");
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  generation = 11;
  stalled = false;
  releaseStalls.splice(0).forEach(release => release());
  await pilot.evaluate(() => { delete (performance as Performance & { now?: () => number }).now; });
  await pilot.waitForFunction(() => (document.querySelector("#live-map") as HTMLImageElement).src.endsWith("?gen=11"));
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
  await pilot.locator("#reconnect").click();
  await waitVisible(pilot, "#live-map", true);
  await waitText(viewer, "#squad-rows", "321 km/h");
  await waitText(pilot, "#contacts-status", "1 enemy");

  // Reconnect clears current readings, history and map before new requests finish.
  stalledPaths.clear(); stalled = true;
  while (!stalledPaths.has("/state") || !stalledPaths.has("/map_info.json")) await pilot.waitForTimeout(50);
  await pilot.locator("#reconnect").click();
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("—");
  expect(await pilot.locator('[data-trace="ias"] svg').count()).toBe(0);
  expect(await pilot.locator("#live-map").isVisible()).toBe(false);
  expect(await pilot.locator(".live-contact").count()).toBe(0);
  stalled = false;
  releaseStalls.splice(0).forEach(release => release());
  await pilot.locator("#reconnect").click();
  await waitText(pilot, "#feed-status", "Connected to local game instruments");
  await waitText(pilot, "#squad-status", "Connected.");
  await waitText(viewer, "#squad-rows", "321 km/h");

  await openSquad(pilot); await pilot.locator("#leave").click();
  expect(await pilot.locator('[data-value="ias"]').textContent()).toBe("321");
  expect(await pilot.locator("#live-map").isVisible()).toBe(true);
  await openSquad(pilot); await pilot.locator("#enter").click();
  await waitText(viewer, "#squad-rows", "321 km/h");
  // Reconnect restarts both while preserving the same private room.
  const count = requests.filter(r => r.page === pilot && r.path === "/state").length;
  await pilot.locator("#reconnect").click();
  await waitText(pilot, "#squad-status", "Connected.");
  expect(await pilot.locator("#invite").getAttribute("href")).toBe(invite);
  expect(requests.filter(r => r.page === pilot && r.path === "/state").length).toBeGreaterThan(count);
  await waitText(viewer, "#squad-rows", "321 km/h");
  await openSquad(pilot); await pilot.locator("#leave").click();
  await pilot.locator("#reconnect").click();
  await waitText(pilot, "#feed-status", "Connected to local game instruments");
  expect(await pilot.locator("#squad-status").textContent()).toContain("Disconnected");
  await viewer.waitForFunction(() => !document.querySelector("#squad-rows")?.textContent?.includes("321 km/h"));
  expect(requests.every(r => ["/state", "/indicators", "/map_info.json", "/map_obj.json", "/map.img", "/gamechat", "/hudmsg"].includes(r.path))).toBe(true);
}, 90000);

test("chat is local, incremental and recovers without inventing sightings", async () => {
  browser ??= await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext();
  await referenceFixtures(context);
  const pilot = await context.newPage(), viewer = await context.newPage();
  let generation: number | null = 1, failChat = false, failMap = false, stallChat = false, chatStalled = false;
  let buffer = [{ id: 10, msg: "Attack Old(P-40)!", sender: "Old scout", enemy: false, mode: "Team" }];
  const requests: Array<{ page: Page; path: string; cursor: string | null }> = [];
  const sent: string[] = [];
  const profileRequests: unknown[] = [];
  await context.route("**/api/player-stats", async route => {
    profileRequests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ updated: "2026-11-20", modes: [{ mode: "r", battles: 300, killsPerBattle: 1.2, airKd: 2 }, { mode: "a", battles: 5, killsPerBattle: 3, airKd: null }, { mode: "s", battles: 1500, killsPerBattle: 2, airKd: 3 }] }) });
  });
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
  await openSquad(pilot); await pilot.locator("#enter").click(); await waitText(pilot, "#squad-status", "Connected.");
  await viewer.goto((await pilot.locator("#invite").getAttribute("href"))!); await openSquad(viewer); await viewer.locator("#enter").click(); await waitText(viewer, "#squad-status", "Connected.");
  await pilot.keyboard.press("Escape");
  await viewer.keyboard.press("Escape");
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
  await waitText(pilot, "#selected-stats", "updated 2026-11-20");
  expect(profileRequests).toEqual([{ nickname: "Canniballistic" }]);
  expect(await pilot.locator("#selected-stats").textContent()).toContain("low sample");
  const battleColour = (row: number) => pilot.locator("#selected-stats tbody tr").nth(row).locator("td").nth(3).locator("span").first().evaluate(el => getComputedStyle(el).color);
  expect(await battleColour(0)).toBe("rgb(35, 100, 58)");
  expect(await battleColour(1)).toBe("rgb(155, 38, 36)");
  expect(await battleColour(2)).toBe("rgb(103, 43, 139)");
  expect(await pilot.locator("#selected-stats tbody tr").nth(0).locator("td").nth(3).locator(".visually-hidden").textContent()).toContain("typical experience");
  await pilot.setViewportSize({ width: 390, height: 844 });
  await pilot.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
  expect(await pilot.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await pilot.locator("#selected-stats").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await pilot.evaluate(() => { document.documentElement.style.fontSize = ""; });
  await pilot.setViewportSize({ width: 1280, height: 720 });
  await pilot.locator("#open-settings").click();
  expect(await pilot.locator('[name="playerStats"]').isChecked()).toBe(true);
  expect(await pilot.locator('#configuration label').filter({ has: pilot.locator('[name="playerStats"]') }).textContent()).toContain("ThunderSkill");
  await pilot.locator('[name="playerStats"]').uncheck();
  await pilot.locator('#settings-form button[type="submit"]').click();
  expect(await pilot.locator("#selected-stats").textContent()).toContain("lookup is off");
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
  await waitText(pilot, "#chat-list", "retrying");
  expect(await pilot.locator("#chat-list").textContent()).toContain("Previous messages are not current");
  expect(await pilot.locator("#chat-list").textContent()).toContain("Canniballistic");
  expect(await pilot.locator("#chat-list time").first().getAttribute("aria-label")).toContain("not game time");
  await waitText(pilot, "#map-status", "Retrying");
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(2);
  failMap = false; failChat = false;
  await pilot.waitForFunction(() => !document.querySelector("#chat-list")?.textContent?.includes("retrying"));
  expect(requests.filter(r => r.path === "/gamechat" && r.cursor === "0").length).toBeGreaterThanOrEqual(2);
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(2);
  failChat = true; await waitText(pilot, "#chat-list", "retrying");
  buffer = [{ id: 1, msg: "Attack Previous(Plane)!", sender: "Scout", enemy: false, mode: "Team" }];
  failChat = false;
  await waitText(pilot, "#chat-list", "Previous(Plane)");
  expect(await pilot.locator("#sighting-rows tr").count()).toBe(0);
  expect(await pilot.locator("#chat-list time").first().textContent()).toBe("—");
  buffer.push({ id: 2, msg: "Attack Fresh(Plane)!", sender: "Scout", enemy: false, mode: "Team" });
  await waitText(pilot, "#sighting-rows", "Fresh");
  expect(profileRequests).toEqual([{ nickname: "Canniballistic" }]);
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
  expect(requests.every(r => ["/state", "/indicators", "/map_info.json", "/map_obj.json", "/map.img", "/gamechat", "/hudmsg"].includes(r.path))).toBe(true);
  await context.close();
}, 90000);

test("game retries transient errors and permission denial requires reconnect", async () => {
  browser ??= await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext();
  await referenceFixtures(context);
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
  await referenceFixtures(context);
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
  expect(await page.locator("#open-squad").innerText()).toBe("Join squad");
  await page.evaluate(() => { location.hash = ""; });
  await waitText(page, "#enter", "Create squad");
  expect(await page.locator("#open-squad").innerText()).toBe("Squad");
  await page.locator("#reconnect").click();
  expect(await page.evaluate(() => ((window as any).sockets ?? []).length)).toBe(0);
  await openSquad(page); await page.locator("#enter").click();
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
  await openSquad(page); await page.locator("#leave").click();
  await page.locator("#reconnect").click();
  expect(await page.evaluate(() => (window as any).sockets.length)).toBe(3);
  await openSquad(page); await page.locator("#enter").click();
  expect(await page.evaluate(() => (window as any).sockets[3].protocols[1] === (window as any).sockets[2].protocols[1])).toBe(true);
  await context.close();
}, 30000);

test("Vy references follow only the local aircraft, expire safely, and display with units and heading", async () => {
  browser ??= await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext(); await referenceFixtures(context); const page = await context.newPage();
  let aircraft: string | null = "first", throttle = 110, heading: number | undefined = 0;
  const calls: string[] = []; let release: (() => void) | undefined;
  await page.route("**/api/climb-speed?**", async route => {
    const id = new URL(route.request().url()).searchParams.get("aircraft")!; calls.push(id);
    if (id === "first") { await new Promise<void>(resolve => { release = resolve; }); try { await route.fulfill({ json: { normalKph: 100, wepKph: 110 } }); } catch {} return; }
    await route.fulfill({ json: { normalKph: 230, wepKph: 240 } });
  });
  await page.route("http://127.0.0.1:8111/**", route => {
    const path = new URL(route.request().url()).pathname;
    const data = path === "/state" ? { valid: true, "IAS, km/h": 245, "throttle 1, %": throttle } : path === "/indicators" ? { valid: true, type: aircraft, compass1: heading } : path === "/gamechat" ? [] : { valid: false };
    return route.fulfill({ json: data, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto(origin); await page.waitForFunction(() => document.querySelector('#bearing')?.textContent === '000');
  expect(await page.locator('#bearing-direction').textContent()).toBe('° N');
  expect(await page.locator('#own-bearing-arrow svg').getAttribute('style')).toContain('0deg');
  expect(calls).toEqual(["first"]);
  aircraft = "second"; await page.waitForFunction(() => document.querySelector('#squad-rows')?.textContent?.includes('240 km/h'));
  expect(await page.locator('[data-value="ias"]').getAttribute('aria-label')).toContain('WEP');
  release?.(); await page.waitForTimeout(100);
  expect(await page.locator('#squad-rows').textContent()).toContain('230 km/h');
  expect(await page.locator('#squad-rows').textContent()).not.toContain('100 km/h');
  throttle = 80; heading = undefined;
  await page.waitForFunction(() => document.querySelector('[data-value="ias"]')?.getAttribute('aria-label')?.includes('100%'));
  await page.waitForFunction(() => !document.querySelector('#own-bearing-arrow svg'));
  await page.locator('#open-settings').click(); await page.locator('[data-section="display"]').click();
  await page.locator('[name="speed"]').selectOption('mph'); await page.locator('#settings-form button[type="submit"]').click();
  expect(await page.locator('#squad-rows').textContent()).toContain('143 mph');
  expect(calls).toEqual(["first", "second"]);
  aircraft = null; await page.waitForFunction(() => document.querySelector('[data-value="ias"]')?.getAttribute('aria-label') === null);
  await context.close();
}, 30000);

test("public profile opt-out aborts pending results and does not backfill", async () => {
  browser ??= await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await browser.newContext(); await referenceFixtures(context); const page = await context.newPage();
  let messages: Array<{id: number; msg: string; sender: string; enemy: boolean}> = [{ id: 1, msg: 'hello', sender: 'Scout', enemy: false }];
  const requests: unknown[] = []; let release: (() => void) | undefined;
  await page.route('**/api/player-stats', async route => {
    requests.push(route.request().postDataJSON());
    await new Promise<void>(resolve => { release = resolve; });
    try { await route.fulfill({ json: { updated: '2026-11-20', modes: [{ mode: 'r', battles: 99, killsPerBattle: 2, airKd: 3 }] } }); } catch {}
  });
  await page.route('http://127.0.0.1:8111/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === '/gamechat' ? messages : { valid: false }, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto(origin); await waitText(page, '#chat-list', 'hello');
  messages.push({ id: 2, msg: 'Attack =TAG= Ace_1(Plane)! [D4]', sender: 'Scout', enemy: false });
  await waitText(page, '#selected-stats', 'Looking up');
  expect(requests).toEqual([{ nickname: 'Ace_1' }]);
  await page.locator('#open-settings').click(); await page.locator('[name="playerStats"]').uncheck(); await page.locator('#settings-form button[type="submit"]').click();
  expect(await page.locator('#selected-stats').textContent()).toContain('lookup is off');
  release?.(); await page.waitForTimeout(200);
  expect(await page.locator('#selected-stats').textContent()).not.toContain('2026-11-20');
  messages.push({ id: 3, msg: 'Attack Another(Plane)!', sender: 'Scout', enemy: false });
  await waitText(page, '#sighting-rows', 'Another'); expect(requests).toHaveLength(1);
  await page.locator('#open-settings').click(); await page.locator('[name="playerStats"]').check(); await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForTimeout(250); expect(requests).toHaveLength(1);
  await context.close();
}, 30000);

test("squad HUD observations stay local, deduplicate and reset with map lifecycle", async () => {
  const instance = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  const context = await instance.newContext();
  try {
    await referenceFixtures(context);
    const pilot = await context.newPage(), wing = await context.newPage();
    await pilot.addInitScript(() => localStorage.setItem("wolfpack-v2-preferences", JSON.stringify({ player: "Pilot@live", playerStats: false })));
    await wing.addInitScript(() => localStorage.setItem("wolfpack-v2-preferences", JSON.stringify({ player: "Wing", playerStats: false })));
    let generation: number | null = 1, failHud = false;
    let damage: Array<{ id: number; msg: string; enemy: boolean; sender?: string }> = [{ id: 10, msg: "Pilot@live (Plane) destroyed Old", enemy: false }];
    const queries: string[] = [], sent: string[] = [];
    pilot.on("websocket", ws => ws.on("framesent", frame => sent.push(String(frame.payload))));
    await context.route("http://127.0.0.1:8111/**", async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      const viewer = request.frame().page() === wing;
      if (path === "/map.img") return void await route.fulfill({ contentType: "image/png", body: image });
      if (path === "/hudmsg") {
        queries.push(url.search);
        if (failHud) return void await route.fulfill({ status: 503, headers: { "Access-Control-Allow-Origin": "*" } });
        const cursor = Number(url.searchParams.get("lastDmg"));
        return void await route.fulfill({ json: { events: [], damage: damage.filter(d => d.id >= cursor) }, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const body = path === "/map_info.json" ? viewer || generation === null ? { valid: false } : { map_generation: generation }
        : path === "/map_obj.json" ? [] : path === "/gamechat" ? [{ id: 1, msg: "Pilot@live (Plane) destroyed Spoof", enemy: false }] : { valid: false };
      await route.fulfill({ json: body, headers: { "Access-Control-Allow-Origin": "*" } });
    });
    await pilot.goto(origin); await wing.goto(origin);
    await waitText(pilot, "#kill-count", "0 KILLS");
    expect(await wing.locator("#kill-count").innerText()).toBe("— KILLS");
    expect(await wing.locator("#kill-count").getAttribute("aria-label")).toContain("unavailable");
    expect(await pilot.locator("#kill-count").getAttribute("role")).toBe("status");
    expect(await pilot.locator("main .section-head h2").allTextContents()).toEqual(["Squad", "Sightings", "Map", "Instruments", "Chat"]);
    expect(await pilot.locator("main .section-head p, #settings-dialog .dialog-head p").count()).toBe(0);
    expect(await pilot.locator("#feed-status").isVisible()).toBe(true);
    expect(await pilot.locator("#chat-list time").first().getAttribute("aria-label")).toContain("Undated");
    const styles = await pilot.evaluate(() => ["#kill-count", "#report-count"].map(s => { const e = document.querySelector(s)!; const c = getComputedStyle(e); const r = e.getBoundingClientRect(), parent = e.parentElement!.getBoundingClientRect(); return [c.fontSize, c.fontWeight, c.letterSpacing, c.color, Math.round(parent.right - r.right)]; }));
    expect(styles[0]).toEqual(styles[1]);
    const wrapped = await pilot.evaluate(() => {
      const head = document.querySelector<HTMLElement>(".squad .section-head")!;
      head.style.width = "125px";
      const title = head.querySelector("h2")!.getBoundingClientRect();
      const badge = head.querySelector("#kill-count")!.getBoundingClientRect();
      const right = head.getBoundingClientRect().right - parseFloat(getComputedStyle(head).paddingRight);
      head.style.width = "";
      return { wrapped: badge.top > title.top, rightGap: Math.abs(right - badge.right) };
    });
    expect(wrapped.wrapped).toBe(true);
    expect(wrapped.rightGap).toBeLessThan(1);
    await openSquad(pilot); await pilot.locator("#enter").click(); await waitText(pilot, "#squad-status", "Connected.");
    await wing.goto((await pilot.locator("#invite").getAttribute("href"))!);
    await openSquad(wing); await wing.locator("#enter").click(); await waitText(pilot, "#squad-rows", "Wing");
    damage.push({ id: 13, msg: "Other (Plane) destroyed Target", enemy: false }, { id: 11, msg: "=TAG= Pilot@live (Plane) shot down Enemy (Plane)", enemy: false }, { id: 12, msg: "Victim (Plane) shot down by Wing (Plane)", enemy: false }, { id: 12, msg: "Wing (Plane) destroyed Duplicate", enemy: false }, { id: 14, msg: "Pilot@liveFake (Plane) destroyed Enemy", enemy: false }, { id: 15, msg: "Wing (Plane) destroyed Enemy", enemy: true }, { id: 16, msg: "Pilot@live (Plane) destroyed SenderSpoof", enemy: false, sender: "Impostor" });
    await waitText(pilot, "#kill-count", "2 KILLS");
    expect(queries.some(q => q.includes("lastDmg=10") && q.includes("lastEvt=0"))).toBe(true);
    expect(await wing.locator("#kill-count").innerText()).toBe("— KILLS");
    expect(sent.join(" ")).not.toContain("shot down");
    await openSquad(wing); await wing.locator("#leave").click();
    await waitText(pilot, "#kill-count", "1 KILL");
    failHud = true; await waitText(pilot, "#kill-count", "— KILLS");
    failHud = false; await waitText(pilot, "#kill-count", "1 KILL");
    generation = 2; await waitText(pilot, "#kill-count", "0 KILLS");
    damage.push({ id: 17, msg: "Victim (Plane) has been destroyed by Pilot@live (Plane)", enemy: false });
    await waitText(pilot, "#kill-count", "1 KILL");
    generation = null; await waitText(pilot, "#kill-count", "— KILLS");
    generation = 3; await waitText(pilot, "#kill-count", "0 KILLS");
    await pilot.locator("#reconnect").click(); await waitText(pilot, "#kill-count", "0 KILLS");
    damage.push({ id: 18, msg: "Pilot@live (Plane) destroyed Next", enemy: false });
    await waitText(pilot, "#kill-count", "1 KILL");
    failHud = true; await waitText(pilot, "#kill-count", "— KILLS");
    damage = [{ id: 1, msg: "Pilot@live (Plane) destroyed Buffered", enemy: false }];
    failHud = false; await waitText(pilot, "#kill-count", "0 KILLS");
    damage.push({ id: 2, msg: "Pilot@live (Plane) destroyed Fresh", enemy: false });
    await waitText(pilot, "#kill-count", "1 KILL");
  } finally { await context.close(); await instance.close(); }
}, 60000);
