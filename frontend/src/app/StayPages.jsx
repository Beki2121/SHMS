import { useCallback, useEffect, useMemo, useState } from 'react';
import { authApi } from '../auth/api.js';
import '../styles/stay.css';

function Field({ label, children }) {
  return <label className="setup-field">{label}{children}</label>;
}

function Money({ value }) {
  return <>ETB {Number(value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>;
}

function cleanRoom(room) {
  return room.isActive && room.status === 'CLEAN';
}

export function FrontDesk({ permissionKeys = [] }) {
  const [arrivals, setArrivals] = useState([]);
  const [stays, setStays] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [activeReservation, setActiveReservation] = useState(null);
  const [activeStay, setActiveStay] = useState(null);
  const [checkInRooms, setCheckInRooms] = useState([]);
  const [earlyCheckIn, setEarlyCheckIn] = useState(false);
  const [checkInIdentity, setCheckInIdentity] = useState({ idType: '', idNumber: '' });
  const [walkIn, setWalkIn] = useState({
    firstName: '', lastName: '', phone: '', email: '', idType: '', idNumber: '',
    roomId: '', adults: 1, children: 0, depositAmount: '0.00', paymentTerms: '',
  });
  const [checkInDeposit, setCheckInDeposit] = useState('0.00');
  const [checkInTerms, setCheckInTerms] = useState('');
  const [guestForm, setGuestForm] = useState({ guestId: '' });
  const [requestForm, setRequestForm] = useState({ type: 'Housekeeping', description: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [lateCheckout, setLateCheckout] = useState(false);
  const [approveCredit, setApproveCredit] = useState(false);
  const [creditReason, setCreditReason] = useState('');
  const [moveRoomId, setMoveRoomId] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [approveRateChange, setApproveRateChange] = useState(false);
  const [extendDate, setExtendDate] = useState('');
  const [extendReason, setExtendReason] = useState('');
  const [addRequest, setAddRequest] = useState(false);
  const canApproveCredit = permissionKeys.includes('folio.approve_credit');
  const canShorten = permissionKeys.includes('stays.shorten');
  const cleanRooms = useMemo(() => rooms.filter(cleanRoom), [rooms]);

  const load = useCallback(async () => {
    const [arrivalData, stayData, roomData] = await Promise.all([
      authApi.request('/api/reservations/arrivals'),
      authApi.request('/api/stays/in-house'),
      authApi.request('/api/property/rooms'),
    ]);
    setArrivals(arrivalData.reservations);
    setStays(stayData);
    setRooms(roomData);
  }, []);

  useEffect(() => {
    load().catch((error) => setMessage(error.message));
  }, [load]);

  async function openCheckIn(reservation) {
    setMessage('');
    setBusy(true);
    try {
      const detail = await authApi.request(`/api/reservations/${reservation.id}`);
      const initialRooms = detail.rooms.map((line) => {
        const existing = rooms.find((room) => room.id === line.roomId && cleanRoom(room));
        const firstClean = rooms.find((room) => room.roomTypeId === line.roomTypeId && cleanRoom(room));
        return String(existing?.id ?? firstClean?.id ?? '');
      });
      setActiveReservation(detail);
      setCheckInRooms(initialRooms);
      setEarlyCheckIn(false);
      setCheckInIdentity({ idType: '', idNumber: '' });
      setCheckInDeposit('0.00');
      setCheckInTerms('');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function checkIn(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await authApi.request(`/api/reservations/${activeReservation.id}/check-in`, {
        method: 'POST',
        body: JSON.stringify({
          roomIds: checkInRooms.map(Number),
          earlyCheckIn,
          depositAmount: checkInDeposit,
          paymentTerms: checkInTerms || null,
          ...(checkInIdentity.idNumber ? {
            idNumber: checkInIdentity.idNumber,
            ...(checkInIdentity.idType ? { idType: checkInIdentity.idType } : {}),
          } : {}),
        }),
      });
      setMessage(`Checked in ${result.data.guestName} to ${result.data.stays.length} room(s).`);
      setActiveReservation(null);
      await load();
    } catch (error) {
      const alternatives = error.details?.assignableRooms?.map((room) => room.roomNumber).join(', ');
      setMessage(alternatives ? `${error.message}. Available alternatives: ${alternatives}` : error.message);
    } finally {
      setBusy(false);
    }
  }

  async function createWalkIn(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await authApi.request('/api/walk-ins', {
        method: 'POST',
        body: JSON.stringify({
          guest: {
            firstName: walkIn.firstName,
            lastName: walkIn.lastName,
            phone: walkIn.phone || null,
            email: walkIn.email || null,
            ...(walkIn.idType ? { idType: walkIn.idType } : {}),
            ...(walkIn.idNumber ? { idNumber: walkIn.idNumber } : {}),
          },
          roomId: Number(walkIn.roomId),
          adults: Number(walkIn.adults),
          children: Number(walkIn.children),
          depositAmount: walkIn.depositAmount,
          paymentTerms: walkIn.paymentTerms || null,
        }),
      });
      setMessage(`Walk-in ${result.data.confirmationNo} checked into room ${result.data.roomNumber}.`);
      setWalkIn({
        firstName: '', lastName: '', phone: '', email: '', idType: '', idNumber: '',
        roomId: '', adults: 1, children: 0, depositAmount: '0.00', paymentTerms: '',
      });
      await load();
    } catch (error) {
      const alternatives = error.details?.assignableRooms?.map((room) => room.roomNumber).join(', ');
      setMessage(alternatives ? `${error.message}. Available alternatives: ${alternatives}` : error.message);
    } finally {
      setBusy(false);
    }
  }

  async function openStay(stay) {
    setMessage('');
    setBusy(true);
    try {
      const detail = await authApi.request(`/api/stays/${stay.id}`);
      setActiveStay(detail);
      setLateCheckout(false);
      setApproveCredit(false);
      setCreditReason('');
      setMoveRoomId('');
      setMoveReason('');
      setApproveRateChange(false);
      setExtendDate(detail.checkOutDate);
      setExtendReason('');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function runStayAction(path, body, success) {
    if (!activeStay) return;
    setBusy(true);
    setMessage('');
    try {
      await authApi.request(path, { method: 'POST', body: JSON.stringify(body) });
      setMessage(success);
      setActiveStay(await authApi.request(`/api/stays/${activeStay.id}`));
      await load();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function checkout() {
    if (!activeStay) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await authApi.request(`/api/stays/${activeStay.id}/check-out`, {
        method: 'POST',
        body: JSON.stringify({ lateCheckout, approveCredit, ...(creditReason ? { creditReason } : {}) }),
      });
      setMessage(`Checked out. Invoice ${result.invoice.number} is ready.`);
      setActiveStay(null);
      await load();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function addGuest(event) {
    event.preventDefault();
    await runStayAction(`/api/stays/${activeStay.id}/guests`, { guestId: Number(guestForm.guestId) }, 'Guest added to the stay.');
    setGuestForm({ guestId: '' });
  }

  async function logRequest(event) {
    event.preventDefault();
    await runStayAction(`/api/stays/${activeStay.id}/requests`, requestForm, 'Guest request logged.');
    setRequestForm({ type: 'Housekeeping', description: '' });
    setAddRequest(false);
  }

  return <div className="stay-page">
    <header className="page-heading">
      <div><p className="eyebrow">HOTEL OPERATIONS</p><h1>Front desk</h1><p className="muted">Arrivals, in-house stays, room moves and checkout.</p></div>
      <button className="button button-secondary" onClick={() => load().catch((error) => setMessage(error.message))}>Refresh</button>
    </header>
    {message && <p className="form-notice" role="status">{message}</p>}

    <section className="stay-columns">
      <article className="panel stay-list-panel">
        <div className="stay-panel-heading"><div><h2>Arrivals today</h2><p className="muted">{arrivals.length} reservations due</p></div></div>
        {arrivals.length === 0 ? <p className="muted">No arrivals due today.</p> : arrivals.map((reservation) => <div className="stay-row" key={reservation.id}>
          <div><strong>{reservation.confirmationNo} · {reservation.guestName}</strong><small>{reservation.checkInDate} – {reservation.checkOutDate} · {reservation.roomType}</small></div>
          <span className={`reservation-status status-${reservation.status}`}>{reservation.status.replaceAll('_', ' ')}</span>
          <button className="button button-primary" disabled={busy || reservation.status === 'checked_in'} onClick={() => openCheckIn(reservation)}>Check in</button>
        </div>)}
      </article>

      <article className="panel walkin-panel">
        <div className="stay-panel-heading"><div><h2>Quick walk-in</h2><p className="muted">Register the guest and create the stay in one transaction.</p></div></div>
        <form className="stay-form" onSubmit={createWalkIn}>
          <Field label="First name"><input required value={walkIn.firstName} onChange={(event) => setWalkIn({ ...walkIn, firstName: event.target.value })} /></Field>
          <Field label="Last name"><input required value={walkIn.lastName} onChange={(event) => setWalkIn({ ...walkIn, lastName: event.target.value })} /></Field>
          <Field label="Phone"><input value={walkIn.phone} onChange={(event) => setWalkIn({ ...walkIn, phone: event.target.value })} /></Field>
          <Field label="Email"><input type="email" value={walkIn.email} onChange={(event) => setWalkIn({ ...walkIn, email: event.target.value })} /></Field>
          <Field label="ID type"><input value={walkIn.idType} onChange={(event) => setWalkIn({ ...walkIn, idType: event.target.value })} /></Field>
          <Field label="ID number"><input value={walkIn.idNumber} onChange={(event) => setWalkIn({ ...walkIn, idNumber: event.target.value })} /></Field>
          <Field label="Room"><select required value={walkIn.roomId} onChange={(event) => setWalkIn({ ...walkIn, roomId: event.target.value })}><option value="">Choose clean room</option>{cleanRooms.map((room) => <option key={room.id} value={room.id}>{room.roomNumber} · {room.roomType}</option>)}</select></Field>
          <Field label="Adults"><input type="number" min="1" max="20" value={walkIn.adults} onChange={(event) => setWalkIn({ ...walkIn, adults: event.target.value })} /></Field>
          <Field label="Children"><input type="number" min="0" max="20" value={walkIn.children} onChange={(event) => setWalkIn({ ...walkIn, children: event.target.value })} /></Field>
          <Field label="Deposit required per room"><input type="number" min="0" step="0.01" value={walkIn.depositAmount} onChange={(event) => setWalkIn({ ...walkIn, depositAmount: event.target.value })} /></Field>
          <Field label="Payment terms"><input value={walkIn.paymentTerms} onChange={(event) => setWalkIn({ ...walkIn, paymentTerms: event.target.value })} /></Field>
          <button className="button button-primary" disabled={busy || cleanRooms.length === 0}>Register & check in</button>
        </form>
      </article>
    </section>

    <section className="panel stay-list-panel">
      <div className="stay-panel-heading"><div><h2>In-house guests</h2><p className="muted">{stays.length} active room stays</p></div></div>
      {stays.length === 0 ? <p className="muted">No guests are currently in-house.</p> : <div className="stay-table">
        {stays.map((stay) => <button className="stay-row stay-row-button" key={stay.id} onClick={() => openStay(stay)}>
          <div><strong>{stay.guestName}</strong><small>{stay.confirmationNo} · {stay.phone || 'No phone'}</small></div>
          <span>Room {stay.roomNumber}</span>
          <span>{stay.checkOutDate} checkout</span>
          <span>Balance <Money value={stay.balance} /></span>
          <span className="stay-open-label">Manage →</span>
        </button>)}
      </div>}
    </section>

    {activeReservation && <div className="stay-modal-backdrop" role="presentation" onClick={() => setActiveReservation(null)}>
      <section className="stay-drawer" role="dialog" aria-modal="true" aria-labelledby="checkin-title" onClick={(event) => event.stopPropagation()}>
        <header><div><p className="eyebrow">GUIDED ARRIVAL</p><h2 id="checkin-title">{activeReservation.confirmationNo}</h2></div><button aria-label="Close check-in wizard" className="icon-button" onClick={() => setActiveReservation(null)}>×</button></header>
        <p><strong>{activeReservation.guestName}</strong> · {activeReservation.checkInDate} – {activeReservation.checkOutDate}</p>
        <form className="stay-form" onSubmit={checkIn}>
          {activeReservation.rooms.map((line, index) => <Field key={line.id ?? index} label={`Room ${index + 1} · ${line.roomType}`}>
            <select required value={checkInRooms[index] ?? ''} onChange={(event) => setCheckInRooms((current) => current.map((roomId, roomIndex) => roomIndex === index ? event.target.value : roomId))}>
              <option value="">Select clean room</option>
              {rooms.filter((room) => room.roomTypeId === line.roomTypeId && cleanRoom(room)).map((room) => <option key={room.id} value={room.id}>{room.roomNumber}</option>)}
            </select>
          </Field>)}
          <Field label="Guest ID type"><input value={checkInIdentity.idType} onChange={(event) => setCheckInIdentity({ ...checkInIdentity, idType: event.target.value })} /></Field>
          <Field label="Guest ID number"><input value={checkInIdentity.idNumber} onChange={(event) => setCheckInIdentity({ ...checkInIdentity, idNumber: event.target.value })} /></Field>
          <label className="stay-checkbox"><input type="checkbox" checked={earlyCheckIn} onChange={(event) => setEarlyCheckIn(event.target.checked)} /> Early check-in (configured fee may apply)</label>
          <Field label="Deposit required per room"><input type="number" min="0" step="0.01" value={checkInDeposit} onChange={(event) => setCheckInDeposit(event.target.value)} /></Field>
          <Field label="Payment terms"><input value={checkInTerms} onChange={(event) => setCheckInTerms(event.target.value)} /></Field>
          <p className="muted">Guest identity details are checked according to the property policy before the stay and folio are opened.</p>
          <button className="button button-primary" disabled={busy}>Complete check-in</button>
        </form>
      </section>
    </div>}

    {activeStay && <div className="stay-modal-backdrop" role="presentation" onClick={() => setActiveStay(null)}>
      <section className="stay-drawer" role="dialog" aria-modal="true" aria-labelledby="stay-title" onClick={(event) => event.stopPropagation()}>
        <header><div><p className="eyebrow">IN-HOUSE STAY</p><h2 id="stay-title">{activeStay.guestName}</h2><p className="muted">{activeStay.confirmationNo} · Room {activeStay.roomNumber}</p></div><button aria-label="Close stay details" className="icon-button" onClick={() => setActiveStay(null)}>×</button></header>
        <div className="stay-summary">
          <div><span>Stay</span><strong>{activeStay.checkInDate} – {activeStay.checkOutDate}</strong></div>
          <div><span>Folio balance</span><strong><Money value={activeStay.folio.balance} /></strong></div>
          <div><span>Folio status</span><strong>{activeStay.folio.status}</strong></div>
          <div><span>Deposit required</span><strong><Money value={activeStay.folio.depositRequired} /></strong></div>
        </div>
        <h3>Move room</h3>
        <form className="stay-form" onSubmit={(event) => { event.preventDefault(); runStayAction(`/api/stays/${activeStay.id}/move`, { roomId: Number(moveRoomId), reason: moveReason, approveRateChange }, 'Room move completed.'); }}>
          <Field label="Clean room"><select required value={moveRoomId} onChange={(event) => setMoveRoomId(event.target.value)}><option value="">Choose room</option>{cleanRooms.filter((room) => room.id !== activeStay.roomId).map((room) => <option key={room.id} value={room.id}>{room.roomNumber} · {room.roomType}</option>)}</select></Field>
          <Field label="Reason"><input required minLength="3" value={moveReason} onChange={(event) => setMoveReason(event.target.value)} /></Field>
          {permissionKeys.includes('stays.rate_change_approve') && <label className="stay-checkbox"><input type="checkbox" checked={approveRateChange} onChange={(event) => setApproveRateChange(event.target.checked)} /> Approve any room-rate change</label>}
          <button className="button button-secondary" disabled={busy}>Move guest</button>
        </form>
        <h3>Extend stay</h3>
        <form className="stay-form" onSubmit={(event) => { event.preventDefault(); runStayAction(`/api/stays/${activeStay.id}/extend`, { checkOutDate: extendDate, reason: extendReason }, 'Stay extended.'); }}>
          <Field label="New check-out"><input type="date" required value={extendDate} onChange={(event) => setExtendDate(event.target.value)} /></Field>
          <Field label="Reason"><input required minLength="3" value={extendReason} onChange={(event) => setExtendReason(event.target.value)} /></Field>
          <button className="button button-secondary" disabled={busy}>Extend</button>
        </form>
        {canShorten && <form className="stay-form" onSubmit={(event) => { event.preventDefault(); runStayAction(`/api/stays/${activeStay.id}/shorten`, { checkOutDate: extendDate, reason: extendReason }, 'Stay shortened.'); }}>
          <button className="button button-secondary" disabled={busy}>Shorten to selected date (manager)</button>
        </form>}
        <h3>Guests and requests</h3>
        <form className="stay-form" onSubmit={addGuest}>
          <Field label="Add guest by guest ID"><input type="number" min="1" required value={guestForm.guestId} onChange={(event) => setGuestForm({ guestId: event.target.value })} /></Field>
          <button className="button button-secondary" disabled={busy}>Add guest</button>
        </form>
        {!addRequest ? <button className="text-button" onClick={() => setAddRequest(true)}>＋ Log guest request</button> : <form className="stay-form" onSubmit={logRequest}>
          <Field label="Request type"><input required value={requestForm.type} onChange={(event) => setRequestForm({ ...requestForm, type: event.target.value })} /></Field>
          <Field label="Description"><textarea required value={requestForm.description} onChange={(event) => setRequestForm({ ...requestForm, description: event.target.value })} /></Field>
          <button className="button button-secondary" disabled={busy}>Save request</button>
        </form>}
        <h3>Room move history</h3>
        {activeStay.roomMoves.map((move, index) => <p className="stay-history" key={`${move.movedAt}-${index}`}>{move.fromRoom} → {move.toRoom} · {move.reason}</p>)}
        <h3>Checkout</h3>
        <label className="stay-checkbox"><input type="checkbox" checked={lateCheckout} onChange={(event) => setLateCheckout(event.target.checked)} /> Late checkout (configured fee may apply)</label>
        {activeStay.folio.balance !== '0.00' && canApproveCredit && <div className="stay-form">
          <label className="stay-checkbox"><input type="checkbox" checked={approveCredit} onChange={(event) => setApproveCredit(event.target.checked)} /> Approve city ledger / credit checkout</label>
          {approveCredit && <Field label="Approval reason"><textarea required minLength="3" value={creditReason} onChange={(event) => setCreditReason(event.target.value)} /></Field>}
        </div>}
        <button className="button button-danger" disabled={busy} onClick={checkout}>Check out · <Money value={activeStay.folio.balance} /></button>
      </section>
    </div>}
  </div>;
}
