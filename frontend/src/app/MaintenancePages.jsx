import { useCallback, useEffect, useState } from 'react';
import { authApi } from '../auth/api.js';
import { useRoomStatusUpdates } from '../realtime.js';
import '../styles/maintenance.css';

function Field({ label, children }) {
  return <label className="maintenance-field"><span>{label}</span>{children}</label>;
}

function AssetCard({ asset, rooms, busy, onSave, onArchive }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: asset.name,
    assetTag: asset.assetTag ?? '',
    category: asset.category ?? '',
    roomId: asset.roomId ? String(asset.roomId) : '',
    status: asset.status,
  });
  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  return <article className="maintenance-asset">
    {editing ? <form onSubmit={async (event) => {
      event.preventDefault();
      const saved = await onSave(asset.id, {
        ...form,
        assetTag: form.assetTag || null,
        category: form.category || null,
        roomId: form.roomId ? Number(form.roomId) : null,
      });
      if (saved) setEditing(false);
    }}>
      <Field label="Asset name"><input required maxLength="160" value={form.name} onChange={(event) => update('name', event.target.value)} /></Field>
      <Field label="Asset tag"><input maxLength="100" value={form.assetTag} onChange={(event) => update('assetTag', event.target.value)} /></Field>
      <Field label="Category"><input maxLength="100" value={form.category} onChange={(event) => update('category', event.target.value)} /></Field>
      <Field label="Assigned room"><select value={form.roomId} onChange={(event) => update('roomId', event.target.value)}>
        <option value="">Unassigned</option>{rooms.map((room) => <option value={room.id} key={room.id}>{room.roomNumber}</option>)}
      </select></Field>
      <Field label="Condition"><select value={form.status} onChange={(event) => update('status', event.target.value)}>
        <option value="active">Active</option><option value="needs_service">Needs service</option><option value="out_of_service">Out of service</option>
      </select></Field>
      <div className="maintenance-actions"><button className="button button-primary" disabled={busy}>Save asset</button><button type="button" className="button button-secondary" onClick={() => setEditing(false)}>Cancel</button></div>
    </form> : <>
      <header><div><strong>{asset.name}</strong><small>{asset.assetTag || 'No tag'} · {asset.category || 'Uncategorized'}</small></div><span className={`maintenance-status asset-${asset.status}`}>{asset.status.replaceAll('_', ' ')}</span></header>
      <p>{asset.roomNumber ? `Room ${asset.roomNumber}` : 'Not assigned to a room'} · {asset.openTickets} open ticket{asset.openTickets === 1 ? '' : 's'}</p>
      <div className="maintenance-actions"><button className="button button-secondary" disabled={busy} onClick={() => setEditing(true)}>Edit</button><button className="text-button" disabled={busy} onClick={() => onArchive(asset.id)}>Archive</button></div>
    </>}
  </article>;
}

function TicketCard({ ticket, staff, busy, onAssign, onStatus }) {
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [clearanceNotes, setClearanceNotes] = useState('');
  return <article className="maintenance-ticket">
    <header>
      <div><div className="maintenance-ticket-title"><strong>#{ticket.id} · {ticket.category}</strong><span className={`maintenance-priority priority-${ticket.priority}`}>{ticket.priority}</span></div>
        <p>{ticket.roomNumber ? `Room ${ticket.roomNumber} · ${ticket.roomStatus?.replaceAll('_', ' ')}` : ticket.assetName || 'Property asset'}{ticket.assetTag ? ` · ${ticket.assetTag}` : ''}</p>
      </div>
      <span className={`maintenance-status status-${ticket.status}`}>{ticket.status.replaceAll('_', ' ')}</span>
    </header>
    <p className="maintenance-description">{ticket.description}</p>
    <div className="maintenance-ticket-meta">
      <span>{ticket.blocksRoom ? 'Room blocking' : 'Does not block room'}</span>
      <span>Reported by {ticket.reporterName || 'Unknown'}</span>
      {ticket.roomNumber && <span>Room status: {ticket.roomStatus}</span>}
    </div>
    <Field label="Assigned maintenance staff"><select value={ticket.assignedTo ?? ''} disabled={busy || ticket.status === 'closed'} onChange={(event) => onAssign(ticket.id, event.target.value ? Number(event.target.value) : null)}>
      <option value="">Unassigned</option>{staff.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
    </select></Field>
    {ticket.status === 'open' || ticket.status === 'assigned' ? <button className="button button-primary" disabled={busy} onClick={() => onStatus(ticket.id, { status: 'in_progress' })}>Start work</button> : null}
    {ticket.status === 'in_progress' && <form className="maintenance-action-form" onSubmit={(event) => {
      event.preventDefault();
      onStatus(ticket.id, { status: 'resolved', resolutionNotes });
    }}>
      <Field label="Resolution notes"><textarea required minLength="3" maxLength="2000" value={resolutionNotes} onChange={(event) => setResolutionNotes(event.target.value)} /></Field>
      <button className="button button-primary" disabled={busy}>Mark resolved</button>
    </form>}
    {ticket.status === 'resolved' && <form className="maintenance-action-form" onSubmit={(event) => {
      event.preventDefault();
      onStatus(ticket.id, { status: 'closed', clearanceNotes });
    }}>
      <p className="maintenance-clearance-note">A clear-room note is required before maintenance clearance is recorded.</p>
      <Field label="Clearance notes"><textarea required minLength="3" maxLength="2000" value={clearanceNotes} onChange={(event) => setClearanceNotes(event.target.value)} /></Field>
      <button className="button button-primary" disabled={busy}>Clear ticket and room</button>
    </form>}
    {ticket.resolutionNotes && <p className="maintenance-history"><strong>Resolution:</strong> {ticket.resolutionNotes}</p>}
    {ticket.clearanceNotes && <p className="maintenance-history"><strong>Clearance:</strong> {ticket.clearanceNotes} · {ticket.clearerName} · {ticket.clearedAt}</p>}
  </article>;
}

export function MaintenanceWorkspace({ propertyId }) {
  const [tickets, setTickets] = useState([]);
  const [assets, setAssets] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [staff, setStaff] = useState([]);
  const [filter, setFilter] = useState('active');
  const [targetType, setTargetType] = useState('room');
  const [form, setForm] = useState({
    roomId: '',
    assetId: '',
    category: '',
    priority: 'normal',
    description: '',
    blocksRoom: false,
    assignedTo: '',
  });
  const [assetForm, setAssetForm] = useState({
    name: '',
    assetTag: '',
    category: '',
    roomId: '',
    status: 'active',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflicts, setConflicts] = useState([]);

  const refresh = useCallback(async () => {
    const [ticketRows, assetRows, roomRows, staffRows] = await Promise.all([
      authApi.request('/api/maintenance/tickets'),
      authApi.request('/api/maintenance/assets'),
      authApi.request('/api/maintenance/rooms'),
      authApi.request('/api/maintenance/staff'),
    ]);
    setTickets(ticketRows);
    setAssets(assetRows);
    setRooms(roomRows);
    setStaff(staffRows);
  }, []);

  useEffect(() => {
    refresh().catch((requestError) => setError(requestError.message));
  }, [propertyId, refresh]);

  const handleRoomUpdate = useCallback((update) => {
    setRooms((current) => current.map((room) => room.id === update.roomId
      ? { ...room, status: update.status }
      : room));
    refresh().catch((requestError) => setError(requestError.message));
  }, [refresh]);
  const handleTicketUpdate = useCallback(() => {
    refresh().catch((requestError) => setError(requestError.message));
  }, [refresh]);
  const connected = useRoomStatusUpdates(propertyId, handleRoomUpdate, handleTicketUpdate);

  async function runAction(action, successMessage) {
    setBusy(true);
    setError('');
    try {
      const response = await action();
      if (response?.conflicts) setConflicts(response.conflicts);
      setMessage(successMessage);
      await refresh();
      return response;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createTicket(event) {
    event.preventDefault();
    setConflicts([]);
    const created = await runAction(() => authApi.request('/api/maintenance/tickets', {
      method: 'POST',
      body: JSON.stringify({
        ...(targetType === 'room' ? { roomId: Number(form.roomId) } : { assetId: Number(form.assetId) }),
        category: form.category,
        priority: form.priority,
        description: form.description,
        blocksRoom: form.blocksRoom,
        assignedTo: form.assignedTo ? Number(form.assignedTo) : null,
      }),
    }), 'Maintenance ticket created.');
    if (!created) return;
    setForm({ roomId: '', assetId: '', category: '', priority: 'normal', description: '', blocksRoom: false, assignedTo: '' });
  }

  async function createAsset(event) {
    event.preventDefault();
    const created = await runAction(() => authApi.request('/api/maintenance/assets', {
      method: 'POST',
      body: JSON.stringify({
        ...assetForm,
        assetTag: assetForm.assetTag || null,
        category: assetForm.category || null,
        roomId: assetForm.roomId ? Number(assetForm.roomId) : null,
      }),
    }), 'Asset saved.');
    if (!created) return;
    setAssetForm({ name: '', assetTag: '', category: '', roomId: '', status: 'active' });
  }

  async function updateAsset(id, data) {
    const updated = await runAction(() => authApi.request(`/api/maintenance/assets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }), 'Asset updated.');
    return Boolean(updated);
  }

  async function archiveAsset(id) {
    if (!window.confirm('Archive this asset? Historical tickets will remain available.')) return;
    await runAction(() => authApi.request(`/api/maintenance/assets/${id}`, { method: 'DELETE' }), 'Asset archived.');
  }

  async function updateAssignment(id, assignedTo) {
    await runAction(() => authApi.request(`/api/maintenance/tickets/${id}/assignment`, {
      method: 'PATCH',
      body: JSON.stringify({ assignedTo }),
    }), 'Ticket assignment updated.');
  }

  async function updateStatus(id, data) {
    await runAction(() => authApi.request(`/api/maintenance/tickets/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }), data.status === 'closed' ? 'Ticket cleared and room readiness updated.' : `Ticket marked ${data.status}.`);
  }

  const visibleTickets = tickets.filter((ticket) => filter === 'all' || (filter === 'active'
    ? ticket.status !== 'closed'
    : ticket.status === filter));
  const blockedRooms = rooms.filter((room) => room.blockingTickets > 0 || room.status === 'BLOCKED_MAINTENANCE');

  return <div className="maintenance-page">
    <header className="page-heading">
      <div><p className="eyebrow">ROOM CARE</p><h1>Maintenance</h1><p className="muted">Track repairs, protect room availability, and record audited clearance.</p></div>
      <span className={`maintenance-live ${connected ? 'connected' : ''}`}><i />{connected ? 'Live updates connected' : 'Live updates reconnecting'}</span>
    </header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-notice" role="status">{message}</p>}
    {conflicts.length > 0 && <section className="maintenance-conflicts" role="status">
      <strong>Room blocked, but existing reservations may be affected.</strong>
      {conflicts.map((conflict) => <p key={conflict.confirmationNo}>{conflict.confirmationNo} · {conflict.reservationStatus} · {conflict.checkInDate} to {conflict.checkOutDate}</p>)}
    </section>}
    <section className="maintenance-metrics">
      <article><span>Open tickets</span><strong>{tickets.filter((ticket) => ticket.status !== 'closed').length}</strong></article>
      <article><span>Urgent / high</span><strong>{tickets.filter((ticket) => ['urgent', 'high'].includes(ticket.priority) && ticket.status !== 'closed').length}</strong></article>
      <article><span>Rooms blocked</span><strong>{blockedRooms.length}</strong></article>
      <article><span>Tracked assets</span><strong>{assets.length}</strong></article>
    </section>
    <section className="maintenance-forms">
      <article className="panel maintenance-panel">
        <h2>Report a maintenance ticket</h2>
        <form onSubmit={createTicket}>
          <Field label="Ticket target"><select value={targetType} onChange={(event) => {
            setTargetType(event.target.value);
            setForm((current) => ({ ...current, roomId: '', assetId: '', blocksRoom: false }));
          }}><option value="room">Room</option><option value="asset">Asset</option></select></Field>
          {targetType === 'room'
            ? <Field label="Room"><select required value={form.roomId} onChange={(event) => setForm({ ...form, roomId: event.target.value })}><option value="">Select a room</option>{rooms.map((room) => <option value={room.id} key={room.id}>{room.roomNumber} · {room.status.replaceAll('_', ' ')}</option>)}</select></Field>
            : <Field label="Asset"><select required value={form.assetId} onChange={(event) => setForm({ ...form, assetId: event.target.value })}><option value="">Select an asset</option>{assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}{asset.assetTag ? ` · ${asset.assetTag}` : ''}</option>)}</select></Field>}
          <Field label="Category"><input required maxLength="100" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} placeholder="Plumbing, electrical, HVAC…" /></Field>
          <Field label="Priority"><select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></Field>
          <Field label="Description"><textarea required minLength="3" maxLength="5000" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
          <Field label="Assign to"><select value={form.assignedTo} onChange={(event) => setForm({ ...form, assignedTo: event.target.value })}><option value="">Unassigned</option>{staff.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select></Field>
          <label className="maintenance-check"><input type="checkbox" checked={form.blocksRoom} onChange={(event) => setForm({ ...form, blocksRoom: event.target.checked })} /> Block room from new bookings</label>
          <button className="button button-primary" disabled={busy}>Create ticket</button>
        </form>
      </article>
      <article className="panel maintenance-panel">
        <h2>Register an asset</h2>
        <form onSubmit={createAsset}>
          <Field label="Asset name"><input required maxLength="160" value={assetForm.name} onChange={(event) => setAssetForm({ ...assetForm, name: event.target.value })} /></Field>
          <Field label="Asset tag"><input maxLength="100" value={assetForm.assetTag} onChange={(event) => setAssetForm({ ...assetForm, assetTag: event.target.value })} /></Field>
          <Field label="Category"><input maxLength="100" value={assetForm.category} onChange={(event) => setAssetForm({ ...assetForm, category: event.target.value })} /></Field>
          <Field label="Assigned room"><select value={assetForm.roomId} onChange={(event) => setAssetForm({ ...assetForm, roomId: event.target.value })}><option value="">Property asset</option>{rooms.map((room) => <option value={room.id} key={room.id}>{room.roomNumber}</option>)}</select></Field>
          <Field label="Condition"><select value={assetForm.status} onChange={(event) => setAssetForm({ ...assetForm, status: event.target.value })}><option value="active">Active</option><option value="needs_service">Needs service</option><option value="out_of_service">Out of service</option></select></Field>
          <button className="button button-primary" disabled={busy}>Register asset</button>
        </form>
      </article>
    </section>
    <section className="panel maintenance-board">
      <header><div><h2>Maintenance tickets</h2><p>Blocking tickets continue to exclude a room through resolution until audited clearance.</p></div>
        <Field label="Filter tickets"><select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="active">All active</option><option value="all">All tickets</option><option value="open">Open</option><option value="assigned">Assigned</option><option value="in_progress">In progress</option><option value="resolved">Resolved / awaiting clearance</option><option value="closed">Cleared</option>
        </select></Field>
        <button className="button button-secondary" disabled={busy} onClick={() => refresh().catch((requestError) => setError(requestError.message))}>Refresh</button>
      </header>
      {visibleTickets.length
        ? <div className="maintenance-ticket-grid">{visibleTickets.map((ticket) => <TicketCard
          key={ticket.id}
          ticket={ticket}
          staff={staff}
          busy={busy}
          onAssign={updateAssignment}
          onStatus={updateStatus}
        />)}</div>
        : <p className="maintenance-empty">No tickets match this filter.</p>}
    </section>
    <section className="panel maintenance-board">
      <header><div><h2>Asset register</h2><p>Property and room-linked equipment with service history.</p></div></header>
      {assets.length
        ? <div className="maintenance-asset-grid">{assets.map((asset) => <AssetCard
          key={asset.id}
          asset={asset}
          rooms={rooms}
          busy={busy}
          onSave={updateAsset}
          onArchive={archiveAsset}
        />)}</div>
        : <p className="maintenance-empty">No assets registered.</p>}
    </section>
    <section className="panel maintenance-board">
      <header><div><h2>Room blocking overview</h2><p>Rooms remain unavailable until every blocking ticket is cleared.</p></div></header>
      {blockedRooms.length
        ? <div className="maintenance-blocked-grid">{blockedRooms.map((room) => <article key={room.id}>
          <strong>{room.roomNumber}</strong><span>{room.status.replaceAll('_', ' ')}</span><small>{room.blockingTickets} blocking ticket{room.blockingTickets === 1 ? '' : 's'}</small>
        </article>)}</div>
        : <p className="maintenance-empty">No rooms are currently blocked.</p>}
    </section>
  </div>;
}
