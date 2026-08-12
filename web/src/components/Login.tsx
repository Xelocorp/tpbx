import { useState } from "react";
import { isTotpRequired, login, type Me } from "../api";
import logoLight from "../assets/xelo-light.png";

export default function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await login(username, password, needTotp ? totpCode : undefined);
      if (isTotpRequired(res)) {
        // Password accepted; the account has 2FA — ask for the code.
        setNeedTotp(true);
        setError("");
      } else {
        onLogin(res);
      }
    } catch (err) {
      setError((err as Error).message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img className="brand-logo lg" src={logoLight} alt="XeloVoice" />
          <div className="rev">CONTROL CONSOLE</div>
        </div>
        {!needTotp ? (
          <>
            <label>
              Username
              <input
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
          </>
        ) : (
          <label>
            Authentication code
            <input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <span className="hint-inline">Enter the 6-digit code from your authenticator app.</span>
          </label>
        )}
        {error && <div className="login-error">{error}</div>}
        <button className="btn" type="submit" disabled={busy || (needTotp && totpCode.length !== 6)}>
          {busy ? "Signing in…" : needTotp ? "Verify" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
