import { useCallback, useEffect, useState } from "react";
import {
  changePassword,
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  type GuiUser,
  type Me,
} from "../api";
import type { Notify } from "../types";

const ROLES = ["admin", "manager", "operator", "viewer"];

export default function Users({ notify, me }: { notify: Notify; me: Me }) {
  const [rows, setRows] = useState<GuiUser[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    listUsers()
      .then(setRows)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [notify]);

  useEffect(refresh, [refresh]);

  const del = async (u: string) => {
    if (!confirm(`Delete user ${u}?`)) return;
    try {
      await deleteUser(u);
      notify({ kind: "ok", text: `Deleted ${u}` });
      refresh();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  const resetPw = async (u: string) => {
    const pw = prompt(`New password for ${u} (min 6 chars):`);
    if (!pw) return;
    try {
      await resetUserPassword(u, pw);
      notify({ kind: "ok", text: `Password reset for ${u}` });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  const changeOwn = async () => {
    const pw = prompt("New password for your account (min 6 chars):");
    if (!pw) return;
    try {
      await changePassword(pw);
      notify({ kind: "ok", text: "Your password was changed" });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Users</h2>
        <div>
          <button className="btn ghost small" onClick={changeOwn}>
            Change my password
          </button>
          <button className="btn" onClick={() => setCreating(true)}>
            + New User
          </button>
        </div>
      </div>

      <section className="panel">
        <header>Console Accounts</header>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Name</th>
              <th>Last login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.username}>
                <td>{u.username}{u.username === me.username ? " (you)" : ""}</td>
                <td>
                  <span className="badge">{u.role}</span>
                </td>
                <td>{u.displayName || "-"}</td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
                <td className="row-action">
                  <button className="btn small" onClick={() => resetPw(u.username)}>
                    Reset PW
                  </button>
                  {u.username !== me.username && (
                    <button className="btn danger" onClick={() => del(u.username)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {creating && (
        <NewUser
          onClose={() => setCreating(false)}
          onSaved={(m) => {
            notify({ kind: "ok", text: m });
            setCreating(false);
            refresh();
          }}
          onError={(m) => notify({ kind: "err", text: m })}
        />
      )}
    </>
  );
}

function NewUser({
  onClose,
  onSaved,
  onError,
}: {
  onClose: () => void;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("operator");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await createUser({ username, password, role, displayName });
      onSaved(`Created user ${username}`);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>New User</header>
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Password
              <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Saving…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
