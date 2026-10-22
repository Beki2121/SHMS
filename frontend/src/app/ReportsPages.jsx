import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../auth/api.js';
import '../styles/reports.css';

const roleLabels = {
  management: 'Management',
  front_desk: 'Front desk',
  cashier: 'Cashier',
  housekeeping: 'Housekeeping supervisor',
};

function reportUrl(path, filters = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '' && value !== null && value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return `${path}${suffix ? `?${suffix}` : ''}`;
}

function SummaryTiles({ report }) {
  const { current, housekeeping, financial, dashboardRole } = report;
  const tiles = dashboardRole === 'front_desk'
    ? [
      ['Today arrivals', current.arrivals, '/reservations', 'blue'],
      ['Today departures', current.departures, '/front-desk', 'amber'],
      ['Available rooms', current.rooms.available, '/rooms', 'green'],
      ['Current occupancy', `${current.occupancyPercent}%`, '/rooms', 'violet'],
    ]
    : dashboardRole === 'cashier'
      ? [
        ['Folio revenue', `${report.property.currency} ${financial?.revenue.total ?? 0}`, '/finance', 'green'],
        ['Payments received', `${report.property.currency} ${financial?.payments.total ?? 0}`, '/finance', 'blue'],
        ['Open balances', `${report.property.currency} ${financial?.outstanding.total ?? 0}`, '/finance', 'amber'],
        ['Cashier variance', `${report.property.currency} ${financial?.cashier.totalVariance ?? 0}`, '/finance', 'violet'],
      ]
      : dashboardRole === 'housekeeping'
        ? [
          ['Tasks completed', housekeeping.completed, '/housekeeping', 'green'],
          ['Completion rate', `${housekeeping.completionPercent}%`, '/housekeeping', 'blue'],
          ['Rooms available', current.rooms.available, '/rooms', 'amber'],
          ['Out of service', current.rooms.outOfService, '/rooms', 'violet'],
        ]
        : [
          ['Current occupancy', `${current.occupancyPercent}%`, '/rooms', 'green'],
          ['Today arrivals', current.arrivals, '/reservations', 'blue'],
          ['Today departures', current.departures, '/front-desk', 'amber'],
          ['Rooms available', current.rooms.available, '/rooms', 'violet'],
        ];

  return <section className="metric-grid report-tiles" aria-label={`${roleLabels[dashboardRole] ?? 'Management'} dashboard`}>
    {tiles.map(([label, value, to, tone]) => <Link className="metric-card report-tile" key={label} to={to}>
      <div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}>◆</span></div>
      <strong>{value}</strong><small>View details →</small>
    </Link>)}
  </section>;
}

export function DashboardPreview({ propertyId, permissionKeys = [] }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const canViewReports = permissionKeys.includes('reports.view');

  useEffect(() => {
    let active = true;
    if (!canViewReports || !propertyId) {
      setLoading(false);
      setReport(null);
      return () => { active = false; };
    }
    setLoading(true);
    authApi.request(reportUrl('/api/reports/dashboard', { propertyId }))
      .then((data) => {
        if (active) {
          setReport(data);
          setError('');
        }
      })
      .catch((requestError) => active && setError(requestError.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [propertyId, canViewReports]);

  if (!canViewReports) return <section className="panel dashboard-empty">
    <div><h2>Welcome to SmartHotel</h2><p className="muted">Your operational workspaces are ready.</p></div>
    <Link className="button button-primary" to="/housekeeping">Open your workspace</Link>
  </section>;
  if (loading) return <section className="panel dashboard-empty" aria-live="polite">Loading today's property dashboard…</section>;
  if (error) return <section className="panel dashboard-empty" role="alert">Dashboard unavailable: {error}</section>;
  if (!report) return null;
  return <section>
    <div className="dashboard-role-heading">
      <div><p className="eyebrow">{report.current.businessDate}</p><h2>{roleLabels[report.dashboardRole] ?? 'Management'} dashboard</h2></div>
      <Link className="text-button" to="/reports">View all reports →</Link>
    </div>
    <SummaryTiles report={report}/>
  </section>;
}

function currency(value, code) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(Number(value ?? 0));
  } catch {
    return `${code} ${Number(value ?? 0).toFixed(2)}`;
  }
}

function MetricCard({ label, value, to }) {
  const content = <><span>{label}</span><strong>{value}</strong></>;
  return to
    ? <Link className="report-stat" to={to}>{content}<small>View records →</small></Link>
    : <article className="report-stat">{content}</article>;
}

function ReportTable({ title, columns, rows }) {
  return <section className="panel report-panel">
    <h2>{title}</h2>
    {!rows.length ? <p className="muted">No records for this date range.</p> : <div className="report-table-wrap">
      <table className="report-table"><thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={`${title}-${index}`}>{columns.map((column) => <td key={column.key}>{column.render ? column.render(row[column.key]) : row[column.key]}</td>)}</tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

function RevenueChart({ entries, currencyCode }) {
  const max = Math.max(0, ...entries.map((entry) => Math.abs(Number(entry.total)))) || 1;
  return <section className="panel report-panel">
    <h2>Daily revenue trend</h2>
    {!entries.length ? <p className="muted">No revenue for this date range.</p> : <div className="report-chart" role="img" aria-label="Daily folio revenue bar chart">
      {entries.map((entry) => {
        const value = Number(entry.total);
        const height = Math.max(0, (Math.abs(value) / max) * 100);
        return <div className="report-chart-column" key={entry.date} title={`${entry.date}: ${currency(value, currencyCode)}`}>
          <div className="report-chart-track"><span className={value < 0 ? 'negative' : ''} style={{ height: `${height}%` }}/></div>
          <small>{entry.date.slice(5)}</small>
        </div>;
      })}
    </div>}
  </section>;
}

async function downloadReport(url, fileName) {
  const blob = await authApi.requestBlob(url);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export function ReportsWorkspace({ propertyId, properties = [], permissionKeys = [] }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selectedPropertyId, setSelectedPropertyId] = useState(String(propertyId ?? ''));
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const includeFinancial = permissionKeys.includes('reports.view_financial');
  const can = (permission) => permissionKeys.includes(permission);

  async function loadReport(event) {
    event?.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await authApi.request(reportUrl('/api/reports', {
        propertyId: selectedPropertyId,
        from,
        to,
      }));
      setReport(data);
      if (!from && !to) {
        setFrom(data.range.from);
        setTo(data.range.to);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelectedPropertyId(String(propertyId ?? ''));
  }, [propertyId]);

  useEffect(() => {
    if (selectedPropertyId) loadReport();
  }, [selectedPropertyId]);

  async function exportReport(format) {
    setExporting(true);
    setError('');
    try {
      const url = reportUrl('/api/reports/export', {
        propertyId: selectedPropertyId,
        from: report?.range.from ?? from,
        to: report?.range.to ?? to,
        format,
      });
      await downloadReport(url, `smarthotel-report.${format}`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setExporting(false);
    }
  }

  const reportSections = report && [
    {
      title: 'Occupancy and reservations',
      items: [
      ['Occupied room-nights', report.occupancy.occupiedRoomNights, can('reservations.view') ? '/reservations' : null],
      ['Available room-nights', report.occupancy.availableRoomNights, can('rooms.manage') ? '/rooms' : null],
      ['Occupancy', `${report.occupancy.occupancyPercent}%`, can('rooms.manage') ? '/rooms' : null],
      ['Reservations created', report.reservations.created, can('reservations.view') ? '/reservations' : null],
      ['Cancellation rate', `${report.reservations.cancellationRatePercent}%`, can('reservations.view') ? '/reservations' : null],
      ['Average lead time', `${report.reservations.averageLeadTimeDays} days`, can('reservations.view') ? '/reservations' : null],
      ['Arrivals in range', report.reservations.arrivals, can('reservations.view') ? '/reservations' : null],
      ['Departures in range', report.reservations.departures, can('reservations.view') ? '/front-desk' : null],
      ],
    },
    {
      title: 'Operations and staffing',
      items: [
        ['Housekeeping completion', `${report.housekeeping.completionPercent}%`, can('housekeeping.view') ? '/housekeeping' : null],
        ['Average cleaning time', `${report.housekeeping.averageCleaningMinutes} min`, can('housekeeping.view') ? '/housekeeping' : null],
        ['Open maintenance', report.maintenance.open, can('maintenance.manage') ? '/maintenance' : null],
        ['Overdue maintenance', report.maintenance.overdue, can('maintenance.manage') ? '/maintenance' : null],
        ['Mean time to resolve', `${report.maintenance.meanResolutionHours} hrs`, can('maintenance.manage') ? '/maintenance' : null],
        ['Shift coverage', `${report.staff.coveragePercent}%`, can('staff.manage') || can('staff.self_service') ? '/staff' : null],
        ['Attendance records', report.staff.attendanceRecords, can('staff.manage') || can('staff.self_service') ? '/staff' : null],
        ['Overtime', `${report.staff.overtimeMinutes} min`, can('staff.manage') || can('staff.self_service') ? '/staff' : null],
      ],
    },
  ];

  return <div className="reports-workspace">
    <header className="page-heading">
      <div><p className="eyebrow">PROPERTY PERFORMANCE</p><h1>Reports & dashboards</h1>
        <p className="muted">Occupancy, guest operations, staffing and financial summaries for your assigned properties.</p></div>
      {report && <div className="report-export-actions">
        <button className="button button-secondary" disabled={exporting} onClick={() => exportReport('csv')}>Export CSV</button>
        <button className="button button-secondary" disabled={exporting} onClick={() => exportReport('pdf')}>Download PDF</button>
        <button className="button button-secondary" onClick={() => window.print()}>Print</button>
      </div>}
    </header>

    <form className="panel report-filters" onSubmit={loadReport}>
      <label>Property
        <select value={selectedPropertyId} onChange={(event) => setSelectedPropertyId(event.target.value)}>
          {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
        </select>
      </label>
      <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label>
      <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label>
      <button className="button button-primary" disabled={loading || !selectedPropertyId} type="submit">{loading ? 'Loading…' : 'Apply filters'}</button>
    </form>

    {error && <p className="form-error report-error" role="alert">{error}</p>}
    {!report && loading && <p className="muted" aria-live="polite">Loading report data…</p>}
    {report && <>
      <div className="report-context"><span>{report.property.name}</span><span>{report.range.from} – {report.range.to}</span>
        <span>{report.range.days} day{report.range.days === 1 ? '' : 's'}</span>
        <span className="role-badge">{roleLabels[report.dashboardRole] ?? 'Management'} view</span>
      </div>
      <div className="report-stat-grid">
        <MetricCard label="Current occupancy" value={`${report.current.occupancyPercent}%`} to={can('rooms.manage') ? '/rooms' : null}/>
        <MetricCard label="Occupied rooms" value={report.current.rooms.occupied} to={can('checkin.perform') ? '/front-desk' : null}/>
        <MetricCard label="Rooms available" value={report.current.rooms.available} to={can('rooms.manage') ? '/rooms' : null}/>
        <MetricCard label="Out of service" value={report.current.rooms.outOfService} to={can('rooms.manage') ? '/rooms' : null}/>
        <MetricCard label="Occupied room-nights" value={report.occupancy.occupiedRoomNights} to={can('reservations.view') ? '/reservations' : null}/>
        <MetricCard label="Available room-nights" value={report.occupancy.availableRoomNights} to={can('rooms.manage') ? '/rooms' : null}/>
        <MetricCard label="ADR" value={includeFinancial ? currency(report.occupancy.adr, report.property.currency) : 'Restricted'} to={includeFinancial ? '/finance' : null}/>
        <MetricCard label="RevPAR" value={includeFinancial ? currency(report.occupancy.revpar, report.property.currency) : 'Restricted'} to={includeFinancial ? '/finance' : null}/>
      </div>
      <div className="report-section-grid">
        {reportSections.map((section) => <section className="panel report-panel" key={section.title}>
          <h2>{section.title}</h2><div className="report-metric-list">
            {section.items.map(([label, value, to]) => <MetricCard key={label} label={label} value={value} to={to}/>)}
          </div>
        </section>)}
      </div>
      {includeFinancial && report.financial && <>
        <section className="report-stat-grid financial-highlights">
          <MetricCard label="Folio charges" value={currency(report.financial.revenue.total, report.property.currency)} to="/finance"/>
          <MetricCard label="Payments received" value={currency(report.financial.payments.total, report.property.currency)} to="/finance"/>
          <MetricCard label="Outstanding balances" value={currency(report.financial.outstanding.total, report.property.currency)} to="/finance"/>
          <MetricCard label="Expenses" value={currency(report.financial.expenses.total, report.property.currency)} to={can('expenses.manage') ? '/operations' : null}/>
          <MetricCard label="Cashier variance" value={currency(report.financial.cashier.totalVariance, report.property.currency)} to="/finance"/>
          <MetricCard label="Open cashier shifts" value={report.financial.cashier.shifts.filter((shift) => shift.status === 'open').length} to="/finance"/>
        </section>
        <div className="report-section-grid">
          <RevenueChart entries={report.financial.revenue.byDay} currencyCode={report.property.currency}/>
          <ReportTable title="Revenue by day" columns={[
            { key: 'date', label: 'Business date' },
            { key: 'total', label: `Amount (${report.property.currency})` },
          ]} rows={report.financial.revenue.byDay}/>
          <ReportTable title="Revenue by week" columns={[
            { key: 'period', label: 'Week starting' },
            { key: 'total', label: `Amount (${report.property.currency})` },
          ]} rows={report.financial.revenue.byWeek}/>
          <ReportTable title="Revenue by month" columns={[
            { key: 'period', label: 'Month' },
            { key: 'total', label: `Amount (${report.property.currency})` },
          ]} rows={report.financial.revenue.byMonth}/>
          <ReportTable title="Revenue by room type" columns={[
            { key: 'roomType', label: 'Room type' },
            { key: 'total', label: `Amount (${report.property.currency})` },
          ]} rows={report.financial.revenue.byRoomType}/>
          <ReportTable title="Revenue by charge type" columns={[
            { key: 'chargeType', label: 'Charge type' },
            { key: 'total', label: `Amount (${report.property.currency})` },
          ]} rows={report.financial.revenue.byChargeType}/>
          <ReportTable title="Payments by method" columns={[
            { key: 'method', label: 'Method' },
            { key: 'count', label: 'Payments' },
            { key: 'total', label: `Amount (${report.property.currency})` },
          ]} rows={report.financial.payments.byMethod}/>
          <ReportTable title="Outstanding balance ageing" columns={[
            { key: 'ageBucket', label: 'Age' },
            { key: 'folios', label: 'Open folios' },
            { key: 'balance', label: `Balance (${report.property.currency})` },
          ]} rows={report.financial.outstanding.ageing}/>
          <ReportTable title="Expenses by category" columns={[
            { key: 'category', label: 'Category' },
            { key: 'count', label: 'Expenses' },
            { key: 'total', label: `Amount (${report.property.currency})` },
          ]} rows={report.financial.expenses.byCategory}/>
          <ReportTable title="Cashier shifts" columns={[
            { key: 'cashierName', label: 'Cashier' },
            { key: 'status', label: 'Status' },
            { key: 'variance', label: `Variance (${report.property.currency})` },
            { key: 'closedAt', label: 'Closed' },
          ]} rows={report.financial.cashier.shifts}/>
          <ReportTable title="Inventory movements" columns={[
            { key: 'movementType', label: 'Movement type' },
            { key: 'count', label: 'Entries' },
            { key: 'quantity', label: 'Quantity' },
          ]} rows={report.financial.inventory.movements}/>
        </div>
      </>}
    </>}
  </div>;
}
