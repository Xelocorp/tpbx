import { useCallback, useEffect, useState } from "react";
import { getPJSIPSettings, savePJSIPSettings, type PJSIPSettings } from "../api";
import type { Notify } from "../types";

const TLS_METHODS = ["tlsv1_2", "tlsv1_3", "tlsv1_1", "sslv23"];
const OVERLOAD_TRIGGERS: PJSIPSettings["taskprocessorOverloadTrigger"][] = ["global", "pjsip_only", "none"];
const IDENTIFIER_TOKENS = ["ip", "username", "anonymous", "header", "auth_username"];

// YesNo is the two-button segmented toggle used across the PJSIP settings panel,
// mirroring the reference UI.
function YesNo({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="yesno">
      <button
        type="button"
        className={`yesno-btn ${value ? "on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(true)}
      >
        Yes
      </button>
      <button
        type="button"
        className={`yesno-btn ${!value ? "on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(false)}
      >
        No
      </button>
    </div>
  );
}

// PJSIPPanel edits the res_pjsip [global] options and TLS defaults (the "Misc
// PJSip Settings" and "TLS/SSL/SRTP Settings" panels from the reference UI). It
// lives on the Settings page's SIP / PJSIP tab; onSaved lets the parent surface
// the "restart to fully apply" hint.
export default function PJSIPPanel({
  notify,
  canEdit,
  onSaved,
}: {
  notify: Notify;
  canEdit: boolean;
  onSaved?: () => void;
}) {
  const [s, setS] = useState<PJSIPSettings | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getPJSIPSettings()
      .then(setS)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [notify]);
  useEffect(load, [load]);

  if (!s) {
    return (
      <section className="panel">
        <header>PJSIP &amp; TLS Settings</header>
        <div className="empty">Loading…</div>
      </section>
    );
  }

  const set = <K extends keyof PJSIPSettings>(k: K, v: PJSIPSettings[K]) =>
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));

  const identTokens = s.endpointIdentifierOrder
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const toggleIdent = (tok: string) => {
    const has = identTokens.includes(tok);
    const next = has ? identTokens.filter((t) => t !== tok) : [...identTokens, tok];
    set("endpointIdentifierOrder", next.join(","));
  };

  const save = async () => {
    setBusy(true);
    try {
      await savePJSIPSettings(s);
      notify({ kind: "ok", text: "PJSIP settings saved. A restart fully applies global/TLS changes." });
      onSaved?.();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="panel">
        <header>Misc PJSip Settings</header>
        <div className="form">
          <div className="settings-row">
            <span>Allow Transports Reload</span>
            <YesNo value={s.allowTransportsReload} disabled={!canEdit} onChange={(v) => set("allowTransportsReload", v)} />
          </div>
          <div className="settings-row">
            <span>Enable Debug</span>
            <YesNo value={s.enableDebug} disabled={!canEdit} onChange={(v) => set("enableDebug", v)} />
          </div>
          <div className="settings-row">
            <span>Keep Alive Interval</span>
            <input
              type="number"
              min={0}
              max={3600}
              disabled={!canEdit}
              value={s.keepAliveInterval}
              onChange={(e) => set("keepAliveInterval", Number(e.target.value))}
              style={{ maxWidth: 120 }}
            />
          </div>
          <div className="settings-row">
            <span>Caller ID into Contact Header</span>
            <YesNo value={s.contactCallerId} disabled={!canEdit} onChange={(v) => set("contactCallerId", v)} />
          </div>
          <div className="settings-row">
            <span>Taskprocessor Overload Trigger</span>
            <div className="seg">
              {OVERLOAD_TRIGGERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`seg-btn ${s.taskprocessorOverloadTrigger === t ? "on" : ""}`}
                  disabled={!canEdit}
                  onClick={() => set("taskprocessorOverloadTrigger", t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <span>Endpoint Identifier Order</span>
            <div className="seg">
              {IDENTIFIER_TOKENS.map((tok) => (
                <button
                  key={tok}
                  type="button"
                  className={`seg-btn ${identTokens.includes(tok) ? "on" : ""}`}
                  disabled={!canEdit}
                  onClick={() => toggleIdent(tok)}
                  title="Click to toggle; order follows click order"
                >
                  {tok}
                </button>
              ))}
            </div>
          </div>
          <p className="hint-inline">
            Identifier order (left to right): <code>{s.endpointIdentifierOrder || "—"}</code>
          </p>
        </div>
      </section>

      <section className="panel">
        <header>TLS/SSL/SRTP Settings</header>
        <div className="form">
          <div className="settings-row">
            <span>Certificate Manager</span>
            <input
              disabled={!canEdit}
              placeholder="certificate label (e.g. wildcard)"
              value={s.certName}
              onChange={(e) => set("certName", e.target.value)}
            />
          </div>
          <div className="settings-row">
            <span>SSL Method</span>
            <select disabled={!canEdit} value={s.tlsMethod} onChange={(e) => set("tlsMethod", e.target.value)}>
              {TLS_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <span>Verify Client</span>
            <YesNo value={s.verifyClient} disabled={!canEdit} onChange={(v) => set("verifyClient", v)} />
          </div>
          <div className="settings-row">
            <span>Verify Server</span>
            <YesNo value={s.verifyServer} disabled={!canEdit} onChange={(v) => set("verifyServer", v)} />
          </div>
          {canEdit && (
            <div className="form-actions">
              <button className="btn" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save PJSIP settings"}
              </button>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
