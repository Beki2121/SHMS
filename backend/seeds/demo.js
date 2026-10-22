function dateOffset(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function seed(knex) {
  const property = await knex('properties').where({ name: 'SmartHotel Demo' }).first();
  if (!property) throw new Error('Run the base seed before the demo seed.');
  const rooms = await knex('rooms').where({ property_id: property.id, is_active: true }).orderBy('id');
  const type = await knex('room_types').where({ property_id: property.id }).orderBy('id').first();
  const ratePlan = await knex('rate_plans').where({ property_id: property.id }).first();
  const owner = await knex('users').where({ email: 'owner@smarthotel.local' }).first();
  if (rooms.length < 20 || !type || !ratePlan || !owner) {
    throw new Error('Base seed is incomplete. Run `npm run db:seed` successfully before `npm run db:seed:demo`.');
  }

  for (let index = 0; index < 20; index += 1) {
    const guestEmail = `guest${String(index + 1).padStart(2, '0')}@example.test`;
    let guest = await knex('guests').where({ property_id: property.id, email: guestEmail }).first();
    if (!guest) {
      const [id] = await knex('guests').insert({
        property_id: property.id, organization_id: property.organization_id,
        first_name: ['Aster', 'Dawit', 'Hana', 'Kebede'][index % 4], last_name: `Guest ${index + 1}`,
        phone: `+251911000${String(index).padStart(3, '0')}`, email: guestEmail,
        nationality: 'Ethiopian', preferences: JSON.stringify({}), is_vip: index === 0,
      });
      guest = await knex('guests').where({ id }).first();
    }
    const confirmation = `DEMO-${String(index + 1).padStart(5, '0')}`;
    let reservation = await knex('reservations').where({ property_id: property.id, confirmation_no: confirmation }).first();
    if (reservation) continue;

    const inHouse = index < 5;
    const checkIn = dateOffset(inHouse ? 0 : index - 4);
    const checkOut = dateOffset(inHouse ? 1 : index - 3);
    const room = rooms[index];
    const [reservationId] = await knex('reservations').insert({
      property_id: property.id, confirmation_no: confirmation, primary_guest_id: guest.id,
      source: 'manual', status: inHouse ? 'checked_in' : 'confirmed', check_in_date: checkIn,
      check_out_date: checkOut, adults: 1, children: 0, room_type_id: type.id,
      assigned_room_id: room.id, rate_plan_id: ratePlan.id, total_estimate: type.base_rate,
      created_by: owner?.id ?? null,
    });
    const reservationIdRow = await knex('reservations').where({ id: reservationId }).first();
    for (let d = new Date(`${checkIn}T00:00:00Z`); d < new Date(`${checkOut}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      await knex('room_nights').insert({ room_id: room.id, night: d.toISOString().slice(0, 10), reservation_id: reservationIdRow.id, property_id: property.id });
    }
    if (inHouse) {
      const [stayId] = await knex('stays').insert({ property_id: property.id, reservation_id: reservationIdRow.id, room_id: room.id, checked_in_at: knex.fn.now(), status: 'in_house', key_card_count: 1 });
      const [folioId] = await knex('folios').insert({
        property_id: property.id, stay_id: stayId, guest_id: guest.id, status: 'open', opened_at: knex.fn.now(),
      });
      await knex('folio_charges').insert({
        property_id: property.id,
        folio_id: folioId,
        charge_type: 'room',
        description: 'Demo room-night charge',
        quantity: 1,
        unit_amount: type.base_rate,
        amount: type.base_rate,
        business_date: dateOffset(0),
        posted_by: owner.id,
      });
      await knex('rooms').where({ id: room.id }).update({ status: 'OCCUPIED' });
    }
  }
}
