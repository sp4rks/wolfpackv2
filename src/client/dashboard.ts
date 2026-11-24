import { statsLookup, statColour, experienceColour } from "./player-stats.ts";
import { climbSpeedLookup, iasComparison } from "./climb-speed.ts";
import type { ClimbSpeeds } from "./climb-speed.ts";
import { createRoomKey, displayName, SAMPLE_LIFETIME_MS } from "../shared/protocol.ts";
import type { Member, ServerMessage, Telemetry } from "../shared/protocol.ts";
import { connectSquad, inviteKey, inviteUrl } from "./squad.ts";
import { GAME_ORIGIN, watchTelemetry } from "./telemetry.ts";
import { watchMap } from "./map.ts";
import { parseSighting, stripGameColors, watchChat } from "./chat.ts";
import type { ChatMessage, Sighting } from "./chat.ts";
import { addHistory, altitude, bearing, choices, climb, climbAngle, climbUnit, defaults, emptyHistories, preferences, speed, speedUnit, temperature, tempUnit } from "./derived.ts";
import type { HistoryKey, Preferences } from "./derived.ts";

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
};
const text = (selector: string, value: string) => { const el = $(selector); if (el.textContent !== value) el.textContent = value; };
const visible = (selector: string, show: boolean) => { $<HTMLElement>(selector).hidden = !show; };
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const storageKey = "wolfpack-v2-preferences";
let prefs = { ...defaults };
try { prefs = preferences(JSON.parse(localStorage.getItem(storageKey) ?? "{}")); } catch { /* storage is optional */ }
function savePrefs(): void { try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch { /* storage is optional */ } }
let roomKey = inviteKey();
// An invite alone is not a request to join. Keep the requested key through
// failures, but clear it on explicit leave.
let requestedRoom: string | null = null;
let squad: ReturnType<typeof connectSquad> | undefined;
let generation = 0;
let stopFeed: (() => void) | undefined;
let stopMap: (() => void) | undefined;
let stopChat: (() => void) | undefined;
let chatStatus: "disconnected" | "connecting" | "live" | "retrying" = "disconnected";
let chatMessages: ChatMessage[] = [];
const liveReports = new Map<string, Sighting>();
let selectedKey: string | null = null;
let knownMap: number | null = null;
let mapAt = 0;
let mapGeneration: number | null = null;
let own: Telemetry | null = null;
let ownAt = 0;
let published = false;
let selfId: string | undefined;
let histories = emptyHistories();
const members = new Map<string, { member: Member; seenAt: number }>();
const enter = $<HTMLButtonElement>("#enter");
const leave = $<HTMLButtonElement>("#leave");
const invite = $<HTMLAnchorElement>("#invite");
let reference: ClimbSpeeds | null = null;
const profiles = statsLookup(() => updateSelection());
const lookup = climbSpeedLookup(value => { reference = value; renderInstruments(); renderSquad(); });
function arrow(heading: number | null | undefined): string {
  if (heading == null || !Number.isFinite(heading)) return "";
  const angle = (heading % 360 + 360) % 360;
  return `<svg class="bearing-icon" aria-hidden="true" viewBox="0 0 24 24" style="transform:rotate(${angle}deg)"><path d="M12 2 4 21l8-4 8 4z"/></svg>`;
}
function connection(kind: "game" | "squad", state: "connected" | "pending" | "disconnected", detail: string): void {
  const button = $<HTMLButtonElement>(`[data-connection="${kind}"]`);
  const label = `${kind === "game" ? "War Thunder" : "Squad room"} connection · ${detail}`;
  if (button.getAttribute("aria-label") === label) return;
  button.dataset.state = state; button.setAttribute("aria-label", label);
  text(`#${kind}-tooltip`, label); text("#connection-announcement", label);
}
document.querySelectorAll<HTMLButtonElement>(".connection-dot").forEach(button => {
  const tip = $<HTMLElement>(`#${button.dataset.connection}-tooltip`);
  const show = (open: boolean) => { tip.hidden = !open; button.setAttribute("aria-expanded", String(open)); };
  button.addEventListener("mouseenter", () => show(true));
  button.addEventListener("mouseleave", () => { if (document.activeElement !== button) show(false); });
  button.addEventListener("focus", () => show(true)); button.addEventListener("blur", () => show(false));
  button.addEventListener("click", () => show(true));
});
const mapImage = $<HTMLImageElement>("#live-map");

const traceNames: Record<string, HistoryKey> = { ias: "iasKph", tas: "tasKph", altitude: "altitudeM", climb: "climbMps", throttle: "throttlePct", coolant: "waterTempC", oil: "oilTempC" };
function renderInstruments(): void {
  const reading = own;
  const values: Record<string, string> = {
    ias: speed(reading?.iasKph ?? null, prefs), tas: speed(reading?.tasKph ?? null, prefs), altitude: altitude(reading?.altitudeM ?? null, prefs),
    climb: climb(reading?.climbMps ?? null, prefs), throttle: reading?.throttlePct == null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(reading.throttlePct),
    coolant: temperature(reading?.waterTempC ?? null, prefs), oil: temperature(reading?.oilTempC ?? null, prefs),
  };
  for (const [key, value] of Object.entries(values)) document.querySelectorAll(`[data-value="${key}"]`).forEach(el => { el.textContent = value; });
  for (const [key, value] of Object.entries({ speed: speedUnit(prefs), altitude: prefs.altitude, climb: climbUnit(prefs), temp: tempUnit(prefs) })) document.querySelectorAll(`[data-unit="${key}"]`).forEach(el => { el.textContent = value; });
  const heading = bearing(reading?.headingDeg ?? null);
  text("#bearing", heading === "—" ? heading : heading.slice(0, 3));
  text("#bearing-direction", heading === "—" ? "" : heading.slice(3));
  $("#own-bearing-arrow").innerHTML = arrow(reading?.headingDeg);
  const ias = $<HTMLElement>('[data-value="ias"]');
  const comparison = iasComparison(reading?.iasKph ?? null, reading?.throttlePct ?? null, reference);
  ias.style.color = comparison?.color ?? "";
  if (comparison) { ias.setAttribute("title", comparison.description); ias.setAttribute("aria-label", `${values.ias} ${speedUnit(prefs)}; ${comparison.description}`); } else { ias.removeAttribute("title"); ias.removeAttribute("aria-label"); }
  const angle = climbAngle(reading?.iasKph ?? null, reading?.climbMps ?? null);
  text("#climb-angle", angle === null ? "" : `· ${angle > 0 ? "+" : ""}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(angle)}° (IAS-derived)`);
  for (const [name, key] of Object.entries(traceNames)) {
    const el = $<HTMLElement>(`[data-trace="${name}"]`);
    const values = histories[key];
    if (!reading || values.length < 2) { el.replaceChildren(); el.removeAttribute("role"); el.removeAttribute("aria-label"); continue; }
    const min = Math.min(...values), range = Math.max(...values) - min || 1;
    const points = values.map((v, i) => `${i * 60 / (values.length - 1)},${15 - (v - min) / range * 12}`).join(" ");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 60 18"); svg.setAttribute("aria-hidden", "true");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline"); line.setAttribute("points", points); svg.append(line); el.replaceChildren(svg);
    el.setAttribute("role", "img"); el.setAttribute("aria-label", "Recent readings; cleared when data is unavailable");
  }
}
function renderSquad(): void {
  const remote = Array.from(members.values(), ({ member }) => member).filter(member => member.id !== selfId);
  const rows = [{ name: `${selfId ? members.get(selfId)?.member.name ?? prefs.player : prefs.player} (you)`, sample: own, local: true }, ...remote.map(member => ({ ...member, local: false }))];
  const html = rows.map(({ name, sample: s, local }) => {
    const comparison = iasComparison(s?.iasKph ?? null, s?.throttlePct ?? null, reference);
    const iasAttrs = comparison ? ` style="color:${comparison.color}" title="${escape(comparison.description)}"` : "";
    const target = (value: number | null | undefined) => value == null ? "—" : `${speed(value, prefs)} ${speedUnit(prefs)}`;
    return `<tr><td>${escape(name)}</td><td data-label="Aircraft">${escape(s?.aircraft ?? "—")}</td><td data-label="Vy 100%">${local ? target(reference?.normalKph) : "—"}</td><td data-label="Vy WEP">${local ? target(reference?.wepKph) : "—"}</td><td data-label="IAS"><span${iasAttrs}>${speed(s?.iasKph ?? null, prefs)} ${speedUnit(prefs)}${comparison ? `<span class="visually-hidden">. ${escape(comparison.description)}</span>` : ""}</span></td><td data-label="Altitude">${altitude(s?.altitudeM ?? null, prefs)} ${prefs.altitude}</td><td data-label="Bearing"><span class="bearing-value">${bearing(s?.headingDeg ?? null)} ${arrow(s?.headingDeg)}</span></td><td data-label="Climb">${climb(s?.climbMps ?? null, prefs)} ${climbUnit(prefs)}</td><td data-label="Throttle">${s?.throttlePct == null ? "—" : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(s.throttlePct)}%`}</td></tr>`;
  }).join("");
  $("#squad-rows").innerHTML = html;
}
function renderReports(): void {
  const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.target : undefined;
  const rows = [...liveReports.values()].reverse().sort((a, b) => b.receivedAt - a.receivedAt);
  $("#sighting-rows").innerHTML = rows.map(r => `<tr data-target="${escape(r.key)}"><td><button type="button" data-target="${escape(r.key)}">${escape(r.player)}</button></td><td data-label="Aircraft">${escape(r.aircraft)}</td><td data-label="Location / alt.">${escape(r.grid ?? "Unknown")} · ${r.altitudeM === null ? "Unknown" : `${altitude(r.altitudeM, prefs)} ${prefs.altitude}`}</td><td data-label="Age" data-age="${r.receivedAt}"></td></tr>`).join("");
  visible("#sighting-empty", rows.length === 0);
  text("#sighting-empty", chatStatus === "disconnected" ? "Game chat disconnected."
    : chatStatus === "connecting" ? "Connecting to game chat…"
    : chatStatus === "retrying" ? "Game chat unavailable; retrying for new English named target callouts."
    : "Waiting for a new English named target callout after connection.");
  visible("#selected-report", !!selectedKey && liveReports.has(selectedKey));
  text("#report-count", `${rows.length} REPORT${rows.length === 1 ? "" : "S"}`);
  if (focused) document.querySelectorAll<HTMLButtonElement>("button[data-target]").forEach(button => { if (button.dataset.target === focused) button.focus(); });
  updateSelection();
  if (!selectedKey) updateAges();
}
function updateSelection(): void {
  const r = selectedKey ? liveReports.get(selectedKey) : undefined;
  visible("#selected-report", !!r);
  if (!r) return;
  text("#selected-aircraft", r.aircraft); text("#selected-grid", r.grid ?? "Grid unknown"); text("#selected-player", r.player);
  text("#selected-altitude", r.altitudeM === null ? "Altitude unknown" : `${altitude(r.altitudeM, prefs)} ${prefs.altitude}`);
  text("#selected-reporter", ` · Reported by ${r.reporter ?? "unknown"}`);
  document.querySelectorAll<HTMLElement>("[data-target]").forEach(el => {
    const active = el.dataset.target === selectedKey;
    if (el.tagName === "BUTTON") el.setAttribute("aria-pressed", String(active));
    if (el.tagName === "TR") el.classList.toggle("selected", active);
  });
  const container = $("#selected-stats");
  const profile = prefs.playerStats ? profiles.get(r.player) : undefined;
  if (!prefs.playerStats) container.innerHTML = "<p>Public player lookup is off.</p>";
  else if (profile === "pending") container.innerHTML = "<p>Looking up public ThunderSkill stats…</p>";
  else if (profile === "unavailable") container.innerHTML = "<p>Public ThunderSkill stats unavailable.</p>";
  else if (!profile) container.innerHTML = "<p>No public stats lookup for this target.</p>";
  else if (!profile.modes.length) container.innerHTML = "<p>No reported battles in public ThunderSkill stats.</p>";
  else {
    const metric = (value: number | null, kind: "kills" | "kd", battles: number) => {
      if (value === null) return "—";
      const assessment = statColour(value, kind, battles);
      return `<span${assessment ? ` style="color:${assessment.color}" title="${assessment.label} (heuristic, not a percentile)"` : ""}>${value.toFixed(2)}${assessment ? `<span class="visually-hidden">, ${assessment.label} (heuristic, not a percentile)</span>` : ""}</span>`;
    };
    const battles = (value: number) => {
      const assessment = experienceColour(value)!;
      return `<span style="color:${assessment.color}" title="${assessment.label} experience (heuristic, not a percentile)">${value}<span class="visually-hidden">, ${assessment.label} experience (heuristic, not a percentile)</span></span>`;
    };
    container.innerHTML = `<p>ThunderSkill public stats · ${profile.updated ? `updated ${escape(profile.updated)}` : "update date unavailable"} · apparent target, not verified enemy</p><table><thead><tr><th>Mode</th><th>Air kills/battle</th><th>Air K/D</th><th>Battles</th></tr></thead><tbody>${profile.modes.map(m => `<tr><td>${({ a: "Arcade", r: "Realistic", s: "Simulator" })[m.mode]}</td><td>${metric(m.killsPerBattle, "kills", m.battles)}</td><td>${metric(m.airKd, "kd", m.battles)}</td><td>${battles(m.battles)}</td></tr>`).join("")}</tbody></table><p>Mode-wide battles and deaths may include ground play; not current-vehicle statistics. Under 20 battles: low sample, no lethality colour. Experience colour uses 20 / 300 / 1,500 battles as low / typical / high reference points. Labels are heuristic, not percentiles.</p>`;
  }
  updateAges();
}
function updateAges(): void {
  const age = (at: number) => `${Math.max(0, Math.floor((Date.now() - at) / 1000))} sec ago`;
  document.querySelectorAll<HTMLElement>("[data-age]").forEach(el => { el.textContent = age(Number(el.dataset.age)); });
  const r = selectedKey ? liveReports.get(selectedKey) : undefined;
  if (r) text("#selected-age", age(r.receivedAt));
}
function clearReports(): void { profiles.clear(); liveReports.clear(); selectedKey = null; renderReports(); }
function renderChat(): void {
  text("#chat-subtitle", chatStatus === "disconnected" ? "Game chat disconnected." : chatStatus === "connecting" ? "Connecting to local game chat…" : chatStatus === "retrying" ? "Chat unavailable · retrying; previous messages are not current" : "Read-only · initial history is undated; times show arrival in Wolf Pack, not game time");
  $("#chat-list").innerHTML = chatMessages.map(m => `<li><time>${m.receivedAt === null ? "—" : escape(new Date(m.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }))}</time><b>${escape(m.sender ?? "Unknown")}${m.channel === null ? "" : ` · ${escape(m.channel)}`}</b><span>${escape(stripGameColors(m.msg))}</span></li>`).join("") || `<li>${chatStatus === "disconnected" ? "Game disconnected." : chatStatus === "retrying" ? "Waiting for chat; retrying…" : "No messages received."}</li>`;
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
  text("#player-stats-disclosure", prefs.playerStats
    ? "New target nicknames are sent via Wolf Pack to ThunderSkill; turn off in Settings."
    : "Public player lookups are off in Settings.");
  text("#publish-status", !prefs.shareInstruments
    ? "Instrument sharing is off."
    : own && selfId ? "Sharing your flight instruments with the squad."
    : "Sharing starts when the game and squad are connected.");
}
function syncPublishing(): void {
  const current = !!selfId && prefs.shareInstruments ? own : null;
  if (current) { squad?.publish(current); published = true; }
  else if (published) { squad?.publish(null); published = false; }
  renderPublishing();
}
function clearMap(message: string): void {
  mapAt = 0; mapGeneration = null;
  mapImage.hidden = true; mapImage.removeAttribute("src");
  text("#map-status", message); visible("#map-status", true);
}
mapImage.addEventListener("load", () => {
  if (!stopMap || mapGeneration === null) return;
  mapImage.hidden = false; visible("#map-status", false);
});
mapImage.addEventListener("error", () => {
  if (!stopMap) return;
  mapImage.hidden = true; mapImage.removeAttribute("src");
  text("#map-status", "Could not load the local game map. Retrying…"); visible("#map-status", true);
});
function stopGame(): void {
  stopFeed?.(); stopFeed = undefined;
  stopMap?.(); stopMap = undefined;
  stopChat?.(); stopChat = undefined; chatStatus = "disconnected"; chatMessages = []; knownMap = null;
  clearReports(); renderChat();
  own = null; ownAt = 0; lookup.set(null); histories = emptyHistories(); syncPublishing();
  clearMap("Connecting to the local game map…");
  if (selfId && members.has(selfId)) remember({ ...members.get(selfId)!.member, sample: null });
  renderInstruments(); renderSquad();
}
function disconnect(message = "Disconnected from squad."): void {
  generation++; const old = squad; squad = undefined; selfId = undefined; members.clear(); published = false; old?.close();
  connection("squad", "disconnected", "Disconnected");
  enter.disabled = false; leave.disabled = !requestedRoom;
  visible("#invite", false); visible("#copy-invite", false); text("#squad-status", message); renderPublishing(); renderSquad();
}
function joinRequested(): void {
  if (!requestedRoom || squad) return;
  if (!displayName(prefs.player)) { text("#squad-status", "Set a valid player name in Settings first."); return; }
  const key = requestedRoom, token = ++generation;
  try {
    squad = connectSquad({ roomKey: key, name: prefs.player, onStatus(status) {
      if (token !== generation) return;
      if (status === "connecting") { connection("squad", "pending", "Connecting"); enter.disabled = true; leave.disabled = false; text("#squad-status", "Connecting to squad…"); }
      else if (status === "joined") { connection("squad", "connected", "Connected"); roomKey = key; invite.href = inviteUrl(key).href; visible("#invite", true); visible("#copy-invite", true); enter.textContent = "Rejoin squad"; text("#squad-status", "Connected. Share the private invite only with squadmates."); }
      else disconnect("Squad disconnected. Use Rejoin squad or reconnect to retry.");
    }, onMessage(message) { if (token === generation) { roomMessage(message); if (message.type === "welcome") syncPublishing(); } } });
  } catch { disconnect("Could not connect. Check the player name and invite, then retry."); }
}
enter.addEventListener("click", () => {
  if (squad) return;
  if (!displayName(prefs.player)) { text("#squad-status", "Set a valid player name in Settings first."); return; }
  $("#open-squad span").textContent = "Squad";
  requestedRoom = requestedRoom ?? roomKey ?? createRoomKey();
  roomKey = requestedRoom;
  enter.textContent = "Rejoin squad";
  joinRequested();
});
leave.addEventListener("click", () => { requestedRoom = null; disconnect(); });
$("#copy-invite").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(invite.href); text("#squad-status", "Invite copied. Share it privately."); }
  catch { text("#squad-status", "Copy unavailable. Use the invite link instead."); }
});
function startGame(): void {
  connection("game", "pending", "Connecting");
  text("#feed-status", "Connecting to the local game. Allow loopback access if prompted.");
  text("#map-status", "Connecting to the local game map…");
  chatStatus = "connecting"; renderChat(); renderReports();
  stopChat = watchChat(update => {
    const statusChanged = chatStatus !== update.status;
    chatStatus = update.status; chatMessages = update.messages;
    if (update.reset) clearReports();
    let reportsChanged = false;
    for (const message of update.fresh) {
      const report = parseSighting(message);
      if (!report) continue;
      reportsChanged = true;
      if (prefs.playerStats) profiles.add(report.player);
      liveReports.delete(report.key); liveReports.set(report.key, report);
      while (liveReports.size > 100) liveReports.delete(liveReports.keys().next().value!);
      if (!selectedKey || !liveReports.has(selectedKey)) selectedKey = report.key;
    }
    if (statusChanged || update.fresh.length || update.reset) renderChat();
    if (statusChanged || reportsChanged || update.reset) renderReports();
  });
  stopFeed = watchTelemetry(update => {
    own = update.sample; ownAt = own ? performance.now() : 0; lookup.set(own?.aircraft ?? null); syncPublishing();
    connection("game", update.status === "live" || update.status === "waiting" ? "connected" : "disconnected", update.status === "live" ? "Connected" : update.status === "waiting" ? "Connected; instruments unavailable" : update.status === "denied" ? "Loopback access denied" : "Unreachable; retrying");
    if (own) addHistory(histories, own); else histories = emptyHistories();
    if (selfId && members.has(selfId)) remember({ ...members.get(selfId)!.member, sample: own });
    if (update.status === "denied") {
      stopGame();
      clearMap("Game map unavailable: loopback access denied.");
      text("#feed-status", "Loopback access denied. Allow it in browser site settings, then use Reconnect game and squad.");
    }
    else if (update.status === "unreachable") text("#feed-status", "Cannot reach War Thunder. Check the game and browser loopback access; retrying.");
    else if (update.status === "waiting") text("#feed-status", "Game connected; aircraft instruments are unavailable.");
    else text("#feed-status", `Connected to local game instruments · ${update.sample?.aircraft ?? "Aircraft"} · recent history`);
    renderInstruments(); renderSquad();
  });
  stopMap = watchMap(update => {
    if (update.status !== "ready") {
      if (update.status === "invalid" && knownMap !== null) { clearReports(); knownMap = null; }
      clearMap(update.status === "waiting" || update.status === "invalid" ? "Game map unavailable; waiting for a valid map." : "Cannot reach game map metadata. Retrying…"); return;
    }
    if (knownMap !== null && knownMap !== update.generation) clearReports();
    knownMap = update.generation;
    mapAt = performance.now();
    if (mapGeneration !== update.generation || !mapImage.hasAttribute("src")) {
      mapGeneration = update.generation; mapImage.hidden = true;
      text("#map-status", "Loading local game map…"); visible("#map-status", true);
      mapImage.src = `${GAME_ORIGIN}/map.img?gen=${update.generation}`;
    }
  });
}
$("#reconnect").addEventListener("click", () => {
  stopGame();
  startGame();
  if (requestedRoom) { disconnect("Reconnecting to squad…"); joinRequested(); }
});
document.addEventListener("click", event => {
  const target = (event.target as Element).closest<HTMLButtonElement>("button[data-target]");
  if (target?.dataset.target && liveReports.has(target.dataset.target)) { selectedKey = target.dataset.target; updateSelection(); }
});

const dialog = $<HTMLDialogElement>("#settings-dialog");
const form = $<HTMLFormElement>("#settings-form");
form.noValidate = true; // Validate after selecting the tab containing a bad field.
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
function section(name: string): void {
  for (const id of ["configuration", "display"]) { visible(`#${id}`, id === name); $(`[data-section="${id}"]`).setAttribute("aria-pressed", String(id === name)); }
}
$("#open-settings").addEventListener("click", () => {
  for (const name of ["player", ...Object.keys(choices)] as (keyof Preferences)[]) field(name).value = String(prefs[name]);
  (field("playerStats") as HTMLInputElement).checked = prefs.playerStats;
  field("endpoint").value = GAME_ORIGIN; section("configuration"); dialog.showModal();
});
document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach(button => button.addEventListener("click", () => section(button.dataset.section!)));
$("#close-settings").addEventListener("click", () => dialog.close());
$("#cancel-settings").addEventListener("click", () => dialog.close());
form.addEventListener("submit", event => {
  event.preventDefault();
  const player = field("player");
  player.setCustomValidity(displayName(player.value) ? "" : "Enter a name of up to 32 characters without control characters.");
  if (!player.checkValidity()) { section("configuration"); player.reportValidity(); return; }
  const candidate = Object.fromEntries(["player", ...Object.keys(choices)].map(name => [name, field(name).value]));
  prefs = preferences({ ...prefs, ...candidate, playerStats: (field("playerStats") as HTMLInputElement).checked }); if (!prefs.playerStats) profiles.clear(); savePrefs(); dialog.close(); syncPublishing();
  renderInstruments(); renderSquad(); renderReports();
  if (squad) text("#squad-status", "Preferences saved. Player name changes apply on rejoin.");
});
const squadPopover = $("#squad-popover");
const squadForm = $<HTMLFormElement>("#squad-form");
const squadName = squadForm.elements.namedItem("squad") as HTMLInputElement;
const squadSharing = squadForm.elements.namedItem("shareInstruments") as HTMLInputElement;
squadName.addEventListener("input", () => squadName.setCustomValidity(""));
squadPopover.addEventListener("beforetoggle", event => {
  if ((event as ToggleEvent).newState === "open") {
    squadName.value = prefs.squad; squadName.setCustomValidity(""); squadSharing.checked = prefs.shareInstruments;
  }
});
squadForm.addEventListener("submit", event => {
  event.preventDefault();
  squadName.setCustomValidity(displayName(squadName.value) ? "" : "Enter a name of up to 32 characters without control characters.");
  if (!squadName.reportValidity()) return;
  prefs = preferences({ ...prefs, squad: squadName.value, shareInstruments: squadSharing.checked });
  savePrefs(); syncPublishing(); squadPopover.hidePopover();
});
function updateInviteAction(): void {
  enter.textContent = roomKey ? "Join squad" : "Create squad";
  $("#open-squad span").textContent = roomKey ? "Join squad" : "Squad";
}
updateInviteAction();
window.addEventListener("hashchange", () => {
  if (!squad && !requestedRoom) { roomKey = inviteKey(); updateInviteAction(); }
});
connection("squad", "disconnected", "Disconnected");
renderPublishing(); renderInstruments(); renderSquad(); renderReports(); renderChat();
startGame();
setInterval(() => {
  let changed = false;
  for (const { member, seenAt } of members.values()) if (member.sample && performance.now() - seenAt >= SAMPLE_LIFETIME_MS) { member.sample = null; changed = true; }
  if (own && performance.now() - ownAt >= SAMPLE_LIFETIME_MS) {
    own = null; ownAt = 0; lookup.set(null); histories = emptyHistories(); syncPublishing();
    connection("game", "pending", "Readings stale; waiting for game");
    text("#feed-status", "Readings are stale; waiting for the local game."); renderInstruments(); changed = true;
  }
  if (mapAt && performance.now() - mapAt >= SAMPLE_LIFETIME_MS) clearMap("Game map is stale; waiting for metadata.");
  if (changed) renderSquad();
  updateAges();
}, 1000);
