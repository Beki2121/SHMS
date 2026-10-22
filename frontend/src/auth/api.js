let accessToken = null;
let refreshPromise = null;
let activePropertyId = sessionStorage.getItem('smarthotel.activePropertyId');
let supportState = null;
let priorAccessToken = null;

function selectActiveProperty(propertyId) {
  activePropertyId = propertyId ? Number(propertyId) : null;
  if (activePropertyId) sessionStorage.setItem('smarthotel.activePropertyId', String(activePropertyId));
  else sessionStorage.removeItem('smarthotel.activePropertyId');
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function asError(response, body) {
  return new ApiError(
    response.status,
    body?.error?.code ?? 'REQUEST_FAILED',
    body?.error?.message ?? 'The request could not be completed',
  );
}

async function readResponse(response) {
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw asError(response, body);
  return body.data;
}

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activePropertyId: activePropertyId ? Number(activePropertyId) : null }),
      });
      const data = await readResponse(response);
      accessToken = data.accessToken;
      selectActiveProperty(data.activePropertyId);
      return data;
    })();
  }
  const pending = refreshPromise;
  try {
    return await pending;
  } finally {
    if (refreshPromise === pending) refreshPromise = null;
  }
}

export const authApi = {
  supportSession() {
    return supportState;
  },

  currentPropertyId() {
    return activePropertyId ? Number(activePropertyId) : null;
  },

  enterSupportSession(data) {
    priorAccessToken = accessToken;
    supportState = data;
    accessToken = data.accessToken;
    selectActiveProperty(data.propertyId);
  },

  async endSupportSession() {
    if (!supportState) return;
    try {
      await this.request('/api/platform/support/exit', { method: 'POST', body: '{}' }, false);
    } finally {
      accessToken = priorAccessToken;
      priorAccessToken = null;
      supportState = null;
      selectActiveProperty(null);
    }
  },

  realtimeCredentials() {
    return { token: accessToken, propertyId: activePropertyId ? Number(activePropertyId) : null };
  },

  async login(email, password) {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await readResponse(response);
    accessToken = data.accessToken;
    selectActiveProperty(data.activePropertyId);
    return data;
  },

  async restore() {
    const data = await refreshAccessToken();
    if (!data.permissionKeys) {
      const current = await this.request('/api/auth/me');
      return { ...data, ...current };
    }
    return data;
  },

  async request(path, options = {}, retry = true) {
    const headers = new Headers(options.headers ?? {});
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, credentials: 'include' });
    if (response.status === 401 && retry && !path.endsWith('/refresh') && !supportState) {
      try {
        await refreshAccessToken();
      } catch (error) {
        accessToken = null;
        throw error;
      }
      return this.request(path, options, false);
    }
    return readResponse(response);
  },

  async requestBlob(path, retry = true) {
    const headers = new Headers();
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    const response = await fetch(path, { headers, credentials: 'include' });
    if (response.status === 401 && retry && !supportState) {
      try {
        await refreshAccessToken();
      } catch (error) {
        accessToken = null;
        throw error;
      }
      return this.requestBlob(path, false);
    }
    if (!response.ok) {
      let body = {};
      try {
        body = await response.json();
      } catch {
        throw new ApiError(response.status, 'REQUEST_FAILED', 'The request could not be completed');
      }
      throw asError(response, body);
    }
    return response.blob();
  },

  async switchProperty(propertyId) {
    const data = await this.request('/api/auth/switch-property', {
      method: 'POST',
      body: JSON.stringify({ propertyId }),
    });
    accessToken = data.accessToken;
    selectActiveProperty(data.activePropertyId);
    return data;
  },

  async logout() {
    try {
      await this.request('/api/auth/logout', { method: 'POST', body: '{}' }, false);
    } finally {
      accessToken = null;
      selectActiveProperty(null);
    }
  },

  clearAccessToken() {
    accessToken = null;
    priorAccessToken = null;
    supportState = null;
    selectActiveProperty(null);
  },
};
