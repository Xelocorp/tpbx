// Desktop-notification + download handling, shared by the Chrome service
// worker and the Firefox background page. Listens for engine events and raises
// an OS notification for incoming calls (with Answer/Decline), and hands
// finished recordings to the downloads API.

import type { Cmd, Evt } from "./proto";
import { wext } from "./wext";

const NID = "tpbx-incoming";

// A tiny embedded icon so notifications work without shipping a binary asset.
// Replace with a real 128px icon for production polish.
const ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function send(cmd: Cmd): void {
  try {
    const p = wext.runtime.sendMessage(cmd);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* no receiver */
  }
}

function openPopup(): void {
  try {
    const p = wext.action?.openPopup?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* not supported on this version */
  }
}

export function installNotifier(): void {
  wext.runtime.onMessage.addListener((ev: Evt) => {
    if (!ev || typeof (ev as { t?: unknown }).t !== "string") return;
    if (ev.t === "incoming") {
      wext.notifications?.create?.(NID, {
        type: "basic",
        iconUrl: ICON,
        title: "Incoming call",
        message: ev.from,
        buttons: [{ title: "Answer" }, { title: "Decline" }],
        requireInteraction: true,
        priority: 2,
      });
    } else if (ev.t === "callcleared") {
      wext.notifications?.clear?.(NID);
    } else if (ev.t === "download") {
      wext.downloads?.download?.({ url: ev.url, filename: ev.name });
    }
  });

  wext.notifications?.onButtonClicked?.addListener((id: string, idx: number) => {
    if (id !== NID) return;
    send(idx === 0 ? { t: "answer" } : { t: "reject" });
    wext.notifications.clear(NID);
    if (idx === 0) openPopup();
  });

  wext.notifications?.onClicked?.addListener((id: string) => {
    if (id === NID) openPopup();
  });
}
