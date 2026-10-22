import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../auth/api.js';

function ErrorMessage({ children }) {
  return children ? <p className="form-error" role="alert">{children}</p> : null;
}

export function DataExportWorkspace() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function download(format) {
    setBusy(true);
    setError('');
    try {
      const blob = await authApi.requestBlob(`/api/platform/data-export?format=${format}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `smarthotel-export.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel">
    <p className="eyebrow">YOUR ORGANIZATION</p>
    <h1>Data export</h1>
    <p className="muted">Download all organization and property records in JSON or CSV. Credentials and refresh tokens are never included.</p>
    <ErrorMessage>{error}</ErrorMessage>
    <div className="form-actions">
      <button className="button button-primary" disabled={busy} onClick={() => download('json')}>Download JSON</button>
      <button className="button button-secondary" disabled={busy} onClick={() => download('csv')}>Download CSV</button>
    </div>
  </section>;
}

export function SupportApprovals({ propertyId }) {
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function refresh() {
    try {
      setRequests(await authApi.request('/api/platform/support-requests/customer'));
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => { refresh(); }, [propertyId]);

  async function decide(id, decision) {
    setError('');
    setMessage('');
    try {
      await authApi.request(`/api/platform/support-requests/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      setMessage(`Support request ${decision}.`);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function revoke(id) {
    setError('');
    setMessage('');
    try {
      await authApi.request(`/api/platform/support-requests/${id}/revoke`, { method: 'POST', body: '{}' });
      setMessage('Support access revoked.');
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  return <section className="panel">
    <p className="eyebrow">CUSTOMER APPROVAL</p>
    <h1>Support access requests</h1>
    <p className="muted">Approve only requests you recognize. Approved access is read-only, limited to this organization, and automatically expires.</p>
    <ErrorMessage>{error}</ErrorMessage>
    {message && <p className="success-message" role="status">{message}</p>}
    {requests.length === 0
      ? <p className="muted">There are no pending requests.</p>
      : <div className="report-table-wrap"><table className="data-table">
        <thead><tr><th>Reason</th><th>Requested duration</th><th>Property</th><th>Actions</th></tr></thead>
        <tbody>{requests.map((item) => <tr key={item.id}>
          <td>{item.reason}</td><td>{item.durationMinutes} minutes</td><td>#{item.propertyId}</td>
          <td>{item.status === 'pending'
            ? <><button className="button button-primary" onClick={() => decide(item.id, 'approved')}>Approve</button>{' '}
              <button className="button button-secondary" onClick={() => decide(item.id, 'denied')}>Deny</button></>
            : <><span>{item.status}</span>{' '}<button className="button button-secondary" onClick={() => revoke(item.id)}>Revoke</button></>}</td>
        </tr>)}</tbody>
      </table></div>}
  </section>;
}

export function PlatformConsole() {
  const navigate = useNavigate();
  const [organizations, setOrganizations] = useState([]);
  const [packages, setPackages] = useState([]);
  const [supportRequests, setSupportRequests] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [packageDraft, setPackageDraft] = useState({
    name: '', maxRooms: 30, maxUsers: 15, modules: 'reservations,housekeeping,reports', monthlyFee: '0.00',
  });
  const [draft, setDraft] = useState({
    name: '', packageId: '', licenseMode: 'cloud',
    property: { name: '', city: '', timezone: 'Africa/Addis_Ababa', currency: 'ETB' },
    owner: { name: '', email: '', password: '' },
  });

  async function refresh() {
    const [organizationRows, packageRows, requestRows] = await Promise.all([
      authApi.request('/api/platform/organizations'),
      authApi.request('/api/platform/packages'),
      authApi.request('/api/platform/support-requests'),
    ]);
    setOrganizations(organizationRows);
    setPackages(packageRows);
    setSupportRequests(requestRows);
  }

  useEffect(() => {
    refresh().catch((requestError) => setError(requestError.message));
  }, []);

  function updateDraft(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateNestedDraft(section, field, value) {
    setDraft((current) => ({ ...current, [section]: { ...current[section], [field]: value } }));
  }

  async function createOrganization(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await authApi.request('/api/platform/organizations', {
        method: 'POST',
        body: JSON.stringify({ ...draft, packageId: Number(draft.packageId) }),
      });
      setMessage('Organization, initial property, and owner account created.');
      setDraft({
        name: '', packageId: '', licenseMode: 'cloud',
        property: { name: '', city: '', timezone: 'Africa/Addis_Ababa', currency: 'ETB' },
        owner: { name: '', email: '', password: '' },
      });
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function updateOrganization(id, changes) {
    setError('');
    try {
      await authApi.request(`/api/platform/organizations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function addBillingNote(organization) {
    const note = window.prompt(`Billing note for ${organization.name}`);
    if (!note) return;
    try {
      await authApi.request(`/api/platform/organizations/${organization.id}/billing-notes`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      });
      setMessage('Billing note added.');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function viewBillingNotes(organization) {
    try {
      const notes = await authApi.request(`/api/platform/organizations/${organization.id}/billing-notes`);
      window.alert(notes.length
        ? notes.map((item) => `${item.createdAt}: ${item.note}${item.amount ? ` (${item.currency} ${item.amount})` : ''}`).join('\n')
        : 'No billing notes recorded.');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function createProperty(organization) {
    const name = window.prompt(`New property name for ${organization.name}`);
    if (!name) return;
    const city = window.prompt('Property city') ?? '';
    try {
      await authApi.request('/api/platform/properties', {
        method: 'POST',
        body: JSON.stringify({ organizationId: organization.id, name, city, timezone: 'Africa/Addis_Ababa', currency: 'ETB' }),
      });
      setMessage('Property created.');
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function createPackage(event) {
    event.preventDefault();
    setError('');
    try {
      await authApi.request('/api/platform/packages', {
        method: 'POST',
        body: JSON.stringify({
          ...packageDraft,
          maxRooms: Number(packageDraft.maxRooms),
          maxUsers: Number(packageDraft.maxUsers),
          modules: packageDraft.modules.split(',').map((value) => value.trim()).filter(Boolean),
        }),
      });
      setPackageDraft({ name: '', maxRooms: 30, maxUsers: 15, modules: 'reservations,housekeeping,reports', monthlyFee: '0.00' });
      await refresh();
      setMessage('Package created.');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function requestSupport(organization) {
    const propertyId = Number(window.prompt(`Property ID for ${organization.name}`));
    const reason = window.prompt('Explain the support work requested (at least 10 characters).');
    if (!propertyId || !reason) return;
    try {
      await authApi.request('/api/platform/support-requests', {
        method: 'POST',
        body: JSON.stringify({ organizationId: organization.id, propertyId, reason, durationMinutes: 30 }),
      });
      setMessage('Customer approval requested.');
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function activateSupport(id) {
    try {
      const data = await authApi.request(`/api/platform/support-requests/${id}/activate`, {
        method: 'POST',
        body: '{}',
      });
      authApi.enterSupportSession(data);
      navigate('/guests');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  return <div className="platform-workspace">
    <header className="page-heading">
      <div><p className="eyebrow">SMART HOTEL PLATFORM</p><h1>Platform administration</h1>
        <p className="muted">Manage organizations, packages, usage, subscriptions, billing notes, and approved support access.</p></div>
    </header>
    <ErrorMessage>{error}</ErrorMessage>
    {message && <p className="success-message" role="status">{message}</p>}
    <section className="panel">
      <h2>Organizations</h2>
      <div className="report-table-wrap"><table className="data-table">
        <thead><tr><th>Organization</th><th>Package</th><th>Usage</th><th>Subscription</th><th>Actions</th></tr></thead>
        <tbody>{organizations.map((organization) => <tr key={organization.id}>
          <td>{organization.name}<small>{organization.licenseMode} · {organization.status}</small></td>
          <td><select value={organization.packageId} onChange={(event) => updateOrganization(organization.id, { packageId: Number(event.target.value) })}>
            {packages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></td>
          <td>{organization.roomCount}/{organization.roomLimit} rooms · {organization.userCount}/{organization.userLimit} users · {organization.propertyCount} properties</td>
          <td><select value={organization.subscriptionStatus} onChange={(event) => updateOrganization(organization.id, { subscriptionStatus: event.target.value })}>
            {['trial', 'active', 'past_due', 'cancelled'].map((status) => <option key={status} value={status}>{status}</option>)}
          </select></td>
          <td>
            <button className="text-button" onClick={() => updateOrganization(organization.id, { status: organization.status === 'active' ? 'suspended' : 'active' })}>
              {organization.status === 'active' ? 'Suspend' : 'Reactivate'}
            </button>{' '}
            <button className="text-button" onClick={() => createProperty(organization)}>Add property</button>{' '}
            <button className="text-button" onClick={() => addBillingNote(organization)}>Billing note</button>{' '}
            <button className="text-button" onClick={() => viewBillingNotes(organization)}>View notes</button>{' '}
            <button className="text-button" onClick={() => requestSupport(organization)}>Request support</button>
          </td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <section className="panel">
      <h2>Create organization</h2>
      <form className="platform-form" onSubmit={createOrganization}>
        <label>Organization name<input required value={draft.name} onChange={(event) => updateDraft('name', event.target.value)}/></label>
        <label>Package<select required value={draft.packageId} onChange={(event) => updateDraft('packageId', event.target.value)}>
          <option value="">Select package</option>{packages.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.maxRooms} rooms / {item.maxUsers} users</option>)}
        </select></label>
        <label>License mode<select value={draft.licenseMode} onChange={(event) => updateDraft('licenseMode', event.target.value)}><option value="cloud">Cloud subscription</option><option value="local">Local license</option></select></label>
        <label>Initial property<input required value={draft.property.name} onChange={(event) => updateNestedDraft('property', 'name', event.target.value)}/></label>
        <label>City<input value={draft.property.city} onChange={(event) => updateNestedDraft('property', 'city', event.target.value)}/></label>
        <label>Owner name<input required value={draft.owner.name} onChange={(event) => updateNestedDraft('owner', 'name', event.target.value)}/></label>
        <label>Owner email<input type="email" required value={draft.owner.email} onChange={(event) => updateNestedDraft('owner', 'email', event.target.value)}/></label>
        <label>Initial password<input type="password" minLength="12" required value={draft.owner.password} onChange={(event) => updateNestedDraft('owner', 'password', event.target.value)}/></label>
        <button className="button button-primary" disabled={busy || !draft.packageId}>Create organization</button>
      </form>
    </section>
    <section className="panel">
      <h2>Create custom package</h2>
      <form className="platform-form" onSubmit={createPackage}>
        <label>Package name<input required value={packageDraft.name} onChange={(event) => setPackageDraft((draft) => ({ ...draft, name: event.target.value }))}/></label>
        <label>Maximum rooms<input type="number" min="1" required value={packageDraft.maxRooms} onChange={(event) => setPackageDraft((draft) => ({ ...draft, maxRooms: event.target.value }))}/></label>
        <label>Maximum users<input type="number" min="1" required value={packageDraft.maxUsers} onChange={(event) => setPackageDraft((draft) => ({ ...draft, maxUsers: event.target.value }))}/></label>
        <label>Enabled modules (comma-separated)<input required value={packageDraft.modules} onChange={(event) => setPackageDraft((draft) => ({ ...draft, modules: event.target.value }))}/></label>
        <label>Monthly fee<input required value={packageDraft.monthlyFee} onChange={(event) => setPackageDraft((draft) => ({ ...draft, monthlyFee: event.target.value }))}/></label>
        <button className="button button-primary">Create package</button>
      </form>
    </section>
    <section className="panel">
      <h2>Support approvals</h2>
      {supportRequests.length === 0
        ? <p className="muted">No support requests.</p>
        : <div className="report-table-wrap"><table className="data-table"><thead><tr><th>Organization</th><th>Reason</th><th>Status</th><th>Expires</th><th/></tr></thead>
          <tbody>{supportRequests.map((item) => <tr key={item.id}><td>{item.organizationName}</td><td>{item.reason}</td><td>{item.status}</td><td>{item.expiresAt ?? '—'}</td>
            <td>{item.status === 'approved' && <button className="button button-primary" onClick={() => activateSupport(item.id)}>Start approved session</button>}</td>
          </tr>)}</tbody></table></div>}
    </section>
  </div>;
}
