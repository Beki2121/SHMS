// Phase 1 responsive hotel dashboard shell.
import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { authApi } from '../auth/api.js';
import { en } from '../i18n/en.js';
import { LoginPage, RoleManagement, UserManagement } from './AuthPages.jsx';
import { getVisibleNavigation, navigation } from './navigation.js';
import { PropertySetup, RoomRack } from './PropertyPages.jsx';
import { GuestManagement } from './GuestPages.jsx';
import { ReservationWorkspace } from './ReservationPages.jsx';
import { FrontDesk } from './StayPages.jsx';
import { FinanceWorkspace } from './FinancePages.jsx';
import { HousekeepingWorkspace } from './HousekeepingPages.jsx';
import { MaintenanceWorkspace } from './MaintenancePages.jsx';
import { StaffWorkspace } from './StaffPages.jsx';
import { OperationsWorkspace } from './OperationsPages.jsx';
import { AutomationWorkspace, NotificationInbox } from './AutomationPages.jsx';
import { DashboardPreview, ReportsWorkspace } from './ReportsPages.jsx';
import { DataExportWorkspace, PlatformConsole, SupportApprovals } from './PlatformPages.jsx';
import '../styles/global.css';

function Overview({ user, propertyId, permissionKeys }) {
  const [health, setHealth] = useState('checking');
  useEffect(() => {
    let active = true;
    fetch('/api/health')
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(({ response, body }) => {
        if (active) setHealth(response.ok && body.data?.database === 'ok' ? 'online' : 'offline');
      })
      .catch(() => active && setHealth('offline'));
    return () => { active = false; };
  }, []);

  const healthText = health === 'online' ? en.healthOnline : health === 'offline' ? en.healthOffline : en.healthChecking;
  const canCreateReservation = permissionKeys.includes('reservations.create');
  return <>
    <header className="page-heading">
      <div><p className="eyebrow">{en.today}</p><h1>{en.goodMorning}, {user.name.split(' ')[0]}</h1><p className="muted">{en.overviewSubtitle}</p></div>
      {canCreateReservation && <Link className="button button-primary" to="/reservations">＋ <span>New reservation</span></Link>}
    </header>
    <DashboardPreview propertyId={propertyId} permissionKeys={permissionKeys}/>
    <div className={`service-banner ${health}`}><span className="service-indicator"/><span>{healthText}</span><span className="service-meta">API · Database</span></div>
  </>;
}

function Placeholder({ title }) { return <section className="panel placeholder"><p className="eyebrow">SMART HOTEL OPERATIONS</p><h1>{title}</h1><p className="muted">This workspace will be implemented in its scheduled project phase.</p></section>; }

function NotificationLink({ propertyId }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = () => authApi.request('/api/notifications?limit=1')
      .then((result) => {
        if (active) {
          setUnreadCount(result.unreadCount);
          setError('');
        }
      })
      .catch((requestError) => active && setError(requestError.message));
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [propertyId]);

  return <span className="notification-wrap">
    <Link className="notification-link" to="/notifications" aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}>
      <span aria-hidden="true">♧</span>
      {unreadCount > 0 && <span className="notification-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}
    </Link>
    {error && <span className="notification-error" role="alert">Notifications unavailable: {error}</span>}
  </span>;
}

export function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [propertyError, setPropertyError] = useState('');
  const [, setSupportVersion] = useState(0);
  const location = useLocation();

  useEffect(() => {
    let active = true;
    authApi.restore()
      .then((restored) => {
        if (active) {
          setSession(restored);
          setSessionError('');
        }
      })
      .catch((error) => {
        authApi.clearAccessToken();
        if (active && error.status !== 401) setSessionError('Could not contact the sign-in service. Please try again.');
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  async function switchProperty(event) {
    const propertyId = Number(event.target.value);
    setPropertyError('');
    try {
      const result = await authApi.switchProperty(propertyId);
      setSession((current) => ({ ...current, activePropertyId: result.activePropertyId }));
    } catch (error) {
      setPropertyError(error.message);
    }
  }

  async function signOut() {
    if (authApi.supportSession()) {
      await authApi.endSupportSession();
      setSupportVersion((version) => version + 1);
    }
    await authApi.logout();
    setSession(null);
  }

  if (loading) return <main className="auth-page"><p className="muted">Checking your session…</p></main>;
  if (!session) return <LoginPage onLogin={setSession} errorMessage={sessionError} />;

  const support = authApi.supportSession();
  const permissionKeys = support?.permissionKeys ?? session.permissionKeys ?? [];
  const modules = support?.modules ?? session.modules ?? [];
  const permissionSet = new Set(permissionKeys);
  const visibleNavigation = getVisibleNavigation(permissionKeys, modules, session.user.role === 'super_admin' && !support)
    .filter(([path]) => !support || !['/admin/data-export', '/admin/support'].includes(path));
  const currentTitle = location.pathname === '/notifications'
    ? 'Notifications'
    : navigation.find(([to]) => to === location.pathname)?.[1] ?? 'SmartHotel';
  const activePropertyId = support?.propertyId ?? session.activePropertyId;
  const activeProperty = support?.property
    ?? session.properties?.find((property) => property.id === activePropertyId);
  const canAccess = (permission) => permissionSet.has(permission);
  const guarded = (permission, element) => canAccess(permission)
    ? element
    : <section className="panel placeholder"><h1>Access denied</h1><p className="muted">Your role does not have permission to view this page.</p></section>;
  const moduleGuarded = (module, element) => (session.user.role === 'super_admin' && !support) || modules.includes(module)
    ? element
    : <section className="panel placeholder"><h1>Module unavailable</h1><p className="muted">This module is not enabled for the organization. Contact your account manager to upgrade.</p></section>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">S</span><span><strong>SmartHotel</strong><small>ETHIOPIA</small></span></div>
      <label className="property-switch" aria-label="Current property">
        <span className="property-avatar">{activeProperty?.name?.slice(0, 1) ?? (support ? 'S' : 'P')}</span>
        {!support && session.properties?.length > 1
          ? <select value={session.activePropertyId ?? ''} onChange={switchProperty}>{session.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select>
          : <span><small>{support ? 'Approved support session' : en.propertyLabel}</small><strong>{activeProperty?.name ?? (support ? `Property #${activePropertyId}` : 'No assigned property')}</strong></span>}
        {!support && session.properties?.length > 1 && <span className="chevron">⌄</span>}
      </label>
      {propertyError && <p className="form-error compact" role="alert">{propertyError}</p>}
      <nav aria-label="Main navigation"><p className="nav-caption">HOTEL OPERATIONS</p>{visibleNavigation.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}><span className="nav-icon">{icon}</span>{label}</NavLink>)}</nav>
      <div className="sidebar-bottom">
        <div className="help-card"><strong>{en.needHelp}</strong><p>Find answers and learn how to get the most out of SmartHotel.</p><a href="#help">{en.documentation} ↗</a></div>
        <div className="user-card"><span className="user-avatar">{session.user.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><span><strong>{session.user.name}</strong><small>{session.user.role.replaceAll('_', ' ')}</small></span><button className="text-button" onClick={signOut}>Sign out</button></div>
      </div>
    </aside>
    <main className="main-content">
      <div className="topbar"><div className="breadcrumb">SmartHotel <span>/</span> <strong>{currentTitle}</strong></div><div className="topbar-actions">
        {support && <button className="button button-secondary" onClick={async () => {
          try { await authApi.endSupportSession(); setSupportVersion((version) => version + 1); }
          catch (error) { setSessionError(error.message); }
        }}>End support access</button>}
        {session.licenseWarning && ['grace', 'read_only', 'invalid', 'cancelled', 'suspended'].includes(session.licenseStatus)
          && <span className="date-label" role="status">{session.licenseWarning}</span>}
        <span className="date-label">{activeProperty?.city ?? ''}</span><NotificationLink propertyId={activePropertyId}/><span className="topbar-divider"/><span className="user-avatar small">{session.user.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span></div></div>
      <div className="page-content"><Routes>
        <Route path="/" element={<Overview
          user={session.user}
          propertyId={activePropertyId}
          permissionKeys={permissionKeys}
        />} />
        <Route path="/front-desk" element={guarded('checkin.perform', moduleGuarded('reservations', <FrontDesk permissionKeys={permissionKeys} />))} />
        <Route path="/reservations" element={guarded('reservations.view', moduleGuarded('reservations', <ReservationWorkspace permissionKeys={permissionKeys} />))} />
        <Route path="/rooms" element={guarded('rooms.manage', moduleGuarded('reservations', <RoomRack propertyId={activePropertyId} />))} />
        <Route path="/housekeeping" element={guarded('housekeeping.view', moduleGuarded('housekeeping', <HousekeepingWorkspace permissionKeys={permissionKeys} propertyId={activePropertyId} />))} />
        <Route path="/maintenance" element={guarded('maintenance.manage', moduleGuarded('maintenance', <MaintenanceWorkspace propertyId={activePropertyId} />))} />
        <Route path="/staff" element={canAccess('staff.manage') || canAccess('staff.self_service')
          ? moduleGuarded('staff', <StaffWorkspace permissionKeys={permissionKeys} propertyId={activePropertyId} />)
          : <section className="panel placeholder"><h1>Access denied</h1><p className="muted">Your role does not have permission to view this page.</p></section>} />
        <Route path="/operations" element={canAccess('expenses.manage') || canAccess('inventory.manage') || canAccess('services.manage')
          ? moduleGuarded('inventory', <OperationsWorkspace permissionKeys={permissionKeys} propertyId={activePropertyId} />)
          : <section className="panel placeholder"><h1>Access denied</h1><p className="muted">Your role does not have permission to view this page.</p></section>} />
        <Route path="/automation" element={guarded('automation.manage', <AutomationWorkspace propertyId={activePropertyId} />)} />
        <Route path="/notifications" element={<NotificationInbox propertyId={activePropertyId} />} />
        <Route path="/guests" element={guarded('guests.view', moduleGuarded('reservations', <GuestManagement permissionKeys={permissionKeys} />))} />
        <Route path="/finance" element={guarded('folio.view', <FinanceWorkspace permissionKeys={permissionKeys} />)} />
        <Route path="/reports" element={guarded('reports.view', moduleGuarded('reports', <ReportsWorkspace
          propertyId={activePropertyId}
          properties={session.properties ?? []}
          permissionKeys={permissionKeys}
        />))} />
        <Route path="/setup" element={guarded('property.manage', <PropertySetup permissionKeys={permissionKeys} />)} />
        <Route path="/admin/users" element={guarded('users.manage', <UserManagement activePropertyId={activePropertyId} />)} />
        <Route path="/admin/roles" element={guarded('roles.manage', <RoleManagement />)} />
        <Route path="/admin/data-export" element={guarded('users.manage', <DataExportWorkspace />)} />
        <Route path="/admin/support" element={guarded('users.manage', <SupportApprovals propertyId={activePropertyId} />)} />
        <Route path="/platform" element={guarded('super_admin.manage', <PlatformConsole />)} />
      </Routes></div>
    </main>
  </div>;
}
