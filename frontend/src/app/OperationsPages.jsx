import { useCallback, useEffect, useState } from 'react';
import { authApi } from '../auth/api.js';
import '../styles/operations.css';

function Field({ label, children }) {
  return <label className="operations-field"><span>{label}</span>{children}</label>;
}

function Section({ title, children }) {
  return <section className="panel operations-panel"><header><h2>{title}</h2></header>{children}</section>;
}

function Empty({ children }) {
  return <p className="operations-empty">{children}</p>;
}

function localDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function OperationsWorkspace({ permissionKeys, propertyId }) {
  const canManageExpenses = permissionKeys.includes('expenses.manage');
  const canManageInventory = permissionKeys.includes('inventory.manage');
  const canManageServices = permissionKeys.includes('services.manage');
  const [categories, setCategories] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [inventoryCategories, setInventoryCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [movements, setMovements] = useState([]);
  const [services, setServices] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expenseCategoryName, setExpenseCategoryName] = useState('');
  const [inventoryCategoryName, setInventoryCategoryName] = useState('');
  const [supplierForm, setSupplierForm] = useState({ name: '', contactName: '', email: '', phone: '', address: '' });
  const [expenseForm, setExpenseForm] = useState({
    categoryId: '', supplierId: '', amount: '', expenseDate: localDate(), reference: '', description: '',
  });
  const [itemForm, setItemForm] = useState({ name: '', categoryId: '', unit: '', reorderLevel: '0' });
  const [movementForm, setMovementForm] = useState({
    itemId: '', movementType: 'purchase', quantity: '', unitCost: '', supplierId: '', reference: '', reason: '',
  });
  const [serviceForm, setServiceForm] = useState({ name: '', category: 'service', price: '', taxClass: '' });

  const refresh = useCallback(async () => {
    const tasks = [];
    if (canManageExpenses) {
      tasks.push(
        authApi.request('/api/expenses/categories').then(setCategories),
        authApi.request('/api/expenses').then(setExpenses),
        authApi.request('/api/suppliers').then(setSuppliers),
      );
    }
    if (canManageInventory) {
      tasks.push(
        authApi.request('/api/inventory/categories').then(setInventoryCategories),
        authApi.request('/api/inventory/items').then(setItems),
        authApi.request('/api/inventory/movements').then(setMovements),
      );
    }
    if (canManageServices) tasks.push(authApi.request('/api/services/catalog?includeInactive=true').then(setServices));
    await Promise.all(tasks);
  }, [canManageExpenses, canManageInventory, canManageServices]);

  useEffect(() => {
    setError('');
    refresh().catch((requestError) => setError(requestError.message));
  }, [propertyId, refresh]);

  async function run(action, success) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await action();
      setNotice(success);
      await refresh();
      return result;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function addExpenseCategory(event) {
    event.preventDefault();
    const result = await run(() => authApi.request('/api/expenses/categories', {
      method: 'POST', body: JSON.stringify({ name: expenseCategoryName }),
    }), 'Expense category created.');
    if (result) setExpenseCategoryName('');
  }

  async function addInventoryCategory(event) {
    event.preventDefault();
    const result = await run(() => authApi.request('/api/inventory/categories', {
      method: 'POST', body: JSON.stringify({ name: inventoryCategoryName }),
    }), 'Inventory category created.');
    if (result) setInventoryCategoryName('');
  }

  async function addSupplier(event) {
    event.preventDefault();
    const contact = Object.fromEntries(
      Object.entries({
        contactName: supplierForm.contactName,
        email: supplierForm.email,
        phone: supplierForm.phone,
        address: supplierForm.address,
      }).filter(([, value]) => value.trim()),
    );
    const result = await run(() => authApi.request('/api/suppliers', {
      method: 'POST',
      body: JSON.stringify({ name: supplierForm.name, contact: Object.keys(contact).length ? contact : null }),
    }), 'Supplier saved.');
    if (result) setSupplierForm({ name: '', contactName: '', email: '', phone: '', address: '' });
  }

  async function addExpense(event) {
    event.preventDefault();
    const result = await run(() => authApi.request('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({
        ...expenseForm,
        categoryId: Number(expenseForm.categoryId),
        supplierId: expenseForm.supplierId ? Number(expenseForm.supplierId) : null,
        reference: expenseForm.reference || null,
        description: expenseForm.description || null,
      }),
    }), 'Expense recorded.');
    if (result) setExpenseForm({
      categoryId: expenseForm.categoryId, supplierId: '', amount: '', expenseDate: localDate(), reference: '', description: '',
    });
  }

  async function archiveExpense(id) {
    if (!window.confirm('Archive this expense? It will be hidden from the active expense list.')) return;
    await run(() => authApi.request(`/api/expenses/${id}`, { method: 'DELETE' }), 'Expense archived.');
  }

  async function addItem(event) {
    event.preventDefault();
    const result = await run(() => authApi.request('/api/inventory/items', {
      method: 'POST',
      body: JSON.stringify({
        ...itemForm,
        categoryId: itemForm.categoryId ? Number(itemForm.categoryId) : null,
      }),
    }), 'Inventory item created.');
    if (result) setItemForm({ name: '', categoryId: '', unit: '', reorderLevel: '0' });
  }

  async function addMovement(event) {
    event.preventDefault();
    const payload = {
      movementType: movementForm.movementType,
      quantity: movementForm.quantity,
      reference: movementForm.reference || null,
      ...(movementForm.movementType === 'purchase'
        ? { unitCost: movementForm.unitCost, supplierId: movementForm.supplierId ? Number(movementForm.supplierId) : null }
        : { reason: movementForm.reason }),
    };
    const result = await run(() => authApi.request(`/api/inventory/items/${movementForm.itemId}/movements`, {
      method: 'POST', body: JSON.stringify(payload),
    }), 'Inventory movement recorded.');
    if (result) setMovementForm({ ...movementForm, quantity: '', unitCost: '', reference: '', reason: '' });
  }

  async function archiveItem(id) {
    if (!window.confirm('Archive this item? Stock must be zero and historical movements will remain.')) return;
    await run(() => authApi.request(`/api/inventory/items/${id}/archive`, { method: 'POST' }), 'Inventory item archived.');
  }

  async function addService(event) {
    event.preventDefault();
    const result = await run(() => authApi.request('/api/services/catalog', {
      method: 'POST',
      body: JSON.stringify({ ...serviceForm, taxClass: serviceForm.taxClass || null }),
    }), 'Service added to the catalog.');
    if (result) setServiceForm({ name: '', category: 'service', price: '', taxClass: '' });
  }

  async function archiveService(id) {
    if (!window.confirm('Archive this service? Existing folio charges will remain unchanged.')) return;
    await run(() => authApi.request(`/api/services/catalog/${id}`, { method: 'DELETE' }), 'Service archived.');
  }

  return <main className="operations-page">
    <header className="page-heading">
      <div><p className="eyebrow">PROPERTY OPERATIONS</p><h1>Operations</h1><p className="muted">Expenses, suppliers, stock and additional guest services.</p></div>
      <button className="button button-secondary" disabled={busy} onClick={() => refresh().catch((requestError) => setError(requestError.message))}>Refresh</button>
    </header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="form-notice" role="status">{notice}</p>}

    {canManageExpenses && <>
      <Section title="Expense categories">
        <form className="operations-inline" onSubmit={addExpenseCategory}>
          <Field label="Category name"><input required minLength="2" maxLength="120" value={expenseCategoryName} onChange={(event) => setExpenseCategoryName(event.target.value)} /></Field>
          <button className="button button-primary" disabled={busy}>Add category</button>
        </form>
        <div className="operations-chips">{categories.map((category) => <span key={category.id}>{category.name}</span>)}</div>
      </Section>

      <Section title="Suppliers">
        <form className="operations-grid" onSubmit={addSupplier}>
          <Field label="Supplier name"><input required minLength="2" maxLength="200" value={supplierForm.name} onChange={(event) => setSupplierForm({ ...supplierForm, name: event.target.value })} /></Field>
          <Field label="Contact name"><input maxLength="160" value={supplierForm.contactName} onChange={(event) => setSupplierForm({ ...supplierForm, contactName: event.target.value })} /></Field>
          <Field label="Email"><input type="email" maxLength="190" value={supplierForm.email} onChange={(event) => setSupplierForm({ ...supplierForm, email: event.target.value })} /></Field>
          <Field label="Phone"><input maxLength="40" value={supplierForm.phone} onChange={(event) => setSupplierForm({ ...supplierForm, phone: event.target.value })} /></Field>
          <Field label="Address"><input maxLength="1000" value={supplierForm.address} onChange={(event) => setSupplierForm({ ...supplierForm, address: event.target.value })} /></Field>
          <button className="button button-primary" disabled={busy}>Add supplier</button>
        </form>
        {suppliers.length
          ? <div className="operations-table-wrap"><table className="operations-table"><thead><tr><th>Supplier</th><th>Contact</th><th>Email</th><th>Phone</th></tr></thead><tbody>
            {suppliers.map((supplier) => <tr key={supplier.id}><td>{supplier.name}</td><td>{supplier.contact?.contactName || '—'}</td><td>{supplier.contact?.email || '—'}</td><td>{supplier.contact?.phone || '—'}</td></tr>)}
          </tbody></table></div>
          : <Empty>No suppliers have been added.</Empty>}
      </Section>

      <Section title="Record expense">
        <form className="operations-grid" onSubmit={addExpense}>
          <Field label="Category"><select required value={expenseForm.categoryId} onChange={(event) => setExpenseForm({ ...expenseForm, categoryId: event.target.value })}><option value="">Select category</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field>
          <Field label="Supplier"><select value={expenseForm.supplierId} onChange={(event) => setExpenseForm({ ...expenseForm, supplierId: event.target.value })}><option value="">No supplier</option>{suppliers.map((supplier) => <option value={supplier.id} key={supplier.id}>{supplier.name}</option>)}</select></Field>
          <Field label="Amount (ETB)"><input required type="number" min="0.01" step="0.01" value={expenseForm.amount} onChange={(event) => setExpenseForm({ ...expenseForm, amount: event.target.value })} /></Field>
          <Field label="Date"><input required type="date" value={expenseForm.expenseDate} onChange={(event) => setExpenseForm({ ...expenseForm, expenseDate: event.target.value })} /></Field>
          <Field label="Reference"><input maxLength="120" value={expenseForm.reference} onChange={(event) => setExpenseForm({ ...expenseForm, reference: event.target.value })} /></Field>
          <Field label="Description"><input maxLength="5000" value={expenseForm.description} onChange={(event) => setExpenseForm({ ...expenseForm, description: event.target.value })} /></Field>
          <button className="button button-primary" disabled={busy || !categories.length}>Record expense</button>
        </form>
        {expenses.length
          ? <div className="operations-table-wrap"><table className="operations-table"><thead><tr><th>Date</th><th>Category</th><th>Supplier</th><th>Amount</th><th>Description</th><th /></tr></thead><tbody>
            {expenses.map((expense) => <tr key={expense.id}><td>{expense.expenseDate}</td><td>{expense.categoryName}</td><td>{expense.supplierName || '—'}</td><td>ETB {expense.amount}</td><td>{expense.description || expense.reference || '—'}</td><td><button className="text-button danger" disabled={busy} onClick={() => archiveExpense(expense.id)}>Archive</button></td></tr>)}
          </tbody></table></div>
          : <Empty>No expenses recorded.</Empty>}
      </Section>
    </>}

    {canManageInventory && <>
      <div className="operations-two-column">
        <Section title="Inventory categories">
          <form className="operations-inline" onSubmit={addInventoryCategory}>
            <Field label="Category name"><input required minLength="2" maxLength="120" value={inventoryCategoryName} onChange={(event) => setInventoryCategoryName(event.target.value)} /></Field>
            <button className="button button-primary" disabled={busy}>Add category</button>
          </form>
          <div className="operations-chips">{inventoryCategories.map((category) => <span key={category.id}>{category.name}</span>)}</div>
        </Section>
        <Section title="Add inventory item">
          <form className="operations-grid" onSubmit={addItem}>
            <Field label="Item name"><input required minLength="2" maxLength="160" value={itemForm.name} onChange={(event) => setItemForm({ ...itemForm, name: event.target.value })} /></Field>
            <Field label="Category"><select value={itemForm.categoryId} onChange={(event) => setItemForm({ ...itemForm, categoryId: event.target.value })}><option value="">Uncategorized</option>{inventoryCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
            <Field label="Unit"><input required maxLength="40" placeholder="piece, bottle, kg…" value={itemForm.unit} onChange={(event) => setItemForm({ ...itemForm, unit: event.target.value })} /></Field>
            <Field label="Reorder level"><input required type="number" min="0" step="0.001" value={itemForm.reorderLevel} onChange={(event) => setItemForm({ ...itemForm, reorderLevel: event.target.value })} /></Field>
            <button className="button button-primary" disabled={busy}>Add item</button>
          </form>
        </Section>
      </div>

      <Section title="Record stock movement">
        <form className="operations-grid" onSubmit={addMovement}>
          <Field label="Item"><select required value={movementForm.itemId} onChange={(event) => setMovementForm({ ...movementForm, itemId: event.target.value })}><option value="">Select item</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.quantity} {item.unit}</option>)}</select></Field>
          <Field label="Movement"><select value={movementForm.movementType} onChange={(event) => setMovementForm({ ...movementForm, movementType: event.target.value })}><option value="purchase">Purchase (adds stock)</option><option value="issue">Issue (uses stock)</option><option value="wastage">Wastage (uses stock)</option><option value="adjustment">Adjustment (signed)</option></select></Field>
          <Field label={movementForm.movementType === 'adjustment' ? 'Quantity delta (+/-)' : 'Quantity'}><input required type="number" step="0.001" min={movementForm.movementType === 'adjustment' ? undefined : '0.001'} value={movementForm.quantity} onChange={(event) => setMovementForm({ ...movementForm, quantity: event.target.value })} /></Field>
          {movementForm.movementType === 'purchase' && <>
            <Field label="Unit cost (ETB)"><input required type="number" min="0" step="0.01" value={movementForm.unitCost} onChange={(event) => setMovementForm({ ...movementForm, unitCost: event.target.value })} /></Field>
            <Field label="Supplier"><select value={movementForm.supplierId} onChange={(event) => setMovementForm({ ...movementForm, supplierId: event.target.value })}><option value="">No supplier</option>{suppliers.map((supplier) => <option value={supplier.id} key={supplier.id}>{supplier.name}</option>)}</select></Field>
          </>}
          <Field label="Reference"><input maxLength="120" value={movementForm.reference} onChange={(event) => setMovementForm({ ...movementForm, reference: event.target.value })} /></Field>
          {movementForm.movementType !== 'purchase' && <Field label="Reason"><input required minLength="3" maxLength="1000" value={movementForm.reason} onChange={(event) => setMovementForm({ ...movementForm, reason: event.target.value })} /></Field>}
          <button className="button button-primary" disabled={busy || !items.length}>Record movement</button>
        </form>
      </Section>

      <Section title="Stock on hand">
        {items.length
          ? <div className="operations-table-wrap"><table className="operations-table"><thead><tr><th>Item</th><th>Category</th><th>On hand</th><th>Reorder at</th><th>Status</th><th /></tr></thead><tbody>
            {items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.categoryName || '—'}</td><td>{item.quantity} {item.unit}</td><td>{item.reorderLevel} {item.unit}</td><td><span className={`operations-badge ${item.lowStock ? 'low' : 'ok'}`}>{item.lowStock ? 'Reorder' : 'In stock'}</span></td><td><button className="text-button danger" disabled={busy || Number(item.quantity) !== 0} onClick={() => archiveItem(item.id)}>Archive</button></td></tr>)}
          </tbody></table></div>
          : <Empty>No inventory items yet.</Empty>}
      </Section>

      <Section title="Recent stock movements">
        {movements.length
          ? <div className="operations-table-wrap"><table className="operations-table"><thead><tr><th>Date</th><th>Item</th><th>Type</th><th>Quantity change</th><th>Supplier</th><th>Reason</th></tr></thead><tbody>
            {movements.slice(0, 100).map((movement) => <tr key={movement.id}><td>{movement.createdAt}</td><td>{movement.itemName}</td><td>{movement.movementType}</td><td>{movement.quantity} {movement.unit}</td><td>{movement.supplierName || '—'}</td><td>{movement.reason || movement.reference || '—'}</td></tr>)}
          </tbody></table></div>
          : <Empty>No stock movements recorded.</Empty>}
      </Section>
    </>}

    {canManageServices && <Section title="Additional guest services">
      <form className="operations-grid" onSubmit={addService}>
        <Field label="Service name"><input required minLength="2" maxLength="160" value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} /></Field>
        <Field label="Category"><input required maxLength="80" value={serviceForm.category} onChange={(event) => setServiceForm({ ...serviceForm, category: event.target.value })} /></Field>
        <Field label="Price (ETB)"><input required type="number" min="0" step="0.01" value={serviceForm.price} onChange={(event) => setServiceForm({ ...serviceForm, price: event.target.value })} /></Field>
        <Field label="Tax class"><input maxLength="80" value={serviceForm.taxClass} onChange={(event) => setServiceForm({ ...serviceForm, taxClass: event.target.value })} /></Field>
        <button className="button button-primary" disabled={busy}>Add service</button>
      </form>
      {services.length
        ? <div className="operations-table-wrap"><table className="operations-table"><thead><tr><th>Service</th><th>Category</th><th>Price</th><th>Tax class</th><th>Status</th><th /></tr></thead><tbody>
          {services.map((service) => <tr key={service.id}><td>{service.name}</td><td>{service.category}</td><td>ETB {service.price}</td><td>{service.taxClass || 'Default'}</td><td>{service.isActive ? 'Active' : 'Archived'}</td><td>{service.isActive && <button className="text-button danger" disabled={busy} onClick={() => archiveService(service.id)}>Archive</button>}</td></tr>)}
        </tbody></table></div>
        : <Empty>No additional services in the catalog.</Empty>}
    </Section>}
  </main>;
}
