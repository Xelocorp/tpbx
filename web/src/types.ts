// Shared UI types.

// Toast is a transient feedback message shown after an action.
export interface Toast {
  kind: "ok" | "err";
  text: string;
}

// Notify shows a toast; provided by the app shell to every view.
export type Notify = (t: Toast) => void;
