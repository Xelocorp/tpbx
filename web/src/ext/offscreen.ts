// Chrome offscreen-document entry: hosts the SIP engine (WebRTC + audio + the
// live WebSocket registration). Kept alive by the service worker.
import { Engine } from "./engine";

new Engine();
