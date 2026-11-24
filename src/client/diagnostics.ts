import { createRoomKey, SAMPLE_LIFETIME_MS } from "../shared/protocol.ts";
import type { Member, ServerMessage } from "../shared/protocol.ts";
import { connectSquad, inviteKey, inviteUrl } from "./squad.ts";
import { watchTelemetry } from "./telemetry.ts";

const form = document.querySelector<HTMLFormElement>("#squad")!;
const name = document.querySelector<HTMLInputElement>("#name")!;
const enter = document.querySelector<HTMLButtonElement>("#enter")!;
const leave = document.querySelector<HTMLButtonElement>("#leave")!;
const invite = document.querySelector<HTMLAnchorElement>("#invite")!;
const share = document.querySelector<HTMLButtonElement>("#share")!;
const squadStatus = document.querySelector("#squad-status")!;
const feedStatus = document.querySelector("#feed-status")!;
const list = document.querySelector("#members")!;
const members = new Map<string, { member: Member; seenAt: number }>();
let roomKey = inviteKey();
let squad: ReturnType<typeof connectSquad> | undefined;
let stopFeed: (() => void) | undefined;
let selfId: string | undefined;
let wasLive = false;

function showMembers(): void {
  list.replaceChildren(...Array.from(members.values(), ({ member }) => {
    const li = document.createElement("li");
    const reading = member.sample;
    const label = member.name + (member.id === selfId ? " (you)" : "");
    li.textContent = reading
      ? `${label}: ${reading.aircraft ?? "aircraft"} · IAS ${reading.iasKph ?? "—"} km/h · altitude ${reading.altitudeM ?? "—"} m`
      : `${label}: not sharing`;
    return li;
  }));
}

function updateRoom(message: ServerMessage): void {
  if (message.type === "welcome") {
    members.clear();
    selfId = message.selfId;
    for (const member of message.members) remember(member);
  } else if (message.type === "member") {
    remember(message.member);
  } else {
    members.delete(message.id);
  }
  showMembers();
}

function remember(member: Member): void {
  members.set(member.id, { member, seenAt: performance.now() });
}

function expireReadings(): void {
  let changed = false;
  for (const { member, seenAt } of members.values()) {
    if (member.sample && performance.now() - seenAt >= SAMPLE_LIFETIME_MS) {
      member.sample = null;
      changed = true;
    }
  }
  if (changed) showMembers();
}

function stopSharing(): void {
  stopFeed?.();
  stopFeed = undefined;
  if (wasLive) squad?.publish(null);
  wasLive = false;
  if (selfId && members.has(selfId)) {
    members.get(selfId)!.member.sample = null;
    showMembers();
  }
  share.textContent = "Share game instruments";
  feedStatus.textContent = "Not sharing game instruments.";
}

enter.textContent = roomKey ? "Join squad" : "Create squad";
form.addEventListener("submit", event => {
  event.preventDefault();
  if (squad) return;
  const key = roomKey ?? createRoomKey();
  try {
    squad = connectSquad({
      roomKey: key,
      name: name.value,
      onStatus(status) {
        enter.disabled = status !== "disconnected";
        leave.disabled = status === "disconnected";
        share.disabled = status !== "joined";
        if (status === "connecting") {
          squadStatus.textContent = "Connecting to squad…";
        } else if (status === "joined") {
          roomKey = key;
          invite.href = inviteUrl(key).href;
          invite.hidden = false;
          enter.textContent = "Rejoin squad";
          squadStatus.textContent = "Connected. Copy the invite link to bring in a squadmate.";
        } else {
          stopSharing();
          squad = undefined;
          selfId = undefined;
          members.clear();
          showMembers();
          squadStatus.textContent = "Disconnected.";
        }
      },
      onMessage: updateRoom,
    });
  } catch {
    squadStatus.textContent = "Couldn’t connect. Check your display name and invite.";
  }
});
leave.addEventListener("click", () => squad?.close());
share.addEventListener("click", () => {
  if (stopFeed) return stopSharing();
  share.textContent = "Stop sharing";
  feedStatus.textContent = "Connecting to the local game. Allow loopback access if prompted.";
  stopFeed = watchTelemetry(update => {
    if (update.sample || wasLive) squad?.publish(update.sample);
    wasLive = update.sample !== null;
    if (selfId && members.has(selfId)) remember({ ...members.get(selfId)!.member, sample: update.sample });
    showMembers();
    if (update.status === "denied") {
      stopSharing();
      feedStatus.textContent = "Allow loopback network access in site settings, then retry.";
    } else if (update.status === "unreachable") {
      feedStatus.textContent = "Can’t reach War Thunder. Check that it is running on this computer and that your browser allows loopback access.";
    } else if (update.status === "waiting") {
      feedStatus.textContent = "Game connected. Spawn in an aircraft for instruments.";
    } else {
      feedStatus.textContent = "Sharing flight instruments.";
    }
  });
});
setInterval(expireReadings, 1_000);
