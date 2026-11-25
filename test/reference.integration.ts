import { afterAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";

// Exercise the built, real Worker against a disposable workerd D1 instance.
// No Cloudflare account, production database, or shared dev state is touched.
const contents = await Bun.file(".cloudflare/output/v1/workers/default/bundle/index.js").text();
const mf = new Miniflare({
  workers: [{
    config: {
      name: "reference-test", compatibilityDate: "2026-11-23",
      manifest: { mainModule: "index.js", modulesRoot: "/", modules: { "index.js": { type: "esm", contents } } },
      env: { REFERENCE: { type: "d1", id: "fixture-only" } },
    },
  }],
});
afterAll(async () => { await mf.dispose(); });

test("reference API uses isolated D1, exact mapped rows and safe failure responses", async () => {
  const db = await mf.getD1Database("REFERENCE");
  await db.exec(await Bun.file("test/reference-fixture.sql").text());
  const get = async (id: string) => mf.dispatchFetch(new URL(`/api/climb-speed?aircraft=${encodeURIComponent(id)}`, await mf.ready));

  let response = await get("p-51_mk1a_usaaf");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ normalKph: 230, wepKph: 240 });
  expect(response.headers.get("Cache-Control")).toContain("max-age=3600");
  response = await get("bf-109g-6");
  expect(await response.json()).toEqual({ normalKph: 240, wepKph: null });
  response = await get("spitfire_mk1");
  expect(await response.json()).toEqual({ normalKph: 200, wepKph: 210 });
  expect(response.headers.get("Cache-Control")).toContain("max-age=3600");
  expect(await (await get("d_520_france")).json()).toEqual({ normalKph: 220, wepKph: 230 });
  response = await get("d_521");
  expect(await response.json()).toEqual({ normalKph: null, wepKph: null, estimatedKph: 217 });
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  response = await get("d_521_extra");
  expect(await response.json()).toEqual({ normalKph: null, wepKph: null });
  expect(response.headers.get("Cache-Control")).toContain("max-age=300");
  response = await get("p-51c-10-nt");
  expect(await response.json()).toEqual({ normalKph: null, wepKph: null });
  expect(response.headers.get("Cache-Control")).toContain("max-age=300");
  expect((await get("../bad")).status).toBe(400);
  expect((await mf.dispatchFetch(new URL("/api/climb-speed?aircraft=x", await mf.ready), { method: "POST" })).status).toBe(405);

  // A moved/renamed row never silently becomes a different aircraft's reference.
  await db.prepare("UPDATE mec_aircraft SET aircraft = ? WHERE sheet_order = ? AND aircraft_row = ?").bind("Wrong", 4, 93).run();
  expect(await (await get("p-51_mk1a_usaaf")).json()).toEqual({ normalKph: null, wepKph: null });
  await db.exec("DROP TABLE mec_aircraft");
  response = await get("p-51_mk1a_usaaf");
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  response = await get("d_521");
  expect(await response.json()).toEqual({ normalKph: null, wepKph: null, estimatedKph: 217 });
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  // Unknown IDs do not query D1 even when the database is unavailable.
  expect((await get("unlisted-plane")).status).toBe(200);
}, 30000);
