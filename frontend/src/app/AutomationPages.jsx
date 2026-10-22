import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../auth/api.js';
import '../styles/automation.css';

const ruleFields = {
  arrival_reminder: { key: 'daysAhead', label: 'Days ahead', type: 'number', min: 0, max: 30 },
  departure_reminder: { key: 'daysAhead', label: 'Days ahead', type: 'number', min: 0, max: 30 },
  overdue_tasks: { key: 'overdueMinutes', label: 'Minutes overdue', type: 'number', min: 0, max: 43200 },
  outstanding_balance: { key: 'minimumBalance', label: 'Minimum balance', type: 'number', min: 0, step: '0.01' },
  unusual_adjustment: { key: 'minimumAmount', label: 'Minimum adjustment', type: 'number', min: 0, step: '0.01' },
};

function PageHeading({ title, description, action }) {
  return <header className="page-heading">
    <div><p className="eyebrow">PROPERTY OPERATIONS</p><h1>{title}</h1><p className="muted">{description}</p></div>
    {action}
  </header>;
}

function AutomationSection({ rule, onChange, onSave, busy }) {
  const field = ruleFields[rule.key];
  return <article className="panel automation-rule">
    <header>
      <div><h2>{rule.key.replaceAll('_', ' ')}</h2><p className="muted">{rule.description}</p></div>
      <span className={`automation-mode ${rule.mode}`}>{rule.mode === 'event' ? 'Event-driven' : 'Scheduled'}</span>
    </header>
    {rule.mode === 'event'
      ? <p className="automation-note">Checkout creates its cleaning task within the checkout transaction.</p>
      : <>
        <label className="automation-toggle">
          <input type="checkbox" checked={rule.enabled} disabled={busy} onChange={(event) => onChange(rule.key, 'enabled', event.target.checked)} />
          <span>Rule enabled</span>
        </label>
        {field && <label className="automation-field">
          <span>{field.label}</span>
          <input
            type={field.type}
            min={field.min}
            max={field.max}
            step={field.step}
            value={rule.config[field.key] ?? ''}
            disabled={busy || !rule.enabled}
            onChange={(event) => onChange(
              rule.key,
              'config',
              { ...rule.config, [field.key]: field.type === 'number' && field.step === undefined
                ? Number(event.target.value)
                : event.target.value },
            )}
          />
        </label>}
        <button className="button button-secondary" disabled={busy} onClick={() => onSave(rule)}>Save rule</button>
      </>}
  </article>;
}

function timeLabel(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

export function AutomationWorkspace({ propertyId }) {
  const [rules, setRules] = useState([]);
  const [logs, setLogs] = useState([]);
  const [runSummary, setRunSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const [ruleRows, logRows] = await Promise.all([
      authApi.request('/api/automation/rules'),
      authApi.request('/api/automation/logs?limit=100'),
    ]);
    setRules(ruleRows);
    setLogs(logRows);
  }, []);

  useEffect(() => {
    setError('');
    refresh().catch((requestError) => setError(requestError.message));
  }, [propertyId, refresh]);

  function updateRule(key, property, value) {
    setRules((current) => current.map((rule) => rule.key === key
      ? { ...rule, [property]: value }
      : rule));
  }

  async function saveRule(rule) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await authApi.request(`/api/automation/rules/${rule.key}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: rule.enabled, config: rule.config }),
      });
      setRules((current) => current.map((item) => item.key === rule.key ? { ...item, ...result } : item));
      setNotice(`${rule.key.replaceAll('_', ' ')} saved.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setRunSummary(await authApi.request('/api/automation/run', { method: 'POST', body: '{}' }));
      await refresh();
      setNotice('Automation run completed. Existing notifications were not duplicated.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="automation-page">
    <PageHeading
      title="Automation"
      description="Configure property rules, review why they matched, and safely run a cycle."
      action={<button className="button button-primary" disabled={busy} onClick={runNow}>{busy ? 'Running…' : 'Run now'}</button>}
    />
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="automation-notice" role="status">{notice}</p>}
    <section className="automation-rule-grid" aria-label="Automation rules">
      {rules.map((rule) => <AutomationSection key={rule.key} rule={rule} busy={busy} onChange={updateRule} onSave={saveRule} />)}
      {!rules.length && !error && <article className="panel"><p className="muted">Loading property rules…</p></article>}
    </section>
    {runSummary && <section className="panel automation-section">
      <header><div><h2>Latest run</h2><p className="muted">Business date {runSummary.businessDate}</p></div></header>
      <div className="automation-table-wrap"><table className="automation-table">
        <thead><tr><th>Rule</th><th>Status</th><th>Matches</th><th>Created</th><th>Duplicates skipped</th></tr></thead>
        <tbody>{runSummary.results.map((result) => <tr key={result.ruleKey}>
          <td>{result.ruleKey.replaceAll('_', ' ')}</td><td>{result.status ?? result.mode}</td>
          <td>{result.matched}</td><td>{result.notificationsCreated}</td><td>{result.duplicatesSuppressed}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    <section className="panel automation-section">
      <header><div><h2>Explainable activity log</h2><p className="muted">Each matching entity is logged once per rule and business-date cycle.</p></div></header>
      {!logs.length
        ? <p className="automation-empty">No automation matches have been recorded.</p>
        : <div className="automation-log-list">{logs.map((entry) => <article key={entry.id}>
          <header><strong>{entry.result.title ?? entry.ruleKey.replaceAll('_', ' ')}</strong><span>{timeLabel(entry.createdAt)}</span></header>
          <p>{entry.result.reason}</p>
          <details><summary>Rule criteria and observed values</summary>
            <dl><dt>Criteria</dt><dd><code>{JSON.stringify(entry.result.criteria)}</code></dd>
              <dt>Observed</dt><dd><code>{JSON.stringify(entry.result.observed)}</code></dd></dl>
          </details>
        </article>)}</div>}
    </section>
  </div>;
}

export function NotificationInbox({ propertyId }) {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const result = await authApi.request('/api/notifications?limit=100');
    setNotifications(result.notifications);
    setUnreadCount(result.unreadCount);
  }, []);

  useEffect(() => {
    setError('');
    refresh().catch((requestError) => setError(requestError.message));
  }, [propertyId, refresh]);

  async function markRead(id) {
    setBusyId(id);
    setError('');
    try {
      await authApi.request(`/api/notifications/${id}/read`, { method: 'PATCH', body: '{}' });
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  }

  return <div className="automation-page">
    <PageHeading title="Notifications" description={`${unreadCount} unread notification${unreadCount === 1 ? '' : 's'} for your role at this property.`} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {!notifications.length
      ? <section className="panel automation-empty">No notifications for this property and role.</section>
      : <section className="automation-notification-list">{notifications.map((notification) => {
        const payload = notification.payload;
        return <article className={`panel automation-notification${notification.readAt ? ' read' : ''}`} key={notification.id}>
          <header><div><p className="eyebrow">{notification.type.replaceAll('_', ' ')}</p><h2>{payload.title ?? 'Property notification'}</h2></div><time>{timeLabel(notification.createdAt)}</time></header>
          <p>{payload.message}</p>
          <div className="automation-explanation">
            <strong>Why this was sent</strong><p>{payload.reason}</p>
            <details><summary>Criteria and observed values</summary>
              <dl><dt>Criteria</dt><dd><code>{JSON.stringify(payload.criteria)}</code></dd>
                <dt>Observed</dt><dd><code>{JSON.stringify(payload.observed)}</code></dd></dl>
            </details>
          </div>
          <footer>{payload.actionUrl && <Link className="button button-secondary" to={payload.actionUrl}>Open workspace</Link>}
            {!notification.readAt && <button className="button button-primary" disabled={busyId === notification.id} onClick={() => markRead(notification.id)}>Mark as read</button>}
            {notification.readAt && <span className="automation-read-label">Read</span>}
          </footer>
        </article>;
      })}</section>}
    {notifications.length === 100 && <p className="automation-note">Showing the latest 100 notifications. Unread count includes all available notifications.</p>}
  </div>;
}
