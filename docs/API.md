# API

## Phase 1 endpoints

### `GET /api/health`
- **Permission:** public operational health endpoint.
- **Request:** no body.
- **Success (200):** `{ "data": { "status": "ok", "database": "ok" } }`.
- **Database unavailable (503):** `{ "data": { "status": "degraded", "database": "unavailable" } }`.
- **Purpose:** used by the web shell and deployment probes. Does not expose connection credentials or server details.

## Phase 3 authentication and access control

All authenticated endpoints use `Authorization: Bearer <access-token>`. Access tokens expire after 15 minutes. Login and refresh set an HttpOnly, SameSite=Strict refresh cookie scoped to `/api/auth`; clients should not store refresh tokens in JavaScript-accessible storage. The API accepts a refresh token in a JSON body for non-browser clients.

### `POST /api/auth/login`
- **Request:** `{ "email": "staff@example.com", "password": "..." }`.
- **Success (200):** access token, user profile, assigned properties, current property, and permission keys; sets the refresh cookie.
- **Failures:** `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS`, or `423 ACCOUNT_LOCKED` after five failed attempts.

### `POST /api/auth/refresh`
- Rotates the refresh token and returns a new access token and session profile.
- A previously rotated token revokes its entire token family and returns `401 REFRESH_REUSE_DETECTED`.

### `POST /api/auth/logout`
- Revokes the presented refresh token and clears the refresh cookie. Returns `204`.

### `GET /api/auth/me`
- **Permission:** authenticated.
- Returns user profile, role, permission keys, assigned properties, and active property.

### `POST /api/auth/switch-property`
- **Request:** `{ "propertyId": 12 }`.
- Issues a new access token only when the property is assigned to the authenticated user and belongs to the user's organization. A body-supplied property never changes an ordinary request's scope.

### `POST /api/auth/change-password`
- **Request:** `{ "currentPassword": "...", "newPassword": "at-least-12-characters" }`.
- Verifies the current password, changes the password, revokes all refresh sessions, and writes an audit entry.

### User and role administration

These endpoints require an active property from the token; the current property is validated against `user_properties` on each request. Request-supplied `propertyId` values do not affect data scope.

| Method | Endpoint | Permission |
|---|---|---|
| `GET` | `/api/auth/admin/users` | `users.manage` |
| `POST` | `/api/auth/admin/users` | `users.manage` |
| `GET` | `/api/auth/admin/assignable-roles` | `users.manage` |
| `POST` | `/api/auth/admin/users/:id/password` | `users.manage` |
| `GET` | `/api/auth/admin/roles` | `roles.manage` |
| `PUT` | `/api/auth/admin/roles/:id/permissions` | `roles.manage` |

User creation can only assign organization roles and properties assigned to the acting user. Role permission changes cannot grant the platform-only `super_admin.manage` permission. User and role updates write before/after snapshots to the append-only `audit_log`.

## Phase 4 property configuration

Every configuration endpoint below requires a valid access token and an active property assigned to the user. `propertyId` values in query strings or request bodies are ignored for scoping.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` / `PUT` | `/api/property` | `property.manage` | Read/update property details, check-in/out times and tax settings |
| `GET` / `POST` | `/api/property/buildings` | `rooms.manage` | List/create buildings |
| `GET` / `POST` | `/api/property/floors` | `rooms.manage` | List/create floors under a property building |
| `GET` / `POST` / `PUT` | `/api/property/room-types` | `rooms.manage` | List/create/update room types and amenities |
| `GET` | `/api/property/rooms` | `rooms.manage` | Room rack inventory including floor, type, active flag and status |
| `POST` | `/api/property/rooms/bulk` | `rooms.manage` | Create up to 100 rooms from a range with optional prefix, suffix and number padding |
| `PATCH` | `/api/property/rooms/:id/active` | `rooms.manage` | Soft-deactivate/reactivate a room; active/future reservations prevent deactivation |
| `GET` | `/api/property/rate-plans` | `rates.view` | List rate plans for booking quotes |
| `POST` | `/api/property/rate-plans` | `rates.edit` | Create rate plans |
| `GET` / `POST` | `/api/property/rates` | `rates.edit` | List/create dated pricing rules |
| `PUT` | `/api/property/rates/:id` | `rates.edit` | Update a dated pricing rule |
| `POST` | `/api/property/rates/quote` | `rates.view` | Return per-night and total quote with tax breakdown |

`PUT /api/property` requires `name`, nullable `address`, `city`, `phone`, `email`, timezone, three-letter currency, `checkInTime`, `checkOutTime` (`HH:mm`), and `taxSettings` (`vatPercent`, `serviceChargePercent`, `tourismLevyPercent`, `pricesTaxInclusive`). The business date is read-only here and will be advanced by night audit in Phase 8.

Rate rules require `roomTypeId`, `ratePlanId`, inclusive `dateFrom`/`dateTo`, `weekdayMask` (Sunday bit 0 through Saturday bit 6), amount, `minStay`, and a non-empty reason. A rate starting later takes precedence; ties use newest `created_at`, then highest ID. Past-dated rates require `rates.override_past`; default `owner_gm` and `system_admin` roles have this permission. Rate writes and property/room configuration changes are audited.

Quote inputs are `{ "roomTypeId", "ratePlanId", "checkIn", "checkOut", "adults", "children" }`. The result includes per-night rate, VAT, service charge, tourism levy and total, plus totals for the stay. Amounts are returned as decimal strings, rounded to cents per night. Inclusive pricing derives the base and taxes from the entered gross price; exclusive pricing adds taxes to the base rate. Stays must be 1–365 nights and meet the largest matched minimum-stay requirement.

## Phase 5 guest records and privacy

Guest APIs require an authenticated user assigned to the active property. Property scope comes from the validated access token, never from a query or body parameter. Search/profile/company/group/request reads require `guests.view`; guest, company and group changes, export, anonymisation, merge, and retention settings require `guests.manage`. Service-request writes require `guest_requests.manage`. Full ID-number reveal requires the separate `guest.view_id` permission (granted by default to owner/GM and system-admin roles only).

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` / `POST` | `/api/guests` | `guests.view` / `guests.manage` | Search by name, phone, email, or ID last four; create guest |
| `GET` / `PUT` | `/api/guests/:id` | `guests.view` / `guests.manage` | Guest profile, request and reservation history; update guest |
| `POST` | `/api/guests/:id/reveal-id` | `guest.view_id` | Decrypt and return the identity number; every reveal is audited |
| `POST` | `/api/guests/:id/export` | `guests.manage` | Export profile and reservations; full ID included only with `guest.view_id`; export is audited |
| `POST` | `/api/guests/:id/anonymize` | `guests.manage` | Replace/remove PII while retaining guest/reservation/folio relationships; requires a reason |
| `POST` | `/api/guests/:id/merge` | `guests.manage` | Re-link reservations, folios, groups and requests to a target guest; anonymise/archive source; requires a reason |
| `GET` / `PUT` | `/api/guests/privacy-settings` | `guests.manage` | Read/update the property's guest retention period (30–36,500 days; default 3,650) |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/companies[/:id]` | view/manage | List, create, update and soft-archive company accounts with TIN/contact/credit terms |
| `GET` / `POST` / `PUT` | `/api/guest-groups[/:id]` | view/manage | List, create and update groups, leaders and members |
| `GET` | `/api/guest-requests` | `guests.view` | List requests; optional `status` filter |
| `GET` | `/api/guest-requests/departments` | `guests.view` | List assignable departments |
| `POST` / `PATCH` | `/api/guest-requests[/:id]` | `guest_requests.manage` | Create requests and update workflow status/department/assignee |

Request status transitions are `open → in_progress → resolved`, with cancellation allowed from `open` or `in_progress`; resolved requests may be reopened to `in_progress`. Cancelled requests are terminal. Invalid transitions return `409 INVALID_STATUS_TRANSITION`.

Guest ID/passport values are encrypted with AES-256-GCM before persistence. The searchable duplicate-detection value is an HMAC-SHA-256 digest keyed separately from the encryption key; only the last four normalized characters are stored for masked display/search. Neither encrypted ciphertext nor HMAC is returned by the API. Set a stable, secret `GUEST_PII_ENCRYPTION_KEY` (at least 32 characters) in every environment; production startup fails without it. Changing it without a deliberate key-rotation/migration process makes existing IDs undecryptable. Never reuse `JWT_ACCESS_SECRET` as the guest encryption key.

Guest profile/search/reveal/export, mutations, merge and anonymisation generate append-only audit entries. Audit payloads contain guest IDs, action metadata and field names only, not raw ID/passport values or search terms. Anonymisation clears names/contact/identity/preferences and VIP status but does not delete financial rows, guest links, or totals. The retention period is stored as a property policy; guest anonymisation remains an explicit, reasoned action (no automatic bulk anonymisation job is enabled).

## Phase 6 reservations and availability

Reservation endpoints require an authenticated user assigned to the active property. Property scope is taken from the validated session. Reads require `reservations.view`; creation requires `reservations.create`; edits, moves and extensions require `reservations.edit`; cancellation and no-show require `reservations.cancel`.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/reservations/availability?from=YYYY-MM-DD&to=YYYY-MM-DD[&roomTypeId=id]` | `reservations.view` | Night-by-night physical and type-level availability; checkout is exclusive |
| `GET` | `/api/reservations/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` | `reservations.view` | Active reservations and assignable room rows for a calendar range (maximum 31 days) |
| `GET` | `/api/reservations?from=&to=&status=&search=` | `reservations.view` | Search reservations by confirmation, primary guest name or phone (maximum 200 results) |
| `GET` | `/api/reservations/:id` | `reservations.view` | Reservation, room/guest links and append-only change history |
| `GET` | `/api/reservations/arrivals[?date=YYYY-MM-DD]` | `reservations.view` | Arrivals for the requested date or property business date |
| `GET` | `/api/reservations/departures[?date=YYYY-MM-DD]` | `reservations.view` | Departures for the requested date or property business date |
| `POST` | `/api/reservations` | `reservations.create` | Create a one-to-twenty-room reservation; accepts guest, company/group, stay, room type/rate plan, occupancy, source, status and special-request fields |
| `PUT` | `/api/reservations/:id` | `reservations.edit` | Modify reservation details with a required reason |
| `POST` | `/api/reservations/:id/extend` | `reservations.edit` | Extend the checkout date with a required reason |
| `POST` | `/api/reservations/:id/move` | `reservations.edit` | Move an unarrived reservation to a room and/or different dates with a required reason |
| `POST` | `/api/reservations/:id/cancel` | `reservations.cancel` | Cancel a tentative/confirmed reservation with reason and optional fee |
| `POST` | `/api/reservations/:id/no-show` | `reservations.cancel` | Mark a due, confirmed reservation no-show with a reason |

Availability and room reservations use stay nights `[checkInDate, checkOutDate)`. Creation and room/date modifications lock room types in sorted order, recheck inventory within the transaction, and rely on the unique `(room_id, night)` constraint as the final assigned-room conflict barrier. An unassigned room line consumes type-level inventory. Active group members are loaded and validated in the creation transaction and linked as reservation guests. Rates and taxes are recalculated on the server; client totals are never trusted. Conflicts return `409 ROOM_UNAVAILABLE`.

Reservation changes write append-only history and audit records. Cancellation/no-show release reserved room nights; an optional cancellation fee is retained in history but is not posted to a folio. The reservation workspace provides an availability/quote wizard, multi-room and group selection, reservation search/list, calendar with single-room drag-and-drop moves, detail/history, arrivals and departures.

## Phase 7 stay operations

All stay endpoints require an authenticated user assigned to the active property. Room readiness, maintenance blocks, reservation conflicts, guest identity policy, permissions, and folio balance are checked server-side; mutations use database transactions and append audit/history records.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/stays/in-house` | `checkin.perform` | List active room stays and folio balances for the property |
| `GET` | `/api/stays/:id` | `checkin.perform` | Read stay, folio summary/charges, and room-move history |
| `POST` | `/api/reservations/:id/check-in` | `checkin.perform` | Assign a clean room to each reservation room and create stays/folios; optionally capture guest ID, deposit requirement, payment terms, and early check-in |
| `POST` | `/api/walk-ins` | `checkin.perform` | Atomically create a guest, confirmed reservation, room assignment, stay, and folio |
| `POST` | `/api/stays/:id/move` | `checkin.perform` | Move an in-house stay to a clean room; rate differences require explicit approval and `stays.rate_change_approve` |
| `POST` | `/api/stays/:id/extend` | `checkin.perform` | Extend checkout date after inventory revalidation and server-side repricing |
| `POST` | `/api/stays/:id/shorten` | `stays.shorten` | Shorten checkout date after inventory revalidation and server-side repricing |
| `POST` | `/api/stays/:id/guests` | `checkin.perform` | Add an existing property guest to the stay |
| `POST` | `/api/stays/:id/requests` | `checkin.perform` | Record a guest request, optionally assigned to a department |
| `POST` | `/api/stays/:id/check-out` | `checkout.perform` | Close an eligible stay/folio, issue an invoice, and enqueue checkout cleaning |

The property can require identity capture at check-in and configure early-check-in and late-checkout fees. When ID capture is required, a missing ID is rejected; supplied identity values are encrypted and duplicate-checked using the guest privacy mechanisms. Walk-in creation and check-in are one transaction. Selected rooms must be active, `CLEAN`, maintenance-unblocked, and conflict-free for the stay interval. Migration 015 canonicalizes legacy `AVAILABLE_CLEAN` rooms to `CLEAN`.

Deposits and payment terms are recorded on the folio as requirements/metadata; this phase does not collect payments. Checkout blocks a positive folio balance unless an authorized user with `folio.approve_credit` submits an approval reason. A successful checkout stores invoice totals, closes the folio and stay, changes the room to `AWAITING_CLEANING`, and creates a `checkout_clean` task. A room vacated by an in-house room move also enters `AWAITING_CLEANING` and receives a cleaning task.

## Phase 8 folios, payments and cashier operations

All finance endpoints require an authenticated active-property membership. Folio, document, adjustment, and shift lookups are scoped to that property.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/folios?status=open|closed|all` | `folio.view` | List property folios and current reconciled balances |
| `GET` | `/api/folios/:id` | `folio.view` | Read ledger entries, payment/adjustment history and totals |
| `POST` | `/api/folios/:id/charges` | `folio.post_charge` | Append an ad-hoc service, minibar, laundry or other charge |
| `POST` | `/api/folios/:id/payments` | `folio.take_payment` | Record a payment and issue a numbered receipt |
| `GET` | `/api/cashier-shifts/current` | `folio.view` | Read the caller's active shift and expected cash |
| `GET` | `/api/cashier-shifts` | `reports.view_financial` | List recent shift reconciliation reports |
| `POST` | `/api/cashier-shifts/open` | `cashier.shift.manage` | Open a cashier shift with an opening float |
| `POST` | `/api/cashier-shifts/:id/close` | `cashier.shift.manage` | Reconcile counted cash, record variance and close the shift |
| `GET` | `/api/adjustment-requests` | `folio.adjust` | List property adjustment requests |
| `POST` | `/api/folios/:id/adjustment-requests` | `folio.adjust` | Request a discount, correction, refund or write-off |
| `POST` | `/api/adjustment-requests/:id/decision` | `folio.adjust` (`refund.approve` also required to approve refunds) | Approve or reject a request, subject to approval rules |
| `GET` | `/api/night-audit/status` | `night_audit.run` | Read the business date and recent audit runs |
| `POST` | `/api/night-audit/run` | `night_audit.run` | Post the current business date and advance it once |
| `GET` | `/api/documents/invoices/:id` | `folio.view` | Read an invoice snapshot and its folio charges |
| `GET` | `/api/documents/receipts/:id` | `folio.view` | Read a payment receipt |
| `GET` | `/api/documents/invoices/:id/pdf` | `folio.view` | Stream a printable invoice PDF |
| `GET` | `/api/documents/receipts/:id/pdf` | `folio.view` | Stream a printable receipt PDF |

Payment requests include `method`, positive decimal-string `amount`, and a unique client-generated `idempotencyKey`; bank transfers require a reference. `isDeposit` tags a payment as a deposit. Payments require an open cashier shift. Retrying a payment with the same key returns the original payment and receipt without inserting a duplicate. Refund approval appends a negative payment linked to the original payment; it does not alter the original ledger row.

Folio balances are reconciled as charges minus payments plus approved discounts/write-offs/corrections. Large adjustments above the property's configured approval threshold require a different approver. Receipt and invoice counters are allocated in their write transaction. Charges, payments, approved adjustments, invoices, receipts, and night-audit runs are append-only; closed cashier shifts reject updates. A successful night audit posts room, VAT, service-charge, and levy components for each eligible in-house stay, records the run, advances the business date transactionally, and returns the existing run on a same-date retry.

Document JSON and PDF endpoints accept `?reprint=1` to visibly mark a duplicate/reprint. PDFs are streamed as `application/pdf`; the Finance workspace downloads them through authenticated blob requests and also supports browser printing.

## Phase 9 housekeeping and room readiness

All endpoints are scoped to the authenticated user's active property. Housekeeping staff can see and act only on tasks assigned to them; supervisors can see the property task board and assign work.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/housekeeping/rooms` | `housekeeping.view` or `housekeeping.work` (front desk with `checkin.perform` can also view) | Room readiness board |
| `GET` | `/api/housekeeping/tasks` | `housekeeping.view` or `housekeeping.work` (front desk with `checkin.perform` can also view) | Scoped task list; staff results are assignment-filtered |
| `GET` / `PUT` | `/api/housekeeping/settings` | `housekeeping.view` / `housekeeping.assign` | Read/update same-day priority and inspection-skip policy |
| `GET` / `POST` | `/api/housekeeping/checklists` | view/work or front desk / `housekeeping.checklist.manage` | Read templates or create a room-type/default checklist |
| `GET` | `/api/housekeeping/staff` | `housekeeping.assign` | List eligible property staff and departments |
| `GET` | `/api/housekeeping/reports` | `housekeeping.view` | Readiness and employee task metrics |
| `POST` | `/api/housekeeping/tasks` | `housekeeping.assign` | Create a task (`roomId`, `type`, optional priority 1–5, ISO `dueAt`, assignee and department) |
| `PATCH` | `/api/housekeeping/tasks/:id/assignment` | `housekeeping.assign` | Assign or reassign one task |
| `POST` | `/api/housekeeping/tasks/bulk-assignment` | `housekeeping.assign` | Assign up to 100 task IDs to a property staff member |
| `POST` | `/api/housekeeping/tasks/:id/start` | `housekeeping.work` | Start assigned work and begin room cleaning when it is a readiness task |
| `PATCH` | `/api/housekeeping/tasks/:id/items/:itemId` | `housekeeping.work` | Mark a copied checklist item complete/incomplete |
| `POST` | `/api/housekeeping/tasks/:id/issue` | `housekeeping.work` | Open a maintenance ticket linked to the task's room |
| `POST` | `/api/housekeeping/tasks/:id/submit` | `housekeeping.work` | Submit completed work; required checklist items must be complete |
| `POST` | `/api/housekeeping/tasks/:id/inspection` | `housekeeping.inspect` | Approve or reject a task awaiting inspection; rejection requires a reason |

Checklist contents and required flags are snapshotted to a task when it is created, so later template edits do not change work already assigned. Checkout-clean and deep-clean readiness tasks move a room through `AWAITING_CLEANING` → `BEING_CLEANED` → `AWAITING_INSPECTION`; approval makes it `CLEAN`, while rejection returns it to `BEING_CLEANED` for rework. The property can enable inspection bypass only for a role with `housekeeping.skip_inspection`. A database guard rejects direct room status changes out of the cleaning/inspection states unless performed by the housekeeping transition workflow.

`PUT /api/housekeeping/settings` accepts `{ "sameDayArrivalPriority": boolean, "skipInspection": boolean }`. Same-day arrival tasks receive priority 1 with an explanatory reason. Socket.IO authenticates the access token and property membership, then broadcasts room-status changes to that property's housekeeping and front-desk rooms; clients retain Socket.IO's polling fallback when WebSocket upgrades are unavailable.

## Phase 10 maintenance, assets and room blocking

All maintenance endpoints require an active property membership and `maintenance.manage`. An assignee must be an active user assigned to the same property whose role also has `maintenance.manage`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/maintenance/rooms` | Property room list and active blocking-ticket count |
| `GET` | `/api/maintenance/staff` | Eligible property maintenance staff |
| `GET` | `/api/maintenance/assets` | List active property assets with room and open-ticket details |
| `POST` | `/api/maintenance/assets` | Register an asset with `name`, optional `assetTag`, `category`, `roomId`, and status |
| `PUT` | `/api/maintenance/assets/:id` | Update an asset; moving an asset with an active ticket is rejected |
| `DELETE` | `/api/maintenance/assets/:id` | Soft archive an asset; active tickets must first be cleared |
| `GET` | `/api/maintenance/tickets` | List tickets; optional `status`, `priority`, and `roomId` filters |
| `POST` | `/api/maintenance/tickets` | Create a room- or asset-linked ticket, set priority, blocking policy and optional assignee |
| `PATCH` | `/api/maintenance/tickets/:id/assignment` | Assign/unassign a ticket to eligible maintenance staff |
| `PATCH` | `/api/maintenance/tickets/:id/status` | Progress a ticket, record its resolution, and separately clear it |

Asset tags, when provided, are unique within a property. Asset statuses are `active`, `needs_service`, or `out_of_service`. Ticket priorities are `low`, `normal`, `high`, or `urgent`; ticket statuses transition from `open`/`assigned` to `in_progress`, then `resolved`, then `closed`. Resolving requires `resolutionNotes`; clearing a resolved ticket requires `clearanceNotes`, stored with the clearing user's ID and timestamp. Each ticket/asset change and room status transition is written to the audit log; room block/unblock transitions are also written to room status history.

Ticket creation accepts `{ "roomId"?, "assetId"?, "category", "priority"?, "description", "blocksRoom"?, "assignedTo"? }`. At least one room or asset is required. An asset-linked ticket inherits the asset's room; conflicting room/asset associations are rejected. A blocking ticket returns any affected active reservation confirmation numbers and dates in `data.conflicts`, so existing bookings are visible to staff.

Blocking tickets continue to exclude room availability while unresolved **and while resolved but not yet cleared**. A clean room transitions to `BLOCKED_MAINTENANCE` when a blocking ticket is opened. Occupied or housekeeping-in-progress rooms keep their current status but are not assignable while a blocker exists; housekeeping inspection cannot mark them ready until the blocking work is cleared. A blocked room returns to `CLEAN` only when the last blocking ticket is closed with clearance notes. A database trigger rejects direct status changes out of `BLOCKED_MAINTENANCE`.

Authenticated Socket.IO clients with `maintenance.manage` join the active property's maintenance channel. Room status events are also delivered there, and ticket lifecycle events are emitted as `maintenance:ticket`; polling remains available as a transport fallback.

## Phase 11 staff, rosters and attendance

All staff endpoints require an authenticated user and an active property validated against the user's membership. `staff.manage` grants staff administration and manager views; `staff.self_service` grants own profile, schedule, attendance, leave-request and department-handover access. The default self-service grant excludes auditor and super-admin roles.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` / `POST` | `/api/staff/departments` | `staff.manage` | List or create departments |
| `PUT` / `DELETE` | `/api/staff/departments/:id` | `staff.manage` | Rename or archive an unused department; handover history is retained |
| `GET` / `POST` | `/api/staff/employees` | `staff.manage` | List or create employee profiles; optional linked user must be active and assigned to this property |
| `PUT` | `/api/staff/employees/:id` | `staff.manage` | Update staff profile and employment status |
| `GET` / `POST` | `/api/staff/shifts` | `staff.manage` | List or define regular/overnight shift times |
| `PUT` / `DELETE` | `/api/staff/shifts/:id` | `staff.manage` | Update or remove a shift only when it has no roster assignments |
| `GET` / `POST` | `/api/staff/roster?from=YYYY-MM-DD&to=YYYY-MM-DD` | `staff.manage` | List up to 92 days or assign an employee to a shift/date |
| `DELETE` | `/api/staff/roster/:id` | `staff.manage` | Remove an assignment that has no attendance record |
| `GET` | `/api/staff/me` | `staff.manage` or `staff.self_service` | Read the linked employee profile, upcoming roster, today's attendance and leave |
| `POST` | `/api/staff/attendance/clock-in` | `staff.manage` or `staff.self_service` | Record the linked employee's property-local work date |
| `POST` | `/api/staff/attendance/clock-out` | `staff.manage` or `staff.self_service` | Close today's or an overnight-shift open attendance record |
| `GET` | `/api/staff/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD` | `staff.manage` | List attendance and calculated overtime |
| `GET` / `POST` | `/api/staff/leave` | `staff.manage` or `staff.self_service` | Managers list all property requests; employees list/request their own |
| `PATCH` | `/api/staff/leave/:id/decision` | `staff.manage` | Approve or reject a pending request |
| `GET` / `POST` | `/api/staff/handovers` | `staff.manage` or `staff.self_service` | List/create immutable department handover notes |
| `GET` | `/api/staff/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` | `staff.manage` | Export attendance for a maximum 92-day date range |

Employee creation/update accepts `fullName`, optional `userId`, `departmentId`, `jobTitle`, `employmentStatus` (`active`, `on_leave`, or `terminated`), `hireDate` and `phone`. Shift times use `HH:mm`; equal start/end values are rejected. Assignments are unique per employee/date, check adjacent dates for overnight overlaps, and reject approved leave. A shift with any assignment cannot be edited or deleted.

Attendance is keyed to the date in the property's configured timezone. Clock-out can close an open record from the previous local date to support overnight shifts. For scheduled work, overtime is `max(0, elapsed attendance minutes - scheduled shift duration)`; unscheduled attendance records zero overtime. Clock-in is unique per employee/property-local day.

Leave requests require `type`, inclusive `dateFrom`/`dateTo`, and `reason`; overlapping pending or approved requests are rejected. Approval is blocked while any roster assignment remains within the requested dates. `approved_by` stores the reviewer for either outcome and `reviewed_at` records the decision time.

Self-service handover reads/writes are limited to the linked employee's department; managers can view and create notes across the property. Handover notes have no update/delete API, and departments with handover history cannot be archived. CSV values are quoted and spreadsheet-formula prefixes are neutralized before export.

## Phase 12 expenses, suppliers, inventory and services

All endpoints are scoped to the authenticated user's active property. Expense operations require `expenses.manage`, inventory operations require `inventory.manage`, and service catalog changes require `services.manage`. Service catalog reads also allow `folio.post_charge` so authorized staff can bill active catalog services.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` / `POST` | `/api/expenses/categories` | `expenses.manage` | List/create property expense categories |
| `GET` / `POST` | `/api/expenses` | `expenses.manage` | List by optional `from`/`to` dates and record expenses |
| `DELETE` | `/api/expenses/:id` | `expenses.manage` | Soft-archive an expense |
| `GET` / `POST` | `/api/suppliers` | `expenses.manage` | List/create property suppliers |
| `PUT` / `DELETE` | `/api/suppliers/:id` | `expenses.manage` | Update/archive suppliers |
| `GET` / `POST` | `/api/inventory/categories` | `inventory.manage` | List/create inventory categories |
| `GET` / `POST` | `/api/inventory/items` | `inventory.manage` | List/create stock items |
| `PUT` | `/api/inventory/items/:id` | `inventory.manage` | Update item details and reorder level |
| `POST` | `/api/inventory/items/:id/archive` | `inventory.manage` | Archive an item only when its balance is zero |
| `GET` | `/api/inventory/movements?itemId=...` | `inventory.manage` | List immutable stock movement history |
| `POST` | `/api/inventory/items/:id/movements` | `inventory.manage` | Record purchase, issue, wastage or signed adjustment |
| `GET` | `/api/services/catalog` | `services.manage` or `folio.post_charge` | List active services; managers may request inactive entries |
| `POST` / `PUT` / `DELETE` | `/api/services/catalog[/:id]` | `services.manage` | Create, update or archive catalog services |
| `POST` | `/api/folios/:id/services` | `folio.post_charge` | Append a priced catalog service to an open folio |

Expense bodies contain `categoryId`, `amount` as a decimal string and `expenseDate` (`YYYY-MM-DD`); optional supplier, reference and description are supported. Inventory movement bodies specify `movementType` and decimal-string `quantity`; purchases also require `unitCost`, and issue/wastage/adjustment records require a reason. Adjustments accept a signed quantity. All stock changes lock the item, record a signed append-only movement and update the on-hand balance atomically; negative stock is rejected. Supplier/category/service references and item lookups are validated within the active property.

Catalog service billing takes `{ "serviceId": 3, "quantity": 2 }`. The API locks and validates the active catalog service, calculates the amount in integer cents, then appends the charge with a catalog reference and audit event. Existing folio charges remain unchanged if catalog metadata is later edited or archived.

## Phase 13 notifications and automation

All endpoints use the authenticated active-property scope. Reading and acknowledging notifications is available to authenticated property members, but a user can only see property-wide, role-targeted, or individually addressed notifications. Rule administration, manual runs and automation logs require `automation.manage`.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/notifications?limit=50&unreadOnly=true` | Active property membership | List visible notifications and return the caller's unread count |
| `PATCH` | `/api/notifications/:id/read` | Active property membership | Mark a visible notification as read; safe to retry |
| `GET` | `/api/automation/rules` | `automation.manage` | Read property rules, descriptions, mode, enabled state and config |
| `PATCH` | `/api/automation/rules/:key` | `automation.manage` | Update a scheduled rule's enabled state and/or validated config |
| `POST` | `/api/automation/run` | `automation.manage` | Run enabled scheduled rules immediately for the active property |
| `GET` | `/api/automation/logs?limit=50&ruleKey=...` | `automation.manage` | Review bounded append-only results, criteria and observed values |

The eight scheduled rules are `arrival_reminder`, `departure_reminder`, `overdue_tasks`, `blocking_ticket`, `outstanding_balance`, `unusual_adjustment`, `no_show_candidates` and `low_stock`. Their tunable config keys are `daysAhead` (arrival/departure, 0–30), `overdueMinutes` (0–43,200), `minimumBalance` (positive decimal string) and `minimumAmount` (positive decimal string); other rules use criteria defined by their current operational state. `checkout_housekeeping` remains a separate event-driven workflow: checkout creates the task transactionally and it is not run by the scheduled evaluator.

The API supports manual execution, and the API server also evaluates enabled rules at startup and every five minutes for active properties. Each match writes one role-targeted notification and one explainable log entry in the same transaction. A property row lock serializes cycles; unique per-property dedupe keys protect each rule/entity/business-date cycle against retries and concurrent workers. Arrival/departure cycles are keyed to their target date; other scheduled detections are keyed to the property's business date. Logs are immutable; notifications may only be acknowledged as read.

## Phase 14 dashboards and reports

All report endpoints require `reports.view` and an authenticated assigned active property. `propertyId` is an optional selector for another property assigned to the caller; the API revalidates membership instead of trusting the access token's property list. Date filters are property-local calendar dates, default to the property's business date, and are limited to 366 days. When only one boundary is supplied, the report is for that one date.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/reports?from=2026-10-01&to=2026-10-31&propertyId=12` | `reports.view` | Return current operational KPIs and selected-period metrics; financial details are included only with `reports.view_financial` |
| `GET` | `/api/reports/dashboard?propertyId=12` | `reports.view` | Return current-date data for the caller's role dashboard |
| `GET` | `/api/reports/export?format=csv&from=2026-10-01&to=2026-10-31` | `reports.view` | Download a CSV report; financial rows are omitted without `reports.view_financial` |
| `GET` | `/api/reports/export?format=pdf&from=2026-10-01&to=2026-10-31` | `reports.view` | Download a printable PDF report with the same permission filtering |

The overview and Reports workspace show live role-oriented KPIs, date/property filters, operational and (where permitted) financial tables, CSV/PDF downloads, browser printing, and links to the relevant operational screens. Timestamp filters use UTC boundaries calculated from the property's IANA timezone; calendar-date columns such as folio business dates and roster dates are filtered directly.

## Phase 15 platform administration and licensing

Platform administration endpoints require the `super_admin.manage` permission. Customers can approve or revoke support sessions and export their organization data using their regular owner/GM account.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` / `POST` / `PATCH` | `/api/platform/packages[/:id]` | `super_admin.manage` | List and manage packages, room/user limits, enabled modules and monthly fee |
| `GET` / `POST` | `/api/platform/organizations` | `super_admin.manage` | List organizations with usage or create an organization, initial property and owner |
| `PATCH` | `/api/platform/organizations/:id` | `super_admin.manage` | Suspend/reactivate an organization, change subscription status or assign a package |
| `POST` | `/api/platform/properties` | `super_admin.manage` | Add a property to an active organization |
| `GET` / `POST` | `/api/platform/organizations/:id/billing-notes` | `super_admin.manage` | Read/add manual invoice and billing notes |
| `GET` | `/api/platform/organizations/:id/usage` | `super_admin.manage` | Read plan modules, limits and current property/room/user usage |
| `POST` | `/api/platform/support-requests` | `super_admin.manage` | Request a customer-approved, property-scoped, read-only support session |
| `GET` | `/api/platform/support-requests` | `super_admin.manage` | Review platform support-request status |
| `POST` | `/api/platform/support-requests/:id/activate` | `super_admin.manage` | Start an approved support session and receive its scoped access token |
| `GET` | `/api/platform/support-requests/customer` | `users.manage` | List requests for the customer's active property |
| `POST` | `/api/platform/support-requests/:id/decision` | `users.manage` | Approve or deny a request for the customer's active property |
| `POST` | `/api/platform/support-requests/:id/revoke` | `users.manage` | Revoke approved/active support access for the customer's active property |
| `POST` | `/api/platform/support/exit` | Active support session | End the current support session |
| `GET` | `/api/platform/data-export?format=json` | `users.manage` | Download the organization-scoped JSON data export |
| `GET` | `/api/platform/data-export?format=csv` | `users.manage` | Download the organization-scoped CSV data export |

Room/user capacity failures return `409 PLAN_LIMIT_ROOMS` or `409 PLAN_LIMIT_USERS`; disabled modules return `403 MODULE_DISABLED`. Organization suspension blocks normal API access while retaining authenticated session restoration and customer data export.

Local license documents are Ed25519-signed JSON bound to `organizationId` and `installationId`, with `maxRooms`, `maxUsers`, `modules`, and `expiresAt`. Valid licenses remain writable through a 14-day grace period; invalid or post-grace licenses are read-only, while customer data export remains available. Configure `LICENSE_FILE_PATH` and, when using a vendor key other than the embedded public key, `LICENSE_PUBLIC_KEY`. Generate documents with `node backend/tools/issue-licence.js --key <offline-private-key.pem> --input <payload.json> --output <licence.json>`; the private key must remain outside the repository.

Support tokens are bound in the database to one approved request, actor, organization and property; customer approval expires after the requested 5–60 minutes. Mutations are rejected during support access, data export is unavailable to support, and access is audited and revocable by the customer.
