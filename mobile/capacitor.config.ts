import type { CapacitorConfig } from "@capacitor/cli";

// The web assets are the shared softphone bundle (built by Vite into dist/),
// wrapped as a native Android app. Register/media use WSS/WebRTC in the
// WebView; raw UDP/TCP/TLS is not available here (see docs/ANDROID.md).
const config: CapacitorConfig = {
  appId: "com.xelocorp.xelovoice",
  appName: "XeloVoice Softphone",
  webDir: "dist",
};

export default config;
