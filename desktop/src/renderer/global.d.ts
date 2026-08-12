import type { SipNative } from "../main/preload";

declare global {
  interface Window {
    sipNative: SipNative;
  }
}

export {};
