import { useCallback, useEffect, useState } from 'react';
import { authApi } from '../auth/api.js';
import { useRoomStatusUpdates } from '../realtime.js';
import '../styles/property.css';

function Field({ label, children }) {
  return <label className="setup-field">{label}{children}</label>;
}

function TextInput({ value, onChange, ...props }) {
  return <input value={value ?? ''} onChange={(event) => onChange(event.target.value)} {...props} />;
}

function SetupSection({ title, description, children }) {
  return <section className="panel setup-section">
    <div className="setup-heading"><h2>{title}</h2><p className="muted">{description}</p></div>
    {children}
  </section>;
}

const emptyProfile = {
  name: '',
  address: '',
  city: '',
  phone: '',
  email: '',
  timezone: 'Africa/Addis_Ababa',
  currency: 'ETB',
  checkInTime: '14:00',
  checkOutTime: '11:00',
  requireIdAtCheckIn: false,
  earlyCheckInFee: '0.00',
  lateCheckoutFee: '0.00',
  taxSettings: { vatPercent: 15, serviceChargePercent: 0, tourismLevyPercent: 0, pricesTaxInclusive: false },
};

const emptyRule = {
  roomTypeId: '',
  ratePlanId: '',
  dateFrom: '',
  dateTo: '',
  weekdayMask: 127,
  amount: '',
  minStay: 1,
  reason: '',
};

export function PropertySetup({ permissionKeys = [] }) {
  const [profile, setProfile] = useState(emptyProfile);
  const [buildings, setBuildings] = useState([]);
  const [floors, setFloors] = useState([]);
  const [roomTypes, setRoomTypes] = useState([]);
  const [ratePlans, setRatePlans] = useState([]);
  const [rates, setRates] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [buildingName, setBuildingName] = useState('');
  const [floorForm, setFloorForm] = useState({ name: '', floorNumber: 1, buildingId: '' });
  const [typeForm, setTypeForm] = useState({
    name: '', description: '', maxAdults: 2, maxChildren: 0, baseRate: '', amenities: '',
  });
  const [bulkForm, setBulkForm] = useState({
    floorId: '', roomTypeId: '', startNumber: 101, endNumber: 120, prefix: '', suffix: '', padLength: 0,
  });
  const [planForm, setPlanForm] = useState({ name: '', mealPlan: '' });
  const [ruleForm, setRuleForm] = useState(emptyRule);
  const [editingRateId, setEditingRateId] = useState(null);
  const [quoteForm, setQuoteForm] = useState({
    roomTypeId: '', ratePlanId: '', checkIn: '', checkOut: '', adults: 1, children: 0,
  });
  const [quoteResult, setQuoteResult] = useState(null);
  const canManageRates = permissionKeys.includes('rates.edit');

  async function load() {
    const requests = [
      authApi.request('/api/property'),
      authApi.request('/api/property/buildings'),
      authApi.request('/api/property/floors'),
      authApi.request('/api/property/room-types'),
    ];
    if (canManageRates) {
      requests.push(
        authApi.request('/api/property/rate-plans'),
        authApi.request('/api/property/rates'),
      );
    }
    const [property, buildingRows, floorRows, typeRows, planRows = [], rateRows = []] = await Promise.all(requests);
    setProfile(property);
    setBuildings(buildingRows);
    setFloors(floorRows);
    setRoomTypes(typeRows);
    setRatePlans(planRows);
    setRates(rateRows);
    if (buildingRows[0]) setFloorForm((current) => ({ ...current, buildingId: current.buildingId || String(buildingRows[0].id) }));
    if (floorRows[0]) setBulkForm((current) => ({ ...current, floorId: current.floorId || String(floorRows[0].id) }));
    if (typeRows[0]) {
      setBulkForm((current) => ({ ...current, roomTypeId: current.roomTypeId || String(typeRows[0].id) }));
      setQuoteForm((current) => ({ ...current, roomTypeId: current.roomTypeId || String(typeRows[0].id) }));
      setRuleForm((current) => ({ ...current, roomTypeId: current.roomTypeId || String(typeRows[0].id) }));
    }
    if (planRows[0]) {
      setRuleForm((current) => ({ ...current, ratePlanId: current.ratePlanId || String(planRows[0].id) }));
      setQuoteForm((current) => ({ ...current, ratePlanId: current.ratePlanId || String(planRows[0].id) }));
    }
  }

  useEffect(() => {
    load().catch((error) => setMessage(error.message));
  }, [canManageRates]);

  async function runAction(action, successMessage, reload = true) {
    setBusy(true);
    setMessage('');
    setQuoteResult(null);
    try {
      const result = await action();
      if (reload) await load();
      setMessage(typeof successMessage === 'function' ? successMessage(result) : successMessage);
      return result;
    } catch (error) {
      setMessage(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    const body = {
      ...profile,
      address: profile.address || null,
      city: profile.city || null,
      phone: profile.phone || null,
      email: profile.email || null,
      taxSettings: {
        ...profile.taxSettings,
        vatPercent: Number(profile.taxSettings.vatPercent),
        serviceChargePercent: Number(profile.taxSettings.serviceChargePercent),
        tourismLevyPercent: Number(profile.taxSettings.tourismLevyPercent),
      },
    };
    await runAction(() => authApi.request('/api/property', { method: 'PUT', body: JSON.stringify(body) }), 'Property profile saved.', false);
  }

  async function createBuilding(event) {
    event.preventDefault();
    const result = await runAction(
      () => authApi.request('/api/property/buildings', { method: 'POST', body: JSON.stringify({ name: buildingName }) }),
      'Building created.',
    );
    if (result) setBuildingName('');
  }

  async function createFloor(event) {
    event.preventDefault();
    const result = await runAction(
      () => authApi.request('/api/property/floors', {
        method: 'POST',
        body: JSON.stringify({ ...floorForm, buildingId: Number(floorForm.buildingId), floorNumber: Number(floorForm.floorNumber) }),
      }),
      'Floor created.',
    );
    if (result) setFloorForm((current) => ({ ...current, name: '' }));
  }

  async function createRoomType(event) {
    event.preventDefault();
    const result = await runAction(
      () => authApi.request('/api/property/room-types', {
        method: 'POST',
        body: JSON.stringify({
          ...typeForm,
          maxAdults: Number(typeForm.maxAdults),
          maxChildren: Number(typeForm.maxChildren),
          amenities: typeForm.amenities.split(',').map((value) => value.trim()).filter(Boolean),
        }),
      }),
      'Room type created.',
    );
    if (result) setTypeForm({ name: '', description: '', maxAdults: 2, maxChildren: 0, baseRate: '', amenities: '' });
  }

  async function createRooms(event) {
    event.preventDefault();
    const result = await runAction(
      () => authApi.request('/api/property/rooms/bulk', {
        method: 'POST',
        body: JSON.stringify({
          ...bulkForm,
          floorId: Number(bulkForm.floorId),
          roomTypeId: Number(bulkForm.roomTypeId),
          startNumber: Number(bulkForm.startNumber),
          endNumber: Number(bulkForm.endNumber),
          padLength: Number(bulkForm.padLength),
        }),
      }),
      (data) => `Created ${data.created} room${data.created === 1 ? '' : 's'}.`,
    );
    if (result) {
      setBulkForm((current) => ({
        ...current,
        startNumber: Number(current.endNumber) + 1,
        endNumber: Number(current.endNumber) + 1,
      }));
    }
  }

  async function createRatePlan(event) {
    event.preventDefault();
    const result = await runAction(
      () => authApi.request('/api/property/rate-plans', { method: 'POST', body: JSON.stringify(planForm) }),
      'Rate plan created.',
    );
    if (result) setPlanForm({ name: '', mealPlan: '' });
  }

  async function saveRate(event) {
    event.preventDefault();
    const body = {
      ...ruleForm,
      roomTypeId: Number(ruleForm.roomTypeId),
      ratePlanId: Number(ruleForm.ratePlanId),
      weekdayMask: Number(ruleForm.weekdayMask),
      minStay: Number(ruleForm.minStay),
    };
    const method = editingRateId ? 'PUT' : 'POST';
    const path = editingRateId ? `/api/property/rates/${editingRateId}` : '/api/property/rates';
    const result = await runAction(
      async () => {
        await authApi.request(path, { method, body: JSON.stringify(body) });
        return true;
      },
      editingRateId ? 'Rate rule updated.' : 'Rate rule created.',
    );
    if (result) {
      setEditingRateId(null);
      setRuleForm(emptyRule);
    }
  }

  async function requestQuote(event) {
    event.preventDefault();
    const result = await runAction(
      () => authApi.request('/api/property/rates/quote', {
        method: 'POST',
        body: JSON.stringify({
          ...quoteForm,
          roomTypeId: Number(quoteForm.roomTypeId),
          ratePlanId: Number(quoteForm.ratePlanId),
          adults: Number(quoteForm.adults),
          children: Number(quoteForm.children),
        }),
      }),
      'Quote calculated.',
      false,
    );
    setQuoteResult(result);
  }

  function updateTax(key, value) {
    setProfile((current) => ({
      ...current,
      taxSettings: { ...current.taxSettings, [key]: value },
    }));
  }

  function editRate(rate) {
    setEditingRateId(rate.id);
    setRuleForm({
      roomTypeId: String(rate.roomTypeId),
      ratePlanId: String(rate.ratePlanId),
      dateFrom: String(rate.dateFrom).slice(0, 10),
      dateTo: String(rate.dateTo).slice(0, 10),
      weekdayMask: rate.weekdayMask,
      amount: String(rate.amount),
      minStay: rate.minStay,
      reason: '',
    });
  }

  return <section className="property-page">
    <header className="page-heading"><div><p className="eyebrow">PROPERTY CONFIGURATION</p><h1>Property setup</h1><p className="muted">Configure property details, room inventory and pricing.</p></div></header>
    {message && <p className="form-notice" role="status">{message}</p>}
    <form className="panel setup-section" onSubmit={saveProfile}>
      <div className="setup-heading"><h2>Property profile</h2><p className="muted">Tax-inclusive prices are decomposed into base rate and configured taxes.</p></div>
      <div className="setup-grid">
        <Field label="Property name"><TextInput value={profile.name} onChange={(value) => setProfile({ ...profile, name: value })} required /></Field>
        <Field label="City"><TextInput value={profile.city} onChange={(value) => setProfile({ ...profile, city: value })} /></Field>
        <Field label="Address"><TextInput value={profile.address} onChange={(value) => setProfile({ ...profile, address: value })} /></Field>
        <Field label="Phone"><TextInput value={profile.phone} onChange={(value) => setProfile({ ...profile, phone: value })} /></Field>
        <Field label="Email"><TextInput type="email" value={profile.email} onChange={(value) => setProfile({ ...profile, email: value })} /></Field>
        <Field label="Timezone"><TextInput value={profile.timezone} onChange={(value) => setProfile({ ...profile, timezone: value })} required /></Field>
        <Field label="Currency"><TextInput value={profile.currency} onChange={(value) => setProfile({ ...profile, currency: value.toUpperCase() })} maxLength="3" required /></Field>
        <Field label="Check-in time"><TextInput type="time" value={profile.checkInTime} onChange={(value) => setProfile({ ...profile, checkInTime: value })} required /></Field>
        <Field label="Check-out time"><TextInput type="time" value={profile.checkOutTime} onChange={(value) => setProfile({ ...profile, checkOutTime: value })} required /></Field>
        <Field label="Early check-in fee"><TextInput type="number" min="0" step="0.01" value={profile.earlyCheckInFee} onChange={(value) => setProfile({ ...profile, earlyCheckInFee: value })} required /></Field>
        <Field label="Late checkout fee"><TextInput type="number" min="0" step="0.01" value={profile.lateCheckoutFee} onChange={(value) => setProfile({ ...profile, lateCheckoutFee: value })} required /></Field>
        <Field label="Identity capture"><select value={profile.requireIdAtCheckIn ? 'required' : 'optional'} onChange={(event) => setProfile({ ...profile, requireIdAtCheckIn: event.target.value === 'required' })}><option value="optional">Identity number optional</option><option value="required">Require identity number at check-in</option></select></Field>
        <Field label="VAT (%)"><TextInput type="number" min="0" max="100" step="0.01" value={profile.taxSettings.vatPercent} onChange={(value) => updateTax('vatPercent', value)} /></Field>
        <Field label="Service charge (%)"><TextInput type="number" min="0" max="100" step="0.01" value={profile.taxSettings.serviceChargePercent} onChange={(value) => updateTax('serviceChargePercent', value)} /></Field>
        <Field label="Tourism levy (%)"><TextInput type="number" min="0" max="100" step="0.01" value={profile.taxSettings.tourismLevyPercent} onChange={(value) => updateTax('tourismLevyPercent', value)} /></Field>
        <Field label="Tax pricing"><select value={profile.taxSettings.pricesTaxInclusive ? 'inclusive' : 'exclusive'} onChange={(event) => updateTax('pricesTaxInclusive', event.target.value === 'inclusive')}><option value="exclusive">Prices exclude taxes</option><option value="inclusive">Prices include taxes</option></select></Field>
      </div>
      <div className="setup-actions"><span className="muted">Business date: {profile.businessDate ?? 'Not set (advanced by night audit)'}</span><button className="button button-primary" disabled={busy}>Save property profile</button></div>
    </form>

    <div className="setup-columns">
      <SetupSection title="Buildings and floors" description="Organize rooms into buildings and floor levels.">
        <form className="inline-form" onSubmit={createBuilding}>
          <Field label="Building name"><TextInput value={buildingName} onChange={setBuildingName} required placeholder="Main Building" /></Field>
          <button className="button button-primary" disabled={busy}>Add building</button>
        </form>
        {buildings.map((building) => <div className="setup-list-row" key={building.id}><strong>{building.name}</strong><span>{floors.filter((floor) => floor.buildingId === building.id).length} floors</span></div>)}
        <form className="inline-form" onSubmit={createFloor}>
          <Field label="Floor name"><TextInput value={floorForm.name} onChange={(value) => setFloorForm({ ...floorForm, name: value })} required placeholder="Ground floor" /></Field>
          <Field label="Floor number"><TextInput type="number" value={floorForm.floorNumber} onChange={(value) => setFloorForm({ ...floorForm, floorNumber: value })} required /></Field>
          <Field label="Building"><select value={floorForm.buildingId} onChange={(event) => setFloorForm({ ...floorForm, buildingId: event.target.value })} required>{buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}</select></Field>
          <button className="button button-primary" disabled={busy || buildings.length === 0}>Add floor</button>
        </form>
        {floors.map((floor) => <div className="setup-list-row" key={floor.id}><strong>{floor.name}</strong><span>{floor.buildingName} · {floor.floorNumber}</span></div>)}
      </SetupSection>

      <SetupSection title="Room types" description="Set capacity, base rate and amenities.">
        <form className="setup-grid compact-grid" onSubmit={createRoomType}>
          <Field label="Type name"><TextInput value={typeForm.name} onChange={(value) => setTypeForm({ ...typeForm, name: value })} required placeholder="Standard Double" /></Field>
          <Field label="Base rate (ETB)"><TextInput type="number" min="0" step="0.01" value={typeForm.baseRate} onChange={(value) => setTypeForm({ ...typeForm, baseRate: value })} required /></Field>
          <Field label="Max adults"><TextInput type="number" min="1" max="20" value={typeForm.maxAdults} onChange={(value) => setTypeForm({ ...typeForm, maxAdults: value })} required /></Field>
          <Field label="Max children"><TextInput type="number" min="0" max="20" value={typeForm.maxChildren} onChange={(value) => setTypeForm({ ...typeForm, maxChildren: value })} required /></Field>
          <Field label="Description"><TextInput value={typeForm.description} onChange={(value) => setTypeForm({ ...typeForm, description: value })} /></Field>
          <Field label="Amenities (comma separated)"><TextInput value={typeForm.amenities} onChange={(value) => setTypeForm({ ...typeForm, amenities: value })} placeholder="Wi-Fi, Desk, Balcony" /></Field>
          <button className="button button-primary" disabled={busy}>Add room type</button>
        </form>
        {roomTypes.map((type) => <div className="setup-list-row" key={type.id}><strong>{type.name}</strong><span>{type.maxAdults} adults · ETB {type.baseRate} · {type.amenities.join(', ') || 'No amenities'}</span></div>)}
      </SetupSection>
    </div>

    <SetupSection title="Create rooms in bulk" description="Choose a room type and floor, then generate a numbered range.">
      <form className="setup-grid compact-grid" onSubmit={createRooms}>
        <Field label="Floor"><select value={bulkForm.floorId} onChange={(event) => setBulkForm({ ...bulkForm, floorId: event.target.value })} required>{floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.buildingName} · {floor.name}</option>)}</select></Field>
        <Field label="Room type"><select value={bulkForm.roomTypeId} onChange={(event) => setBulkForm({ ...bulkForm, roomTypeId: event.target.value })} required>{roomTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field>
        <Field label="From"><TextInput type="number" min="0" value={bulkForm.startNumber} onChange={(value) => setBulkForm({ ...bulkForm, startNumber: value })} required /></Field>
        <Field label="To (max 100)"><TextInput type="number" min="0" value={bulkForm.endNumber} onChange={(value) => setBulkForm({ ...bulkForm, endNumber: value })} required /></Field>
        <Field label="Prefix"><TextInput value={bulkForm.prefix} onChange={(value) => setBulkForm({ ...bulkForm, prefix: value })} placeholder="A-" /></Field>
        <Field label="Suffix"><TextInput value={bulkForm.suffix} onChange={(value) => setBulkForm({ ...bulkForm, suffix: value })} /></Field>
        <Field label="Number padding"><TextInput type="number" min="0" max="6" value={bulkForm.padLength} onChange={(value) => setBulkForm({ ...bulkForm, padLength: value })} /></Field>
        <button className="button button-primary" disabled={busy || floors.length === 0 || roomTypes.length === 0}>Create room range</button>
      </form>
    </SetupSection>

    {canManageRates && <>
      <div className="setup-columns">
        <SetupSection title="Rate plans" description="Create room-only or meal-plan pricing options.">
          <form className="inline-form" onSubmit={createRatePlan}>
            <Field label="Plan name"><TextInput value={planForm.name} onChange={(value) => setPlanForm({ ...planForm, name: value })} required /></Field>
            <Field label="Meal plan"><TextInput value={planForm.mealPlan} onChange={(value) => setPlanForm({ ...planForm, mealPlan: value })} placeholder="room_only" /></Field>
            <button className="button button-primary" disabled={busy}>Add plan</button>
          </form>
          {ratePlans.map((plan) => <div className="setup-list-row" key={plan.id}><strong>{plan.name}</strong><span>{plan.mealPlan || 'No meal plan'}</span></div>)}
        </SetupSection>
        <SetupSection title={editingRateId ? 'Edit rate rule' : 'Add rate rule'} description="Date end is inclusive. Matching rules with a later start date take precedence; ties use latest creation then highest ID.">
          <form className="setup-grid compact-grid" onSubmit={saveRate}>
            <Field label="Room type"><select value={ruleForm.roomTypeId} onChange={(event) => setRuleForm({ ...ruleForm, roomTypeId: event.target.value })} required>{roomTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field>
            <Field label="Rate plan"><select value={ruleForm.ratePlanId} onChange={(event) => setRuleForm({ ...ruleForm, ratePlanId: event.target.value })} required>{ratePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></Field>
            <Field label="Date from"><TextInput type="date" value={ruleForm.dateFrom} onChange={(value) => setRuleForm({ ...ruleForm, dateFrom: value })} required /></Field>
            <Field label="Date to (inclusive)"><TextInput type="date" value={ruleForm.dateTo} onChange={(value) => setRuleForm({ ...ruleForm, dateTo: value })} required /></Field>
            <Field label="Nightly price (ETB)"><TextInput type="number" min="0" step="0.01" value={ruleForm.amount} onChange={(value) => setRuleForm({ ...ruleForm, amount: value })} required /></Field>
            <Field label="Minimum stay (nights)"><TextInput type="number" min="1" max="365" value={ruleForm.minStay} onChange={(value) => setRuleForm({ ...ruleForm, minStay: value })} required /></Field>
            <Field label="Weekdays"><select value={ruleForm.weekdayMask} onChange={(event) => setRuleForm({ ...ruleForm, weekdayMask: event.target.value })}><option value="127">Every day</option><option value="62">Weekdays (Mon–Fri)</option><option value="65">Weekend (Sat–Sun)</option></select></Field>
            <Field label="Reason for rate change"><TextInput value={ruleForm.reason} onChange={(value) => setRuleForm({ ...ruleForm, reason: value })} required minLength="3" /></Field>
            <div className="setup-actions">
              {editingRateId && <button className="text-button" type="button" onClick={() => { setEditingRateId(null); setRuleForm(emptyRule); }}>Cancel edit</button>}
              <button className="button button-primary" disabled={busy || roomTypes.length === 0 || ratePlans.length === 0}>{editingRateId ? 'Save rate rule' : 'Add rate rule'}</button>
            </div>
          </form>
          {rates.map((rate) => <div className="setup-list-row" key={rate.id}>
            <strong>{rate.roomType} · {rate.ratePlan}</strong>
            <span>{String(rate.dateFrom).slice(0, 10)} – {String(rate.dateTo).slice(0, 10)} · ETB {rate.amount} · min {rate.minStay}</span>
            <button className="text-button" onClick={() => editRate(rate)}>Edit</button>
          </div>)}
        </SetupSection>
      </div>
      <SetupSection title="Rate quote preview" description="Check seasonal rules, minimum stays, capacity and configured taxes.">
        <form className="setup-grid compact-grid" onSubmit={requestQuote}>
          <Field label="Room type"><select value={quoteForm.roomTypeId} onChange={(event) => setQuoteForm({ ...quoteForm, roomTypeId: event.target.value })} required>{roomTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field>
          <Field label="Rate plan"><select value={quoteForm.ratePlanId} onChange={(event) => setQuoteForm({ ...quoteForm, ratePlanId: event.target.value })} required>{ratePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></Field>
          <Field label="Check-in"><TextInput type="date" value={quoteForm.checkIn} onChange={(value) => setQuoteForm({ ...quoteForm, checkIn: value })} required /></Field>
          <Field label="Check-out"><TextInput type="date" value={quoteForm.checkOut} onChange={(value) => setQuoteForm({ ...quoteForm, checkOut: value })} required /></Field>
          <Field label="Adults"><TextInput type="number" min="1" value={quoteForm.adults} onChange={(value) => setQuoteForm({ ...quoteForm, adults: value })} required /></Field>
          <Field label="Children"><TextInput type="number" min="0" value={quoteForm.children} onChange={(value) => setQuoteForm({ ...quoteForm, children: value })} required /></Field>
          <button className="button button-primary" disabled={busy || roomTypes.length === 0 || ratePlans.length === 0}>Calculate quote</button>
        </form>
        {quoteResult && <div className="quote-result" role="status">
          <strong>{quoteResult.nights} nights · Total {quoteResult.currency} {quoteResult.totals.total}</strong>
          <div className="table-scroll"><table><thead><tr><th>Night</th><th>Room rate</th><th>VAT</th><th>Service</th><th>Levy</th><th>Total</th></tr></thead>
            <tbody>{quoteResult.nightlyRates.map((night) => <tr key={night.date}><td>{night.date}</td><td>{night.rate}</td><td>{night.vat}</td><td>{night.serviceCharge}</td><td>{night.tourismLevy}</td><td>{night.total}</td></tr>)}</tbody>
          </table></div>
        </div>}
      </SetupSection>
    </>}
  </section>;
}

export function RoomStatusCard({ room, onToggle }) {
  const statusClass = room.status.toLowerCase().replaceAll('_', '-');
  return <article className={`room-card room-${statusClass} ${room.isActive ? '' : 'room-inactive'}`}>
    <div className="room-number">{room.roomNumber}</div>
    <strong>{room.roomType}</strong>
    <span className="room-status-label">{room.status.replaceAll('_', ' ')}</span>
    <span className="room-floor-label">{room.building || 'Building'} · {room.floor || 'Unassigned floor'}</span>
    <button className="text-button" onClick={() => onToggle(room)}>{room.isActive ? 'Deactivate' : 'Reactivate'}</button>
  </article>;
}

export function RoomRack({ propertyId }) {
  const [rooms, setRooms] = useState([]);
  const [message, setMessage] = useState('');
  const [busyRoomId, setBusyRoomId] = useState(null);

  const loadRooms = useCallback(async () => {
    setRooms(await authApi.request('/api/property/rooms'));
  }, []);

  useEffect(() => {
    loadRooms().catch((error) => setMessage(error.message));
  }, [loadRooms]);

  useRoomStatusUpdates(propertyId, (update) => {
    setRooms((current) => current.map((room) => room.id === update.roomId
      ? { ...room, status: update.status }
      : room));
  });

  async function toggleRoom(room) {
    setBusyRoomId(room.id);
    setMessage('');
    try {
      await authApi.request(`/api/property/rooms/${room.id}/active`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !room.isActive }),
      });
      await loadRooms();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyRoomId(null);
    }
  }

  const floorGroups = rooms.reduce((groups, room) => {
    const key = room.floorId ?? 'unassigned';
    if (!groups.has(key)) groups.set(key, { name: room.floor ?? 'Unassigned floor', building: room.building, rooms: [] });
    groups.get(key).rooms.push(room);
    return groups;
  }, new Map());

  return <section className="property-page">
    <header className="page-heading"><div><p className="eyebrow">ROOM STATUS</p><h1>Room rack</h1><p className="muted">Live housekeeping and maintenance states for this property.</p></div></header>
    {message && <p className="form-notice" role="status">{message}</p>}
    {!rooms.length && !message && <p className="muted">No rooms configured yet. Create floors, room types and rooms in Property setup.</p>}
    {[...floorGroups.entries()].map(([id, group]) => <section className="rack-floor" key={id}>
      <div className="rack-floor-heading"><h2>{group.name}</h2><span>{group.building}</span></div>
      <div className="room-rack-grid">{group.rooms.map((room) => <div className={busyRoomId === room.id ? 'room-card-busy' : ''} key={room.id}>
        <RoomStatusCard room={room} onToggle={toggleRoom} />
      </div>)}</div>
    </section>)}
  </section>;
}
