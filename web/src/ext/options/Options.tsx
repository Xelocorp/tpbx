import { useEffect, useState } from "react";
import { STORAGE_KEY, type Cmd } from "../proto";
import { wext } from "../wext";

export default function Options() {
  const [server, setServer] = useState("");
  const [extension, setExtension] = useState("");
  const [password, setPassword] = useState("");
  const [mic, setMic] = useState<"unknown" | "ok" | "denied">("unknown");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void wext.storage.local.get(STORAGE_KEY).then((o: Record<string, unknown>) => {
      const c = o?.[STORAGE_KEY] as { server?: string; extension?: string; password?: string } | undefined;
      if (c) {
        setServer(c.server ?? "");
        setExtension(c.extension ?? "");
        setPassword(c.password ?? "");
      }
    });
  }, []);

  // Requesting the mic from this extension page grants it for the whole
  // extension origin, so the background/offscreen engine can then use it.
  const grantMic = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMic("ok");
    } catch {
      setMic("denied");
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = server.trim().replace(/\/+$/, "");
    const cmd: Cmd = { t: "login", server: clean, extension: extension.trim(), password };
    // Persist + tell the engine to (re)connect.
    const p = wext.runtime.sendMessage(cmd);
    if (p && typeof p.catch === "function") p.catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <form className="login-card" onSubmit={save} style={{ margin: "40px auto" }}>
      <div className="login-brand">
        <h1>TPBX</h1>
        <div className="login-sub">Softphone setup</div>
      </div>

      <label>
        Server URL
        <input
          value={server}
          placeholder="https://pbx.eko.bz"
          onChange={(e) => setServer(e.target.value)}
        />
      </label>
      <label>
        Extension
        <input value={extension} placeholder="1001" onChange={(e) => setExtension(e.target.value)} />
      </label>
      <label>
        SIP password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>

      <button type="button" className="btn ghost" onClick={grantMic}>
        {mic === "ok" ? "Microphone ✓" : mic === "denied" ? "Microphone blocked — retry" : "Grant microphone"}
      </button>
      <p className="hint-inline">
        Grant the microphone once here so background calls have audio. The server
        URL is your TPBX console address; the extension + SIP password are the
        same you use on the web softphone.
      </p>

      <button className="btn" type="submit">
        {saved ? "Saved ✓" : "Save & connect"}
      </button>
    </form>
  );
}
