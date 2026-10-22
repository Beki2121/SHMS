import { afterAll, describe, expect, it } from 'vitest';
import knexFactory from 'knex';
import configs from '../knexfile.js';

const knex = knexFactory(configs.test);

describe('database uniqueness constraints', () => {
  afterAll(async () => knex.destroy());

  it('enforces unique room numbers within a property', async () => {
    const room = await knex('rooms').first();
    expect(room).toBeTruthy();
    const duplicate = {
      property_id: room.property_id,
      room_type_id: room.room_type_id,
      floor_id: room.floor_id,
      room_number: room.room_number,
      status: 'AVAILABLE_CLEAN',
      is_active: true,
    };
    await expect(knex('rooms').insert(duplicate)).rejects.toThrow();
  });

  it('enforces a single reservation per room and night', async () => {
    const room = await knex('rooms').first();
    const reservation = await knex('reservations').first();
    expect(room).toBeTruthy();
    expect(reservation).toBeTruthy();
    const existing = await knex('room_nights').where({ room_id: room.id }).first();
    const row = {
      room_id: room.id,
      night: existing?.night ?? '2099-01-01',
      reservation_id: reservation.id,
      property_id: room.property_id,
    };
    if (!existing) await knex('room_nights').insert(row);
    await expect(knex('room_nights').insert(row)).rejects.toThrow();
    if (!existing) await knex('room_nights').where(row).del();
  });
});
