// Health endpoint response and database outage behavior.
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('GET /api/health', () => {
  it('reports database connectivity in the standard response envelope', async () => {
    const db = { query: vi.fn().mockResolvedValue([[{ ok: 1 }]]) };
    const response = await request(createApp({ db })).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: 'ok', database: 'ok' } });
  });

  it('returns degraded status when the database is unavailable', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('offline')) };
    const response = await request(createApp({ db })).get('/api/health');
    expect(response.status).toBe(503);
    expect(response.body.data.database).toBe('unavailable');
  });
});
