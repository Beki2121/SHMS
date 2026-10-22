# Implementation progress

## Phase 1 — Repository, tooling and MAMP development environment

**Status: foundation implemented; environment gate remains open.** The Phase 1 foundation is established in the user-selected `backend/` and `frontend/` folders.

### Done

- [x] Read the supplied implementation playbook and extracted its Master Brief to `PROJECT_SPEC.md`.
- [x] Created the monorepo workspace skeleton under `backend/` and `frontend/`.
- [x] Added initial API health route, frontend shell, English strings, environment example, and project scripts.
- [x] Current `npm run lint`, `npm test`, and `npm run build` pass.
- [x] `npm audit` found advisories in the initial Vitest version; upgraded Vitest to 4.1.12. A subsequent install reported zero vulnerabilities.
- [x] `npm run dev` starts both processes; the sign-in UI was verified in the browser.

### Deferred / outstanding

- [ ] Run `npm run db:create` on a clean supported MySQL 8 / MariaDB 10.5+ server.
- [ ] Verify the full health indicator on a supported database version.
- [ ] Confirm the GitHub Actions workflow on a remote push/PR.

### Environment notes

- Required target runtime is Node.js 20 LTS. The available environment currently reports Node.js 22.14.0 and npm 10.9.2.
- Use `npm.cmd` in PowerShell if the execution policy blocks the `npm.ps1` shim.
- The reachable database identifies as MySQL 5.7.24. It is below the specified MySQL 8 / MariaDB 10.5 minimum; the API logs a compatibility warning. Migrations and current tests pass, but upgrade or validate against a supported server before deployment.
- A local `npm ci` attempt hit Windows `EBUSY` while deleting a locked package folder. Dependencies were restored with `npm install --legacy-peer-deps`; the clean-install lockfile dry run passed.
- The workspace lockfile was regenerated for the selected `backend/` and `frontend/` folders.

### How to run / verify

1. Install Node.js 20 LTS and MAMP MySQL, then copy `.env.example` to `.env`.
2. Start MAMP MySQL, then run `npm ci` (or `npm install`), `npm run db:create`, and `npm run dev`.
3. Run `npm run lint`, `npm test`, and `npm run build`.

# Phase 2 — schema and seed data

**Status: implemented and verified, including disposable-database rollback.** The initial Knex migration, base seed, demo seed, uniqueness tests, and schema relationship overview have been added. The seed includes a demo organization/property, ten role accounts, twenty rooms, rates, service and expense catalogs, checklist, and automation rules. Demo seeding creates guests, reservations, five in-house stays, folios, and room-night reservations. A dedicated disposable validation database completed migration, both seed runs, rollback of all 21 migrations, remigration, and reseeding.

Run from the repository root after MAMP MySQL is available and `.env` points to it:

```powershell
npm install
npm run db:create
npm run db:migrate
npm run db:seed
npm run db:seed:demo
npm test
```

The default development seed password is `ChangeMe123!`; set `SEED_ADMIN_PASSWORD` before seeding to use a different password. Change seeded credentials before any production use.

**User verified on MAMP:** migration and both seed scripts completed without an error. phpMyAdmin reports 20 rooms, 20 guests, 20 reservations, 5 stays, and 5 folios. The room-number and room-night uniqueness tests now pass against the database. The dedicated disposable validation database has since passed full migration rollback and remigration.

# Phase 3 — authentication, RBAC, tenancy and audit foundation

**Status: implemented and verified.**

- [x] Login, 15-minute JWT access tokens, hashed rotating refresh-token families, replay detection, logout, current-user profile, property switching, password change, and admin password reset.
- [x] Five-failure / 15-minute account lockout; production requires `JWT_ACCESS_SECRET`.
- [x] Permission checks, 30-second role-permission cache with invalidation, module entitlements, active-property validation, and a property-scoped repository helper.
- [x] Organization-scoped user/role management UI and API; user and role changes record before/after audit snapshots in the same transaction. Database triggers reject audit-log updates/deletes.
- [x] Login, role-based navigation, protected routes, property switcher, and a permission-aware client that retries once after a single-flight refresh.
- [x] API permission/isolation tests cover every seeded role on user/role routes for assigned and unassigned properties; auth lifecycle tests cover rotation/reuse and lockout; audit tests verify snapshots and immutability.
- [x] Browser check confirmed sign-in, current-property shell, and user/role administration views. `npm test`, `npm run lint`, and `npm run build` pass.

# Phase 4 — property setup, rooms and rates

**Status: implemented and verified against the existing MAMP database.**

- [x] Property profile editing for contact/location, timezone, currency, check-in/out and configurable VAT/service/levy with tax-inclusive pricing. Business date is displayed read-only.
- [x] Property-scoped building/floor setup; room-type management with capacity, base rate and normalized amenities; bulk room creation with floor/type, number range, prefix/suffix and padding.
- [x] Room rack grouped by floor with live room status and soft activation controls. Deactivation is blocked while an assigned room has an in-house or future active reservation.
- [x] Rate plan and date/weekday/minimum-stay rule management; rate changes require a reason and audit record. Past-dated rate changes require the new `rates.override_past` permission. `rates.view` permits front desk price quotes without granting edit access.
- [x] Integer-cent quote calculator covers weekday/weekend rates, seasonal precedence, minimum-stay enforcement, capacity, exclusive and inclusive taxes, and per-night totals.
- [x] Property setup endpoints enforce permissions and token-derived property scope; a role matrix covers assigned and unassigned property access and confirms request-supplied property IDs do not alter scope.
- [x] API routes, DB migrations, calculator and role-isolation tests pass. The browser verified the setup screen, all 20 seeded rooms grouped into three floors, and a two-night quote of ETB 9,200. `npm test` (15 API and 4 frontend tests), `npm run lint`, `npm run build`, and `npm audit` pass.

**Environment limitation:** validation ran against MySQL 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum. Migrations currently apply successfully there, but supported-server validation is still required before deployment.

# Phase 5 — guest management and privacy

**Status: implemented and locally verified.**

- [x] Guest create/update, scoped search by name/contact/email/ID last four, masked-by-default profile, reservation and request history, duplicate detection by normalized contact and keyed ID HMAC.
- [x] ID/passport persistence uses AES-256-GCM with a dedicated `GUEST_PII_ENCRYPTION_KEY`; the database stores encrypted ciphertext, a separately keyed HMAC digest and only the last four normalized characters. `guest.view_id` reveal and authorized data export are audited; audit metadata does not contain ID plaintext or search terms.
- [x] Guest merge re-links primary/secondary reservation records, folios, group membership/leaders and service requests, then anonymises/archives the source with a required reason. Anonymisation clears guest PII while leaving folio relations, ledger rows and financial totals unchanged.
- [x] Property retention policy can be read/updated; anonymisation is explicit (there is no automatic bulk anonymisation job). Guest profile/search/reveal/export, changes, merges and anonymisation are audited.
- [x] Added company accounts with TIN/contact/credit terms, guest groups with leader/member relations, and service-request status/department/assignee fields and API workflow.
- [x] Added the guest workspace: guest search/profile/history, create, audited reveal/export, anonymise/merge actions, company and group setup, service-request assignment/workflow, and retention-policy UI.
- [x] API tests verify encrypted-at-rest representation, HMAC duplicate detection, masking/reveal/export, audit omission of raw identity, anonymisation financial relationship preservation, company/group/request workflows, and retention policy. The full guest-route permission/property matrix passes. The browser verified the guest directory, profile/stay history, company and group forms, request assignment workspace and retention settings.
- [x] Final validation: `npm test` passes (9 API files / 21 tests and 3 frontend files / 4 tests); `npm run lint`, `npm run build`, and `npm audit --audit-level=high` pass (zero advisories).
- [x] Additive migrations 007–008 applied successfully to the existing MAMP database.

**Environment/security gate:** migrations and tests ran on MySQL 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum; validate on a supported server before deployment. Set a unique stable `GUEST_PII_ENCRYPTION_KEY` of at least 32 characters in production. Key rotation is not automated and requires a controlled re-encryption procedure.

# Phase 6 — reservations and availability

**Status: implemented and locally verified; supported-database gate remains open.**

- [x] Nightly availability uses the half-open stay interval `[check-in, check-out)`, excludes inactive/maintenance-blocked rooms, and accounts for assigned room nights plus unassigned type-level inventory.
- [x] Reservation APIs provide property-scoped availability, calendar, search/detail, arrivals/departures, create/modify, extension, room/date move, cancellation and no-show actions.
- [x] Booking mutations lock room-type inventory in stable order and recheck within the transaction. The unique room-night key remains the final double-booking barrier; 50 simultaneous attempts for one room produce exactly one success and 49 `409 ROOM_UNAVAILABLE` responses.
- [x] Multi-room and group bookings calculate server-side quotes per room line; group membership is loaded and active/non-anonymised guest links are checked inside the creation transaction. Reservation changes are recorded in append-only history and audit entries.
- [x] Cancellation/no-show release reserved room nights. Cancellation fee is recorded for Phase 8 posting and is not yet posted to a folio.
- [x] Reservation workspace provides calendar, search/list, arrival/departure boards, multi-room/group wizard, availability/rate preview, reservation detail/history and single-room drag-and-drop date/room moves. Browser checks verified the legacy seeded-reservation calendar, quote wizard, list/detail and departure board.
- [x] Integration coverage includes type-level inventory release, legacy reservation details, group member links, extension conflict/move history, permission/property scope, and the mandatory 50-request concurrency case.
- [x] Final validation: `npm test`, `npm run lint`, `npm run build`, and `npm audit --audit-level=high` pass (zero advisories).
- [x] Additive migration 009 applied successfully to the local database.

**Environment and test-data notes:** local database is MySQL 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum; run migrations and tests on a supported server before deployment. Reservation test bookings are cancelled but retained because reservation history is append-only; their room-night inventory is released.

## Phase 7 — check-in, stays, room moves, checkout and walk-ins

**Status: implemented and locally verified; supported-database gate remains open.**

- [x] Property settings expose required guest ID capture and early-check-in/late-checkout fees. New permissions cover stay shortening, room-move rate approval, and checkout credit approval.
- [x] Reservation check-in assigns a distinct clean room to each reservation room, rechecks maintenance and room-night conflicts, optionally captures encrypted guest ID, and creates one stay/open folio per assigned room.
- [x] Walk-ins create guest, reservation, room assignment/night, stay, folio, audit and reservation history atomically.
- [x] In-house stay APIs and the front-desk workspace support folio/stay detail, room moves, date extension/shortening, adding guests, request logging, and checkout.
- [x] Room moves and date changes revalidate inventory and recalculate server-side quotes. A vacated room is sent to housekeeping; rate-changing moves require authorized explicit approval; shortening has its own permission.
- [x] Checkout blocks unsettled positive balances without authorized, reasoned credit approval; successful checkout stores invoice totals, closes the folio/stay, transitions the room to `AWAITING_CLEANING`, and creates a checkout-clean task.
- [x] Integration tests cover required ID policy, encrypted ID capture, walk-in rollback/readiness, balance blocking/approved credit, check-in, stay detail, room move, extension/shortening, and checkout.
- [x] Browser verification confirmed the front-desk arrivals and walk-in workspace, check-in wizard, and in-house stay controls. It also caught and helped fix a BigInt serialization error in stay detail.
- [x] Final validation: `npm test` passes (11 API files / 29 tests and 3 frontend files / 4 tests); `npm run lint` and `npm run build` pass.
- [x] Additive migrations 010–011 applied successfully to the local database.

**Scope and environment notes:** deposit amounts and payment terms are recorded as folio requirements/metadata; collection, receipts, and cashier shifts were completed in Phase 8. The local database is MySQL 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum. Validate on a supported database before deployment.

## Phase 8 — folios, payments, night audit, documents and cashier shifts

**Status: implemented and locally verified; supported-database gate remains open.**

- [x] Property-scoped folio list/detail and charge/payment APIs reconcile charges, payments, and approved adjustments using integer-cent arithmetic.
- [x] Split payments, deposit tagging, bank-transfer references, open-shift requirements, and idempotent payment/receipt retries are enforced server-side.
- [x] Refunds append negative linked payment rows; discounts, write-offs, and corrections use an approval workflow with a separate-approver threshold.
- [x] Cashier shifts record opening float, expected cash, counted cash, and variance; closed shifts are immutable.
- [x] Night audit posts room and configured tax components once per business date, advances the date transactionally, and safely returns the prior result on retry.
- [x] Sequential invoice/receipt numbering is transactional. JSON and PDF invoice/receipt endpoints support duplicate/reprint marking; PDFs are verified as valid PDF streams.
- [x] Finance workspace provides folio ledger actions, adjustment review, cashier reconciliation, night-audit controls, and document print/download views. Browser verification loaded the workspace, folios, shift state, and ledger/payment controls.
- [x] Database triggers enforce append-only financial and night-audit records. Migrations 012–014 applied successfully to the local database.
- [x] Integration coverage validates split/idempotent payments, refunds/discounts, reconciliation, checkout/invoice, PDF headers/content, night-audit tax posting/replay, and audit-run immutability.
- [x] Final validation: `npm test` passes (12 API files / 31 tests and 3 frontend files / 4 tests); `npm run lint` and `npm run build` pass.

**Environment and validation notes:** the reachable server is MySQL 5.7.24, below the supported MySQL 8 / MariaDB 10.5 minimum; local success does not replace supported-server verification. Backend integration tests execute serially because they share seeded database fixtures. Deployment also requires a unique, stable `GUEST_PII_ENCRYPTION_KEY`.

## Phase 9 — housekeeping and room readiness

**Status: implemented and locally verified; supported-database gate remains open.**

- [x] Migration 015 canonicalizes `AVAILABLE_CLEAN` to `CLEAN`, adds task departments, priority explanations, readiness flags and checklist required-item snapshots, and adds property inspection/same-day priority policies and housekeeping permissions.
- [x] Housekeeping APIs provide property-scoped room/task boards, task creation, individual/bulk assignment, staff/departments, checklist templates, settings, reports, task start/checklist/issue/submit actions, and supervisor inspection approval/rejection.
- [x] Task creation copies the selected room-type/default checklist and required flags. Required incomplete items block submission; rejection returns the room to rework. Same-day arrivals elevate priority with a stored explanation.
- [x] Checkout and room moves create cleaning work for vacated rooms. Room transitions are guarded by a database trigger; check-in now accepts only canonical `CLEAN` rooms.
- [x] Authenticated Socket.IO membership limits live room updates to assigned properties and housekeeping/front-desk channels, with polling fallback. The Room Rack and Housekeeping workspace consume live changes.
- [x] Housekeeping workspace supports supervisor task creation/assignment, bulk assignment, checklist configuration, readiness policy, reports, staff task workflow, maintenance issue reporting, and inspections. Browser verification confirmed the supervisor board and the live-connection indicator.
- [x] Integration tests cover checklist snapshots/required items, overdue tasks, assigned staff visibility, direct-transition rejection, race-safe starts, maintenance issue creation, rejected rework, approval, bulk assignment and staff restrictions.
- [x] Final validation: `npm test` passes (13 API files / 33 tests and 3 frontend files / 4 tests); `npm run lint` and `npm run build` pass. Targeted stay/property/housekeeping tests and the full authorization matrix also pass.
- [x] Migration 015 (`20261022001500_housekeeping_workflows.js`) is applied locally; Knex reports no pending migrations.

**Environment and validation notes:** validation ran against MySQL 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum; local migration/test success does not replace supported-server verification. Backend tests share seeded database state and run serially.

## Phase 10 — maintenance, assets and room blocking

**Status: implemented and locally verified; supported-database gate remains open.**

- [x] Migration 016 adds asset-tag uniqueness and lookup indexes, persistent ticket clearance notes and room/asset ticket indexes. A DB trigger prevents maintenance-blocked rooms from being unblocked outside the maintenance clearance workflow.
- [x] Property-scoped APIs support ticket listing/filtering, ticket creation against a room or asset, staff assignment, the open/assigned/in-progress/resolved/closed workflow, asset registration/edit/soft archive and room/staff boards.
- [x] Blocking ticket creation transitions a clean room to `BLOCKED_MAINTENANCE` and reports affected reservations. Reservation availability, assignment and check-in exclude blocking tickets through resolution; the room remains blocked until a reasoned, audited clearance closes the final blocking ticket.
- [x] Room status history, ticket lifecycle and asset changes are audited. Clearance records the actor, timestamp and notes; only when all blocking tickets are closed can a blocked room return to `CLEAN`.
- [x] Housekeeping approval and inspection-bypass paths preserve a maintenance block instead of accidentally marking a room ready. Authenticated maintenance-channel updates notify the maintenance workspace of room/ticket changes.
- [x] The Maintenance workspace provides ticket reporting, priority/assignment/status controls, resolution and clearance forms, asset register editing/archiving, room conflict warnings, blocked-room overview and live updates.
- [x] Integration tests verify duplicate asset tags, reservation conflict reporting, blocked-room availability exclusion, direct unblock rejection, assignment, resolution remaining blocked, required clearance, audit/history and housekeeping/maintenance state interaction. The role matrix covers the maintenance API.
- [x] Final validation: `npm test` passes (14 API files / 34 tests and 3 frontend files / 4 tests); `npm run lint` and `npm run build` pass. The maintenance page and live-connection state were browser-checked.
- [x] Migration 016 (`20261022001600_maintenance_workflows.js`) applied locally.

**Environment and validation notes:** the local MySQL server is 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum; validate the migration and suite against a supported server before deployment.

## Phase 11 — staff, schedules, attendance and handovers

**Status: implemented and locally verified; supported-database gate remains open.**

- [x] Migration 017 adds unique per-employee/day roster and attendance constraints, indexes, attendance-to-roster linkage, leave reason/review metadata, titled department handovers, and the property-scoped `staff.self_service` permission. It is applied locally; Knex reports no pending migrations.
- [x] Property-scoped APIs manage departments, employee profiles, shift definitions and rosters; staff managers can list and update employees, while self-service users can read their linked profile and upcoming schedule.
- [x] Roster assignments reject approved leave and check adjacent dates for overnight-shift overlap. A single roster assignment per employee/date is enforced by a unique constraint; assigned shift definitions cannot be edited or deleted.
- [x] Staff can clock in/out against property-local dates. Attendance links to the day's roster, handles clock-out after midnight, and calculates overtime as recorded attendance duration beyond the assigned shift; unscheduled attendance records zero overtime.
- [x] Employees can request leave, with overlap checks; managers approve or reject requests and cannot approve leave while the employee still has roster assignments during that period.
- [x] Department handovers are create/list only, scoped to the employee's department for self-service users. Managers can view all departments; departments with handover history cannot be archived.
- [x] Attendance export is bounded to 92 days and CSV cells are quoted and protected against spreadsheet formula injection. Staff and roster/attendance/leave/hand-over changes are audited.
- [x] The Staff workspace includes department and employee management, shift definitions, roster planning, attendance review/export, leave review/self-service, and handover notes. Navigation is permission-gated for staff managers and self-service roles.
- [x] Integration coverage verifies overnight overlap, leave conflict/review, roster constraints, linked self-service permissions, clock-in/out overtime, department-scoped handovers, CSV formula protection, property scoping and manager-only access.
- [x] Final validation: all 15 backend test files / 35 tests and all 3 frontend test files / 4 tests pass; `npm run lint` and `npm run build` pass. The Staff workspace was browser-checked.
- [x] Migration 017 (`20261022001700_staff_workflows.js`) applied locally.

**Environment and validation notes:** validation ran against MySQL 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum; local success does not replace supported-server verification.

## Phase 12 — expenses, suppliers, inventory and additional services

**Status: implemented and locally verified; supported-database gate remains open.**

- [x] Migration 018 adds property-scoped lookup/uniqueness indexes, a service-catalog reference on folio charges, append-only inventory movement triggers, and inventory/service role grants. It is applied locally; Knex reports no pending migrations.
- [x] Operations APIs provide scoped expense categories/records, suppliers, inventory categories/items/movements and service catalog management. Expense and supplier records can be archived; inventory items cannot be archived until stock reaches zero.
- [x] Inventory purchase, issue, wastage and signed adjustment movements lock the item, enforce nonnegative stock and atomically update the balance, append the ledger row and audit the operation. Database triggers reject ledger updates/deletes.
- [x] Catalog services are validated and billed to open folios with integer-cent arithmetic, a catalog reference, immutable charge history and an audit record. Managers can read inactive services; folio-charge users can read active catalog entries.
- [x] The Operations workspace provides category, supplier, expense, inventory and catalog service workflows. Finance can add active catalog services to an open folio. Navigation is permission-gated.
- [x] Integration tests cover expense/supplier workflows, inventory stock changes and insufficient stock, immutable movement history, catalog billing, invalid dates, tenant references and role permission access.
- [x] Final validation: all 16 backend test files / 37 tests and all 3 frontend test files / 4 tests pass. `npm run lint` and `npm run build` pass. The Operations workspace was browser-checked.
- [x] Migration 018 (`20261022001800_expenses_inventory_services.js`) applied locally.

**Environment and validation notes:** validation ran against MySQL 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum; local success does not replace supported-server verification. Integration-test movement rows and folio charges are append-only history.

## Phase 13 — notifications and explainable, idempotent automation

**Status: implemented and locally verified; supported-database gate remains open.**

- [x] Migration 019 adds unique property-scoped automation rules and per-cycle dedupe keys, lookup indexes, and append-only triggers for automation logs. It is applied locally.
- [x] Eight scheduled rules cover arrivals, departures, overdue housekeeping tasks, room-blocking maintenance tickets, outstanding folio balances, unusual adjustment requests, no-show candidates and low stock. Checkout housekeeping stays event-driven in the existing checkout transaction.
- [x] Each scheduled match records its criteria, observed values, plain-language explanation, business date and target workspace. Notifications and immutable log rows are inserted atomically; per-property locking and unique dedupe constraints prevent repeat-run and concurrent-run duplicates.
- [x] The API server runs automation at startup and every five minutes, logs property-specific failures, and continues across other active properties. Authorized managers can run a property cycle, tune validated rule settings and review bounded logs.
- [x] Property-scoped role/user notifications include an unread count and retry-safe read acknowledgement. The topbar inbox link and Notifications page display explanations and allow marking notifications read.
- [x] Browser checks confirmed the Automation workspace, effective default settings, unread badge and Notifications inbox render without client-side errors.
- [x] Integration tests create one match for each scheduled rule, run the evaluator twice, and verify exactly one notification and one log per fixture; they also cover criteria/evidence, role visibility, read acknowledgement, invalid rule config, event-rule protection, log immutability and access control.
- [x] Final validation: all 17 backend test files / 39 tests and all 3 frontend test files / 4 tests pass. `npm run lint` and `npm run build` pass.
- [x] Migration 019 (`20261022001900_notifications_automation.js`) applied locally.

**Environment and validation notes:** test validation ran against MySQL 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum; supported-server verification remains required. Automation test log/notification records are intentionally retained as history after source fixtures are removed.

## Phase 14 — management dashboards and reports

**Status: implemented and locally verified on the available seeded dataset; supported-database and 50k-reservation performance gates remain open.**

- [x] Migration 020 adds indexed report access paths for folio charges/payments, reservations, stays, cashier shifts, housekeeping, maintenance, staff schedules/attendance and inventory movement. It is applied locally.
- [x] Reports APIs enforce `reports.view`, verify every selectable property against the caller's actual organization membership, cap date ranges at 366 days, and include financial aggregates/exports only for `reports.view_financial`.
- [x] Occupancy excludes distinct blocked room-nights; ADR/RevPAR use room charges; timestamps are filtered using property-local date boundaries converted to UTC. Folio-charge and open-balance reports reconcile to Finance arithmetic with integer-cent aggregation.
- [x] Role-oriented management, front-desk, cashier and housekeeping dashboards use live property data. The Reports workspace provides date/property filters, operational and financial report tables, a daily revenue chart, permission-safe drill-down links, CSV/PDF exports and print output; CSV formula prefixes are neutralized.
- [x] Tests cover hand-calculated occupancy/blocked-night and property-timezone fixtures, folio-charge and outstanding-balance reconciliation, financial-role withholding, property scope, invalid dates and CSV/PDF endpoints.
- [x] Final relevant validation: the full backend suite passed (19 files / 44 tests); after the final timezone-aware metric/API changes, the focused report suite passed (6 tests); all 3 frontend test files / 4 tests passed; project lint and build passed. Browser checks confirmed live overview tiles and the report workspace without current API/UI errors. On the available small seeded dataset, a report request measured approximately 0.8 seconds.
- [ ] The required generated 50k-reservation benchmark has not been run; the local database is MySQL 5.7.24, below the supported MySQL 8 / MariaDB 10.5 minimum. Repeat the performance and migration checks on a supported server before deployment.

**Environment and validation notes:** tests used the existing shared MySQL fixture; append-only ledger rows were retained. The complete 21-migration rollback and remigration gate subsequently passed on the dedicated disposable validation database. Phase 16 remains gated on completing the Phase 14 benchmark and supported-database validation.

## Phase 15 — platform administration, package limits and local licensing

**Status: implemented and locally verified; production licensing configuration and supported-database verification remain environment gates.**

- [x] Platform administration supports organizations, package assignment, subscription state, suspension, support-access approval/revocation, and scoped customer data export.
- [x] Package entitlements and limits are enforced in API routes and the UI. Suspended/cancelled organizations are denied normal operations while retaining session restoration, support exit, and data export paths.
- [x] Support access is property-scoped, time-bound, auditable, read-only, transactionally approved/revoked, and cannot refresh into a super-admin session or perform platform mutations.
- [x] Data export includes organization/property-owned records and necessary role, permission, user-property, and package relationships while excluding credentials and refresh tokens.
- [x] Local Ed25519 license validation checks document/key shape, organization and installation binding, module names, signature validity, and expiry/grace transitions. Invalid production license configuration fails closed.
- [x] Module-aware frontend navigation, support-mode restrictions, API tests for support and platform flows, plan/licensing tests, and frontend auth/navigation tests are in place.
- [x] All 21 migrations were applied and seeded, fully rolled back on the dedicated disposable validation database, then reapplied and reseeded successfully. The rollback exercised the conditional reservation index path.
- [x] Final validation: all 22 backend test files / 54 tests pass serially against the isolated database; all 3 frontend test files / 6 tests pass; project lint and production build pass.

**Environment and deployment gates:** the available database is MySQL 5.7.24, below the MySQL 8 / MariaDB 10.5 minimum. The Phase 14 50k-reservation benchmark is still outstanding. Production licensing requires the vendor's real Ed25519 public key and an externally protected private signing key; the guest PII encryption key must also be uniquely provisioned. Do not advance to Phase 16 until the remaining Phase 14 validation gates are satisfied.
