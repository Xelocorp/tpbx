import { useCallback, useEffect, useState } from "react";
import {
  can,
  changePassword,
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  listRoles,
  listUsers,
  resetUserPassword,
  updateRole,
  updateUser,
  type Action,
  type Feature,
  type GuiUser,
  type Me,
  type Perm,
  type Permissions,
  type Role,
} from "../api";
import type { Notify } from "../types";

const ACTION_LABEL: Record<Action, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
};

const emptyPerm: Perm = { view: false, create: false, edit: false, delete: false };

export default function Users({ notify, me }: { notify: Notify; me: Me }) {
  const [rows, setRows] = useState<GuiUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [creating, setCreating] = useState(false);
  const [editingUser, setEditingUser] = useState<GuiUser | null>(null);
  const [editingRole, setEditingRole] = useState<Role | "new" | null>(null);

  const canCreate = can(me, "users", "create");
  const canEdit = can(me, "users", "edit");
  const canDelete = can(me, "users", "delete");
  const isAdmin = me.role === "admin";

  const refreshUsers = useCallback(() => {
    listUsers()
      .then(setRows)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [notify]);

  const refreshRoles = useCallback(() => {
    listRoles()
      .then((r) => {
        setRoles(r.roles);
        setFeatures(r.features);
        setActions(r.actions);
      })
      .catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [notify]);

  useEffect(() => {
    refreshUsers();
    if (isAdmin) refreshRoles();
  }, [refreshUsers, refreshRoles, isAdmin]);

  const roleNames = roles.length ? roles.map((r) => r.name) : ["admin", "manager", "operator", "viewer"];

  const del = async (u: string) => {
    if (!confirm(`Delete user ${u}?`)) return;
    try {
      await deleteUser(u);
      notify({ kind: "ok", text: `Deleted ${u}` });
      refreshUsers();
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

  const delRole = async (name: string) => {
    if (!confirm(`Delete role ${name}?`)) return;
    try {
      await deleteRole(name);
      notify({ kind: "ok", text: `Deleted role ${name}` });
      refreshRoles();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Users &amp; Roles</h2>
        <div className="row-action">
          <button className="btn ghost small" onClick={changeOwn}>
            Change my password
          </button>
          {canCreate && (
            <button className="btn" onClick={() => setCreating(true)}>
              + New User
            </button>
          )}
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
              <th>Status</th>
              <th>Last login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.username}>
                <td>
                  {u.username}
                  {u.username === me.username ? " (you)" : ""}
                </td>
                <td>
                  <span className="badge">{u.role}</span>
                </td>
                <td>{u.displayName || "-"}</td>
                <td>
                  {u.disabled ? <span className="badge warn">disabled</span> : <span className="badge ok">active</span>}
                </td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
                <td className="row-action">
                  {canEdit && (
                    <button className="btn small" onClick={() => setEditingUser(u)}>
                      Edit
                    </button>
                  )}
                  {canEdit && (
                    <button className="btn small" onClick={() => resetPw(u.username)}>
                      Reset PW
                    </button>
                  )}
                  {canDelete && u.username !== me.username && (
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

      {isAdmin && (
        <section className="panel">
          <header>
            Roles &amp; Permissions
            <button className="btn small" style={{ float: "right" }} onClick={() => setEditingRole("new")}>
              + New Role
            </button>
          </header>
          <p className="hint-inline" style={{ padding: "10px 14px 0" }}>
            A role is a named set of feature permissions. For each feature you
            can allow any of view / create / edit / delete. Assign a role to a
            user above. The built-in <strong>admin</strong> role always has full
            access and cannot be changed.
          </p>
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Features allowed</th>
                <th>2FA</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.name}>
                  <td>
                    <strong>{r.name}</strong>
                    {r.displayName ? <div className="hint-inline">{r.displayName}</div> : null}
                  </td>
                  <td>
                    <RoleSummary role={r} features={features} />
                  </td>
                  <td>{r.requireTotp ? <span className="badge">required</span> : "-"}</td>
                  <td className="row-action">
                    {r.builtIn ? (
                      <span className="hint-inline">built-in</span>
                    ) : (
                      <>
                        <button className="btn small" onClick={() => setEditingRole(r)}>
                          Edit
                        </button>
                        <button className="btn danger" onClick={() => delRole(r.name)}>
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {creating && (
        <NewUser
          roles={roleNames}
          onClose={() => setCreating(false)}
          onSaved={(m) => {
            notify({ kind: "ok", text: m });
            setCreating(false);
            refreshUsers();
          }}
          onError={(m) => notify({ kind: "err", text: m })}
        />
      )}

      {editingUser && (
        <EditUser
          user={editingUser}
          roles={roleNames}
          onClose={() => setEditingUser(null)}
          onSaved={(m) => {
            notify({ kind: "ok", text: m });
            setEditingUser(null);
            refreshUsers();
          }}
          onError={(m) => notify({ kind: "err", text: m })}
        />
      )}

      {editingRole && (
        <RoleEditor
          role={editingRole === "new" ? null : editingRole}
          features={features}
          actions={actions}
          onClose={() => setEditingRole(null)}
          onSaved={(m) => {
            notify({ kind: "ok", text: m });
            setEditingRole(null);
            refreshRoles();
          }}
          onError={(m) => notify({ kind: "err", text: m })}
        />
      )}
    </>
  );
}

// RoleSummary renders the compact "which features" cell for the roles table.
function RoleSummary({ role, features }: { role: Role; features: Feature[] }) {
  const allowed = features.filter((f) => role.permissions[f]?.view);
  if (!allowed.length) return <span className="hint-inline">none</span>;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {allowed.map((f) => {
        const p = role.permissions[f]!;
        const letters = [p.create && "C", p.edit && "E", p.delete && "D"].filter(Boolean).join("");
        return (
          <span key={f} className="badge" title={`${f}: view${letters ? " + " + letters : ""}`}>
            {f}
            {letters ? ` ${letters}` : ""}
          </span>
        );
      })}
    </span>
  );
}

function NewUser({
  roles,
  onClose,
  onSaved,
  onError,
}: {
  roles: string[];
  onClose: () => void;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(roles.includes("operator") ? "operator" : roles[0] || "");
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
                {roles.map((r) => (
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

function EditUser({
  user,
  roles,
  onClose,
  onSaved,
  onError,
}: {
  user: GuiUser;
  roles: string[];
  onClose: () => void;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [role, setRole] = useState(user.role);
  const [displayName, setDisplayName] = useState(user.displayName || "");
  const [disabled, setDisabled] = useState(user.disabled);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await updateUser(user.username, { role, displayName, disabled });
      onSaved(`Updated ${user.username}`);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>Edit {user.username}</header>
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            Account disabled (blocks login, drops active sessions)
          </label>
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// RoleEditor is the create/edit modal for a role: name + display name + the
// per-feature permission matrix + a "require 2FA" toggle.
function RoleEditor({
  role,
  features,
  actions,
  onClose,
  onSaved,
  onError,
}: {
  role: Role | null;
  features: Feature[];
  actions: Action[];
  onClose: () => void;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const isNew = role === null;
  const [name, setName] = useState(role?.name || "");
  const [displayName, setDisplayName] = useState(role?.displayName || "");
  const [requireTotp, setRequireTotp] = useState(role?.requireTotp || false);
  const [perms, setPerms] = useState<Permissions>(() => {
    const base: Permissions = {};
    for (const f of features) base[f] = { ...(role?.permissions[f] || emptyPerm) };
    return base;
  });
  const [busy, setBusy] = useState(false);

  const toggle = (f: Feature, a: Action) =>
    setPerms((prev) => {
      const cur = prev[f] || { ...emptyPerm };
      const next: Perm = { ...cur, [a]: !cur[a] };
      // View is the floor: granting any action implies view; removing view
      // removes the others.
      if (a === "view" && !next.view) {
        next.create = next.edit = next.delete = false;
      } else if (a !== "view" && next[a]) {
        next.view = true;
      }
      return { ...prev, [f]: next };
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isNew) {
        await createRole({ name, displayName, permissions: perms, requireTotp });
        onSaved(`Created role ${name}`);
      } else {
        await updateRole(name, { displayName, permissions: perms, requireTotp });
        onSaved(`Updated role ${name}`);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <header>{isNew ? "New Role" : `Edit Role: ${name}`}</header>
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>
              Role name {isNew ? <span className="hint-inline">(lowercase, a–z 0–9 _ -)</span> : null}
              <input
                value={name}
                disabled={!isNew}
                placeholder="e.g. support"
                onChange={(e) => setName(e.target.value.toLowerCase())}
              />
            </label>
            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          </div>

          <div className="perm-matrix">
            <table>
              <thead>
                <tr>
                  <th>Feature</th>
                  {actions.map((a) => (
                    <th key={a} style={{ textAlign: "center" }}>
                      {ACTION_LABEL[a]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {features.map((f) => (
                  <tr key={f}>
                    <td style={{ textTransform: "capitalize" }}>{f}</td>
                    {actions.map((a) => (
                      <td key={a} style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={perms[f]?.[a] || false}
                          onChange={() => toggle(f, a)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label className="checkbox">
            <input type="checkbox" checked={requireTotp} onChange={(e) => setRequireTotp(e.target.checked)} />
            Require two-factor authentication (Google Authenticator) for this role
          </label>

          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Saving…" : isNew ? "Create role" : "Save role"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
