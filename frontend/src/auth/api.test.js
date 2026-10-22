import { afterEach, describe, expect, it, vi } from 'vitest';
import { authApi } from './api.js';

describe('auth API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    authApi.clearAccessToken();
    sessionStorage.removeItem('smarthotel.activePropertyId');
  });

  it('shares concurrent refresh attempts to avoid rotating a cookie twice', async () => {
    const data = {
      accessToken: 'access-token',
      permissionKeys: [],
      properties: [],
      user: { id: 1, name: 'Test User', role: 'owner_gm' },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ data }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([authApi.restore(), authApi.restore()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([data, data]);
  });

  it('carries the selected property through refresh and page reloads', async () => {
    const response = (data) => ({
      status: 200,
      ok: true,
      json: async () => ({ data }),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ accessToken: 'switched-token', activePropertyId: 7 }))
      .mockResolvedValueOnce(response({
        accessToken: 'refreshed-token',
        activePropertyId: 7,
        permissionKeys: [],
        properties: [{ id: 7 }],
        user: { id: 1, name: 'Test User', role: 'owner_gm' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await authApi.switchProperty(7);
    await authApi.restore();

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ activePropertyId: 7 });
    expect(sessionStorage.getItem('smarthotel.activePropertyId')).toBe('7');
  });

  it('does not replace an expired support token with a refreshed super-admin token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      json: async () => ({ error: { code: 'UNAUTHENTICATED', message: 'Session expired' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    authApi.enterSupportSession({ accessToken: 'support-token', propertyId: 7 });

    await expect(authApi.request('/api/guests')).rejects.toMatchObject({ status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
