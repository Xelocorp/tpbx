// Cross-browser WebExtension API handle. Firefox exposes `browser` (promises);
// Chrome exposes `chrome` (promises for most MV3 APIs). Both accept `chrome`,
// so we prefer `browser` when present and fall back to `chrome`.
//
// Typed loosely as any to avoid pulling in @types/chrome for this build.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const wext: any = (globalThis as any).browser ?? (globalThis as any).chrome;

export const isFirefox = typeof (globalThis as any).browser !== "undefined";
