import { useCallback, useEffect, useMemo, useState } from 'react';
import { authApi } from '../auth/api.js';
import '../styles/staff.css';

function todayString() {
  const date = new Date();
  const local = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000));
  return local.toISOString().slice(0, 10);
}

function Field({ label, children }) {
  return <label className="staff-field"><span>{label}</span>{children}</label>;
}

function dateOffset(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function StaffSection({ title, description, children, action }) {
  return <section className="panel staff-section">
    <header><div><h2>{title}</h2>{description && <p className="muted">{description}</p>}</div>{action}</header>
    {children}
  </section>;
}

function Empty({ children }) {
  return <p className="staff-empty">{children}</p>;
}

export function StaffWorkspace({ permissionKeys, propertyId }) {
  const permissionSet = useMemo(() => new Set(permissionKeys), [permissionKeys]);
  const canManage = permissionSet.has('staff.manage');
  const canSelfServe = permissionSet.has('staff.self_service');
  const today = todayString();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(dateOffset(today, 6));
  const [profile, setProfile] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [roster, setRoster] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [handovers, setHandovers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingEmployeeId, setEditingEmployeeId] = useState(null);
  const [editingShiftId, setEditingShiftId] = useState(null);
  const [departmentName, setDepartmentName] = useState('');
  const [employeeForm, setEmployeeForm] = useState({
    userId: '', fullName: '', departmentId: '', jobTitle: '', employmentStatus: 'active', hireDate: '', phone: '',
  });
  const [shiftForm, setShiftForm] = useState({ name: '', startTime: '08:00', endTime: '17:00' });
  const [rosterForm, setRosterForm] = useState({ employeeId: '', shiftId: '', date: today });
  const [leaveForm, setLeaveForm] = useState({ type: 'annual', dateFrom: today, dateTo: today, reason: '' });
  const [handoverForm, setHandoverForm] = useState({ departmentId: '', title: '', body: '' });

  const refresh = useCallback(async () => {
    const params = new URLSearchParams({ from, to });
    if (canManage) {
      const [departmentRows, employeeRows, shiftRows, rosterRows, attendanceRows, leaveRows, handoverRows] = await Promise.all([
        authApi.request('/api/staff/departments'),
        authApi.request('/api/staff/employees'),
        authApi.request('/api/staff/shifts'),
        authApi.request(`/api/staff/roster?${params}`),
        authApi.request(`/api/staff/attendance?${params}`),
        authApi.request('/api/staff/leave'),
        authApi.request('/api/staff/handovers'),
      ]);
      setDepartments(departmentRows);
      setEmployees(employeeRows);
      setShifts(shiftRows);
      setRoster(rosterRows);
      setAttendance(attendanceRows);
      setLeaveRequests(leaveRows);
      setHandovers(handoverRows);
    } else {
      const [profileData, leaveRows, handoverRows] = await Promise.all([
        authApi.request('/api/staff/me'),
        authApi.request('/api/staff/leave'),
        authApi.request('/api/staff/handovers'),
      ]);
      setProfile(profileData);
      setLeaveRequests(leaveRows);
      setHandovers(handoverRows);
    }
    if (canManage && canSelfServe) {
      try {
        setProfile(await authApi.request('/api/staff/me'));
      } catch (requestError) {
        if (requestError.status === 404) setProfile(null);
        else throw requestError;
      }
    }
  }, [canManage, canSelfServe, from, to]);

  useEffect(() => {
    setError('');
    refresh().catch((requestError) => setError(requestError.message));
  }, [propertyId, refresh]);

  async function runAction(action, successMessage) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await action();
      setNotice(successMessage);
      await refresh();
      return result;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function employeePayload(form) {
    return {
      userId: form.userId ? Number(form.userId) : null,
      departmentId: form.departmentId ? Number(form.departmentId) : null,
      fullName: form.fullName,
      jobTitle: form.jobTitle || null,
      employmentStatus: form.employmentStatus,
      hireDate: form.hireDate || null,
      phone: form.phone || null,
    };
  }

  async function saveEmployee(event) {
    event.preventDefault();
    const path = editingEmployeeId
      ? `/api/staff/employees/${editingEmployeeId}`
      : '/api/staff/employees';
    const method = editingEmployeeId ? 'PUT' : 'POST';
    const saved = await runAction(() => authApi.request(path, {
      method,
      body: JSON.stringify(employeePayload(employeeForm)),
    }), editingEmployeeId ? 'Employee profile updated.' : 'Employee added.');
    if (saved) {
      setEditingEmployeeId(null);
      setEmployeeForm({
        userId: '', fullName: '', departmentId: '', jobTitle: '', employmentStatus: 'active', hireDate: '', phone: '',
      });
    }
  }

  function editEmployee(employee) {
    setEditingEmployeeId(employee.id);
    setEmployeeForm({
      userId: employee.userId ? String(employee.userId) : '',
      fullName: employee.fullName,
      departmentId: employee.departmentId ? String(employee.departmentId) : '',
      jobTitle: employee.jobTitle ?? '',
      employmentStatus: employee.employmentStatus,
      hireDate: employee.hireDate ?? '',
      phone: employee.phone ?? '',
    });
  }

  async function createDepartment(event) {
    event.preventDefault();
    const result = await runAction(() => authApi.request('/api/staff/departments', {
      method: 'POST', body: JSON.stringify({ name: departmentName }),
    }), 'Department created.');
    if (result) setDepartmentName('');
  }

  async function renameDepartment(department) {
    const name = window.prompt('Department name', department.name);
    if (name === null || name.trim() === '' || name.trim() === department.name) return;
    await runAction(() => authApi.request(`/api/staff/departments/${department.id}`, {
      method: 'PUT', body: JSON.stringify({ name: name.trim() }),
    }), 'Department updated.');
  }

  async function createShift(event) {
    event.preventDefault();
    const path = editingShiftId ? `/api/staff/shifts/${editingShiftId}` : '/api/staff/shifts';
    const result = await runAction(() => authApi.request(path, {
      method: editingShiftId ? 'PUT' : 'POST', body: JSON.stringify(shiftForm),
    }), editingShiftId ? 'Shift updated.' : 'Shift created.');
    if (result) {
      setEditingShiftId(null);
      setShiftForm({ name: '', startTime: '08:00', endTime: '17:00' });
    }
  }

  async function deleteShift(id) {
    if (!window.confirm('Delete this shift definition? Shifts already on rosters cannot be deleted.')) return;
    await runAction(() => authApi.request(`/api/staff/shifts/${id}`, { method: 'DELETE' }), 'Shift deleted.');
  }

  async function assignShift(event) {
    event.preventDefault();
    await runAction(() => authApi.request('/api/staff/roster', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: Number(rosterForm.employeeId),
        shiftId: Number(rosterForm.shiftId),
        date: rosterForm.date,
      }),
    }), 'Roster assignment created.');
  }

  async function removeAssignment(id) {
    if (!window.confirm('Remove this roster assignment?')) return;
    await runAction(() => authApi.request(`/api/staff/roster/${id}`, { method: 'DELETE' }), 'Roster assignment removed.');
  }

  async function decideLeave(id, decision) {
    const reason = decision === 'rejected' ? window.prompt('Reason for rejecting this request (optional):') : '';
    if (decision === 'rejected' && reason === null) return;
    await runAction(() => authApi.request(`/api/staff/leave/${id}/decision`, {
      method: 'PATCH',
      body: JSON.stringify({ decision, reason: reason || undefined }),
    }), `Leave request ${decision}.`);
  }

  async function createLeave(event) {
    event.preventDefault();
    const result = await runAction(() => authApi.request('/api/staff/leave', {
      method: 'POST', body: JSON.stringify(leaveForm),
    }), 'Leave request submitted for review.');
    if (result) setLeaveForm({ type: 'annual', dateFrom: todayString(), dateTo: todayString(), reason: '' });
  }

  async function createHandover(event) {
    event.preventDefault();
    const result = await runAction(() => authApi.request('/api/staff/handovers', {
      method: 'POST',
      body: JSON.stringify({
        departmentId: Number(handoverForm.departmentId),
        title: handoverForm.title,
        body: handoverForm.body,
      }),
    }), 'Handover note added.');
    if (result) setHandoverForm({ departmentId: profile?.departmentId ? String(profile.departmentId) : '', title: '', body: '' });
  }

  async function clock(action) {
    await runAction(() => authApi.request(`/api/staff/attendance/${action}`, { method: 'POST', body: '{}' }),
      action === 'clock-in' ? 'Clock-in recorded.' : 'Clock-out recorded.');
  }

  async function downloadCsv() {
    setError('');
    try {
      const blob = await authApi.requestBlob(`/api/staff/export.csv?${new URLSearchParams({ from, to })}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `staff-attendance-${from}-${to}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  const pendingLeave = leaveRequests.filter((request) => request.status === 'pending');
  const myAttendance = profile?.attendance;
  const todayRoster = profile?.roster?.find((assignment) => assignment.date === profile.date);
  const hasProfile = Boolean(profile);

  return <main className="staff-page">
    <header className="page-heading">
      <div><p className="eyebrow">TEAM OPERATIONS</p><h1>Staff</h1><p className="muted">Manage your team, plan shifts, and keep attendance and handovers in one place.</p></div>
      {canManage && <button className="button button-secondary" onClick={downloadCsv}>Export attendance CSV</button>}
    </header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="form-notice" role="status">{notice}</p>}

    {canSelfServe && <StaffSection title="My staff desk" description="Your upcoming roster, attendance, and leave requests.">
      {!hasProfile ? <p className="staff-empty">Your staff profile is not linked yet. Ask a property manager to link your account.</p> : <>
        <div className="staff-profile">
          <div><strong>{profile.fullName}</strong><span>{profile.jobTitle || 'Staff member'} · {profile.departmentName || 'No department'}</span></div>
          <span className={`staff-badge ${profile.employmentStatus}`}>{profile.employmentStatus.replaceAll('_', ' ')}</span>
        </div>
        <div className="staff-self-grid">
          <article><span>Today’s shift</span><strong>{todayRoster ? `${todayRoster.shiftName} · ${todayRoster.startTime.slice(0, 5)}–${todayRoster.endTime.slice(0, 5)}` : 'No shift scheduled'}</strong></article>
          <article><span>Attendance</span><strong>{myAttendance?.clockIn ? `${myAttendance.clockOut ? 'Completed' : 'Clocked in'} · ${myAttendance.overtimeMinutes} overtime min` : 'Not clocked in'}</strong></article>
        </div>
        <div className="staff-actions">
          <button className="button button-primary" disabled={busy || Boolean(myAttendance)} onClick={() => clock('clock-in')}>Clock in</button>
          <button className="button button-secondary" disabled={busy || !myAttendance?.clockIn || Boolean(myAttendance?.clockOut)} onClick={() => clock('clock-out')}>Clock out</button>
        </div>
        <h3>Upcoming shifts</h3>
        {profile.roster?.length
          ? <div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>Date</th><th>Shift</th><th>Hours</th></tr></thead><tbody>
            {profile.roster.map((assignment) => <tr key={assignment.id}><td>{assignment.date}</td><td>{assignment.shiftName}</td><td>{assignment.startTime.slice(0, 5)}–{assignment.endTime.slice(0, 5)}</td></tr>)}
          </tbody></table></div>
          : <Empty>No shifts assigned for the next two weeks.</Empty>}
      </>}
    </StaffSection>}

    {canManage && <>
      <StaffSection title="Departments" description="Organize staff into departments.">
        <form className="staff-inline-form" onSubmit={createDepartment}>
          <Field label="Department name"><input required minLength="2" maxLength="120" value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} /></Field>
          <button className="button button-primary" disabled={busy}>Add department</button>
        </form>
        {departments.length
          ? <div className="staff-chip-list">{departments.map((department) => <span key={department.id}>{department.name} <small>{department.employeeCount} staff</small><button type="button" className="text-button" onClick={() => renameDepartment(department)}>Rename</button></span>)}</div>
          : <Empty>No departments have been created.</Empty>}
      </StaffSection>

      <StaffSection title="Employee directory" description="Create employee profiles and optionally link them to a sign-in account.">
        <form className="staff-form-grid" onSubmit={saveEmployee}>
          <Field label="Full name"><input required maxLength="200" value={employeeForm.fullName} onChange={(event) => setEmployeeForm({ ...employeeForm, fullName: event.target.value })} /></Field>
          <Field label="User ID (optional)"><input type="number" min="1" value={employeeForm.userId} onChange={(event) => setEmployeeForm({ ...employeeForm, userId: event.target.value })} /></Field>
          <Field label="Department"><select value={employeeForm.departmentId} onChange={(event) => setEmployeeForm({ ...employeeForm, departmentId: event.target.value })}><option value="">No department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></Field>
          <Field label="Job title"><input maxLength="120" value={employeeForm.jobTitle} onChange={(event) => setEmployeeForm({ ...employeeForm, jobTitle: event.target.value })} /></Field>
          <Field label="Status"><select value={employeeForm.employmentStatus} onChange={(event) => setEmployeeForm({ ...employeeForm, employmentStatus: event.target.value })}><option value="active">Active</option><option value="on_leave">On leave</option><option value="terminated">Terminated</option></select></Field>
          <Field label="Hire date"><input type="date" value={employeeForm.hireDate} onChange={(event) => setEmployeeForm({ ...employeeForm, hireDate: event.target.value })} /></Field>
          <Field label="Phone"><input maxLength="40" value={employeeForm.phone} onChange={(event) => setEmployeeForm({ ...employeeForm, phone: event.target.value })} /></Field>
          <div className="staff-form-actions"><button className="button button-primary" disabled={busy}>{editingEmployeeId ? 'Save employee' : 'Add employee'}</button>{editingEmployeeId && <button type="button" className="button button-secondary" onClick={() => { setEditingEmployeeId(null); setEmployeeForm({ userId: '', fullName: '', departmentId: '', jobTitle: '', employmentStatus: 'active', hireDate: '', phone: '' }); }}>Cancel edit</button>}</div>
        </form>
        {employees.length
          ? <div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>Name</th><th>Department</th><th>Job title</th><th>Status</th><th>Account</th><th /></tr></thead><tbody>
            {employees.map((employee) => <tr key={employee.id}><td>{employee.fullName}</td><td>{employee.departmentName || '—'}</td><td>{employee.jobTitle || '—'}</td><td>{employee.employmentStatus.replaceAll('_', ' ')}</td><td>{employee.email || 'Not linked'}</td><td><button className="text-button" onClick={() => editEmployee(employee)}>Edit</button></td></tr>)}
          </tbody></table></div>
          : <Empty>No employee profiles have been added.</Empty>}
      </StaffSection>

      <div className="staff-two-column">
        <StaffSection title="Shift definitions" description="Define regular or overnight shifts.">
          <form className="staff-form-grid" onSubmit={createShift}>
            <Field label="Shift name"><input required minLength="2" maxLength="100" value={shiftForm.name} onChange={(event) => setShiftForm({ ...shiftForm, name: event.target.value })} /></Field>
            <Field label="Start"><input type="time" required value={shiftForm.startTime} onChange={(event) => setShiftForm({ ...shiftForm, startTime: event.target.value })} /></Field>
            <Field label="End"><input type="time" required value={shiftForm.endTime} onChange={(event) => setShiftForm({ ...shiftForm, endTime: event.target.value })} /></Field>
            <div className="staff-form-actions"><button className="button button-primary" disabled={busy}>{editingShiftId ? 'Save shift' : 'Add shift'}</button>{editingShiftId && <button type="button" className="button button-secondary" onClick={() => { setEditingShiftId(null); setShiftForm({ name: '', startTime: '08:00', endTime: '17:00' }); }}>Cancel</button>}</div>
          </form>
          {shifts.length
            ? <ul className="staff-simple-list">{shifts.map((shift) => <li key={shift.id}><strong>{shift.name}</strong><span>{shift.startTime.slice(0, 5)}–{shift.endTime.slice(0, 5)}</span><button type="button" className="text-button" onClick={() => { setEditingShiftId(shift.id); setShiftForm({ name: shift.name, startTime: shift.startTime.slice(0, 5), endTime: shift.endTime.slice(0, 5) }); }}>Edit</button><button type="button" className="text-button danger" disabled={busy} onClick={() => deleteShift(shift.id)}>Delete</button></li>)}</ul>
            : <Empty>No shifts defined.</Empty>}
        </StaffSection>

        <StaffSection title="Roster planner" description="Assignments are checked for overnight overlaps and approved leave.">
          <form className="staff-form-grid" onSubmit={assignShift}>
            <Field label="Employee"><select required value={rosterForm.employeeId} onChange={(event) => setRosterForm({ ...rosterForm, employeeId: event.target.value })}><option value="">Select employee</option>{employees.filter((employee) => employee.employmentStatus === 'active').map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</select></Field>
            <Field label="Shift"><select required value={rosterForm.shiftId} onChange={(event) => setRosterForm({ ...rosterForm, shiftId: event.target.value })}><option value="">Select shift</option>{shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.name}</option>)}</select></Field>
            <Field label="Date"><input type="date" required value={rosterForm.date} onChange={(event) => setRosterForm({ ...rosterForm, date: event.target.value })} /></Field>
            <button className="button button-primary" disabled={busy}>Assign shift</button>
          </form>
        </StaffSection>
      </div>

      <StaffSection title="Roster and attendance" description="Review scheduled shifts and recorded attendance.">
        <div className="staff-range"><Field label="From"><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></Field><Field label="To"><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></Field></div>
        <h3>Roster</h3>
        {roster.length
          ? <div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>Date</th><th>Employee</th><th>Department</th><th>Shift</th><th>Hours</th><th /></tr></thead><tbody>
            {roster.map((assignment) => <tr key={assignment.id}><td>{assignment.date}</td><td>{assignment.employeeName}</td><td>{assignment.departmentName || '—'}</td><td>{assignment.shiftName}</td><td>{assignment.startTime.slice(0, 5)}–{assignment.endTime.slice(0, 5)}</td><td><button className="text-button" disabled={busy} onClick={() => removeAssignment(assignment.id)}>Remove</button></td></tr>)}
          </tbody></table></div>
          : <Empty>No roster assignments in this date range.</Empty>}
        <h3>Attendance</h3>
        {attendance.length
          ? <div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>Date</th><th>Employee</th><th>Shift</th><th>Clock in</th><th>Clock out</th><th>Overtime</th></tr></thead><tbody>
            {attendance.map((record) => <tr key={record.id}><td>{record.date}</td><td>{record.employeeName}</td><td>{record.shiftName || 'Unscheduled'}</td><td>{record.clockIn || '—'}</td><td>{record.clockOut || '—'}</td><td>{record.overtimeMinutes} min</td></tr>)}
          </tbody></table></div>
          : <Empty>No attendance records in this date range.</Empty>}
      </StaffSection>
    </>}

    {(canSelfServe || canManage) && <StaffSection title="Leave requests" description={canManage ? 'Review staff requests or submit your own.' : 'Submit a request and track its status.'}>
      {hasProfile && canSelfServe && <form className="staff-form-grid" onSubmit={createLeave}>
        <Field label="Leave type"><select value={leaveForm.type} onChange={(event) => setLeaveForm({ ...leaveForm, type: event.target.value })}><option value="annual">Annual</option><option value="sick">Sick</option><option value="personal">Personal</option><option value="unpaid">Unpaid</option></select></Field>
        <Field label="From"><input type="date" required value={leaveForm.dateFrom} onChange={(event) => setLeaveForm({ ...leaveForm, dateFrom: event.target.value })} /></Field>
        <Field label="To"><input type="date" required value={leaveForm.dateTo} onChange={(event) => setLeaveForm({ ...leaveForm, dateTo: event.target.value })} /></Field>
        <Field label="Reason"><textarea required minLength="3" maxLength="2000" value={leaveForm.reason} onChange={(event) => setLeaveForm({ ...leaveForm, reason: event.target.value })} /></Field>
        <button className="button button-primary" disabled={busy}>Submit leave request</button>
      </form>}
      {leaveRequests.length
        ? <div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Reason</th><th>Status</th>{canManage && <th>Review</th>}</tr></thead><tbody>
          {leaveRequests.map((leave) => <tr key={leave.id}><td>{leave.employeeName || profile?.fullName || 'Me'}</td><td>{leave.type}</td><td>{leave.dateFrom} – {leave.dateTo}</td><td>{leave.reason || '—'}</td><td><span className={`staff-badge ${leave.status}`}>{leave.status}</span></td>{canManage && <td>{leave.status === 'pending' && <div className="staff-actions"><button className="text-button" disabled={busy} onClick={() => decideLeave(leave.id, 'approved')}>Approve</button><button className="text-button danger" disabled={busy} onClick={() => decideLeave(leave.id, 'rejected')}>Reject</button></div>}</td>}</tr>)}
        </tbody></table></div>
        : <Empty>{canManage ? 'No leave requests have been submitted.' : 'You have no leave requests.'}</Empty>}
      {canManage && pendingLeave.length > 0 && <p className="staff-note">{pendingLeave.length} request{pendingLeave.length === 1 ? '' : 's'} awaiting review.</p>}
    </StaffSection>}

    {(canSelfServe || canManage) && <StaffSection title="Department handovers" description="Handover entries are append-only and remain available for the department.">
      {hasProfile && canSelfServe && <form className="staff-form-grid" onSubmit={createHandover}>
        {canManage && <Field label="Department"><select required value={handoverForm.departmentId} onChange={(event) => setHandoverForm({ ...handoverForm, departmentId: event.target.value })}><option value="">Select department</option>{departments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></Field>}
        <Field label="Title"><input required minLength="3" maxLength="160" value={handoverForm.title} onChange={(event) => setHandoverForm({ ...handoverForm, title: event.target.value })} /></Field>
        <Field label="Details"><textarea required minLength="3" maxLength="10000" value={handoverForm.body} onChange={(event) => setHandoverForm({ ...handoverForm, body: event.target.value })} /></Field>
        <button className="button button-primary" disabled={busy || (!canManage && !profile.departmentId)}>Add handover</button>
      </form>}
      {handovers.length
        ? <div className="staff-handover-list">{handovers.map((note) => <article key={note.id}><header><strong>{note.title || 'Handover note'}</strong><span>{note.departmentName} · {note.authorName} · {note.createdAt}</span></header><p>{note.body}</p></article>)}</div>
        : <Empty>No handover notes available for this department.</Empty>}
    </StaffSection>}
  </main>;
}
