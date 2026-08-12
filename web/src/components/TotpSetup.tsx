import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { activateTotp, enrollTotp } from "../api";

// TotpSetup walks a user through enrolling an authenticator app: it starts a
// server-side enrolment, renders the otpauth QR + manual key, then confirms a
// six-digit code. Used both for voluntary enrolment and the mandatory setup
// gate (when a role requires two-factor). `onCancel` is omitted for the
// mandatory flow so the step cannot be skipped.
export default function TotpSetup({
  onDone,
  onCancel,
  onError,
}: {
  onDone: (msg: string) => void;
  onCancel?: () => void;
  onError?: (msg: string) => void;
}) {
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState("");

  const fail = (m: string) => {
    setError(m);
    onError?.(m);
  };

  useEffect(() => {
    let alive = true;
    enrollTotp()
      .then(async (r) => {
        if (!alive) return;
        setSecret(r.secret);
        try {
          setQr(await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 200 }));
        } catch {
          setQr("");
        }
      })
      .catch((e) => alive && fail((e as Error).message))
      .finally(() => alive && setStarting(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await activateTotp(code.trim());
      onDone("Two-factor authentication is now enabled.");
    } catch (err) {
      fail((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form totp-setup" onSubmit={confirm}>
      <p className="hint-inline">
        Scan this QR code with Google Authenticator (or any compatible app),
        then enter the 6-digit code it shows to finish setup.
      </p>
      {starting ? (
        <div className="empty">Preparing…</div>
      ) : (
        <>
          {qr && <img className="totp-qr" src={qr} alt="TOTP QR code" />}
          <label>
            Or enter this key manually
            <input readOnly value={secret} onFocus={(e) => e.target.select()} />
          </label>
          <label>
            Authentication code
            <input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </label>
          {error && <div className="login-error">{error}</div>}
          <div className="form-actions">
            {onCancel && (
              <button type="button" className="btn ghost" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn" disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Enable two-factor"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
