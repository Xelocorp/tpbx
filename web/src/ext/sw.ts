// Chrome MV3 service worker. It cannot run WebRTC itself, so it hosts the SIP
// engine in an offscreen document and keeps that document alive; it also owns
// notifications/downloads (the offscreen document has no access to those APIs).

import { installNotifier } from "./notifier";
import { wext } from "./wext";

const OFFSCREEN_URL = "offscreen.html";

async function ensureOffscreen(): Promise<void> {
  try {
    if (wext.offscreen.hasDocument && (await wext.offscreen.hasDocument())) return;
  } catch {
    /* fall through to create */
  }
  try {
    await wext.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA", "WEB_RTC", "AUDIO_PLAYBACK"],
      justification: "Keep the SIP registration, microphone and call audio alive for the softphone.",
    });
  } catch {
    /* already exists (race) */
  }
}

wext.runtime.onStartup?.addListener?.(() => void ensureOffscreen());
wext.runtime.onInstalled?.addListener?.(() => void ensureOffscreen());

// Keepalive: the alarm wakes the worker periodically and re-creates the
// offscreen document if it ever went away. The offscreen doc itself persists
// independently of the worker while it holds the live WebSocket.
wext.alarms?.create?.("keepalive", { periodInMinutes: 0.5 });
wext.alarms?.onAlarm?.addListener?.(() => void ensureOffscreen());

installNotifier();
void ensureOffscreen();
