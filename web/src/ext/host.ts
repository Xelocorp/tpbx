// Storage host for the Chrome service worker. The offscreen engine has no
// chrome.storage, so the worker owns it: it seeds the engine with the stored
// credentials + call log on request, persists new credentials/log, and clears
// them on logout. (Firefox doesn't use this — its background page has storage
// and the engine persists directly.)

import { LOG_KEY, STORAGE_KEY, type Cmd, type Evt } from "./proto";
import { wext } from "./wext";

function send(cmd: Cmd): void {
  try {
    const p = wext.runtime.sendMessage(cmd);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* no receiver */
  }
}

async function seedEngine(): Promise<void> {
  const o = await wext.storage.local.get([STORAGE_KEY, LOG_KEY]);
  send({ t: "initlog", log: o?.[LOG_KEY] ?? [] });
  const cfg = o?.[STORAGE_KEY];
  if (cfg?.server && cfg?.extension && cfg?.password) {
    send({ t: "login", server: cfg.server, extension: cfg.extension, password: cfg.password });
  }
}

export function installHost(): void {
  wext.runtime.onMessage.addListener((msg: Evt | Cmd) => {
    const t = (msg as { t?: string })?.t;
    if (t === "ready") {
      void seedEngine();
    } else if (t === "snapshot") {
      const log = (msg as Extract<Evt, { t: "snapshot" }>).snap?.log;
      if (log) void wext.storage.local.set({ [LOG_KEY]: log });
    } else if (t === "login") {
      const c = msg as Extract<Cmd, { t: "login" }>;
      void wext.storage.local.set({ [STORAGE_KEY]: { server: c.server, extension: c.extension, password: c.password } });
    } else if (t === "logout") {
      void wext.storage.local.remove(STORAGE_KEY);
    }
  });
}
