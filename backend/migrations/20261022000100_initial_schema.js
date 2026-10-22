const definitions = [
  ['packages', { name: 'string:100', max_rooms: 'int', max_users: 'int', modules: 'json', monthly_fee: 'money' }],
  ['organizations', { name: 'string:200', package_id: 'int?', status: 'enum:active|suspended', licence_mode: 'enum:cloud|local' }],
  ['properties', { organization_id: 'int', name: 'string:200', address: 'text?', city: 'string:120?', phone: 'string:40?', email: 'string:190?', timezone: 'string:80', currency: 'string:3', business_date: 'date?', check_in_time: 'time?', check_out_time: 'time?', tax_settings: 'json?', is_active: 'bool' }],
  ['roles', { organization_id: 'int?', name: 'string:80', is_system: 'bool' }],
  ['permissions', { key: 'string:120', description: 'string:255' }],
  ['users', { organization_id: 'int?', name: 'string:200', email: 'string:190', phone: 'string:40?', password_hash: 'string:255', role_id: 'int?', is_active: 'bool', last_login_at: 'datetime?', mfa_ready: 'bool' }],
  ['user_properties', { user_id: 'int', property_id: 'int' }],
  ['role_permissions', { role_id: 'int', permission_key: 'string:120' }],
  ['licences', { organization_id: 'int', key: 'string:190', payload: 'json', signature: 'text', valid_until: 'datetime?' }],
  ['refresh_tokens', { user_id: 'int', token_hash: 'string:255', expires_at: 'datetime', revoked_at: 'datetime?', replaced_by_id: 'int?' }],
  ['audit_log', { organization_id: 'int?', property_id: 'int?', actor_id: 'int?', action: 'string:100', entity: 'string:100', entity_id: 'string:80?', before: 'json?', after: 'json?', ip: 'string:45?' }, { appendOnly: true }],
  ['system_settings', { organization_id: 'int?', property_id: 'int?', setting_key: 'string:120', setting_value: 'json?' }],

  ['buildings', { property_id: 'int', name: 'string:120' }],
  ['floors', { property_id: 'int', building_id: 'int?', name: 'string:80', floor_number: 'int?' }],
  ['room_types', { property_id: 'int', name: 'string:120', description: 'text?', max_adults: 'int', max_children: 'int', base_rate: 'money', is_active: 'bool', deleted_at: 'datetime?' }],
  ['rooms', { property_id: 'int', room_type_id: 'int', floor_id: 'int?', room_number: 'string:30', status: 'enum:AVAILABLE_CLEAN|OCCUPIED|AWAITING_CLEANING|BEING_CLEANED|AWAITING_INSPECTION|CLEAN|BLOCKED_MAINTENANCE', housekeeping_priority: 'int', is_active: 'bool', deleted_at: 'datetime?' }],
  ['room_status_history', { property_id: 'int', room_id: 'int', from_status: 'string:40?', to_status: 'string:40', reason: 'string:255?', changed_by: 'int?', changed_at: 'datetime' }, { appendOnly: true }],
  ['rate_plans', { property_id: 'int', name: 'string:120', meal_plan: 'string:50?', is_active: 'bool', deleted_at: 'datetime?' }],
  ['rates', { property_id: 'int', room_type_id: 'int', rate_plan_id: 'int', date_from: 'date', date_to: 'date', weekday_mask: 'int?', amount: 'money', min_stay: 'int', reason: 'string:255?' }],
  ['amenities', { property_id: 'int', name: 'string:120' }],
  ['room_amenities', { property_id: 'int', room_id: 'int', amenity_id: 'int' }],

  ['guests', { organization_id: 'int?', property_id: 'int', first_name: 'string:120', last_name: 'string:120', phone: 'string:40?', email: 'string:190?', nationality: 'string:80?', id_type: 'string:40?', id_number_enc: 'text?', id_number_hash: 'string:128?', date_of_birth: 'date?', notes: 'text?', preferences: 'json?', is_vip: 'bool', anonymised_at: 'datetime?', deleted_at: 'datetime?' }],
  ['companies', { property_id: 'int', name: 'string:200', tin: 'string:80?', contact: 'json?', credit_terms: 'text?', deleted_at: 'datetime?' }],
  ['groups', { property_id: 'int', name: 'string:160', leader_guest_id: 'int?', notes: 'text?' }],
  ['reservations', { property_id: 'int', confirmation_no: 'string:40', primary_guest_id: 'int?', company_id: 'int?', group_id: 'int?', source: 'enum:walk_in|phone|manual', status: 'enum:tentative|confirmed|checked_in|checked_out|cancelled|no_show', check_in_date: 'date', check_out_date: 'date', adults: 'int', children: 'int', room_type_id: 'int', assigned_room_id: 'int?', rate_plan_id: 'int?', total_estimate: 'money', special_requests: 'text?', created_by: 'int?' }],
  ['reservation_rooms', { property_id: 'int', reservation_id: 'int', room_type_id: 'int', room_id: 'int?', adults: 'int', children: 'int', nightly_rate: 'money?' }],
  ['reservation_guests', { property_id: 'int', reservation_id: 'int', guest_id: 'int', is_primary: 'bool' }],
  ['room_nights', { property_id: 'int', room_id: 'int', night: 'date', reservation_id: 'int' }, { unique: [['room_id', 'night']], indexes: [['property_id', 'night']] }],
  ['stays', { property_id: 'int', reservation_id: 'int', room_id: 'int', checked_in_at: 'datetime', checked_out_at: 'datetime?', status: 'enum:in_house|checked_out', key_card_count: 'int' }],
  ['room_moves', { property_id: 'int', stay_id: 'int', from_room_id: 'int', to_room_id: 'int', reason: 'string:255', approved_by: 'int?', moved_at: 'datetime' }, { appendOnly: true }],

  ['cashier_shifts', { property_id: 'int', cashier_id: 'int', opened_at: 'datetime', closed_at: 'datetime?', opening_float: 'money', expected_cash: 'money?', counted_cash: 'money?', variance: 'money?', status: 'enum:open|closed', notes: 'text?' }],
  ['folios', { property_id: 'int', stay_id: 'int?', guest_id: 'int?', company_id: 'int?', status: 'enum:open|closed', opened_at: 'datetime', closed_at: 'datetime?' }],
  ['folio_charges', { property_id: 'int', folio_id: 'int', charge_type: 'enum:room|service|minibar|laundry|tax|service_charge|levy|other', description: 'string:255', quantity: 'decimal', unit_amount: 'money', amount: 'money', business_date: 'date', reverses_charge_id: 'int?', posted_by: 'int?' }, { appendOnly: true }],
  ['folio_payments', { property_id: 'int', folio_id: 'int', method: 'enum:cash|bank_transfer|card_manual|mobile_manual|deposit_transfer', amount: 'money', reference: 'string:190?', shift_id: 'int?', is_deposit: 'bool', reverses_payment_id: 'int?', received_by: 'int?' }, { appendOnly: true }],
  ['adjustments', { property_id: 'int', folio_id: 'int', type: 'enum:discount|correction|refund|write_off', amount: 'money', reason: 'text', requested_by: 'int', approved_by: 'int?', status: 'enum:pending|approved|rejected', created_at: 'datetime' }, { appendOnly: true }],
  ['invoices', { property_id: 'int', folio_id: 'int', number: 'string:40', issued_at: 'datetime', totals: 'json', pdf_path: 'string:500?' }, { appendOnly: true, unique: [['property_id', 'number']] }],
  ['receipts', { property_id: 'int', payment_id: 'int', number: 'string:40', issued_at: 'datetime' }, { appendOnly: true, unique: [['property_id', 'number']] }],
  ['number_counters', { property_id: 'int', kind: 'string:40', next_value: 'int' }, { unique: [['property_id', 'kind']] }],
  ['expense_categories', { property_id: 'int', name: 'string:120', is_active: 'bool' }],
  ['suppliers', { property_id: 'int', name: 'string:200', contact: 'json?', deleted_at: 'datetime?' }],
  ['expenses', { property_id: 'int', category_id: 'int', supplier_id: 'int?', amount: 'money', expense_date: 'date', reference: 'string:120?', description: 'text?', attachment_path: 'string:500?', logged_by: 'int?', deleted_at: 'datetime?' }],

  ['departments', { property_id: 'int', name: 'string:120', deleted_at: 'datetime?' }],
  ['employees', { property_id: 'int', user_id: 'int?', full_name: 'string:200', department_id: 'int?', job_title: 'string:120?', employment_status: 'string:40', hire_date: 'date?', phone: 'string:40?', deleted_at: 'datetime?' }],
  ['shifts', { property_id: 'int', name: 'string:100', start_time: 'time', end_time: 'time' }],
  ['shift_assignments', { property_id: 'int', employee_id: 'int', shift_id: 'int', date: 'date' }],
  ['attendance', { property_id: 'int', employee_id: 'int', date: 'date', clock_in: 'datetime?', clock_out: 'datetime?', overtime_minutes: 'int', source: 'string:40' }],
  ['leave_requests', { property_id: 'int', employee_id: 'int', type: 'string:60', date_from: 'date', date_to: 'date', status: 'string:40', approved_by: 'int?' }],
  ['handover_notes', { property_id: 'int', department_id: 'int', author_id: 'int', body: 'text' }, { appendOnly: true }],
  ['housekeeping_checklists', { property_id: 'int', room_type_id: 'int?', name: 'string:120', is_active: 'bool' }],
  ['housekeeping_tasks', { property_id: 'int', room_id: 'int', type: 'enum:checkout_clean|daily_clean|deep_clean|inspection|turndown', priority: 'int', status: 'enum:pending|assigned|in_progress|awaiting_inspection|approved|rejected', assigned_to: 'int?', due_at: 'datetime?', started_at: 'datetime?', completed_at: 'datetime?', inspected_by: 'int?', inspected_at: 'datetime?', source_rule: 'string:120?' }],
  ['housekeeping_checklist_items', { property_id: 'int', checklist_id: 'int', label: 'string:255', sort_order: 'int', is_required: 'bool' }],
  ['task_checklist_items', { property_id: 'int', task_id: 'int', checklist_id: 'int?', label: 'string:255', is_complete: 'bool', completed_by: 'int?', completed_at: 'datetime?' }],
  ['assets', { property_id: 'int', room_id: 'int?', name: 'string:160', asset_tag: 'string:100?', category: 'string:100?', status: 'string:40', deleted_at: 'datetime?' }],
  ['maintenance_tickets', { property_id: 'int', room_id: 'int?', asset_id: 'int?', category: 'string:100', priority: 'string:40', description: 'text', status: 'enum:open|assigned|in_progress|resolved|closed', blocks_room: 'bool', assigned_to: 'int?', reported_by: 'int?', resolution_notes: 'text?', opened_at: 'datetime', resolved_at: 'datetime?', cleared_by: 'int?', cleared_at: 'datetime?' }],
  ['inventory_categories', { property_id: 'int', name: 'string:120', is_active: 'bool' }],
  ['inventory_items', { property_id: 'int', category_id: 'int?', name: 'string:160', unit: 'string:40', quantity: 'decimal', reorder_level: 'decimal', deleted_at: 'datetime?' }],
  ['inventory_movements', { property_id: 'int', item_id: 'int', movement_type: 'enum:purchase|issue|adjustment|wastage', quantity: 'decimal', unit_cost: 'money?', supplier_id: 'int?', reference: 'string:120?', reason: 'text?', moved_by: 'int?' }, { appendOnly: true }],
  ['service_catalog', { property_id: 'int', name: 'string:160', price: 'money', category: 'string:80', tax_class: 'string:80?', is_active: 'bool', deleted_at: 'datetime?' }],
  ['guest_requests', { property_id: 'int', stay_id: 'int', type: 'string:80', description: 'text', status: 'string:40', assigned_department_id: 'int?' }],
  ['notifications', { property_id: 'int', user_id: 'int?', role: 'string:80?', type: 'string:100', payload: 'json', read_at: 'datetime?' }],
  ['automation_rules', { property_id: 'int', key: 'string:100', enabled: 'bool', config: 'json?' }],
  ['automation_log', { property_id: 'int', rule_key: 'string:100', entity: 'string:100', entity_id: 'string:80', result: 'json?' }, { appendOnly: true }],
];

const tableNames = new Set(definitions.map(([name]) => name));
const aliases = {
  property: 'properties', company: 'companies', category: null, group: 'groups', person: null,
  actor: 'users', changed_by: 'users', created_by: 'users', posted_by: 'users', received_by: 'users',
  requested_by: 'users', approved_by: 'users', logged_by: 'users', reported_by: 'users', cleared_by: 'users',
  inspected_by: 'users', completed_by: 'users', moved_by: 'users', author: 'users', assigned_to: 'users',
  leader_guest: 'guests', replaced_by: 'refresh_tokens', reverses_charge: 'folio_charges',
  reverses_payment: 'folio_payments', from_room: 'rooms', to_room: 'rooms',
};

function targetFor(column) {
  if (Object.hasOwn(aliases, column)) return aliases[column];
  if (!column.endsWith('_id')) return null;
  const stem = column.slice(0, -3);
  if (Object.hasOwn(aliases, stem)) return aliases[stem];
  const plural = `${stem}s`;
  return tableNames.has(plural) ? plural : (tableNames.has(stem) ? stem : null);
}

function addColumn(table, owner, name, rawType) {
  const nullable = rawType.endsWith('?');
  const type = nullable ? rawType.slice(0, -1) : rawType;
  const [kind, size] = type.split(':');
  let column;
  if (kind === 'int') column = table.integer(name).unsigned();
  else if (kind === 'bool') column = table.boolean(name).defaultTo(false);
  else if (kind === 'money') column = table.decimal(name, 12, 2).defaultTo(0);
  else if (kind === 'decimal') column = table.decimal(name, 12, 3).defaultTo(0);
  else if (kind === 'json') column = table.json(name);
  else if (kind === 'text') column = table.text(name);
  else if (kind === 'date') column = table.date(name);
  else if (kind === 'datetime') column = table.dateTime(name);
  else if (kind === 'time') column = table.time(name);
  else if (kind === 'enum') column = table.enu(name, size.split('|'), { useNative: true });
  else column = table.string(name, size ? Number(size) : 255);
  if (nullable) column.nullable();
  else column.notNullable();
  let target = targetFor(name);
  if (name === 'shift_id' && owner === 'folio_payments') target = 'cashier_shifts';
  if (name === 'category_id' && owner === 'expenses') target = 'expense_categories';
  if (name === 'category_id' && owner === 'inventory_items') target = 'inventory_categories';
  if (target && tableNames.has(target)) table.foreign(name).references('id').inTable(target).onDelete('RESTRICT');
  return column;
}

export async function up(knex) {
  for (const [name, fields, options = {}] of definitions) {
    await knex.schema.createTable(name, (table) => {
      table.increments('id').unsigned().primary();
      if (!['packages', 'permissions', 'roles', 'role_permissions', 'users', 'licences', 'refresh_tokens', 'audit_log', 'system_settings', 'organizations', 'properties'].includes(name) && !Object.hasOwn(fields, 'property_id')) {
        addColumn(table, name, 'property_id', 'int');
      }
      for (const [columnName, rawType] of Object.entries(fields)) addColumn(table, name, columnName, rawType);
      if (!Object.hasOwn(fields, 'created_at')) table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      if (!options.appendOnly) table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      if (options.unique) for (const columns of options.unique) table.unique(columns);
      if (options.indexes) for (const columns of options.indexes) table.index(columns);
      if (Object.hasOwn(fields, 'property_id')) table.index(['property_id']);
      if (name === 'users') table.unique(['email']);
      if (name === 'permissions') table.unique(['key']);
      if (name === 'rooms') table.unique(['property_id', 'room_number']);
      if (name === 'reservations') {
        table.unique(['confirmation_no']);
        table.index(['property_id', 'check_in_date', 'status']);
        table.index(['property_id', 'check_out_date', 'status']);
      }
      if (name === 'rates') table.index(['property_id', 'room_type_id', 'date_from', 'date_to']);
      if (name === 'housekeeping_checklists') table.index(['property_id', 'room_type_id']);
      if (name === 'housekeeping_tasks') table.index(['property_id', 'status', 'due_at']);
      if (name === 'maintenance_tickets') table.index(['property_id', 'status', 'blocks_room']);
      if (name === 'folios') table.index(['property_id', 'status']);
      if (name === 'folio_charges') table.index(['property_id', 'business_date']);
    });
  }
}

export async function down(knex) {
  for (const [name] of [...definitions].reverse()) await knex.schema.dropTableIfExists(name);
}
