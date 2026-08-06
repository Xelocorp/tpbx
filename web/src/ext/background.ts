// Firefox background-page entry: Firefox has no offscreen documents, but its
// background page can run WebRTC/audio directly, so it hosts both the SIP
// engine and the notifier.
import { Engine } from "./engine";
import { installNotifier } from "./notifier";

new Engine();
installNotifier();
