import { createRoomKey, displayName, SAMPLE_LIFETIME_MS } from "../shared/protocol.ts";
import type { Member, ServerMessage, Telemetry } from "../shared/protocol.ts";
import { connectSquad, inviteKey, inviteUrl } from "./squad.ts";
import { GAME_ORIGIN, watchTelemetry } from "./telemetry.ts";
import { watchMap } from "./map.ts";
import { addHistory, altitude, bearing, choices, climb, climbAngle, climbUnit, defaults, emptyHistories, historyKeys, preferences, speed, speedUnit, temperature, tempUnit } from "./derived.ts";
import type { Histories, HistoryKey, Preferences } from "./derived.ts";
import { reports, sampleOwn, sampleSquad } from "./sample.ts";

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
};
const text = (selector: string, value: string) => { $(selector).textContent = value; };
const visible = (selector: string, show: boolean) => { $<HTMLElement>(selector).hidden = !show; };
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const storageKey = "wolfpack-v2-preferences";
let prefs = { ...defaults };
try { prefs = preferences(JSON.parse(localStorage.getItem(storageKey) ?? "{}")); } catch { /* storage is optional */ }
function savePrefs(): void { try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch { /* storage is optional */ } }
let sampleMode = false;
let selected = 0;
let roomKey = inviteKey();
let squad: ReturnType<typeof connectSquad> | undefined;
let generation = 0;
let stopFeed: (() => void) | undefined;
let stopMap: (() => void) | undefined;
let mapAt = 0;
let mapGeneration: number | null = null;
let imageLoaded = false;
let own: Telemetry | null = null;
let ownAt = 0;
let published = false;
let selfId: string | undefined;
let histories = emptyHistories();
const members = new Map<string, { member: Member; seenAt: number }>();
const enter = $<HTMLButtonElement>("#enter");
const leave = $<HTMLButtonElement>("#leave");
const share = $<HTMLButtonElement>("#share");
const invite = $<HTMLAnchorElement>("#invite");
const showOwn = $<HTMLInputElement>("#show-own");
const mapImage = $<HTMLImageElement>("#live-map");

function sampleHistories(): Histories {
  const history = emptyHistories();
  for (const key of historyKeys) {
    const v = sampleOwn[key];
    if (v !== null) history[key] = [v * .94, v * .955, v * .97, v * .96, v * .98, v * .99, v];
  }
  return history;
}
const exampleHistories = sampleHistories();
const traceNames: Record<string, HistoryKey> = { ias: "iasKph", tas: "tasKph", altitude: "altitudeM", climb: "climbMps", throttle: "throttlePct", coolant: "waterTempC", oil: "oilTempC" };
function renderInstruments(): void {
  const reading = sampleMode ? sampleOwn : own;
  const values: Record<string, string> = {
    ias: speed(reading?.iasKph ?? null, prefs), tas: speed(reading?.tasKph ?? null, prefs), altitude: altitude(reading?.altitudeM ?? null, prefs),
    climb: climb(reading?.climbMps ?? null, prefs), throttle: reading?.throttlePct == null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(reading.throttlePct),
    coolant: temperature(reading?.waterTempC ?? null, prefs), oil: temperature(reading?.oilTempC ?? null, prefs),
  };
  for (const [key, value] of Object.entries(values)) document.querySelectorAll(`[data-value="${key}"]`).forEach(el => { el.textContent = value; });
  for (const [key, value] of Object.entries({ speed: speedUnit(prefs), altitude: prefs.altitude, climb: climbUnit(prefs), temp: tempUnit(prefs) })) document.querySelectorAll(`[data-unit="${key}"]`).forEach(el => { el.textContent = value; });
  text("#bearing", bearing(reading?.headingDeg ?? null));
  const angle = climbAngle(reading?.iasKph ?? null, reading?.climbMps ?? null);
  text("#climb-angle", angle === null ? "" : `· ${angle > 0 ? "+" : ""}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(angle)}° (IAS-derived)`);
  text("#instrument-subtitle", sampleMode ? "Fictional sample aircraft · Spitfire Mk IX · sample history" : own ? `${own.aircraft ?? "Aircraft"} · local instruments · recent history` : "No current readings · connect to the game");
  const activeHistory = sampleMode ? exampleHistories : histories;
  for (const [name, key] of Object.entries(traceNames)) {
    const el = $<HTMLElement>(`[data-trace="${name}"]`);
    const values = activeHistory[key];
    if (!reading || values.length < 2) { el.replaceChildren(); el.removeAttribute("role"); el.removeAttribute("aria-label"); continue; }
    const min = Math.min(...values), range = Math.max(...values) - min || 1;
    const points = values.map((v, i) => `${i * 60 / (values.length - 1)},${15 - (v - min) / range * 12}`).join(" ");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 60 18"); svg.setAttribute("aria-hidden", "true");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline"); line.setAttribute("points", points); svg.append(line); el.replaceChildren(svg);
    el.setAttribute("role", "img"); el.setAttribute("aria-label", sampleMode ? "Fictional sample recent history" : "Recent readings; cleared when data is unavailable");
  }
}
function renderSquad(): void {
  showOwn.checked = prefs.showOwn;
  const rows: Array<Member & { out?: boolean }> = sampleMode
    ? [...(prefs.showOwn ? [{ id: "sample-self", name: prefs.player.toLowerCase() === "you" ? "You" : `${prefs.player} (you)`, sample: sampleOwn }] : []), ...sampleSquad]
    : Array.from(members.values(), ({ member }) => ({ ...member, sample: member.id === selfId ? own : member.sample, name: member.id === selfId ? `${member.name} (you)` : member.name })).filter(member => prefs.showOwn || member.id !== selfId);
  const html = rows.map(({ name, sample: s, out }) => `<tr${out ? ' class="out-of-action"' : ""}><td>${escape(name)}${out ? ' <span class="state-label">Out of action</span>' : ""}</td><td data-label="IAS">${speed(s?.iasKph ?? null, prefs)} ${speedUnit(prefs)}</td><td data-label="Altitude">${altitude(s?.altitudeM ?? null, prefs)} ${prefs.altitude}</td><td data-label="Bearing">${bearing(s?.headingDeg ?? null)}</td><td data-label="Climb">${climb(s?.climbMps ?? null, prefs)} ${climbUnit(prefs)}</td><td data-label="Throttle">${s?.throttlePct == null ? "—" : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(s.throttlePct)}%`}</td></tr>`).join("");
  $("#squad-rows").innerHTML = html || '<tr><td colspan="6">No squad readings available.</td></tr>';
  text("#squad-subtitle", sampleMode ? "Fictional sample instruments and statuses" : `${prefs.squad} · live instruments when shared · out-of-action status unavailable`);
}
function renderReports(): void {
  $("#sighting-rows").innerHTML = sampleMode ? reports.map((r, i) => `<tr data-report="${i}"><td><button type="button" data-report="${i}">${r.player}${r.out ? ' <span class="state-label">Out of action</span>' : ""}</button></td><td data-label="Aircraft">${r.aircraft}</td><td data-label="Location / alt.">${r.grid} · ${r.altitude === null ? "Unknown" : `${altitude(r.altitude, prefs)} ${prefs.altitude}`}</td><td data-label="Age">${r.age}</td></tr>`).join("") : "";
  updateSelection();
}
function updateSelection(): void {
  if (!sampleMode) return;
  const r = reports[selected]!;
  text("#selected-aircraft", r.aircraft); text("#selected-grid", r.grid); text("#selected-player", r.player);
  text("#selected-altitude", r.altitude === null ? "Altitude unknown" : `${altitude(r.altitude, prefs)} ${prefs.altitude}`);
  text("#selected-age", `${r.age === "Age unknown" ? r.age : `${r.age} ago`}${r.out ? " · Out of action" : ""}`);
  $("#aircraft-path").setAttribute("d", r.path);
  $(".aircraft").setAttribute("aria-label", `Side profile illustration of ${r.aircraft}`);
  document.querySelectorAll<HTMLElement>("[data-report]").forEach(el => {
    const active = Number(el.dataset.report) === selected;
    if (el.tagName === "BUTTON") el.setAttribute("aria-pressed", String(active));
    if (el.tagName === "TR") el.classList.toggle("selected", active);
  });
}
function renderMode(): void {
  visible(".connection-bar", !sampleMode);
  text("#mode-label", sampleMode ? "Fictional sample view" : "Real view");
  text("#mode-toggle", sampleMode ? "Return to real view" : "Explore sample view");
  text("#page-subtitle", sampleMode ? "Greyhaven coast / Fictional sample session · no game connection" : "Real view / Local game and squad");
  text("#map-subtitle", sampleMode ? "Fictional Greyhaven coast · sample grid reference" : "Local game map · not shared");
  $("#map").setAttribute("aria-label", sampleMode ? "Fictional sample coastal map. Select a last-known sample sighting." : "Local War Thunder operating map.");
  $("#map").classList.toggle("live-map", !sampleMode);
  document.querySelectorAll<HTMLElement>(".map-art, .map-columns, .map-rows").forEach(el => { el.hidden = !sampleMode; });
  visible("#map-status", !sampleMode && !imageLoaded);
  mapImage.hidden = sampleMode || !imageLoaded;
  document.querySelectorAll<HTMLElement>(".sample-marker").forEach(el => { el.hidden = !sampleMode; });
  visible("#map-distance", sampleMode); visible("#map-legend", sampleMode);
  visible("#selected-report", sampleMode); visible("#sighting-empty", !sampleMode);
  text("#report-count", sampleMode ? "3 SAMPLE REPORTS" : "UNAVAILABLE");
  text("#awards-summary", sampleMode ? "3 sample squad awards" : "Awards unavailable");
  $("#awards-content").innerHTML = sampleMode ? "<p>Moss · Teamwork</p><p>Moss · Mission Maker</p><p>Raven · Supporting Fire</p>" : "<p>Awards are unavailable in real view.</p>";
  text("#chat-subtitle", sampleMode ? "Read-only fictional sample messages" : "Read-only · unavailable in real view");
  $("#chat-list").innerHTML = sampleMode ? "<li><time>14:32</time><b>Moss</b><span>Turning toward the coast.</span></li><li><time>14:31</time><b>Raven</b><span>Contact over the bay, heading north.</span></li><li><time>14:30</time><b>You</b><span>Copy, climbing to meet you.</span></li>" : "<li>Game chat is unavailable in real view.</li>";
  enter.disabled = sampleMode || !!squad; leave.disabled = sampleMode || !squad; share.disabled = sampleMode;
  visible("#invite", !sampleMode && !!selfId); visible("#copy-invite", !sampleMode && !!selfId);
  renderPublishing(); renderInstruments(); renderSquad(); renderReports();
}
function remember(member: Member): void { members.set(member.id, { member, seenAt: performance.now() }); }
function roomMessage(message: ServerMessage): void {
  // Welcome snapshots contain no sample timestamp. Wait for a fresh update
  // instead of presenting a potentially almost-expired snapshot as current.
  if (message.type === "welcome") { members.clear(); selfId = message.selfId; for (const member of message.members) remember({ ...member, sample: null }); }
  else if (message.type === "member") remember(message.member);
  else members.delete(message.id);
  renderSquad();
}
function renderPublishing(): void {
  text("#publish-status", sampleMode ? "Sample mode: no game reads or squad sharing." : !prefs.shareInstruments
    ? "Squad instrument sharing is off in Settings. Your map and instruments remain local."
    : own && selfId ? "Sharing your own aircraft instruments with the squad. Map and positions stay local."
    : "Squad instrument sharing is on in Settings. Connect the game and join a squad to share; map and positions stay local.");
}
function syncPublishing(): void {
  const current = !sampleMode && !!selfId && prefs.shareInstruments ? own : null;
  if (current) { squad?.publish(current); published = true; }
  else if (published) { squad?.publish(null); published = false; }
  renderPublishing();
}
function clearMap(message: string): void {
  mapAt = 0; mapGeneration = null; imageLoaded = false;
  mapImage.hidden = true; mapImage.removeAttribute("src");
  text("#map-status", message); visible("#map-status", !sampleMode);
}
mapImage.addEventListener("load", () => {
  if (sampleMode || !stopMap || mapGeneration === null) return;
  imageLoaded = true; mapImage.hidden = false; visible("#map-status", false);
});
mapImage.addEventListener("error", () => {
  if (sampleMode || !stopMap) return;
  imageLoaded = false; mapImage.hidden = true; mapImage.removeAttribute("src");
  text("#map-status", "Could not load the local game map. Retrying…"); visible("#map-status", true);
});
function stopGame(): void {
  stopFeed?.(); stopFeed = undefined;
  stopMap?.(); stopMap = undefined;
  own = null; ownAt = 0; histories = emptyHistories(); syncPublishing();
  clearMap("Connect game to load the local operating map.");
  if (selfId && members.has(selfId)) remember({ ...members.get(selfId)!.member, sample: null });
  share.textContent = "Connect game"; text("#feed-status", "Game disconnected. Connect game and allow loopback access if prompted.");
  renderInstruments(); renderSquad();
}
function disconnect(): void {
  generation++; const old = squad; squad = undefined; selfId = undefined; members.clear(); published = false; old?.close();
  enter.disabled = sampleMode; leave.disabled = true; share.disabled = sampleMode;
  visible("#invite", false); visible("#copy-invite", false); text("#squad-status", "Disconnected from squad."); renderPublishing(); renderSquad();
}
enter.addEventListener("click", () => {
  if (sampleMode || squad) return;
  if (!displayName(prefs.player)) { text("#squad-status", "Set a valid player name in Settings first."); return; }
  const key = roomKey ?? createRoomKey(), token = ++generation;
  try {
    squad = connectSquad({ roomKey: key, name: prefs.player, onStatus(status) {
      if (token !== generation || sampleMode) return;
      if (status === "connecting") { enter.disabled = true; leave.disabled = false; text("#squad-status", "Connecting to squad…"); }
      else if (status === "joined") { roomKey = key; invite.href = inviteUrl(key).href; visible("#invite", true); visible("#copy-invite", true); enter.textContent = "Rejoin squad"; text("#squad-status", "Connected. Share the private invite only with squadmates."); }
      else disconnect();
    }, onMessage(message) { if (token === generation && !sampleMode) { roomMessage(message); if (message.type === "welcome") syncPublishing(); } } });
  } catch { squad = undefined; enter.disabled = false; text("#squad-status", "Could not connect. Check the player name and invite."); }
});
leave.addEventListener("click", disconnect);
$("#copy-invite").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(invite.href); text("#squad-status", "Invite copied. Share it privately."); }
  catch { text("#squad-status", "Copy unavailable. Use the invite link instead."); }
});
share.addEventListener("click", () => {
  if (sampleMode) return;
  if (stopFeed) return stopGame();
  share.textContent = "Disconnect game"; text("#feed-status", "Connecting to the local game. Allow loopback access if prompted.");
  text("#map-status", "Connecting to the local game map…");
  stopFeed = watchTelemetry(update => {
    if (sampleMode) return;
    own = update.sample; ownAt = own ? performance.now() : 0; syncPublishing();
    if (own) addHistory(histories, own); else histories = emptyHistories();
    if (selfId && members.has(selfId)) remember({ ...members.get(selfId)!.member, sample: own });
    if (update.status === "denied") { stopGame(); text("#feed-status", "Loopback access denied. Allow it in site settings, then retry."); }
    else if (update.status === "unreachable") text("#feed-status", "Cannot reach War Thunder. Check the game and browser loopback access.");
    else if (update.status === "waiting") text("#feed-status", "Game connected; aircraft instruments are unavailable.");
    else text("#feed-status", "Connected to local game instruments.");
    renderInstruments(); renderSquad();
  });
  stopMap = watchMap(update => {
    if (sampleMode) return;
    if (update.status !== "ready") { clearMap(update.status === "waiting" ? "Game map unavailable; waiting for a valid map." : "Cannot reach game map metadata. Retrying…"); return; }
    mapAt = performance.now();
    if (mapGeneration !== update.generation || !mapImage.hasAttribute("src")) {
      mapGeneration = update.generation; imageLoaded = false; mapImage.hidden = true;
      text("#map-status", "Loading local game map…"); visible("#map-status", true);
      mapImage.src = `${GAME_ORIGIN}/map.img?gen=${update.generation}`;
    }
  });
});
$("#mode-toggle").addEventListener("click", () => {
  if (!sampleMode) { stopGame(); disconnect(); sampleMode = true; text("#squad-status", "Fictional sample view: disconnected; no game reads or sharing."); text("#feed-status", "Sample data only. Game connection is off."); }
  else { sampleMode = false; text("#squad-status", "Real view: disconnected from squad."); text("#feed-status", "Game disconnected. Connect game and allow loopback access if prompted."); }
  renderMode();
});
document.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-report]");
  if (!sampleMode || !button) return;
  selected = Number(button.dataset.report); updateSelection();
});
showOwn.addEventListener("change", () => { prefs.showOwn = showOwn.checked; savePrefs(); renderSquad(); });

const dialog = $<HTMLDialogElement>("#settings-dialog");
const form = $<HTMLFormElement>("#settings-form");
form.noValidate = true; // Validate after selecting the tab containing a bad field.
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
function section(name: string): void {
  for (const id of ["configuration", "display"]) { visible(`#${id}`, id === name); $(`[data-section="${id}"]`).setAttribute("aria-pressed", String(id === name)); }
}
$("#open-settings").addEventListener("click", () => {
  for (const name of ["player", "squad", ...Object.keys(choices)] as (keyof Preferences)[]) field(name).value = String(prefs[name]);
  (field("shareInstruments") as HTMLInputElement).checked = prefs.shareInstruments;
  field("endpoint").value = GAME_ORIGIN; section("configuration"); dialog.showModal();
});
document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach(button => button.addEventListener("click", () => section(button.dataset.section!)));
$("#close-settings").addEventListener("click", () => dialog.close());
$("#cancel-settings").addEventListener("click", () => dialog.close());
form.addEventListener("submit", event => {
  event.preventDefault();
  for (const name of ["player", "squad"]) {
    const input = field(name); input.setCustomValidity(displayName(input.value) ? "" : "Enter a name of up to 32 characters without control characters.");
    if (!input.checkValidity()) { section("configuration"); input.reportValidity(); return; }
  }
  const candidate = Object.fromEntries(["player", "squad", ...Object.keys(choices)].map(name => [name, field(name).value]));
  prefs = preferences({ ...candidate, showOwn: prefs.showOwn, shareInstruments: (field("shareInstruments") as HTMLInputElement).checked }); savePrefs(); dialog.close(); syncPublishing();
  renderInstruments(); renderSquad(); renderReports();
  if (squad) text("#squad-status", "Preferences saved. Player name changes apply on rejoin.");
});
enter.textContent = roomKey ? "Join squad" : "Create squad";
window.addEventListener("hashchange", () => {
  if (!squad) { roomKey = inviteKey(); enter.textContent = roomKey ? "Join squad" : "Create squad"; }
});
renderMode();
setInterval(() => {
  if (sampleMode) return;
  let changed = false;
  for (const { member, seenAt } of members.values()) if (member.sample && performance.now() - seenAt >= SAMPLE_LIFETIME_MS) { member.sample = null; changed = true; }
  if (own && performance.now() - ownAt >= SAMPLE_LIFETIME_MS) {
    own = null; ownAt = 0; histories = emptyHistories(); syncPublishing();
    text("#feed-status", "Readings are stale; waiting for the local game."); renderInstruments(); changed = true;
  }
  if (mapAt && performance.now() - mapAt >= SAMPLE_LIFETIME_MS) clearMap("Game map is stale; waiting for metadata.");
  if (changed) renderSquad();
}, 1000);
