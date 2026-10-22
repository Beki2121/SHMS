import { useEffect, useState } from 'react';
import { authApi } from '../auth/api.js';
import '../styles/guest.css';

const tabs = ['Guests', 'Companies', 'Groups', 'Requests'];

function Field({ label, children }) {
  return <label className="setup-field">{label}{children}</label>;
}

function GuestForm({ onSave, busy }) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', phone: '', email: '', nationality: '',
    idType: '', idNumber: '', dateOfBirth: '', notes: '', isVip: false,
  });
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event) {
    event.preventDefault();
    const saved = await onSave({
      ...form,
      phone: form.phone || null,
      email: form.email || null,
      nationality: form.nationality || null,
      idType: form.idType || null,
      idNumber: form.idNumber || null,
      dateOfBirth: form.dateOfBirth || null,
      notes: form.notes || null,
    });
    if (saved) setForm({ firstName: '', lastName: '', phone: '', email: '', nationality: '', idType: '', idNumber: '', dateOfBirth: '', notes: '', isVip: false });
  }
  return <form className="guest-form" onSubmit={submit}>
    <Field label="First name"><input required maxLength="120" value={form.firstName} onChange={(event) => set('firstName', event.target.value)} /></Field>
    <Field label="Last name"><input required maxLength="120" value={form.lastName} onChange={(event) => set('lastName', event.target.value)} /></Field>
    <Field label="Phone"><input type="tel" maxLength="40" value={form.phone} onChange={(event) => set('phone', event.target.value)} /></Field>
    <Field label="Email"><input type="email" maxLength="190" value={form.email} onChange={(event) => set('email', event.target.value)} /></Field>
    <Field label="Nationality"><input maxLength="80" value={form.nationality} onChange={(event) => set('nationality', event.target.value)} /></Field>
    <Field label="Date of birth"><input type="date" value={form.dateOfBirth} onChange={(event) => set('dateOfBirth', event.target.value)} /></Field>
    <Field label="ID type"><input maxLength="40" value={form.idType} onChange={(event) => set('idType', event.target.value)} /></Field>
    <Field label="ID / passport number"><input autoComplete="off" maxLength="120" value={form.idNumber} onChange={(event) => set('idNumber', event.target.value)} /></Field>
    <Field label="Notes"><input maxLength="5000" value={form.notes} onChange={(event) => set('notes', event.target.value)} /></Field>
    <label className="guest-vip"><input type="checkbox" checked={form.isVip} onChange={(event) => set('isVip', event.target.checked)} /> VIP guest</label>
    <button className="button button-primary" disabled={busy}>Save guest</button>
  </form>;
}

function CompanyPanel({ companies, onCreate, busy }) {
  const [form, setForm] = useState({ name: '', tin: '', contactName: '', email: '', phone: '', creditTerms: '' });
  async function submit(event) {
    event.preventDefault();
    const saved = await onCreate({
      name: form.name,
      tin: form.tin || null,
      contact: { name: form.contactName || null, email: form.email || null, phone: form.phone || null },
      creditTerms: form.creditTerms || null,
    });
    if (saved) setForm({ name: '', tin: '', contactName: '', email: '', phone: '', creditTerms: '' });
  }
  return <div className="guest-stack">
    <form className="guest-form" onSubmit={submit}>
      <Field label="Company name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label="TIN"><input value={form.tin} onChange={(event) => setForm({ ...form, tin: event.target.value })} /></Field>
      <Field label="Contact name"><input value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} /></Field>
      <Field label="Contact email"><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
      <Field label="Contact phone"><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></Field>
      <Field label="Credit terms"><input value={form.creditTerms} onChange={(event) => setForm({ ...form, creditTerms: event.target.value })} /></Field>
      <button className="button button-primary" disabled={busy}>Add company</button>
    </form>
    <div className="guest-list">{companies.map((company) => <article className="guest-list-row" key={company.id}><strong>{company.name}</strong><span>TIN: {company.tin || '—'} · {company.creditTerms || 'No credit terms'}</span></article>)}</div>
  </div>;
}

function GroupPanel({ groups, guests, onCreate, busy }) {
  const [form, setForm] = useState({ name: '', leaderGuestId: '', guestIds: [], notes: '' });
  async function submit(event) {
    event.preventDefault();
    const saved = await onCreate({
      ...form,
      leaderGuestId: form.leaderGuestId ? Number(form.leaderGuestId) : null,
      guestIds: form.guestIds.map(Number),
      notes: form.notes || null,
    });
    if (saved) setForm({ name: '', leaderGuestId: '', guestIds: [], notes: '' });
  }
  return <div className="guest-stack">
    <form className="guest-form" onSubmit={submit}>
      <Field label="Group name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label="Group leader"><select value={form.leaderGuestId} onChange={(event) => setForm({ ...form, leaderGuestId: event.target.value })}><option value="">Select a guest</option>{guests.map((guest) => <option key={guest.id} value={guest.id}>{guest.fullName}</option>)}</select></Field>
      <Field label="Members (Ctrl/Cmd-click for multiple)"><select multiple value={form.guestIds} onChange={(event) => setForm({ ...form, guestIds: [...event.target.selectedOptions].map((option) => option.value) })}>{guests.map((guest) => <option key={guest.id} value={guest.id}>{guest.fullName}</option>)}</select></Field>
      <Field label="Notes"><input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></Field>
      <button className="button button-primary" disabled={busy}>Create group</button>
    </form>
    <div className="guest-list">{groups.map((group) => <article className="guest-list-row" key={group.id}><strong>{group.name}</strong><span>Leader: {group.leaderName || 'Not set'} · {group.memberCount} members</span><small>{group.members.map((member) => member.name).join(', ')}</small></article>)}</div>
  </div>;
}

function RequestPanel({ requests, guests, departments, canManageRequests, onCreate, onUpdate, busy }) {
  const [form, setForm] = useState({ guestId: '', type: '', description: '', assignedDepartmentId: '' });
  async function submit(event) {
    event.preventDefault();
    const saved = await onCreate({
      guestId: form.guestId ? Number(form.guestId) : null,
      type: form.type,
      description: form.description,
      assignedDepartmentId: form.assignedDepartmentId ? Number(form.assignedDepartmentId) : null,
    });
    if (saved) setForm({ guestId: '', type: '', description: '', assignedDepartmentId: '' });
  }
  return <div className="guest-stack">
    {canManageRequests && <form className="guest-form" onSubmit={submit}>
      <Field label="Guest"><select value={form.guestId} onChange={(event) => setForm({ ...form, guestId: event.target.value })}><option value="">No guest linked</option>{guests.map((guest) => <option key={guest.id} value={guest.id}>{guest.fullName}</option>)}</select></Field>
      <Field label="Request type"><input required maxLength="80" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} /></Field>
      <Field label="Description"><input required maxLength="5000" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
      <Field label="Assign department"><select value={form.assignedDepartmentId} onChange={(event) => setForm({ ...form, assignedDepartmentId: event.target.value })}><option value="">Unassigned</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></Field>
      <button className="button button-primary" disabled={busy}>Log request</button>
    </form>}
    <div className="guest-list">{requests.map((item) => <article className="guest-list-row request-row" key={item.id}>
      <strong>{item.type} <span className={`request-status status-${item.status}`}>{item.status.replace('_', ' ')}</span></strong>
      <span>{item.guestName || 'Unlinked guest'} · {item.description}</span>
      <small>{item.departmentName || 'Unassigned department'}{item.assigneeName ? ` · ${item.assigneeName}` : ''}</small>
      {canManageRequests && <label className="request-assignment">Department
        <select value={item.assignedDepartmentId ?? ''} disabled={busy} onChange={(event) => onUpdate(item.id, { assignedDepartmentId: event.target.value ? Number(event.target.value) : null })}>
          <option value="">Unassigned</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
        </select>
      </label>}
      {canManageRequests && item.status === 'open' && <>
        <button className="text-button" disabled={busy} onClick={() => onUpdate(item.id, { status: 'in_progress' })}>Start</button>
        <button className="text-button" disabled={busy} onClick={() => onUpdate(item.id, { status: 'cancelled' })}>Cancel</button>
      </>}
      {canManageRequests && item.status === 'in_progress' && <>
        <button className="text-button" disabled={busy} onClick={() => onUpdate(item.id, { status: 'resolved' })}>Mark resolved</button>
        <button className="text-button" disabled={busy} onClick={() => onUpdate(item.id, { status: 'cancelled' })}>Cancel</button>
      </>}
      {canManageRequests && item.status === 'resolved' && <button className="text-button" disabled={busy} onClick={() => onUpdate(item.id, { status: 'in_progress' })}>Reopen</button>}
    </article>)}</div>
  </div>;
}

export function GuestManagement({ permissionKeys = [] }) {
  const [tab, setTab] = useState('Guests');
  const [guests, setGuests] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [groups, setGroups] = useState([]);
  const [requests, setRequests] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [retentionDays, setRetentionDays] = useState(3650);
  const [mergeTarget, setMergeTarget] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [revealedId, setRevealedId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = permissionKeys.includes('guests.manage');
  const canRevealId = permissionKeys.includes('guest.view_id');
  const canManageRequests = permissionKeys.includes('guest_requests.manage');

  async function loadGuests(term = search) {
    const [guestRows, companyRows, groupRows, requestRows, departmentRows] = await Promise.all([
      authApi.request(`/api/guests?search=${encodeURIComponent(term)}`),
      authApi.request('/api/companies'),
      authApi.request('/api/guest-groups'),
      authApi.request('/api/guest-requests'),
      authApi.request('/api/guest-requests/departments'),
    ]);
    setGuests(guestRows);
    setCompanies(companyRows);
    setGroups(groupRows);
    setRequests(requestRows);
    setDepartments(departmentRows);
    if (canManage) {
      const privacy = await authApi.request('/api/guests/privacy-settings');
      setRetentionDays(privacy.retentionDays);
    }
  }

  useEffect(() => {
    loadGuests('').catch((error) => setMessage(error.message));
  }, []);

  async function action(operation, success) {
    setBusy(true);
    setMessage('');
    try {
      const result = await operation();
      await loadGuests();
      setMessage(success);
      return result;
    } catch (error) {
      setMessage(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function selectGuest(id) {
    setRevealedId('');
    setMessage('');
    try {
      setSelected(await authApi.request(`/api/guests/${id}`));
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function revealId() {
    if (!selected) return;
    const result = await action(
      () => authApi.request(`/api/guests/${selected.id}/reveal-id`, { method: 'POST', body: '{}' }),
      'Identity number reveal was audited.',
    );
    if (result) setRevealedId(result.idNumber);
  }

  async function anonymize() {
    if (!selected) return;
    const reason = window.prompt('Enter a reason to anonymise this guest record:');
    if (!reason) return;
    const result = await action(
      () => authApi.request(`/api/guests/${selected.id}/anonymize`, { method: 'POST', body: JSON.stringify({ reason }) }),
      'Guest personal data anonymised; financial records remain unchanged.',
    );
    if (result) {
      setRevealedId('');
      await selectGuest(selected.id);
    }
  }

  async function mergeGuests(event) {
    event.preventDefault();
    if (!selected) return;
    const result = await action(
      () => authApi.request(`/api/guests/${selected.id}/merge`, {
        method: 'POST',
        body: JSON.stringify({ targetGuestId: Number(mergeTarget), reason: mergeReason }),
      }),
      'Guest records merged.',
    );
    if (result) {
      setSelected(null);
      setMergeTarget('');
      setMergeReason('');
    }
  }

  async function exportGuest() {
    if (!selected) return;
    const result = await action(
      () => authApi.request(`/api/guests/${selected.id}/export`, { method: 'POST', body: '{}' }),
      'Guest data export generated and audited.',
    );
    if (result) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `guest-${selected.id}-export.json`;
      link.click();
      URL.revokeObjectURL(url);
    }
  }

  return <div className="guest-page">
    <header className="page-heading">
      <div><p className="eyebrow">HOTEL OPERATIONS</p><h1>Guest management</h1><p className="muted">Privacy-aware guest records, company accounts, groups and service requests.</p></div>
    </header>
    {message && <div className="form-message" role="status">{message}</div>}
    <section className="panel guest-panel">
      <div className="guest-tabs" role="tablist" aria-label="Guest workspaces">
        {tabs.map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}
      </div>
      {tab === 'Guests' && <div className="guest-workspace">
        <section className="guest-directory">
          <form className="guest-search" onSubmit={(event) => { event.preventDefault(); loadGuests(search).catch((error) => setMessage(error.message)); }}>
            <input aria-label="Search guests" placeholder="Search name, phone, email or ID last 4" value={search} onChange={(event) => setSearch(event.target.value)} />
            <button className="button button-secondary">Search</button>
          </form>
          {canManage && <details className="guest-create"><summary>Add guest</summary><GuestForm busy={busy} onSave={(data) => action(() => authApi.request('/api/guests', { method: 'POST', body: JSON.stringify(data) }), 'Guest record created.')} /></details>}
          <div className="guest-list">{guests.map((guest) => <button className={`guest-list-row guest-select${selected?.id === guest.id ? ' selected' : ''}`} key={guest.id} onClick={() => selectGuest(guest.id)}>
            <strong>{guest.fullName}{guest.isVip && <span className="vip-badge">VIP</span>}</strong>
            <span>{guest.phone || guest.email || 'No contact details'}{guest.idNumber ? ` · ID ${guest.idNumber}` : ''}</span>
          </button>)}
          {!guests.length && <p className="muted guest-empty">No guest records found.</p>}</div>
        </section>
        <section className="guest-profile" aria-live="polite">
          {!selected && <div className="guest-empty"><strong>Select a guest</strong><p className="muted">Guest profile and stay history will appear here.</p></div>}
          {selected && <>
            <div className="guest-profile-heading"><div><p className="eyebrow">GUEST PROFILE</p><h2>{selected.fullName}{selected.isVip && <span className="vip-badge">VIP</span>}</h2><p className="muted">{selected.email || 'No email'} · {selected.phone || 'No phone'}</p></div>{selected.isAnonymised && <span className="request-status status-cancelled">Anonymised</span>}</div>
            <dl className="guest-details">
              <div><dt>Nationality</dt><dd>{selected.nationality || '—'}</dd></div>
              <div><dt>Identity</dt><dd>{selected.idType || 'ID'} {revealedId || selected.idNumber || '—'} {selected.idNumber && canRevealId && !selected.isAnonymised && <button className="text-button" onClick={revealId}>Reveal (audited)</button>}</dd></div>
              <div><dt>Date of birth</dt><dd>{selected.dateOfBirth || '—'}</dd></div>
              <div><dt>Notes</dt><dd>{selected.notes || '—'}</dd></div>
            </dl>
            <div className="guest-actions">
              {canManage && !selected.isAnonymised && <button className="button button-secondary" onClick={anonymize}>Anonymise</button>}
              {canManage && <button className="button button-secondary" onClick={exportGuest}>Export data</button>}
            </div>
            {canManage && !selected.isAnonymised && <form className="merge-form" onSubmit={mergeGuests}>
              <strong>Merge duplicate into another guest</strong>
              <div className="guest-form">
                <Field label="Target guest"><select required value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}><option value="">Select target</option>{guests.filter((guest) => guest.id !== selected.id && !guest.isAnonymised).map((guest) => <option key={guest.id} value={guest.id}>{guest.fullName}</option>)}</select></Field>
                <Field label="Reason"><input required minLength="5" value={mergeReason} onChange={(event) => setMergeReason(event.target.value)} /></Field>
                <button className="button button-secondary" disabled={busy}>Merge guest</button>
              </div>
            </form>}
            <h3>Stay history</h3>
            <div className="guest-list">{selected.reservations?.map((reservation) => <article className="guest-list-row" key={reservation.id}>
              <strong>{reservation.confirmationNo} · {reservation.status}</strong>
              <span>{reservation.checkInDate} – {reservation.checkOutDate} · {reservation.roomType || 'Room type'} · {reservation.totalEstimate}</span>
            </article>)}
            {!selected.reservations?.length && <p className="muted">No stay history recorded.</p>}</div>
          </>}
        </section>
      </div>}
      {tab === 'Companies' && <CompanyPanel companies={companies} busy={busy} onCreate={(data) => action(() => authApi.request('/api/companies', { method: 'POST', body: JSON.stringify(data) }), 'Company account created.')} />}
      {tab === 'Groups' && <GroupPanel groups={groups} guests={guests} busy={busy} onCreate={(data) => action(() => authApi.request('/api/guest-groups', { method: 'POST', body: JSON.stringify(data) }), 'Guest group created.')} />}
      {tab === 'Requests' && <RequestPanel
        requests={requests}
        guests={guests}
        departments={departments}
        canManageRequests={canManageRequests}
        busy={busy}
        onCreate={(data) => action(() => authApi.request('/api/guest-requests', { method: 'POST', body: JSON.stringify(data) }), 'Guest request logged.')}
        onUpdate={(id, data) => action(() => authApi.request(`/api/guest-requests/${id}`, { method: 'PATCH', body: JSON.stringify(data) }), 'Guest request updated.')}
      />}
    </section>
    {canManage && <section className="panel guest-retention">
      <div><h2>Guest privacy retention</h2><p className="muted">Retention is a property policy; anonymisation is an explicit audited action.</p></div>
      <form onSubmit={(event) => {
        event.preventDefault();
        action(
          () => authApi.request('/api/guests/privacy-settings', { method: 'PUT', body: JSON.stringify({ retentionDays: Number(retentionDays) }) }),
          'Guest retention policy saved.',
        );
      }}>
        <Field label="Retention period (days)"><input type="number" min="30" max="36500" required value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} /></Field>
        <button className="button button-primary" disabled={busy}>Save policy</button>
      </form>
    </section>}
  </div>;
}
