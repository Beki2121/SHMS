import { useCallback, useEffect, useState } from 'react';
import { authApi } from '../auth/api.js';
import { useRoomStatusUpdates } from '../realtime.js';
import '../styles/housekeeping.css';

function Field({ label, children }) {
  return <label className="housekeeping-field">{label}{children}</label>;
}

const taskLabels = {
  checkout_clean: 'Checkout clean',
  daily_clean: 'Daily clean',
  deep_clean: 'Deep clean',
  inspection: 'Inspection',
  turndown: 'Turndown',
};

function TaskCard({
  task,
  canWork,
  canAssign,
  canInspect,
  staff,
  departments,
  selected,
  onSelect,
  onStart,
  onChecklist,
  onSubmit,
  onAssign,
  onInspect,
  onIssue,
}) {
  const [issueOpen, setIssueOpen] = useState(false);
  const [issue, setIssue] = useState({ category: 'Housekeeping', description: '', priority: 'normal' });
  const [inspectionReason, setInspectionReason] = useState('');
  const complete = task.checklist.filter((item) => item.complete).length;
  const canStart = canWork && ['pending', 'assigned', 'rejected'].includes(task.status);
  const canEditChecklist = canWork && task.status === 'in_progress';
  return <article className={`hk-task-card${task.isOverdue ? ' overdue' : ''}`}>
    {canAssign && ['pending', 'assigned', 'rejected'].includes(task.status) && <label className="hk-task-select">
      <input type="checkbox" checked={selected} onChange={(event) => onSelect(task.id, event.target.checked)} />
      Select for bulk assignment
    </label>}
    <header className="hk-task-heading">
      <div><span className="hk-room-label">ROOM {task.roomNumber}</span><h3>{taskLabels[task.type] ?? task.type.replaceAll('_', ' ')}</h3></div>
      <span className={`hk-task-status ${task.status}`}>{task.status.replaceAll('_', ' ')}</span>
    </header>
    <div className="hk-task-meta">
      <span>{task.roomType}</span>
      <span>Priority {task.priority}</span>
      {task.dueAt && <span className={task.isOverdue ? 'hk-overdue-label' : ''}>{task.isOverdue ? 'Overdue · ' : 'Due · '}{new Date(task.dueAt).toLocaleString()}</span>}
      {task.assigneeName && <span>Assigned to {task.assigneeName}</span>}
    </div>
    {task.priorityReason && <p className="hk-priority-reason">Priority rule: {task.priorityReason}</p>}

    {task.checklist.length > 0 && <div className="hk-checklist">
      <div className="hk-checklist-title"><strong>Room checklist</strong><span>{complete}/{task.checklist.length} complete</span></div>
      {task.checklist.map((item) => <label className="hk-checklist-item" key={item.id}>
        <input
          type="checkbox"
          checked={item.complete}
          disabled={!canEditChecklist}
          onChange={(event) => onChecklist(task.id, item.id, event.target.checked)}
        />
        <span>{item.label}</span>
      </label>)}
    </div>}

    {canAssign && <div className="hk-assignment-row">
      <Field label="Housekeeper">
        <select
          aria-label={`Assign room ${task.roomNumber}`}
          value={task.assignedTo ?? ''}
          disabled={['awaiting_inspection', 'approved'].includes(task.status)}
          onChange={(event) => onAssign(task, event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">Unassigned</option>
          {staff.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
        </select>
      </Field>
      <Field label="Team">
        <select
          aria-label={`Assign team for room ${task.roomNumber}`}
          value={task.departmentId ?? ''}
          disabled={['awaiting_inspection', 'approved'].includes(task.status)}
          onChange={(event) => onAssign(task, task.assignedTo, event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">No team</option>
          {departments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}
        </select>
      </Field>
    </div>}

    {task.status === 'awaiting_inspection' && canInspect && <div className="hk-inspection-controls">
      <Field label="Inspection note (required for rejection)">
        <input value={inspectionReason} onChange={(event) => setInspectionReason(event.target.value)} />
      </Field>
      <div className="hk-actions">
        <button className="button button-primary" onClick={() => onInspect(task.id, 'approve', inspectionReason)}>Approve and mark clean</button>
        <button className="button button-secondary" disabled={inspectionReason.trim().length < 3} onClick={() => onInspect(task.id, 'reject', inspectionReason)}>Reject for rework</button>
      </div>
    </div>}

    {issueOpen && canEditChecklist && <form className="hk-issue-form" onSubmit={async (event) => {
      event.preventDefault();
      await onIssue(task.id, issue);
      setIssueOpen(false);
      setIssue({ category: 'Housekeeping', description: '', priority: 'normal' });
    }}>
      <Field label="Issue category"><input required value={issue.category} onChange={(event) => setIssue({ ...issue, category: event.target.value })} /></Field>
      <Field label="Description"><textarea required minLength="3" value={issue.description} onChange={(event) => setIssue({ ...issue, description: event.target.value })} /></Field>
      <Field label="Priority"><select value={issue.priority} onChange={(event) => setIssue({ ...issue, priority: event.target.value })}>
        <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
      </select></Field>
      <button className="button button-secondary">Create maintenance issue</button>
    </form>}

    <footer className="hk-task-actions">
      {canStart && <button className="button button-primary hk-large-button" onClick={() => onStart(task.id)}>Start task</button>}
      {canEditChecklist && <>
        <button className="button button-secondary hk-large-button" onClick={() => setIssueOpen(!issueOpen)}>{issueOpen ? 'Close issue form' : 'Report an issue'}</button>
        <button className="button button-primary hk-large-button" onClick={() => onSubmit(task.id)}>Submit task</button>
      </>}
      {task.status === 'awaiting_inspection' && !canInspect && <span className="hk-waiting-note">Waiting for supervisor inspection</span>}
    </footer>
  </article>;
}

export function HousekeepingWorkspace({ permissionKeys = [], propertyId }) {
  const canAssign = permissionKeys.includes('housekeeping.assign');
  const canWork = permissionKeys.includes('housekeeping.work');
  const canInspect = permissionKeys.includes('housekeeping.inspect');
  const canSkipInspection = permissionKeys.includes('housekeeping.skip_inspection');
  const [tasks, setTasks] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [staff, setStaff] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [checklists, setChecklists] = useState([]);
  const [settings, setSettings] = useState({ skipInspection: false, sameDayArrivalPriority: true });
  const [report, setReport] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskForm, setTaskForm] = useState({ roomId: '', type: 'checkout_clean', priority: 3, dueAt: '', assignedTo: '' });
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);
  const [bulkAssignee, setBulkAssignee] = useState('');
  const [templateForm, setTemplateForm] = useState({ name: '', roomTypeId: '', items: [''].map((label) => ({ label, required: true })) });

  const refresh = useCallback(async () => {
    const [taskData, roomData] = await Promise.all([
      authApi.request('/api/housekeeping/tasks'),
      authApi.request('/api/housekeeping/rooms'),
    ]);
    setTasks(taskData);
    setRooms(roomData);
    if (canAssign) {
      const [staffData, templateData, settingData, reportData] = await Promise.all([
        authApi.request('/api/housekeeping/staff'),
        authApi.request('/api/housekeeping/checklists'),
        authApi.request('/api/housekeeping/settings'),
        authApi.request('/api/housekeeping/reports'),
      ]);
      setStaff(staffData.staff);
      setDepartments(staffData.departments);
      setChecklists(templateData);
      setSettings(settingData);
      setReport(reportData);
    }
  }, [canAssign]);

  const connected = useRoomStatusUpdates(propertyId, () => {
    refresh().catch((error) => setMessage(error.message));
  });

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  async function perform(action, success) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      await refresh();
      if (success) setMessage(success);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  function patchTask(updated) {
    setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
  }

  function saveTask(event) {
    event.preventDefault();
    perform(async () => {
      await authApi.request('/api/housekeeping/tasks', {
        method: 'POST',
        body: JSON.stringify({
          ...taskForm,
          roomId: Number(taskForm.roomId),
          priority: Number(taskForm.priority),
          assignedTo: taskForm.assignedTo ? Number(taskForm.assignedTo) : null,
          ...(taskForm.dueAt ? { dueAt: new Date(taskForm.dueAt).toISOString() } : {}),
        }),
      });
      setTaskForm({ roomId: '', type: 'checkout_clean', priority: 3, dueAt: '', assignedTo: '' });
    }, 'Housekeeping task created.');
  }

  function saveTemplate(event) {
    event.preventDefault();
    perform(async () => {
      await authApi.request('/api/housekeeping/checklists', {
        method: 'POST',
        body: JSON.stringify({
          ...templateForm,
          roomTypeId: templateForm.roomTypeId ? Number(templateForm.roomTypeId) : null,
          items: templateForm.items.filter((item) => item.label.trim()),
        }),
      });
      setTemplateForm({ name: '', roomTypeId: '', items: [{ label: '', required: true }] });
    }, 'Checklist template saved; new tasks will receive a copy.');
  }

  function mutateTask(id, method, endpoint, body, success) {
    perform(async () => {
      const updated = await authApi.request(endpoint, { method, body: JSON.stringify(body) });
      if (updated?.id) patchTask(updated);
    }, success);
  }

  function selectTask(id, checked) {
    setSelectedTaskIds((current) => checked
      ? [...new Set([...current, id])]
      : current.filter((taskId) => taskId !== id));
  }

  function applyBulkAssignment() {
    if (!bulkAssignee || selectedTaskIds.length === 0) return;
    perform(async () => {
      await authApi.request('/api/housekeeping/tasks/bulk-assignment', {
        method: 'POST',
        body: JSON.stringify({ taskIds: selectedTaskIds, assignedTo: Number(bulkAssignee) }),
      });
      setSelectedTaskIds([]);
      setBulkAssignee('');
    }, `${selectedTaskIds.length} task(s) assigned.`);
  }

  const roomsAwaitingReadiness = rooms.filter((room) => ['AWAITING_CLEANING', 'BEING_CLEANED', 'AWAITING_INSPECTION'].includes(room.status)).length;
  const overdue = tasks.filter((task) => task.isOverdue).length;

  return <div className="housekeeping-page">
    <header className="page-heading">
      <div><p className="eyebrow">ROOM CARE</p><h1>Housekeeping</h1><p className="muted">Complete assigned work and keep room readiness current.</p></div>
      <span className={`hk-live-indicator ${connected ? 'connected' : ''}`}><i />{connected ? 'Live room updates connected' : 'Connecting to live updates'}</span>
    </header>
    {message && <p className="form-notice" role="status">{message}</p>}

    <section className="hk-summary-grid">
      <article><span>Tasks in view</span><strong>{tasks.length}</strong></article>
      <article><span>Rooms in readiness flow</span><strong>{roomsAwaitingReadiness}</strong></article>
      <article className={overdue ? 'warning' : ''}><span>Overdue tasks</span><strong>{overdue}</strong></article>
      {report && <article><span>Average cleaning time</span><strong>{report.averageMinutes === null ? '—' : `${Math.round(report.averageMinutes)} min`}</strong></article>}
    </section>

    {canAssign && <section className="hk-supervisor-grid">
      <article className="panel hk-panel">
        <h2>Create and assign a task</h2>
        <form className="hk-form-grid" onSubmit={saveTask}>
          <Field label="Room"><select required value={taskForm.roomId} onChange={(event) => setTaskForm({ ...taskForm, roomId: event.target.value })}>
            <option value="">Select a room</option>
            {rooms.map((room) => <option key={room.id} value={room.id}>Room {room.roomNumber} · {room.status}</option>)}
          </select></Field>
          <Field label="Task type"><select value={taskForm.type} onChange={(event) => setTaskForm({ ...taskForm, type: event.target.value })}>
            {Object.entries(taskLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></Field>
          <Field label="Priority (1 highest)"><select value={taskForm.priority} onChange={(event) => setTaskForm({ ...taskForm, priority: Number(event.target.value) })}>
            {[1, 2, 3, 4, 5].map((priority) => <option value={priority} key={priority}>{priority}</option>)}
          </select></Field>
          <Field label="Due time"><input type="datetime-local" value={taskForm.dueAt} onChange={(event) => setTaskForm({ ...taskForm, dueAt: event.target.value })} /></Field>
          <Field label="Assign to housekeeper"><select value={taskForm.assignedTo} onChange={(event) => setTaskForm({ ...taskForm, assignedTo: event.target.value })}>
            <option value="">Unassigned</option>{staff.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
          </select></Field>
          <button className="button button-primary" disabled={busy || rooms.length === 0}>Create task</button>
        </form>
      </article>
      <article className="panel hk-panel">
        <h2>Readiness rules</h2>
        <label className="hk-setting">
          <input type="checkbox" checked={settings.sameDayArrivalPriority} disabled={busy} onChange={(event) => {
            const next = { ...settings, sameDayArrivalPriority: event.target.checked };
            perform(async () => {
              await authApi.request('/api/housekeeping/settings', { method: 'PUT', body: JSON.stringify(next) });
              setSettings(next);
            }, 'Priority rule updated.');
          }} />
          <span><strong>Prioritize same-day arrivals</strong><small>New tasks explain when an arrival changes their priority.</small></span>
        </label>
        <label className="hk-setting">
          <input type="checkbox" checked={settings.skipInspection} disabled={busy || !canSkipInspection} onChange={(event) => {
            const next = { ...settings, skipInspection: event.target.checked };
            perform(async () => {
              await authApi.request('/api/housekeeping/settings', { method: 'PUT', body: JSON.stringify(next) });
              setSettings(next);
            }, 'Inspection policy updated.');
          }} />
          <span><strong>Skip supervisor inspection</strong><small>Off by default; only property administrators can enable.</small></span>
        </label>
        <div className="hk-template-list"><h3>Checklist templates</h3>
          {checklists.map((template) => <div key={template.id}><strong>{template.name}</strong><small>{template.roomType ?? 'All room types'} · {template.items.length} items</small></div>)}
        </div>
        <details className="hk-template-editor">
          <summary>Create checklist template</summary>
          <form onSubmit={saveTemplate}>
            <Field label="Template name"><input required value={templateForm.name} onChange={(event) => setTemplateForm({ ...templateForm, name: event.target.value })} /></Field>
            <Field label="Room type"><select value={templateForm.roomTypeId} onChange={(event) => setTemplateForm({ ...templateForm, roomTypeId: event.target.value })}>
              <option value="">All room types</option>
              {[...new Map(rooms.map((room) => [room.roomType, room])).values()].map((room) => <option value={room.roomTypeId} key={room.roomTypeId}>{room.roomType}</option>)}
            </select></Field>
            {templateForm.items.map((item, index) => <Field label={`Checklist item ${index + 1}`} key={index}>
              <div className="hk-template-item">
                <input required value={item.label} onChange={(event) => setTemplateForm({
                  ...templateForm,
                  items: templateForm.items.map((current, itemIndex) => itemIndex === index ? { ...current, label: event.target.value } : current),
                })} />
                {templateForm.items.length > 1 && <button type="button" className="text-button" onClick={() => setTemplateForm({
                  ...templateForm, items: templateForm.items.filter((_, itemIndex) => itemIndex !== index),
                })}>Remove</button>}
              </div>
            </Field>)}
            <button type="button" className="button button-secondary" onClick={() => setTemplateForm({ ...templateForm, items: [...templateForm.items, { label: '', required: true }] })}>Add checklist item</button>
            <button className="button button-primary" disabled={busy}>Save template</button>
          </form>
        </details>
      </article>
    </section>}

    <section className="hk-board">
      <header><div><h2>{canAssign || canInspect ? 'Supervisor task board' : 'My assigned tasks'}</h2><p>Room readiness is not assignable until the inspection is approved.</p></div>
        <button className="button button-secondary" disabled={busy} onClick={() => refresh().catch((error) => setMessage(error.message))}>Refresh</button>
      </header>
      {canAssign && <div className="hk-bulk-assignment">
        <strong>{selectedTaskIds.length} selected</strong>
        <Field label="Bulk assign to"><select value={bulkAssignee} onChange={(event) => setBulkAssignee(event.target.value)}>
          <option value="">Select a housekeeper</option>{staff.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
        </select></Field>
        <button className="button button-primary" disabled={busy || !bulkAssignee || !selectedTaskIds.length} onClick={applyBulkAssignment}>Assign selected</button>
      </div>}
      {tasks.length === 0 ? <p className="hk-empty">No housekeeping tasks are assigned or waiting.</p> : <div className="hk-task-grid">
        {tasks.map((task) => <TaskCard
          key={task.id}
          task={task}
          canWork={canWork}
          canAssign={canAssign}
          canInspect={canInspect}
          staff={staff}
          departments={departments}
          selected={selectedTaskIds.includes(task.id)}
          onSelect={selectTask}
          onStart={(id) => mutateTask(id, 'POST', `/api/housekeeping/tasks/${id}/start`, {}, 'Task started.')}
          onChecklist={(id, itemId, complete) => mutateTask(id, 'PATCH', `/api/housekeeping/tasks/${id}/items/${itemId}`, { complete })}
          onSubmit={(id) => mutateTask(id, 'POST', `/api/housekeeping/tasks/${id}/submit`, {}, 'Task submitted for inspection.')}
          onAssign={(task, assignedTo, departmentId = task.departmentId) => mutateTask(task.id, 'PATCH', `/api/housekeeping/tasks/${task.id}/assignment`, {
            assignedTo,
            departmentId,
          }, 'Task assignment updated.')}
          onInspect={(id, decision, reason) => mutateTask(id, 'POST', `/api/housekeeping/tasks/${id}/inspection`, { decision, reason: reason || undefined }, decision === 'approve' ? 'Room approved as clean.' : 'Task rejected for rework.')}
          onIssue={(id, data) => perform(async () => {
            const result = await authApi.request(`/api/housekeeping/tasks/${id}/issue`, { method: 'POST', body: JSON.stringify(data) });
            setMessage(`Maintenance issue #${result.ticketId} created.`);
          })}
        />)}
      </div>}
    </section>

    {canAssign && report && <section className="panel hk-panel">
      <h2>Cleaning performance</h2>
      <div className="hk-report-details">
        {report.byRoomType.map((item) => <div key={`room-${item.roomType}`}><strong>{item.roomType}</strong><small>Room average · {Math.round(item.averageMinutes)} min</small></div>)}
        {report.byEmployee.map((item) => <div key={`staff-${item.employeeId}`}><strong>{item.employeeName}</strong><small>Staff average · {Math.round(item.averageMinutes)} min</small></div>)}
      </div>
    </section>}

    <section className="hk-room-board panel">
      <header><div><h2>Live room readiness</h2><p>Room status changes update connected front-desk and housekeeping views.</p></div></header>
      <div className="hk-room-grid">{rooms.map((room) => <article className={`hk-room-status ${room.status.toLowerCase()}`} key={room.id}>
        <strong>{room.roomNumber}</strong><span>{room.status.replaceAll('_', ' ')}</span><small>{room.roomType}</small>
      </article>)}</div>
    </section>
  </div>;
}
