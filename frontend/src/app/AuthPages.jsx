import { useEffect, useState } from 'react';
import { authApi } from '../auth/api.js';
import '../styles/auth.css';

function LoginPage({ onLogin, errorMessage }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(errorMessage ?? '');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await authApi.login(email, password);
      onLogin(session);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-page">
    <form className="auth-card" onSubmit={submit}>
      <div className="brand auth-brand"><span className="brand-mark">S</span><span><strong>SmartHotel</strong><small>ETHIOPIA</small></span></div>
      <p className="eyebrow">HOTEL OPERATIONS</p>
      <h1>Welcome back</h1>
      <p className="muted">Sign in to manage your property.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <label>Email address<input autoComplete="username" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label>Password<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <button className="button button-primary auth-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </main>;
}

function UserManagement({ activePropertyId }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '', roleId: '', phone: '' });

  async function load() {
    const [userRows, roleRows] = await Promise.all([
      authApi.request('/api/auth/admin/users'),
      authApi.request('/api/auth/admin/assignable-roles'),
    ]);
    setUsers(userRows);
    setRoles(roleRows);
    if (!form.roleId && roleRows[0]) setForm((current) => ({ ...current, roleId: String(roleRows[0].id) }));
  }

  useEffect(() => {
    load().catch((error) => setMessage(error.message));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await authApi.request('/api/auth/admin/users', {
        method: 'POST',
        body: JSON.stringify({ ...form, roleId: Number(form.roleId), propertyIds: [activePropertyId] }),
      });
      setMessage('User created.');
      setForm((current) => ({ ...current, name: '', email: '', password: '', phone: '' }));
      await load();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitPasswordReset(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await authApi.request(`/api/auth/admin/users/${resetTarget}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: resetPassword }),
      });
      setMessage('Password reset. The user must sign in again.');
      setResetTarget(null);
      setResetPassword('');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="admin-layout">
    <header className="page-heading"><div><p className="eyebrow">ACCESS CONTROL</p><h1>User management</h1><p className="muted">Accounts assigned to your current property.</p></div></header>
    <div className="admin-grid">
      <form className="panel admin-form" onSubmit={submit}>
        <h2>Create user</h2>
        {message && <p className="form-notice" role="status">{message}</p>}
        <label>Full name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
        <label>Email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required /></label>
        <label>Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
        <label>Temporary password<input type="password" minLength="12" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required /></label>
        <label>Role<select value={form.roleId} onChange={(event) => setForm({ ...form, roleId: event.target.value })} required>{roles.map((role) => <option key={role.id} value={role.id}>{role.name.replaceAll('_', ' ')}</option>)}</select></label>
        <button className="button button-primary" disabled={busy || roles.length === 0}>{busy ? 'Creating…' : 'Create user'}</button>
      </form>
      <section className="panel admin-list"><h2>Property users</h2>{users.map((user) => <article className="admin-user" key={user.id}>
        <div><strong>{user.name}</strong><small>{user.email}</small></div>
        <span>{user.role.replaceAll('_', ' ')}</span>
        {resetTarget === user.id
          ? <form className="reset-form" onSubmit={submitPasswordReset}>
            <input aria-label={`New password for ${user.name}`} type="password" minLength="12" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} required />
            <button className="text-button" disabled={busy}>Save</button>
            <button className="text-button" type="button" onClick={() => setResetTarget(null)}>Cancel</button>
          </form>
          : <button className="text-button" onClick={() => { setResetTarget(user.id); setResetPassword(''); }}>Reset password</button>}
      </article>)}</section>
    </div>
  </section>;
}

function RoleManagement() {
  const [roles, setRoles] = useState([]);
  const [permissionKeys, setPermissionKeys] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authApi.request('/api/auth/admin/roles')
      .then((data) => {
        setRoles(data.roles);
        setPermissionKeys(data.permissionKeys);
      })
      .catch((error) => setMessage(error.message));
  }, []);

  function updateRole(roleId, permissionKey, checked) {
    setRoles((current) => current.map((role) => role.id === roleId
      ? { ...role, permissionKeys: checked
        ? [...new Set([...role.permissionKeys, permissionKey])]
        : role.permissionKeys.filter((key) => key !== permissionKey) }
      : role));
  }

  async function save(role) {
    setBusy(true);
    setMessage('');
    try {
      await authApi.request(`/api/auth/admin/roles/${role.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissionKeys: role.permissionKeys }),
      });
      setMessage(`${role.name.replaceAll('_', ' ')} permissions saved.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="admin-layout">
    <header className="page-heading"><div><p className="eyebrow">ACCESS CONTROL</p><h1>Role permissions</h1><p className="muted">Changes are audited and take effect immediately.</p></div></header>
    {message && <p className="form-notice" role="status">{message}</p>}
    <div className="role-list">{roles.map((role) => <article className="panel role-card" key={role.id}>
      <div className="panel-heading"><h2>{role.name.replaceAll('_', ' ')}</h2><button className="button button-primary" disabled={busy} onClick={() => save(role)}>Save permissions</button></div>
      <div className="permission-grid">{permissionKeys.map((permission) => <label key={permission}><input type="checkbox" checked={role.permissionKeys.includes(permission)} onChange={(event) => updateRole(role.id, permission, event.target.checked)} />{permission}</label>)}</div>
    </article>)}</div>
  </section>;
}

export { LoginPage, RoleManagement, UserManagement };
