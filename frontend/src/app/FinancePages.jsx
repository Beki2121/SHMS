import { useCallback, useEffect, useMemo, useState } from 'react';
import { authApi } from '../auth/api.js';
import '../styles/finance.css';

function Amount({ value }) {
  return <>ETB {Number(value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>;
}

function Field({ label, children }) {
  return <label className="finance-field">{label}{children}</label>;
}

function PrintDocument({ document, kind, onClose, onDownloadPdf, onPrint }) {
  if (!document) return null;
  const receipt = kind === 'receipt';
  const title = receipt ? 'Payment receipt' : 'Guest invoice';
  const number = document.number;
  return <section className={`finance-document ${receipt ? 'receipt-document' : 'invoice-document'}`} aria-label={title}>
    <div className="finance-document-actions">
      <button className="button button-secondary" onClick={onClose}>Back to folio</button>
      <button className="button button-secondary" onClick={onDownloadPdf}>Download PDF</button>
      <button className="button button-primary" onClick={onPrint}>Print {title.toLowerCase()}</button>
    </div>
    <article className="finance-paper">
      <header>
        <h1>{receipt ? document.propertyName : document.property.name}</h1>
        {!receipt && <p>{[document.property.address, document.property.city, document.property.phone, document.property.email].filter(Boolean).join(' · ')}</p>}
        <h2>{title}</h2>
        <p><strong>{number}</strong>{document.duplicate && <span className="duplicate-mark"> · DUPLICATE / REPRINT</span>}</p>
      </header>
      <div className="finance-document-meta">
        <span>Guest: <strong>{document.guestName || 'Guest'}</strong></span>
        {!receipt && document.confirmationNo && <span>Reservation: <strong>{document.confirmationNo}</strong></span>}
        {!receipt && document.roomNumber && <span>Room: <strong>{document.roomNumber}</strong></span>}
        <span>Issued: <strong>{new Date(document.issuedAt).toLocaleString()}</strong></span>
      </div>
      {receipt ? <div className="finance-document-total">
        <span>{document.method.replaceAll('_', ' ')}{document.isDeposit ? ' · Deposit' : ''}</span>
        <strong><Amount value={document.amount} /></strong>
        {document.reference && <small>Reference: {document.reference}</small>}
      </div> : <>
        <table className="finance-document-table">
          <thead><tr><th>Item</th><th>Date</th><th>Qty</th><th>Unit</th><th>Amount</th></tr></thead>
          <tbody>{document.charges.map((charge, index) => <tr key={`${charge.description}-${index}`}>
            <td>{charge.description}</td>
            <td>{String(charge.business_date).slice(0, 10)}</td>
            <td>{charge.quantity}</td>
            <td><Amount value={charge.unit_amount} /></td>
            <td><Amount value={charge.amount} /></td>
          </tr>)}</tbody>
        </table>
        <div className="finance-document-totals">
          <span>Charges <strong><Amount value={document.totals.charges} /></strong></span>
          <span>Payments <strong><Amount value={document.totals.payments} /></strong></span>
          <span>Balance <strong><Amount value={document.totals.balance} /></strong></span>
        </div>
        <p className="finance-disclaimer">{document.disclaimer}</p>
      </>}
      <footer>Thank you for choosing {receipt ? document.propertyName : document.property.name}.</footer>
    </article>
  </section>;
}

export function FinanceWorkspace({ permissionKeys = [] }) {
  const canPostCharge = permissionKeys.includes('folio.post_charge');
  const canTakePayment = permissionKeys.includes('folio.take_payment');
  const canAdjust = permissionKeys.includes('folio.adjust');
  const canRefund = permissionKeys.includes('refund.approve');
  const canManageShift = permissionKeys.includes('cashier.shift.manage');
  const canRunAudit = permissionKeys.includes('night_audit.run');
  const canSeeShiftReports = permissionKeys.includes('reports.view_financial');
  const [folios, setFolios] = useState([]);
  const [folioStatus, setFolioStatus] = useState('open');
  const [activeFolio, setActiveFolio] = useState(null);
  const [shift, setShift] = useState(null);
  const [shifts, setShifts] = useState([]);
  const [adjustmentRequests, setAdjustmentRequests] = useState([]);
  const [audit, setAudit] = useState(null);
  const [document, setDocument] = useState(null);
  const [documentKind, setDocumentKind] = useState('invoice');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [openingFloat, setOpeningFloat] = useState('0.00');
  const [countedCash, setCountedCash] = useState('');
  const [chargeForm, setChargeForm] = useState({ type: 'other', description: '', amount: '' });
  const [serviceCatalog, setServiceCatalog] = useState([]);
  const [serviceCharge, setServiceCharge] = useState({ serviceId: '', quantity: '1' });
  const [paymentForm, setPaymentForm] = useState({
    method: 'cash', amount: '', reference: '', isDeposit: false, approveCredit: false, creditReason: '',
  });
  const [adjustmentForm, setAdjustmentForm] = useState({ type: 'discount', amount: '', reason: '', paymentId: '' });
  const [reprinted, setReprinted] = useState(new Set());

  const refresh = useCallback(async (selectedId = activeFolio?.id) => {
    const tasks = [
      authApi.request(`/api/folios?status=${folioStatus}`).then(setFolios),
      authApi.request('/api/cashier-shifts/current').then(setShift),
    ];
    if (canPostCharge) tasks.push(authApi.request('/api/services/catalog').then(setServiceCatalog));
    if (canAdjust) tasks.push(authApi.request('/api/adjustment-requests').then(setAdjustmentRequests));
    if (canRunAudit) tasks.push(authApi.request('/api/night-audit/status').then(setAudit));
    if (canSeeShiftReports) tasks.push(authApi.request('/api/cashier-shifts').then(setShifts));
    await Promise.all(tasks);
    if (selectedId) {
      const detail = await authApi.request(`/api/folios/${selectedId}`);
      setActiveFolio(detail);
    } else {
      setActiveFolio(null);
    }
  }, [activeFolio?.id, canAdjust, canPostCharge, canRunAudit, canSeeShiftReports, folioStatus]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  const pendingAdjustmentIds = useMemo(
    () => new Set(adjustmentRequests.filter((item) => item.status === 'pending').map((item) => item.id)),
    [adjustmentRequests],
  );

  async function run(action, successMessage) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(successMessage);
      await refresh(activeFolio?.id);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadFolio(id) {
    setBusy(true);
    setMessage('');
    try {
      setActiveFolio(await authApi.request(`/api/folios/${id}`));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function openDocument(kind, id) {
    setBusy(true);
    setMessage('');
    try {
      const key = `${kind}:${id}`;
      const params = reprinted.has(key) ? '?reprint=1' : '';
      const data = await authApi.request(`/api/documents/${kind}s/${id}${params}`);
      setDocument(data);
      setDocumentKind(kind);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (!document) return;
    setBusy(true);
    try {
      const key = `${documentKind}:${document.id}`;
      const params = reprinted.has(key) ? '?reprint=1' : '';
      const blob = await authApi.requestBlob(`/api/documents/${documentKind}s/${document.id}/pdf${params}`);
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `${document.number}${reprinted.has(key) ? '-copy' : ''}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setReprinted((current) => new Set(current).add(key));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  function printDocument() {
    if (!document) return;
    window.print();
    setReprinted((current) => new Set(current).add(`${documentKind}:${document.id}`));
  }

  async function submitCharge(event) {
    event.preventDefault();
    await run(async () => {
      await authApi.request(`/api/folios/${activeFolio.id}/charges`, {
        method: 'POST',
        body: JSON.stringify(chargeForm),
      });
      setChargeForm({ type: 'other', description: '', amount: '' });
    }, 'Charge posted to the folio.');
  }

  async function submitServiceCharge(event) {
    event.preventDefault();
    await run(async () => {
      await authApi.request(`/api/folios/${activeFolio.id}/services`, {
        method: 'POST',
        body: JSON.stringify({
          serviceId: Number(serviceCharge.serviceId),
          quantity: Number(serviceCharge.quantity),
        }),
      });
      setServiceCharge({ serviceId: '', quantity: '1' });
    }, 'Catalog service posted to the folio.');
  }

  async function submitPayment(event) {
    event.preventDefault();
    await run(async () => {
      const idempotencyKey = globalThis.crypto?.randomUUID?.()
        ?? `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await authApi.request(`/api/folios/${activeFolio.id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          ...paymentForm,
          reference: paymentForm.reference || null,
          idempotencyKey,
        }),
      });
      setPaymentForm({
        method: 'cash', amount: '', reference: '', isDeposit: false, approveCredit: false, creditReason: '',
      });
      await openDocument('receipt', result.receiptId);
    }, 'Payment received and receipt issued.');
  }

  async function submitAdjustment(event) {
    event.preventDefault();
    await run(async () => {
      await authApi.request(`/api/folios/${activeFolio.id}/adjustment-requests`, {
        method: 'POST',
        body: JSON.stringify({
          ...adjustmentForm,
          ...(adjustmentForm.type === 'refund' ? { paymentId: Number(adjustmentForm.paymentId) } : {}),
        }),
      });
      setAdjustmentForm({ type: 'discount', amount: '', reason: '', paymentId: '' });
    }, 'Adjustment request recorded.');
  }

  if (document) {
    return <PrintDocument
      document={document}
      kind={documentKind}
      onClose={() => setDocument(null)}
      onDownloadPdf={downloadPdf}
      onPrint={printDocument}
    />;
  }

  return <div className="finance-page">
    <header className="page-heading">
      <div><p className="eyebrow">HOTEL OPERATIONS</p><h1>Finance</h1><p className="muted">Folios, payments, receipts, cashier shifts and night audit.</p></div>
      <button className="button button-secondary" disabled={busy} onClick={() => refresh().catch((error) => setMessage(error.message))}>Refresh</button>
    </header>
    {message && <p className="form-notice" role="status">{message}</p>}

    <section className="finance-ops-grid">
      <article className="panel finance-panel">
        <header className="finance-panel-heading"><div><h2>Cashier shift</h2><p className="muted">Payments require an open shift.</p></div><span className={`finance-status ${shift ? 'open' : 'closed'}`}>{shift ? 'Open' : 'Closed'}</span></header>
        {shift ? <>
          <div className="finance-summary">
            <span>Opening float <strong><Amount value={shift.openingFloat} /></strong></span>
            <span>Cash collections <strong><Amount value={shift.cashCollections} /></strong></span>
            <span>Expected cash <strong><Amount value={shift.expectedCash} /></strong></span>
          </div>
          {canManageShift && <form className="finance-inline-form" onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await authApi.request(`/api/cashier-shifts/${shift.id}/close`, {
                method: 'POST',
                body: JSON.stringify({ countedCash }),
              });
              setCountedCash('');
            }, 'Cashier shift closed.');
          }}>
            <Field label="Counted cash"><input required type="number" min="0" step="0.01" value={countedCash} onChange={(event) => setCountedCash(event.target.value)} /></Field>
            <button className="button button-primary" disabled={busy}>Close and reconcile</button>
          </form>}
        </> : canManageShift && <form className="finance-inline-form" onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            await authApi.request('/api/cashier-shifts/open', {
              method: 'POST',
              body: JSON.stringify({ openingFloat }),
            });
          }, 'Cashier shift opened.');
        }}>
          <Field label="Opening float"><input required type="number" min="0" step="0.01" value={openingFloat} onChange={(event) => setOpeningFloat(event.target.value)} /></Field>
          <button className="button button-primary" disabled={busy}>Open shift</button>
        </form>}
      </article>

      {canRunAudit && <article className="panel finance-panel">
        <header className="finance-panel-heading"><div><h2>Night audit</h2><p className="muted">Posts room and configured tax charges, then advances the business date.</p></div></header>
        <div className="finance-summary">
          <span>Current business date <strong>{audit?.businessDate ?? '—'}</strong></span>
          <span>Next date <strong>{audit?.nextBusinessDate ?? '—'}</strong></span>
        </div>
        <button className="button button-primary" disabled={busy || !audit?.businessDate} onClick={() => {
          if (window.confirm(`Run night audit for ${audit?.businessDate}?`)) {
            run(async () => {
              const result = await authApi.request('/api/night-audit/run', {
                method: 'POST',
                body: JSON.stringify({ businessDate: audit.businessDate }),
              });
              setMessage(`Night audit posted ${result.postedStays} stay(s), ETB ${result.totalAmount}.`);
            }, 'Night audit completed.');
          }
        }}>Run audit for {audit?.businessDate ?? 'current date'}</button>
        {audit?.runs?.length > 0 && <p className="finance-history-note">Last audit: {audit.runs[0].businessDate} · {audit.runs[0].postedStays} stays · <Amount value={audit.runs[0].totalAmount} /></p>}
      </article>}
    </section>

    <section className="finance-main-grid">
      <article className="panel finance-panel finance-folio-list">
        <header className="finance-panel-heading">
          <div><h2>Guest folios</h2><p className="muted">{folios.length} shown (up to 200)</p></div>
          <select aria-label="Folio status" value={folioStatus} onChange={(event) => setFolioStatus(event.target.value)}>
            <option value="open">Open</option><option value="closed">Closed</option><option value="all">All</option>
          </select>
        </header>
        {folios.length === 0 ? <p className="muted">No folios match this view.</p> : <div className="finance-folio-rows">
          {folios.map((folio) => <button className={`finance-folio-row${activeFolio?.id === folio.id ? ' selected' : ''}`} key={folio.id} onClick={() => loadFolio(folio.id)}>
            <span><strong>{folio.guestName || 'Guest'}</strong><small>{folio.confirmationNo || 'Direct folio'} · Room {folio.roomNumber || '—'}</small></span>
            <span className="finance-status">{folio.status}</span>
            <span><Amount value={folio.balance} /></span>
          </button>)}
        </div>}
      </article>

      <article className="panel finance-panel finance-ledger">
        {!activeFolio ? <div className="finance-empty"><h2>Select a folio</h2><p className="muted">Choose a folio to review its ledger and post activity.</p></div> : <>
          <header className="finance-panel-heading"><div><p className="eyebrow">FOLIO {activeFolio.id}</p><h2>{activeFolio.guestName || 'Guest'}</h2><p className="muted">{activeFolio.confirmationNo ?? 'Direct folio'} · {activeFolio.status}</p></div><strong className="finance-balance"><Amount value={activeFolio.balance} /></strong></header>
          <div className="finance-summary">
            <span>Charges <strong><Amount value={activeFolio.totalCharges} /></strong></span>
            <span>Payments <strong><Amount value={activeFolio.totalPayments} /></strong></span>
            <span>Adjustments <strong><Amount value={activeFolio.totalAdjustments} /></strong></span>
          </div>
          {canPostCharge && activeFolio.status === 'open' && <form className="finance-action-form" onSubmit={submitCharge}>
            <h3>Post a charge</h3>
            <Field label="Category"><select value={chargeForm.type} onChange={(event) => setChargeForm({ ...chargeForm, type: event.target.value })}>
              <option value="service">Service</option><option value="minibar">Minibar</option><option value="laundry">Laundry</option><option value="other">Other</option>
            </select></Field>
            <Field label="Description"><input required value={chargeForm.description} onChange={(event) => setChargeForm({ ...chargeForm, description: event.target.value })} /></Field>
            <Field label="Amount"><input required type="number" min="0.01" step="0.01" value={chargeForm.amount} onChange={(event) => setChargeForm({ ...chargeForm, amount: event.target.value })} /></Field>
            <button className="button button-secondary" disabled={busy}>Post charge</button>
          </form>}
          {canPostCharge && activeFolio.status === 'open' && serviceCatalog.length > 0 && <form className="finance-action-form" onSubmit={submitServiceCharge}>
            <h3>Post catalog service</h3>
            <Field label="Service"><select required value={serviceCharge.serviceId} onChange={(event) => setServiceCharge({ ...serviceCharge, serviceId: event.target.value })}>
              <option value="">Select service</option>{serviceCatalog.map((service) => <option key={service.id} value={service.id}>{service.name} · ETB {service.price}</option>)}
            </select></Field>
            <Field label="Quantity"><input required type="number" min="1" max="1000" step="1" value={serviceCharge.quantity} onChange={(event) => setServiceCharge({ ...serviceCharge, quantity: event.target.value })} /></Field>
            <button className="button button-secondary" disabled={busy}>Post service</button>
          </form>}
          {canTakePayment && activeFolio.status === 'open' && <form className="finance-action-form" onSubmit={submitPayment}>
            <h3>Receive payment</h3>
            <Field label="Method"><select value={paymentForm.method} onChange={(event) => setPaymentForm({ ...paymentForm, method: event.target.value })}>
              <option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="card_manual">Card (manual)</option><option value="mobile_manual">Mobile money (manual)</option><option value="deposit_transfer">Deposit transfer</option>
            </select></Field>
            <Field label="Amount"><input required type="number" min="0.01" step="0.01" value={paymentForm.amount} onChange={(event) => setPaymentForm({ ...paymentForm, amount: event.target.value })} /></Field>
            <Field label="Reference"><input value={paymentForm.reference} onChange={(event) => setPaymentForm({ ...paymentForm, reference: event.target.value })} /></Field>
            <label className="finance-checkbox"><input type="checkbox" checked={paymentForm.isDeposit} onChange={(event) => setPaymentForm({ ...paymentForm, isDeposit: event.target.checked })} /> Record as deposit</label>
            <button className="button button-primary" disabled={busy || !shift}>Receive payment and issue receipt</button>
            {!shift && <small className="finance-help">Open a cashier shift before recording payment.</small>}
          </form>}
          {canAdjust && activeFolio.status === 'open' && <form className="finance-action-form" onSubmit={submitAdjustment}>
            <h3>Request adjustment</h3>
            <Field label="Type"><select value={adjustmentForm.type} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, type: event.target.value })}>
              <option value="discount">Discount</option><option value="correction">Correction</option><option value="write_off">Write-off</option>{canRefund && <option value="refund">Refund</option>}
            </select></Field>
            {adjustmentForm.type === 'refund' && <Field label="Original payment"><select required value={adjustmentForm.paymentId} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, paymentId: event.target.value })}>
              <option value="">Select payment</option>{activeFolio.payments.filter((payment) => Number(payment.amount) > 0).map((payment) => <option key={payment.id} value={payment.id}>{payment.method} · ETB {payment.amount} · {payment.receiptNumber}</option>)}
            </select></Field>}
            <Field label="Amount"><input required type="number" min="0.01" step="0.01" value={adjustmentForm.amount} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, amount: event.target.value })} /></Field>
            <Field label="Reason"><input required value={adjustmentForm.reason} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, reason: event.target.value })} /></Field>
            <button className="button button-secondary" disabled={busy}>Submit for approval</button>
          </form>}
          <div className="finance-timeline">
            <h3>Ledger activity</h3>
            {[...activeFolio.charges.map((entry) => ({ ...entry, kind: 'charge' })),
              ...activeFolio.payments.map((entry) => ({ ...entry, kind: 'payment', description: `${entry.method.replaceAll('_', ' ')}${entry.isDeposit ? ' · deposit' : ''}`, amount: entry.amount, createdAt: entry.createdAt })),
              ...activeFolio.adjustments.map((entry) => ({ ...entry, kind: 'adjustment', description: `${entry.type.replaceAll('_', ' ')} · ${entry.reason}` })),
            ].sort((left, right) => new Date(left.created_at ?? left.createdAt).getTime() - new Date(right.created_at ?? right.createdAt).getTime()).map((entry) => <div className="finance-ledger-row" key={`${entry.kind}-${entry.id}`}>
              <span className={`finance-kind ${entry.kind}`}>{entry.kind}</span><span>{entry.description}</span><strong><Amount value={entry.amount} /></strong>
              {entry.receiptNumber && <button className="text-button" onClick={() => openDocument('receipt', entry.receiptId)}>Receipt {entry.receiptNumber}</button>}
            </div>)}
            {activeFolio.adjustmentRequests.map((entry) => <div className="finance-ledger-row" key={`request-${entry.id}`}>
              <span className="finance-kind adjustment">{entry.status}</span><span>{entry.type} · {entry.reason}</span><strong><Amount value={entry.amount} /></strong>
            </div>)}
            {activeFolio.charges.length + activeFolio.payments.length + activeFolio.adjustments.length === 0 && <p className="muted">No ledger entries yet.</p>}
          </div>
          {(activeFolio.invoices.length > 0 || activeFolio.payments.some((payment) => payment.receiptNumber)) && <div className="finance-doc-links">
            {activeFolio.invoices.map((invoice) => <button className="text-button" key={invoice.id} onClick={() => openDocument('invoice', invoice.id)}>Invoice {invoice.number}</button>)}
            {activeFolio.payments.map((payment) => payment.receiptNumber && <button className="text-button" key={payment.id} onClick={() => openDocument('receipt', payment.receiptId)}>Receipt {payment.receiptNumber}</button>)}
          </div>}
        </>}
      </article>
    </section>

    {canAdjust && <section className="panel finance-panel">
      <header className="finance-panel-heading"><div><h2>Adjustment approval inbox</h2><p className="muted">{pendingAdjustmentIds.size} pending requests</p></div></header>
      {adjustmentRequests.filter((item) => item.status === 'pending').length === 0 ? <p className="muted">No adjustments need review.</p> : adjustmentRequests.filter((item) => item.status === 'pending').map((item) => <div className="finance-approval-row" key={item.id}>
        <div><strong>Folio {item.folioId} · {item.type} · <Amount value={item.amount} /></strong><small>{item.requesterName}: {item.reason}</small></div>
        <button className="button button-primary" disabled={busy} onClick={() => run(async () => {
          await authApi.request(`/api/adjustment-requests/${item.id}/decision`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) });
        }, 'Adjustment approved.')}>Approve</button>
        <button className="button button-secondary" disabled={busy} onClick={() => {
          const reason = window.prompt('Reason for rejecting this request:');
          if (reason) run(async () => {
            await authApi.request(`/api/adjustment-requests/${item.id}/decision`, { method: 'POST', body: JSON.stringify({ action: 'reject', reason }) });
          }, 'Adjustment rejected.');
        }}>Reject</button>
      </div>)}
    </section>}

    {canSeeShiftReports && <section className="panel finance-panel">
      <header className="finance-panel-heading"><div><h2>Recent cashier shifts</h2><p className="muted">Closed reports are immutable.</p></div></header>
      <div className="finance-shifts">
        {shifts.map((item) => <div className="finance-shift-row" key={item.id}>
          <span><strong>{item.cashierName}</strong><small>Shift {item.id} · {item.status} · {new Date(item.openedAt).toLocaleString()}</small></span>
          <span>Cash <strong><Amount value={item.cashCollections} /></strong></span>
          <span>Other <strong><Amount value={item.otherCollections} /></strong></span>
          <span>Variance <strong>{item.variance === null ? '—' : <Amount value={item.variance} />}</strong></span>
        </div>)}
      </div>
    </section>}
  </div>;
}
