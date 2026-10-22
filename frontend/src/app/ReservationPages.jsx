import { useCallback, useEffect, useMemo, useState } from 'react';
import { authApi } from '../auth/api.js';
import '../styles/reservation.css';

const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const shiftDate = (value, days) => new Date(new Date(`${value}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const dayCount = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS);
const money = (value, currency = 'ETB') => `${currency} ${Number(value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Field({ label, children }) {
  return <label className="setup-field">{label}{children}</label>;
}

function dateRange(from, count) {
  return Array.from({ length: count }, (_, index) => shiftDate(from, index));
}

function NewReservation({ permissionKeys, onCreated, onMessage }) {
  const [guests, setGuests] = useState([]);
  const [roomTypes, setRoomTypes] = useState([]);
  const [ratePlans, setRatePlans] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [groups, setGroups] = useState([]);
  const [form, setForm] = useState({
    primaryGuestId: '',
    companyId: '',
    groupId: '',
    checkInDate: today(),
    checkOutDate: shiftDate(today(), 1),
    roomTypeId: '',
    ratePlanId: '',
    roomId: '',
    adults: 1,
    children: 0,
    roomCount: 1,
    source: 'manual',
    status: 'confirmed',
    specialRequests: '',
  });
  const [availability, setAvailability] = useState([]);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const canQuote = permissionKeys.includes('rates.view');

  useEffect(() => {
    Promise.all([
      authApi.request('/api/guests'),
      authApi.request('/api/property/room-types'),
      authApi.request('/api/property/rate-plans'),
      authApi.request('/api/property/rooms'),
      authApi.request('/api/companies'),
      authApi.request('/api/guest-groups'),
    ]).then(([guestRows, typeRows, planRows, roomRows, companyRows, groupRows]) => {
      setGuests(guestRows);
      setRoomTypes(typeRows);
      setRatePlans(planRows);
      setRooms(roomRows);
      setCompanies(companyRows);
      setGroups(groupRows);
      setForm((current) => ({
        ...current,
        roomTypeId: current.roomTypeId || String(typeRows[0]?.id ?? ''),
        ratePlanId: current.ratePlanId || String(planRows[0]?.id ?? ''),
        primaryGuestId: current.primaryGuestId || String(guestRows[0]?.id ?? ''),
      }));
    }).catch((error) => onMessage(error.message));
  }, [onMessage]);

  const selectedType = roomTypes.find((item) => item.id === Number(form.roomTypeId));
  const selectedPlan = ratePlans.find((item) => item.id === Number(form.ratePlanId));
  const assignableRooms = rooms.filter((room) => room.roomTypeId === Number(form.roomTypeId)
    && room.isActive && room.status !== 'BLOCKED_MAINTENANCE');
  async function checkAvailability(event) {
    event.preventDefault();
    setBusy(true);
    setQuote(null);
    try {
      const result = await authApi.request(
        `/api/reservations/availability?from=${form.checkInDate}&to=${form.checkOutDate}&roomTypeId=${form.roomTypeId}`,
      );
      setAvailability(result);
      setForm((current) => ({ ...current, roomId: '' }));
      if (canQuote) {
        const price = await authApi.request('/api/property/rates/quote', {
          method: 'POST',
          body: JSON.stringify({
            roomTypeId: Number(form.roomTypeId),
            ratePlanId: Number(form.ratePlanId),
            checkIn: form.checkInDate,
            checkOut: form.checkOutDate,
            adults: Number(form.adults),
            children: Number(form.children),
          }),
        });
        setQuote(price);
      }
      onMessage('Availability and rate quote refreshed.');
    } catch (error) {
      onMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await authApi.request('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          primaryGuestId: Number(form.primaryGuestId),
          guestIds: groups.find((group) => group.id === Number(form.groupId))?.members.map((guest) => guest.id) ?? [],
          companyId: form.companyId ? Number(form.companyId) : null,
          groupId: form.groupId ? Number(form.groupId) : null,
          source: form.source,
          status: form.status,
          checkInDate: form.checkInDate,
          checkOutDate: form.checkOutDate,
          rooms: Array.from({ length: Number(form.roomCount) }, () => ({
            roomTypeId: Number(form.roomTypeId),
            roomId: Number(form.roomCount) === 1 && form.roomId ? Number(form.roomId) : null,
            ratePlanId: Number(form.ratePlanId),
            adults: Number(form.adults),
            children: Number(form.children),
          })),
          specialRequests: form.specialRequests || null,
        }),
      });
      onMessage(`Reservation ${result.confirmationNo} created.`);
      onCreated(result);
    } catch (error) {
      onMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  const firstNightAvailability = availability[0]?.roomTypes?.find((type) => type.id === Number(form.roomTypeId));
  return <div className="reservation-wizard">
    <div className="reservation-wizard-heading"><h2>New reservation</h2><p className="muted">Check availability and rates, then confirm the guest and room.</p></div>
    <form className="reservation-form" onSubmit={create}>
      <Field label="Check in"><input required type="date" min={today()} value={form.checkInDate} onChange={(event) => setForm({ ...form, checkInDate: event.target.value })} /></Field>
      <Field label="Check out"><input required type="date" min={shiftDate(form.checkInDate, 1)} value={form.checkOutDate} onChange={(event) => setForm({ ...form, checkOutDate: event.target.value })} /></Field>
      <Field label="Room type"><select required value={form.roomTypeId} onChange={(event) => setForm({ ...form, roomTypeId: event.target.value })}>{roomTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field>
      <Field label="Rate plan"><select required value={form.ratePlanId} onChange={(event) => setForm({ ...form, ratePlanId: event.target.value })}>{ratePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></Field>
      <Field label="Adults"><input type="number" required min="1" max={selectedType?.maxAdults ?? 20} value={form.adults} onChange={(event) => setForm({ ...form, adults: event.target.value })} /></Field>
      <Field label="Children"><input type="number" required min="0" max={selectedType?.maxChildren ?? 20} value={form.children} onChange={(event) => setForm({ ...form, children: event.target.value })} /></Field>
      <Field label="Primary guest"><select required value={form.primaryGuestId} onChange={(event) => setForm({ ...form, primaryGuestId: event.target.value })}>{guests.map((guest) => <option key={guest.id} value={guest.id}>{guest.fullName}</option>)}</select></Field>
      <Field label="Company (optional)"><select value={form.companyId} onChange={(event) => setForm({ ...form, companyId: event.target.value })}><option value="">No company</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></Field>
      <Field label="Guest group (optional)"><select value={form.groupId} onChange={(event) => setForm({ ...form, groupId: event.target.value })}><option value="">No group</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name} · {group.memberCount} guests</option>)}</select></Field>
      <Field label="Rooms"><input type="number" min="1" max="20" required value={form.roomCount} onChange={(event) => setForm({ ...form, roomCount: event.target.value, roomId: '' })} /></Field>
      <Field label="Source"><select value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })}><option value="manual">Manual</option><option value="phone">Phone</option><option value="walk_in">Walk-in</option></select></Field>
      <Field label="Status"><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="confirmed">Confirmed</option><option value="tentative">Tentative</option></select></Field>
      <Field label="Special requests"><input maxLength="5000" value={form.specialRequests} onChange={(event) => setForm({ ...form, specialRequests: event.target.value })} /></Field>
      <Field label="Assign room (one room only)"><select disabled={Number(form.roomCount) !== 1} value={form.roomId} onChange={(event) => setForm({ ...form, roomId: event.target.value })}><option value="">Leave unassigned</option>{assignableRooms.map((room) => <option key={room.id} value={room.id}>{room.roomNumber} · {room.status.replaceAll('_', ' ').toLowerCase()}</option>)}</select></Field>
      <button type="button" className="button button-secondary" disabled={busy || !form.roomTypeId || !form.ratePlanId} onClick={checkAvailability}>Check availability &amp; quote</button>
      <button className="button button-primary" disabled={busy || !form.primaryGuestId || !form.roomTypeId || !form.ratePlanId}>Create reservation</button>
    </form>
    {availability.length > 0 && <div className="reservation-availability">
      <strong>{firstNightAvailability?.availableRooms ?? 0} {selectedType?.name ?? 'rooms'} available on first night</strong>
      <div className="availability-nights">{availability.map((night) => {
        const type = night.roomTypes.find((item) => item.id === Number(form.roomTypeId));
        return <span key={night.date} className={type?.availableRooms ? '' : 'sold-out'}>{night.date.slice(5)} · {type?.availableRooms ?? 0}</span>;
      })}</div>
      {quote && <div className="quote-result"><strong>{money(quote.totals.total, quote.currency)} total · {quote.nights} nights</strong><small>{selectedPlan?.name} · {money(quote.totals.rate, quote.currency)} room rate</small></div>}
    </div>}
  </div>;
}

function ReservationDetails({ reservation, permissionKeys, onClose, onRefresh, onMessage }) {
  const [reason, setReason] = useState('');
  const [cancellationFee, setCancellationFee] = useState('0.00');
  const [busy, setBusy] = useState(false);
  async function mutate(path, body, success) {
    if (!reason.trim()) {
      onMessage('Enter a reason before changing a reservation.');
      return;
    }
    setBusy(true);
    try {
      await authApi.request(path, { method: 'POST', body: JSON.stringify({ ...body, reason }) });
      onMessage(success);
      await onRefresh(reservation.id);
    } catch (error) {
      onMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  const canCancel = permissionKeys.includes('reservations.cancel') && ['tentative', 'confirmed'].includes(reservation.status);
  const canEdit = permissionKeys.includes('reservations.edit') && ['tentative', 'confirmed'].includes(reservation.status);
  return <div className="reservation-modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
    <section className="reservation-drawer" role="dialog" aria-modal="true" aria-labelledby="reservation-detail-title">
      <header><div><p className="eyebrow">RESERVATION DETAIL</p><h2 id="reservation-detail-title">{reservation.confirmationNo}</h2></div><button className="icon-button" aria-label="Close reservation details" onClick={onClose}>×</button></header>
      <div className="reservation-detail-grid">
        <div><span>Guest</span><strong>{reservation.guestName || 'Guest'}</strong></div>
        <div><span>Status</span><strong className={`reservation-status status-${reservation.status}`}>{reservation.status.replace('_', ' ')}</strong></div>
        <div><span>Stay</span><strong>{reservation.checkInDate} – {reservation.checkOutDate}</strong></div>
        <div><span>Room</span><strong>{reservation.assignedRoom || 'Unassigned'} · {reservation.roomType}</strong></div>
        <div><span>Guests</span><strong>{reservation.adults} adults · {reservation.children} children</strong></div>
        <div><span>Estimate</span><strong>{money(reservation.totalEstimate)}</strong></div>
        {reservation.guestPhone && <div><span>Phone</span><strong>{reservation.guestPhone}</strong></div>}
        {reservation.companyName && <div><span>Company</span><strong>{reservation.companyName}</strong></div>}
      </div>
      {reservation.specialRequests && <p className="reservation-special"><strong>Special requests</strong><br />{reservation.specialRequests}</p>}
      {reservation.guests?.length > 1 && <section><h3>Guests</h3>{reservation.guests.map((guest) => <p key={guest.id}>{guest.name}{guest.isPrimary ? ' · Primary' : ''}</p>)}</section>}
      {canEdit && <section className="reservation-action-form">
        <h3>Extend stay</h3>
        <Field label="New check-out date"><input type="date" min={shiftDate(reservation.checkOutDate, 1)} id="reservation-extension-date" /></Field>
        <Field label="Reason"><input value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <button className="button button-secondary" disabled={busy} onClick={() => {
          const value = document.getElementById('reservation-extension-date')?.value;
          if (value) mutate(`/api/reservations/${reservation.id}/extend`, { checkOutDate: value }, 'Reservation extended.');
        }}>Extend</button>
      </section>}
      {canCancel && <section className="reservation-action-form">
        <h3>Cancel reservation</h3>
        <Field label="Cancellation fee (recorded for later posting)"><input inputMode="decimal" value={cancellationFee} onChange={(event) => setCancellationFee(event.target.value)} /></Field>
        <Field label="Reason"><input value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <button className="button button-danger" disabled={busy} onClick={() => mutate(`/api/reservations/${reservation.id}/cancel`, { cancellationFee }, 'Reservation cancelled and inventory released.')}>Cancel reservation</button>
      </section>}
      {permissionKeys.includes('reservations.cancel') && reservation.status === 'confirmed' && <section className="reservation-action-form">
        <h3>Mark no-show</h3>
        <Field label="Reason"><input value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <button className="button button-secondary" disabled={busy} onClick={() => mutate(`/api/reservations/${reservation.id}/no-show`, {}, 'Reservation marked no-show.')}>Mark no-show</button>
      </section>}
      <section className="reservation-history"><h3>History</h3>{reservation.history?.map((event) => <article key={event.id}><strong>{event.action.replaceAll('_', ' ')}</strong><span>{event.fromStatus && `${event.fromStatus} → `}{event.toStatus || ''}{event.reason ? ` · ${event.reason}` : ''}</span></article>)}</section>
    </section>
  </div>;
}

export function ReservationWorkspace({ permissionKeys = [] }) {
  const [tab, setTab] = useState('Calendar');
  const [from, setFrom] = useState(today());
  const [calendar, setCalendar] = useState({ rooms: [], reservations: [] });
  const [reservations, setReservations] = useState([]);
  const [arrivals, setArrivals] = useState([]);
  const [departures, setDepartures] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState(null);
  const canCreate = permissionKeys.includes('reservations.create');
  const canEdit = permissionKeys.includes('reservations.edit');
  const dates = useMemo(() => dateRange(from, 14), [from]);

  const load = useCallback(async () => {
    const [calendarData, listData, arrivalsData, departuresData] = await Promise.all([
      authApi.request(`/api/reservations/calendar?from=${from}&to=${shiftDate(from, 14)}`),
      authApi.request(`/api/reservations?search=${encodeURIComponent(search)}${status ? `&status=${status}` : ''}`),
      authApi.request(`/api/reservations/arrivals?date=${today()}`),
      authApi.request(`/api/reservations/departures?date=${today()}`),
    ]);
    setCalendar(calendarData);
    setReservations(listData);
    setArrivals(arrivalsData.reservations);
    setDepartures(departuresData.reservations);
  }, [from, search, status]);

  useEffect(() => {
    load().catch((error) => setMessage(error.message));
    const interval = window.setInterval(() => load().catch((error) => setMessage(error.message)), 10_000);
    const onFocus = () => load().catch((error) => setMessage(error.message));
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  async function refreshDetail(id) {
    await load();
    setSelected(await authApi.request(`/api/reservations/${id}`));
  }

  async function selectReservation(reservation) {
    try {
      setSelected(await authApi.request(`/api/reservations/${reservation.id}`));
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function dropReservation(room, date) {
    if (!dragged || !canEdit) return;
    const reservation = dragged;
    setDragged(null);
    const offset = dayCount(reservation.checkInDate, date);
    const checkInDate = shiftDate(reservation.checkInDate, offset);
    const checkOutDate = shiftDate(reservation.checkOutDate, offset);
    setBusy(true);
    try {
      await authApi.request(`/api/reservations/${reservation.id}/move`, {
        method: 'POST',
        body: JSON.stringify({
          roomId: room.id,
          checkInDate,
          checkOutDate,
          reason: `Calendar move to room ${room.roomNumber} on ${date}`,
        }),
      });
      setMessage('Reservation moved on the calendar.');
      await load();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  const assignedByRoom = useMemo(() => {
    const mapping = new Map();
    for (const reservation of calendar.reservations) {
      const roomLines = reservation.rooms?.length
        ? reservation.rooms.filter((line) => line.roomId)
        : reservation.assignedRoomId ? [{ roomId: reservation.assignedRoomId }] : [];
      for (const line of roomLines) {
        if (!mapping.has(line.roomId)) mapping.set(line.roomId, []);
        mapping.get(line.roomId).push(reservation);
      }
    }
    return mapping;
  }, [calendar.reservations]);

  const reservationCard = (reservation, date) => {
    const starts = reservation.checkInDate === date;
    const nightInStay = date >= reservation.checkInDate && date < reservation.checkOutDate;
    if (!starts && !nightInStay) return null;
    if (!starts) return <div className="calendar-stay-continuation" aria-label={`${reservation.confirmationNo} stay continues`} />;
    const canDrag = canEdit && reservation.status !== 'checked_in' && (reservation.rooms?.length ?? 1) === 1;
    return <button
      className={`calendar-reservation status-${reservation.status}`}
      draggable={canDrag}
      title={`${reservation.confirmationNo} · ${reservation.guestName ?? 'Guest'} · ${reservation.status}`}
      onDragStart={() => setDragged(reservation)}
      onDragEnd={() => setDragged(null)}
      onClick={() => selectReservation(reservation)}
    >{reservation.guestName || reservation.confirmationNo}<small>{reservation.confirmationNo}</small></button>;
  };

  return <div className="reservation-page">
    <header className="page-heading reservation-page-heading">
      <div><p className="eyebrow">HOTEL OPERATIONS</p><h1>Reservations</h1><p className="muted">Availability, arrivals, departures and the room timeline.</p></div>
      {canCreate && <button className="button button-primary" onClick={() => setShowCreate((value) => !value)}>＋ New reservation</button>}
    </header>
    {message && <div className="form-message" role="status">{message}</div>}
    {showCreate && <section className="panel"><NewReservation permissionKeys={permissionKeys} onMessage={setMessage} onCreated={async () => { setShowCreate(false); await load(); }} /></section>}
    <div className="reservation-tabs" role="tablist" aria-label="Reservation views">
      {['Calendar', 'Reservations', 'Arrivals', 'Departures'].map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}{item === 'Arrivals' ? ` · ${arrivals.length}` : item === 'Departures' ? ` · ${departures.length}` : ''}</button>)}
    </div>
    {tab === 'Calendar' && <section className="panel calendar-panel">
      <div className="calendar-toolbar"><div><h2>Room timeline</h2><p className="muted">Updates automatically every 10 seconds. Drag an unarrived reservation to move its room and stay dates.</p></div><div className="calendar-date-controls"><button className="button button-secondary" onClick={() => setFrom((value) => shiftDate(value, -7))}>← Week</button><input aria-label="Calendar start date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /><button className="button button-secondary" onClick={() => setFrom((value) => shiftDate(value, 7))}>Week →</button><button className="button button-secondary" disabled={busy} onClick={() => load().catch((error) => setMessage(error.message))}>Refresh</button></div></div>
      <div className="calendar-scroll"><div className="reservation-calendar">
        <div className="calendar-corner">ROOM</div>{dates.map((date) => <div className="calendar-date" key={date}><strong>{date.slice(8)}</strong><small>{new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short' })}</small></div>)}
        {calendar.rooms.map((room) => <FragmentRow
          key={room.id}
          room={room}
          dates={dates}
          reservations={assignedByRoom.get(room.id) ?? []}
          reservationCard={reservationCard}
          onDrop={dropReservation}
          canEdit={canEdit}
          dragged={Boolean(dragged)}
        />)}
      </div></div>
      {dragged && <p className="calendar-drop-hint">Drop {dragged.confirmationNo} on a room/date cell to move it.</p>}
    </section>}
    {tab === 'Reservations' && <section className="panel reservation-list-panel">
      <form className="reservation-list-filters" onSubmit={(event) => { event.preventDefault(); load().catch((error) => setMessage(error.message)); }}>
        <input aria-label="Search reservations" placeholder="Guest, phone or confirmation number" value={search} onChange={(event) => setSearch(event.target.value)} />
        <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{['tentative', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'].map((item) => <option key={item} value={item}>{item.replace('_', ' ')}</option>)}</select>
        <button className="button button-secondary">Search</button>
      </form>
      <ReservationList reservations={reservations} onSelect={selectReservation} />
    </section>}
    {tab === 'Arrivals' && <section className="panel reservation-list-panel"><h2>Arrivals today</h2><ReservationList reservations={arrivals} onSelect={selectReservation} /></section>}
    {tab === 'Departures' && <section className="panel reservation-list-panel"><h2>Departures today</h2><ReservationList reservations={departures} onSelect={selectReservation} /></section>}
    {selected && <ReservationDetails
      reservation={selected}
      permissionKeys={permissionKeys}
      onClose={() => setSelected(null)}
      onRefresh={refreshDetail}
      onMessage={setMessage}
    />}
  </div>;
}

function FragmentRow({ room, dates, reservations, reservationCard, onDrop, canEdit, dragged }) {
  return <>
    <div className="calendar-room"><strong>{room.roomNumber}</strong><small>{room.roomType}{room.floor ? ` · ${room.floor}` : ''}</small></div>
    {dates.map((date) => {
      const reservation = reservations.find((item) => date >= item.checkInDate && date < item.checkOutDate);
      return <div
        key={`${room.id}:${date}`}
        className={`calendar-cell${dragged ? ' drop-target' : ''}`}
        onDragOver={(event) => canEdit && event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); onDrop(room, date); }}
      >{reservation ? reservationCard(reservation, date) : null}</div>;
    })}
  </>;
}

function ReservationList({ reservations, onSelect }) {
  if (!reservations.length) return <p className="guest-empty">No reservations to display.</p>;
  return <div className="reservation-list">{reservations.map((reservation) => <button className="reservation-list-row" key={reservation.id} onClick={() => onSelect(reservation)}>
    <span><strong>{reservation.confirmationNo}</strong><small>{reservation.guestName || 'Guest'}{reservation.guestPhone ? ` · ${reservation.guestPhone}` : ''}</small></span>
    <span><strong>{reservation.checkInDate} – {reservation.checkOutDate}</strong><small>{reservation.assignedRoom || 'Unassigned'} · {reservation.roomType}</small></span>
    <span className={`reservation-status status-${reservation.status}`}>{reservation.status.replace('_', ' ')}</span>
    <strong>{money(reservation.totalEstimate)}</strong>
  </button>)}</div>;
}
