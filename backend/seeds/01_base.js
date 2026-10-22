import bcrypt from 'bcrypt';
import { permissionKeys as permissions, rolePermissionMatrix as rolePermissions } from '../src/auth/permissions.js';

async function ensure(knex, table, where, values) {
  const existing = await knex(table).where(where).first();
  if (existing) return existing;
  const [id] = await knex(table).insert(values);
  return knex(table).where({ id }).first();
}

export async function seed(knex) {
  const now = knex.fn.now();
  await ensure(knex, 'packages', { name: 'Essential' }, {
    name: 'Essential', max_rooms: 30, max_users: 15,
    modules: JSON.stringify(['reservations', 'housekeeping', 'reports']), monthly_fee: '0.00',
  });
  await ensure(knex, 'packages', { name: 'Professional' }, {
    name: 'Professional', max_rooms: 150, max_users: 75,
    modules: JSON.stringify(['reservations', 'housekeeping', 'maintenance', 'staff', 'inventory', 'reports']), monthly_fee: '0.00',
  });
  const enterprise = await ensure(knex, 'packages', { name: 'Enterprise' }, {
    name: 'Enterprise', max_rooms: 1000, max_users: 500,
    modules: JSON.stringify(['reservations', 'housekeeping', 'maintenance', 'staff', 'inventory', 'reports']), monthly_fee: '0.00',
  });
  let organization = await ensure(knex, 'organizations', { name: 'Demo Hotel Group' }, {
    name: 'Demo Hotel Group', package_id: enterprise.id, status: 'active', licence_mode: 'local', created_at: now,
  });
  if (Number(organization.package_id) !== Number(enterprise.id)) {
    await knex('organizations').where({ id: organization.id }).update({ package_id: enterprise.id });
    organization = { ...organization, package_id: enterprise.id };
  }
  const property = await ensure(knex, 'properties', { organization_id: organization.id, name: 'SmartHotel Demo' }, {
    organization_id: organization.id, name: 'SmartHotel Demo', address: 'Addis Ababa, Ethiopia', city: 'Addis Ababa',
    timezone: 'Africa/Addis_Ababa', currency: 'ETB', business_date: knex.raw('CURRENT_DATE'),
    check_in_time: '14:00:00', check_out_time: '11:00:00',
    tax_settings: JSON.stringify({ vatPercent: 15, serviceChargePercent: 0, tourismLevyPercent: 0, pricesTaxInclusive: false }), is_active: true,
  });

  const roleRows = {};
  for (const name of Object.keys(rolePermissions)) {
    roleRows[name] = await ensure(knex, 'roles', { organization_id: name === 'super_admin' ? null : organization.id, name }, {
      organization_id: name === 'super_admin' ? null : organization.id, name, is_system: true,
    });
  }
  const permissionRows = {};
  for (const key of permissions) {
    permissionRows[key] = await ensure(knex, 'permissions', { key }, { key, description: key.replaceAll('.', ' ') });
  }
  for (const [roleName, keys] of Object.entries(rolePermissions)) {
    for (const key of keys) {
      const row = { role_id: roleRows[roleName].id, permission_key: key };
      if (!(await knex('role_permissions').where(row).first())) await knex('role_permissions').insert(row);
    }
  }

  const passwordHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!', 12);
  const emails = {
    owner_gm: 'owner@smarthotel.local', front_desk: 'frontdesk@smarthotel.local',
    cashier_accountant: 'cashier@smarthotel.local', housekeeping_supervisor: 'hk.supervisor@smarthotel.local',
    housekeeping_staff: 'housekeeper@smarthotel.local', maintenance_staff: 'maintenance@smarthotel.local',
    hr_manager: 'hr@smarthotel.local', system_admin: 'admin@smarthotel.local', auditor: 'auditor@smarthotel.local',
    super_admin: 'superadmin@smarthotel.local',
  };
  for (const [roleName, email] of Object.entries(emails)) {
    const user = await ensure(knex, 'users', { email }, {
      organization_id: roleName === 'super_admin' ? null : organization.id,
      name: roleName.replaceAll('_', ' '), email, password_hash: passwordHash,
      role_id: roleRows[roleName].id, is_active: true,
    });
    if (roleName !== 'super_admin' && !(await knex('user_properties').where({ user_id: user.id, property_id: property.id }).first())) {
      await knex('user_properties').insert({ user_id: user.id, property_id: property.id });
    }
  }

  const building = await ensure(knex, 'buildings', { property_id: property.id, name: 'Main Building' }, { property_id: property.id, name: 'Main Building' });
  const floors = [];
  for (let floorNo = 1; floorNo <= 3; floorNo += 1) {
    floors.push(await ensure(knex, 'floors', { property_id: property.id, building_id: building.id, floor_number: floorNo }, {
      property_id: property.id, building_id: building.id, floor_number: floorNo, name: `Floor ${floorNo}`,
    }));
  }
  const typeSpecs = [
    ['Standard', 'Comfortable standard room', 2, 1, '2500.00'],
    ['Deluxe', 'Spacious deluxe room', 2, 2, '4000.00'],
    ['Suite', 'Suite with separate sitting area', 3, 2, '6500.00'],
  ];
  const roomTypes = [];
  for (const [name, description, maxAdults, maxChildren, baseRate] of typeSpecs) {
    roomTypes.push(await ensure(knex, 'room_types', { property_id: property.id, name }, {
      property_id: property.id, name, description, max_adults: maxAdults, max_children: maxChildren, base_rate: baseRate, is_active: true,
    }));
  }
  for (let n = 1; n <= 20; n += 1) {
    const floorIndex = Math.floor((n - 1) / 7);
    const type = n <= 12 ? roomTypes[0] : n <= 18 ? roomTypes[1] : roomTypes[2];
    const room = await ensure(knex, 'rooms', { property_id: property.id, room_number: String(100 + n) }, {
      property_id: property.id, room_type_id: type.id, floor_id: floors[Math.min(floorIndex, 2)].id,
      room_number: String(100 + n), status: 'CLEAN', housekeeping_priority: 0, is_active: true,
    });
    if (room.status === 'AVAILABLE_CLEAN') {
      await knex('rooms').where({ id: room.id }).update({ status: 'CLEAN' });
    }
  }
  const plan = await ensure(knex, 'rate_plans', { property_id: property.id, name: 'Standard Flexible' }, {
    property_id: property.id, name: 'Standard Flexible', meal_plan: 'room_only', is_active: true,
  });
  for (const type of roomTypes) {
    if (!(await knex('rates').where({ property_id: property.id, room_type_id: type.id, rate_plan_id: plan.id }).first())) {
      await knex('rates').insert({ property_id: property.id, room_type_id: type.id, rate_plan_id: plan.id, date_from: '2020-01-01', date_to: '2099-12-31', weekday_mask: 127, amount: type.base_rate, min_stay: 1 });
    }
  }
  const categoryNames = ['Utilities', 'Supplies', 'Maintenance', 'Transport', 'Other'];
  for (const name of categoryNames) await ensure(knex, 'expense_categories', { property_id: property.id, name }, { property_id: property.id, name, is_active: true });
  const services = [['Laundry', 'laundry', '350.00'], ['Minibar water', 'minibar', '80.00'], ['Minibar soft drink', 'minibar', '180.00']];
  for (const [name, category, price] of services) await ensure(knex, 'service_catalog', { property_id: property.id, name }, { property_id: property.id, name, category, price, is_active: true });
  const automation = ['checkout_housekeeping', 'arrival_reminder', 'departure_reminder', 'overdue_tasks', 'blocking_ticket', 'outstanding_balance', 'unusual_adjustment', 'no_show_candidates', 'low_stock'];
  for (const key of automation) await ensure(knex, 'automation_rules', { property_id: property.id, key }, { property_id: property.id, key, enabled: true, config: JSON.stringify({}) });

  const checklist = await ensure(knex, 'housekeeping_checklists', { property_id: property.id, name: 'Default Room Turnover' }, { property_id: property.id, name: 'Default Room Turnover', room_type_id: null, is_active: true });
  for (const [sort_order, label] of ['Replace linen and towels', 'Clean bathroom', 'Clean surfaces', 'Restock amenities', 'Inspect room'].entries()) {
    await ensure(knex, 'housekeeping_checklist_items', { checklist_id: checklist.id, sort_order }, { property_id: property.id, checklist_id: checklist.id, sort_order, label, is_required: true });
  }
}
