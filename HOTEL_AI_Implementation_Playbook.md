# SmartHotel Ethiopia — AI Implementation Playbook

How to use this file:

1. Save **Section 0 (Master Brief)** as `PROJECT_SPEC.md` in the repo root (or `CLAUDE.md` if you use Claude Code). Every phase prompt assumes the AI can read it.
2. Give the AI **one phase prompt at a time**, in order. Do not start the next phase until the current phase's **Done when** list passes.
3. After each phase, commit, then start the next prompt in a fresh session. The AI re-reads `PROJECT_SPEC.md` and `docs/PROGRESS.md` to pick up where it stopped.

Stack: React (Vite) + CSS · Node.js + Express · MySQL 8 · Socket.IO · jsonwebtoken · MAMP (dev) · Apache + Yegara Host (production)

**Assumption to confirm:** the proposal document uses the same stack and hosting as your restaurant system (React + Vite + CSS, Express, MySQL 8, MAMP, Apache, Yegara)


## 0. MASTER BRIEF (save as PROJECT_SPEC.md)

### 0.1 What we are building

**Smart Hotel Management System (SmartHotel Ethiopia):** an integrated platform for small and medium Ethiopian hotels, extensible to multi-property hotel groups. It manages property/room setup, reservations and availability, guests, check-in/checkout, housekeeping, maintenance, staff and shifts, guest folios, payments and receipts, cashier reconciliation, expenses, basic inventory and extra services, rule-based automation, and management dashboards and reports. It is sold as a **hybrid SaaS subscription / local licence** product.

Explicitly **out of scope** for the baseline (do not build, do not stub beyond a clean extension point): restaurant POS and kitchen management, OTA/channel-manager integrations, payment-gateway/bank integrations, statutory accounting and payroll, AI forecasting/assistants, full cloud-to-local offline sync, native mobile apps, smart locks/biometrics, ERP integrations, e-invoicing accreditation.

### 0.2 Tech stack (fixed — do not substitute)

| Layer     | Choice                                                                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend  | React 18 + Vite, plain hand-written CSS (CSS variables, responsive for desktop/tablet/phone). No Tailwind or UI kit. React Router. Small chart library allowed (e.g. Recharts). Interface language: English (keep all strings in one i18n-ready file).                     |
| Backend   | Node.js 20 LTS + Express, JavaScript (ES modules), `mysql2/promise`, `zod` validation, `pino` logging, `helmet`, `cors`, `express-rate-limit`, `bcrypt`, `node-cron` for in-process jobs                                                                                   |
| Real-time | Socket.IO, rooms per property and department, e.g. `p:7:frontdesk`, `p:7:housekeeping`, `p:7:maintenance`, `p:7:managers`. Must **fall back to long-polling** if the host blocks WebSocket upgrades.                                                                       |
| Database  | MySQL 8, InnoDB, utf8mb4, Knex migrations (SQL-level control; no heavy ORM)                                                                                                                                                                                                |
| Auth      | `jsonwebtoken` access token (15 min) + rotating refresh token stored hashed; configurable RBAC permissions; property-scope middleware                                                                                                                                      |
| Documents | Server-side HTML→PDF (e.g. Puppeteer or `pdfkit`) for invoices/receipts, plus print-friendly CSS (A4 and 80 mm) for browser printing                                                                                                                                       |
| Tests     | Vitest (unit/frontend), Supertest (API), Playwright (e2e), k6 or Artillery (load)                                                                                                                                                                                          |
| Dev       | **MAMP** MySQL (`127.0.0.1:3306`, root/root by default, all configurable), Node dev servers run natively — **no Docker**                                                                                                                                                   |
| Deploy    | Apache serves built React `dist/`; Node API runs on **Yegara Host** (cPanel "Setup Node.js App"/Passenger, or VPS plan); MySQL via cPanel; **hotel-local install** supported via the same code (Node + MySQL + Apache/MAMP on a hotel server). GitHub Actions for CI only. |

### 0.3 Tenancy model and roles

Hierarchy: **Organization** (a hotel business or group) → **Properties** (hotels) → rooms, users, data. Every operational row carries `property_id` (and the property carries `organization_id`).

Roles (permissions are configurable per role; defaults below): `owner_gm` (hotel owner / general manager), `front_desk`, `cashier_accountant`, `housekeeping_supervisor`, `housekeeping_staff`, `maintenance_staff`, `hr_manager`, `system_admin`, `auditor` (read-only). A separate **platform-level** `super_admin` (SmartHotel Ethiopia staff) manages organizations, packages and licences, and has no access to guest data unless explicitly granted for support.

### 0.4 Non-negotiable rules

1. **Tenant and property isolation:** `organization_id`/`property_id` always come from the JWT/session, **never from the request body**. Users only see properties they are explicitly assigned to; cross-property access (hotel groups) needs explicit grants. Violations return `403`. Tested in a permission matrix in CI.
2. **No double bookings, ever:** a stay night is the interval `[check_in_date, check_out_date)`. Room availability is enforced in the database, not just in application code (see Phase 6: `room_nights` table with `UNIQUE(room_id, night)` plus per-room-type locking for unassigned reservations). Concurrency-tested.
3. **Room state machine:** `AVAILABLE_CLEAN` → `OCCUPIED` → `AWAITING_CLEANING` → `BEING_CLEANED` → `AWAITING_INSPECTION` → `CLEAN` (assignable) ; plus `BLOCKED_MAINTENANCE` from/to any state with recorded clearance. A checked-out room **never** becomes assignable until inspected/approved (configurable "skip inspection" flag per property, off by default). Every transition is stored in `room_status_history`.
4. **Money:** `DECIMAL(12,2)` in ETB, never floats. All timestamps stored UTC, displayed in the property timezone (default `Africa/Addis_Ababa`). Stay dates are `DATE` in property-local time. A **business date** per property (advanced by night audit) drives daily reports.
5. **Financial integrity:** folio charges and payments are **append-only**. Corrections are new reversing/adjustment entries linked to the original, with reason, user and (above a configurable limit) a second user's approval. Nothing financial is ever updated or deleted. Invoice and receipt numbers are **gapless and sequential per property** (counter table with row lock). Closed cashier shifts are immutable.
6. **Audit log is append-only:** before/after JSON for reservations, rates, folio adjustments, refunds, permission changes, role changes, user changes, guest-PII views/exports, shift closures. No update/delete code path.
7. **Sensitive actions need authorization:** refunds, rate overrides, financial adjustments, permission changes, and deleting/cancelling past reservations require a permission, a reason, and approval above configurable thresholds.
8. **Tax is configurable, not hard-coded:** per property VAT %, service charge %, tourism levy % and whether prices are tax-inclusive. The system is **operational billing, not statutory accounting** and does **not** claim e-invoicing compliance; show a configurable disclaimer on invoices. (Ethiopian tax/invoicing requirements are confirmed before production use.)
9. **Guest privacy:** collect only what is needed. ID/passport numbers are **encrypted at rest** (AES-256-GCM, key from env), masked in the UI by default, with an audit entry when revealed. Configurable data-retention periods and a "anonymise guest" operation that preserves financial records.
10. **Soft delete only** for rooms, room types, guests, users, properties, rates. Historical records stay readable.
11. **Plan limits and feature flags:** the organization's package (Essential/Professional/Enterprise) limits rooms, users and enabled modules; enforced server-side with clear errors (Phase 15). Local-licence installs read a signed licence file.
12. **Automation is rule-based and explainable** (no AI): every automatic action (e.g. housekeeping task after checkout) records which rule fired and why.
13. Security baseline: bcrypt cost ≥ 12, zod validation on every endpoint, parameterised SQL only, rate-limited login, helmet, strict CORS, secrets only in env vars, no secrets in the repo, request-size limits.

### 0.5 Repository layout

```
smarthotel/
  apps/
    api/            # Express + Socket.IO
      src/{config,db,middleware,modules,realtime,jobs,services,utils}
      migrations/  seeds/  tests/
    web/            # React (Vite)
      src/{app,components,features,pages,realtime,styles,i18n}
  docs/{PROGRESS.md,API.md,RUNBOOK.md,DECISIONS.md,TEST_PLAN.md}
  deploy/{apache/.htaccess,cpanel-notes.md,local-install/}
  .github/workflows/
  PROJECT_SPEC.md
```

### 0.6 Working agreement for the AI (applies to every phase)

- **Start each phase by reading** `PROJECT_SPEC.md` and `docs/PROGRESS.md`, then post a short plan (files, endpoints, tables) before writing code.
- Work in small runnable steps. Run migrations, tests and dev servers yourself; never claim something works without running it.
- Write tests alongside code, targeting the phase's acceptance criteria. Extend the **permission/isolation matrix** test in every phase.
- API responses: `{ data }` on success, `{ error: { code, message, details? } }` on failure; paginate lists; document every endpoint in `docs/API.md` (method, path, permission, body, response).
- At the end of the phase: update `docs/PROGRESS.md` (done, deferred, open questions), list how to run/verify, and **stop**. Do not start the next phase.
- If the spec is ambiguous, choose the simplest option consistent with the rules above, record it in `docs/DECISIONS.md`, and continue.

---

## PHASE 1 — Repository, tooling and MAMP dev environment

_(Proposal Phase 3 start, week 1 of build)_

**Prompt:**

> Read PROJECT_SPEC.md. Set up the monorepo exactly as in section 0.5. Create `apps/api` (Express, ES modules, pino, helmet, cors, zod env-config loader that validates env vars on boot, `GET /api/health` that pings MySQL) and `apps/web` (Vite + React + React Router, plain-CSS design foundation: CSS variables for colour/spacing/type, responsive breakpoints, app shell with sidebar navigation, a central `i18n/en.js` strings file). Add ESLint + Prettier, Vitest in both apps, root npm workspaces with scripts `dev`, `test`, `lint`, `build`. **Do not use Docker.** Read DB settings from `.env` for MAMP (default host `127.0.0.1`, port `3306`, user `root`, password `root`; all configurable), add a `db:create` script that creates the utf8mb4 database if missing, add `.env.example` for MAMP-dev and production, and verify at boot that the server is MySQL 8 (or MariaDB ≥ 10.5), warning otherwise. Add a GitHub Actions workflow running lint + tests with a MySQL service. Create `docs/PROGRESS.md`, `DECISIONS.md`, `API.md`, `RUNBOOK.md` (with MAMP setup steps).

**Done when:**

- With MAMP's MySQL running, `npm run db:create` works; `npm run dev` runs API and web together; the web shell calls `/api/health` and shows DB status.
- `npm run lint && npm test` pass locally and in CI.

---

## PHASE 2 — Database schema, migrations and seed data

_(Proposal Phase 3: architecture and database model)_

**Prompt:**

> Write Knex migrations for the **complete** schema with foreign keys, indexes for the main query paths (property + dates + status), utf8mb4/InnoDB. Tables (all operational tables carry `property_id`):
> **Platform/tenancy:** `organizations(id,name,package_id,status,licence_mode enum[cloud,local],created_at)` · `packages(id,name,max_rooms,max_users,modules JSON,monthly_fee)` · `licences(id,organization_id,key,payload JSON,signature,valid_until)` · `properties(id,organization_id,name,address,city,phone,email,timezone,currency,business_date,check_in_time,check_out_time,tax_settings JSON,is_active)` · `users(id,organization_id,name,email unique,phone,password_hash,role_id,is_active,last_login_at,mfa_ready)` · `user_properties(user_id,property_id)` · `roles(id,organization_id nullable,name,is_system)` · `permissions(key,description)` · `role_permissions(role_id,permission_key)` · `refresh_tokens` · `audit_log(id,organization_id,property_id,actor_id,action,entity,entity_id,before JSON,after JSON,ip,created_at)` (append-only) · `system_settings`.
> **Rooms & rates:** `buildings` · `floors` · `room_types(id,property_id,name,description,max_adults,max_children,base_rate,is_active)` · `rooms(id,property_id,room_type_id,floor_id,room_number,status,housekeeping_priority,is_active, unique(property_id,room_number))` · `room_status_history` · `rate_plans(id,property_id,name,meal_plan,is_active)` · `rates(id,property_id,room_type_id,rate_plan_id,date_from,date_to,weekday_mask,amount,min_stay)` · `amenities`/`room_amenities` (optional).
> **Guests & bookings:** `guests(id,property_id/organization_id,first_name,last_name,phone,email,nationality,id_type,id_number_enc,id_number_hash,date_of_birth,notes,preferences JSON,is_vip,anonymised_at)` · `companies(id,name,tin,contact,credit_terms)` · `reservations(id,property_id,confirmation_no unique,primary_guest_id,company_id,group_id nullable,source enum[walk_in,phone,manual],status enum[tentative,confirmed,checked_in,checked_out,cancelled,no_show],check_in_date,check_out_date,adults,children,room_type_id,assigned_room_id nullable,rate_plan_id,total_estimate,special_requests,created_by,created_at)` · `reservation_rooms` (for multi-room/group bookings) · `reservation_guests` · `room_nights(room_id,night,reservation_id,property_id, UNIQUE(room_id,night))` · `groups(id,property_id,name,leader_guest_id,notes)` · `stays(id,property_id,reservation_id,room_id,checked_in_at,checked_out_at,status,key_card_count)` · `room_moves(id,stay_id,from_room_id,to_room_id,reason,approved_by,moved_at)`.
> **Finance:** `folios(id,property_id,stay_id,guest_id,company_id,status enum[open,closed],opened_at,closed_at)` · `folio_charges(id,folio_id,property_id,charge_type enum[room,service,minibar,laundry,tax,service_charge,levy,other],description,quantity,unit_amount,amount,business_date,reverses_charge_id nullable,posted_by,created_at)` · `folio_payments(id,folio_id,property_id,method enum[cash,bank_transfer,card_manual,mobile_manual,deposit_transfer],amount,reference,shift_id,is_deposit,reverses_payment_id nullable,received_by,created_at)` · `adjustments(id,folio_id,type enum[discount,correction,refund,write_off],amount,reason,requested_by,approved_by nullable,status,created_at)` · `invoices(id,property_id,folio_id,number,issued_at,totals JSON,pdf_path)` · `receipts(id,property_id,payment_id,number,issued_at)` · `number_counters(property_id,kind,next_value)` · `cashier_shifts(id,property_id,cashier_id,opened_at,closed_at,opening_float,expected_cash,counted_cash,variance,status,notes)` · `expenses(id,property_id,category_id,supplier_id nullable,amount,expense_date,reference,description,logged_by)` · `expense_categories` · `suppliers`.
> **Operations:** `housekeeping_tasks(id,property_id,room_id,type enum[checkout_clean,daily_clean,deep_clean,inspection,turndown],priority,status enum[pending,assigned,in_progress,awaiting_inspection,approved,rejected],assigned_to,due_at,started_at,completed_at,inspected_by,inspected_at,source_rule)` · `housekeeping_checklists`/`task_checklist_items` · `maintenance_tickets(id,property_id,room_id nullable,asset_id nullable,category,priority,description,status enum[open,assigned,in_progress,resolved,closed],blocks_room,assigned_to,reported_by,resolution_notes,opened_at,resolved_at,cleared_by,cleared_at)` · `assets` · `employees(id,property_id,user_id nullable,full_name,department_id,job_title,employment_status,hire_date,phone)` · `departments` · `shifts(id,property_id,name,start_time,end_time)` · `shift_assignments(id,employee_id,shift_id,date)` · `attendance(id,employee_id,date,clock_in,clock_out,overtime_minutes,source)` · `leave_requests(id,employee_id,type,date_from,date_to,status,approved_by)` · `handover_notes(id,property_id,department_id,author_id,body,created_at)` · `inventory_items(id,property_id,category_id,name,unit,quantity,reorder_level)` · `inventory_movements` · `service_catalog(id,property_id,name,price,category,is_active)` · `guest_requests(id,property_id,stay_id,type,description,status)` (complaints/service requests) · `notifications(id,property_id,user_id nullable,role nullable,type,payload JSON,read_at,created_at)` · `automation_rules(id,property_id,key,enabled,config JSON)` · `automation_log(id,property_id,rule_key,entity,entity_id,result,created_at)`.
> **Seed script (idempotent):** 1 super admin, 2 packages (Essential, Professional), 1 organization with 1 property, 20 rooms across 3 room types and 3 floors, default rates, one user for every role with sensible default permissions, default housekeeping checklist, expense categories, service catalog (laundry, minibar items), automation rules enabled by default, plus a **demo dataset script** (`db:seed:demo`) generating guests, reservations, stays and folios for testing. Add DB tests proving `UNIQUE(room_id, night)` and unique `(property_id, room_number)`.

**Done when:**

- `db:migrate`, `db:seed`, `db:seed:demo` work on a clean DB and are re-runnable; `db:rollback` works.
- Mermaid ER diagram added to `docs/DECISIONS.md`.

---

## PHASE 3 — Authentication, RBAC, tenancy and audit foundation

_(Proposal Phase 3: authentication, permissions, property setup, audit foundation)_

**Prompt:**

> Implement `POST /api/auth/login`, `/refresh` (rotating refresh tokens stored hashed with reuse detection), `/logout`, `GET /api/auth/me` (returns user, role, permission keys, assigned properties), `POST /api/auth/change-password`, password reset by admin. JWT payload `{ sub, orgId, role, propertyIds[], activePropertyId }`; add `POST /api/auth/switch-property`. Build middleware: `authenticate`, `requirePermission(key)` (permissions loaded from role_permissions, cached with invalidation), `propertyScope` (forces `req.propertyId` from the token, validated against `user_properties`), `requireModule(moduleKey)` (package feature flags, stubbed until Phase 15), and an `auditable()` helper that writes before/after JSON to `audit_log` inside the same transaction as the change. A repository helper must **always** inject `property_id` so developers can't forget. Define the full permission key list (e.g. `reservations.create|edit|cancel`, `checkin.perform`, `folio.post_charge`, `folio.adjust`, `refund.approve`, `rates.edit`, `housekeeping.assign|inspect`, `maintenance.manage`, `staff.manage`, `reports.view_financial`, `users.manage`, `audit.view`, `guest.view_id`) and map the nine default roles to them. API + UI for **user and role management** (create users, assign properties, edit role permissions within the agreed scope; every change audited). Login lockout after 5 failures for 15 minutes. UI: login, protected routes, role-based navigation showing only permitted modules, a property switcher, and a permission-aware API client (auto refresh + retry).
> Write the **permission/isolation matrix test** (every route × role × own/other property × allowed/denied). It runs in CI and is extended in all later phases.

**Done when:**

- Each seeded role logs in and sees only its permitted menu; a user from Property A calling a Property B resource gets `403`; body-supplied `propertyId` is ignored.
- Every user/role/permission change appears in the audit log with before/after values.

---

## PHASE 4 — Property setup: buildings, room types, rooms and rates

_(Proposal Phase 4: hotel and room configuration)_

**Prompt:**

> Build property configuration. **API + UI:** property profile (name, address, timezone, check-in/out times, currency, tax settings: VAT %, service charge %, tourism levy %, inclusive/exclusive), buildings and floors, room types (capacity, base rate, amenities), rooms (bulk-create by floor range and numbering pattern, e.g. 101–120), room activation/deactivation (soft), rate plans, and **rate rules** with date ranges, weekday masks, seasons and minimum stay. Implement a pure, unit-tested **rate calculator** `quote({roomTypeId, ratePlanId, checkIn, checkOut, adults, children})` returning per-night rates, taxes, levy, service charge and total using the property's tax settings; later rules override earlier ones deterministically (document precedence). Rate changes require `rates.edit`, a reason, and an audit entry; past-dated rates cannot be changed without an override permission. Add a **room rack/grid** screen (rooms × floor with live status colours) as the reusable status component for later phases. Add a property **business date** field (advanced only by night audit, Phase 8).

**Done when:**

- A manager can configure a 20-room property end-to-end from the UI; the rate calculator passes a table of test cases (weekend rate, season override, min-stay violation, tax-inclusive vs exclusive).

---

## PHASE 5 — Guest management

_(Proposal Phase 4: guest records and registration)_

**Prompt:**

> Implement guests (§4.2). CRUD with profile, contact info, nationality, preferences, VIP flag, notes; **ID/passport numbers encrypted at rest** with a searchable HMAC hash for duplicate detection (never store plaintext); masked in responses unless the caller has `guest.view_id`, and each reveal writes an audit entry. Duplicate detection (same phone/email/ID hash) with a merge tool that re-links reservations, stays and folios and audits the merge. Stay history per guest, repeat-guest flag, **group and corporate** records (companies with TIN and credit terms; groups with a leader and members). Guest complaints and service requests (`guest_requests`) with status workflow and assignment to a department. Privacy controls: configurable retention period, `anonymise guest` (replaces PII with placeholders but keeps folios and totals intact), and a guest data export. UI: guest search (name, phone, ID last 4), guest profile with history tab, merge dialog, requests list.

**Done when:**

- ID numbers are never present in plaintext in the DB or logs (verified by a test that scans a DB dump); revealing an ID is audited; anonymisation keeps financial totals unchanged; the permission matrix covers all guest routes.

---

## PHASE 6 — Reservations and availability engine

_(Proposal Phase 4: reservations and availability management)_

**Prompt:**

> Build the reservation core with **database-enforced no-overlap**. (1) **Availability service:** `getAvailability(propertyId, from, to, roomTypeId?)` returns free room counts per type per night, honouring `BLOCKED_MAINTENANCE` rooms, out-of-service rooms and existing reservations. (2) **Creating a reservation** runs in one transaction: lock the room type row (`SELECT … FOR UPDATE`), re-check availability, insert the reservation (status `confirmed` or `tentative`), generate `confirmation_no`, and — when a specific room is assigned — insert one `room_nights(room_id, night, reservation_id)` row per night; the `UNIQUE(room_id, night)` constraint is the final safety net, and a duplicate-key error is translated to a clean `409 ROOM_UNAVAILABLE`. (3) Unassigned reservations reserve **type-level inventory**; assigning a room later inserts room_nights. (4) Support walk-in/phone/manual sources, modify dates or room type (re-check and rewrite room_nights atomically), **extensions**, cancellations (with reason and optional cancellation fee posted later), no-show marking (job-assisted in Phase 13), multi-room/group bookings, deposits requested (recorded at Phase 8), room moves before arrival, and a full status/history trail with audit entries. (5) Endpoints for arrival and departure lists. (6) UI: **reservation calendar/timeline** (rooms on Y axis, dates on X, drag to move/extend with validation), new-reservation wizard (dates → availability → room type/rate quote from Phase 4 → guest → confirm), reservation detail drawer, search by name/confirmation/phone, arrivals/departures boards.
> **Concurrency tests are mandatory:** 50 parallel requests for the last remaining room must produce exactly one success; overlapping extensions and room moves must never double-book.

**Done when:**

- No scenario in the concurrency suite can create two confirmed reservations on one room-night; modifying/cancelling frees room-nights correctly; the calendar reflects changes live across two browser tabs.

---

## PHASE 7 — Check-in, stay management and checkout

_(Proposal Phase 4: check-in, checkout, stay management)_

**Prompt:**

> Implement the guided workflows in §4.3 as server-enforced state machines. **Check-in** (`POST /api/reservations/:id/check-in`): retrieve reservation or register a walk-in (creates guest + reservation + stay in one transaction); verify guest details and required ID capture (property-configurable); assign a room only if its status is `CLEAN` and not blocked (clear error otherwise, with a list of assignable alternatives); record rate, deposit and payment terms; create the **stay** and the **folio**; set room to `OCCUPIED`; write status history and audit. **During the stay:** extend stay, shorten stay (with authorization), **room move** (reason, approval if rate changes, updates room_nights, previous room → `AWAITING_CLEANING`, folio keeps continuity), add guests, log guest requests. **Checkout** (`POST /api/stays/:id/check-out`): block while the folio has an unsettled balance unless the user has an "approve credit/city ledger" permission and records a reason; apply authorized adjustments; produce invoice/receipt (Phase 8 hooks); close folio and stay; room → `AWAITING_CLEANING`; **emit event so the automation rule creates the housekeeping task** (Phase 9/13). Late-checkout and early-check-in options with configurable fees. UI: arrivals list with one-click check-in wizard, in-house guests list, stay detail (folio summary, move/extend actions), checkout wizard with balance and receipt step, walk-in flow optimised for speed (target under 60 seconds with keyboard-only operation).

**Done when:**

- Checking in a guest to a dirty or blocked room is rejected; a checkout with a balance is blocked without approval; a full walk-in → stay → checkout flow works and every transition appears in room and audit history.

---

## PHASE 8 — Folios, payments, invoices and cashier shifts

_(Proposal Phase 4: guest folios, payment records, invoices and receipts)_

**Prompt:**

> Implement billing (§4.7) with append-only integrity. **Folios:** automatic room-charge posting by a **night audit** job/endpoint (`POST /api/night-audit/run`) that posts each in-house stay's nightly rate (plus tax, service charge, levy per property settings), advances the **business date**, records the run in an audit log, is idempotent per business date, and can be re-run safely after a failure; manual posting of services/minibar/laundry from the service catalog (Phase 12) and ad-hoc charges. **Payments:** cash, bank transfer (reference required), manually-recorded card and mobile-money payments (no gateway integration), deposits (held on the folio and applied at checkout), split payments across methods, partial payments, overpayment → approved credit balance. **Corrections:** voids/refunds/discounts are _new_ entries referencing the original (`reverses_*_id`), require reason, and need a second approver above a configurable amount; unusual adjustments (amount or percentage above thresholds) raise a warning event (Phase 13). **Documents:** gapless sequential invoice and receipt numbers per property using the `number_counters` row lock; PDF and print-friendly HTML (A4 and 80 mm) with property header, tax breakdown, configurable disclaimer ("operational invoice — not a statutory tax invoice unless stated"), duplicate/reprint marking. **Cashier shifts:** open shift with float, every payment tied to the open shift, close shift with counted cash → expected vs counted variance, immutable once closed, shift report; payments without an open shift are rejected (configurable). **Expenses basics** arrive in Phase 12. UI: folio screen (charges/payments timeline, balance, quick-post buttons, split-payment dialog), cashier console (open/close shift, today's collections), adjustment approval inbox for managers, invoices/receipts list with reprint.
> **Property tests:** for any sequence of operations, `balance = Σcharges − Σpayments ± adjustments` computed from raw rows equals the API balance; the invoice number series has no gaps under 20 concurrent issuances.

**Done when:**

- A stay's folio reconciles to the cent after charges, split payments, a refund and a discount; closed shifts cannot be edited; numbering has no gaps or duplicates under concurrency; night audit can be re-run without double-posting.

---

## PHASE 9 — Housekeeping and room readiness

_(Proposal Phase 5: housekeeping task management and room readiness)_

**Prompt:**

> Implement §4.4. Task model with types (checkout clean, daily clean, deep clean, inspection, turndown), priority, due time and **checklists** (templates per room type, copied onto the task). Assignment by room, employee or team with a supervisor board (drag-and-drop or bulk assign), staff mobile view (large buttons: start, complete checklist items, mark ready for inspection, report an issue → creates a maintenance ticket draft in Phase 10), progress and completion timestamps, **supervisor inspection** (approve → room `CLEAN`; reject with reason → back to `BEING_CLEANED`), overdue-task flag, and priority rules (e.g. same-day arrivals first — implemented as configurable rules with an explanation shown to supervisors). Enforce the room state machine from §0.4 rule 3 (also guarded by the DB layer): rooms leave `AWAITING_CLEANING` only via housekeeping workflow, and become assignable only at `CLEAN`. Live room-status dashboard for front desk and housekeeping (reuse the rack component) updated through Socket.IO rooms `p:{id}:housekeeping` and `p:{id}:frontdesk`. Reports: room readiness, average cleaning time per room type and per employee, overdue tasks. Staff see only their own tasks (matrix test).

**Done when:**

- Checkout creates a task (via the event hook even before Phase 13's scheduler exists); the room is unassignable until inspection approval; two housekeepers cannot start the same task; the status board updates live on the front desk screen.

---

## PHASE 10 — Maintenance and room blocking

_(Proposal Phase 5: basic maintenance ticket management)_

**Prompt:**

> Implement §4.6. Tickets with category, priority, description, photo attachments (store in a local `uploads/` directory with type/size limits and an abstraction ready for object storage), assignment, status workflow `open → assigned → in_progress → resolved → closed`, resolution notes, repair history per room and per asset, overdue alerts, and assets register (basic). **Room blocking:** a ticket flagged `blocks_room` sets the room to `BLOCKED_MAINTENANCE` (with date range) and **removes it from availability**; if it overlaps an existing reservation the system lists affected reservations and requires the front desk to relocate them (workflow) — it must never silently break a reservation. Clearing a block requires an authorized user and a clearance record; the room then goes through housekeeping before being assignable. Notifications to the maintenance team and front desk. UI: maintenance board (kanban by status), ticket detail with timeline, "report issue" from room rack and from housekeeping mobile view, room history tab.

**Done when:**

- Blocking an occupied-in-future room surfaces the affected reservations; a blocked room never appears in availability or check-in assignment; clearance is audited.

---

## PHASE 11 — Staff and workforce management

_(Proposal Phase 5: staff accounts, roles, employee records, and shift management)_

**Prompt:**

> Implement §4.5. Employee profiles (linked optionally to user accounts), departments, job titles, employment status; **shift planning** (shift templates, weekly roster grid with drag-and-drop, conflict detection for double-booking an employee or exceeding configured weekly hours); **attendance** (clock-in/out by staff on their device, manager corrections with reason and audit, overtime calculation from configurable rules); **leave requests** with approval workflow and balance tracking; **handover notes** per department/shift with read receipts; department task lists; supervisor oversight and basic performance indicators (attendance rate, task completion, overdue rate); **payroll-ready attendance summaries** (CSV per period). Explicitly no statutory payroll calculations. HR can see all employee records; supervisors only their department; employees only their own. Leave/attendance approvals emit notifications.

**Done when:**

- Roster conflicts are detected; overtime hours reconcile with attendance rows; the attendance CSV matches a hand-computed fixture; access rules pass the matrix test.

---

## PHASE 12 — Expenses, suppliers, basic inventory and additional services

_(Proposal Phase 5: basic inventory and expense recording)_

**Prompt:**

> Implement §4.7 expense recording and §4.8. **Expenses:** categories (admin-extendable), amount, date, supplier, reference, description, attachment; edit/delete via soft-delete with audit; period totals by category. **Suppliers:** basic records with contact and purchase history. **Inventory:** stock items with categories and units, opening balances, movements (purchase, issue, adjustment, wastage) all recorded in `inventory_movements`, reorder levels with low-stock alerts, purchase records linking supplier + items + optional expense. **Additional services:** `service_catalog` (laundry, minibar, other approved services, with price and tax class) and **manual posting to the guest folio** from the stay screen or from housekeeping (minibar consumption entry), each posting creating a folio charge plus an optional inventory issue. Permissions separate "post to folio" from "manage catalog". UI: expense tracker, supplier list, inventory screen with movement history and low-stock banner, one-click service posting on the folio. Explicitly **not** a restaurant POS or recipe costing system.

**Done when:**

- Posting a minibar item creates a correct folio charge and decrements stock once; low-stock alert fires once per crossing; expense totals reconcile to entries.

---

## PHASE 13 — Notifications and rule-based automation

_(Proposal Phase 5: basic rule-based alerts and workflow automation)_

**Prompt:**

> Build a `NotificationService.notify({ propertyId, userId|role, type, payload })` that stores a row, emits to the right Socket.IO room, and appears in a bell/notification centre (unread counts, mark read, per-user mute). Build the **rule engine** (`automation_rules` per property, enable/disable and thresholds editable by owner/GM; every execution logged in `automation_log` with the rule key and reason): (1) housekeeping task auto-created after checkout; (2) upcoming arrivals/departures reminders to front desk (X hours before, configurable); (3) overdue housekeeping/maintenance task alerts to supervisors; (4) block-room rule when a blocking maintenance ticket opens; (5) highlight guests with outstanding balances (in-house and at checkout day) to the cashier; (6) warn authorised users about unusual financial adjustments (above amount/percentage thresholds or repeated adjustments by the same user); (7) no-show candidates list after a configurable cut-off time; (8) low-stock alerts. Jobs run in-process with `node-cron`, **derive state from the DB on every run (idempotent, restart-safe)**, and are also callable through a secured `/api/internal/cron` endpoint so **cPanel cron jobs** can trigger them every minute if the host idles the Node app. Socket.IO client must automatically fall back to long-polling and re-sync on reconnect.

**Done when:**

- Each of the eight rules has a test that triggers it and asserts exactly one notification and one automation_log row, even if the job runs twice; restarting the server mid-day does not duplicate or lose alerts.

---

## PHASE 14 — Management dashboard and reports

_(Proposal Phase 5: management dashboard and agreed standard reports)_

**Prompt:**

> Build the reporting layer (§4.9) with documented metric definitions in `docs/DECISIONS.md`: **occupancy %** = occupied room-nights ÷ available room-nights (excluding blocked rooms, documented), **ADR** = room revenue ÷ occupied room-nights, **RevPAR** = room revenue ÷ available room-nights, plus current occupancy, available/occupied/out-of-service rooms, arrivals and departures, reservations and cancellations (with lead time and cancellation rate), revenue by day/week/month and by room type, payments received and outstanding balances (ageing), cashier reconciliation (variance per shift/cashier), housekeeping completion and average cleaning time, maintenance issues (open/overdue/mean time to resolve), staff attendance and shift coverage, expenses by category and basic inventory movement. All reports support date ranges, property filter (for groups, only assigned properties), CSV export and print/PDF. Use indexed SQL aggregations; add daily summary rollup tables updated by night audit if queries exceed 500 ms on the demo dataset (generate ≥ 50k reservations for testing). Financial reports **must reconcile to the underlying folio rows** — add reconciliation tests. Dashboards by role: GM/owner overview, front desk today, cashier today, housekeeping supervisor today. UI: charts, KPI tiles, drill-down from a number to the underlying records.

**Done when:**

- Occupancy, ADR and RevPAR match hand-computed fixtures; revenue totals equal the sum of folio charges for the period; every report enforces property scope and `reports.view_financial`; dashboards render in under 2 s on the large demo dataset.

---

## PHASE 15 — Platform administration, packages and licensing

_(Commercial model: cloud subscription and local licence)_

**Prompt:**

> Build the **platform layer** for selling the product. A separate super-admin console (route-protected, `super_admin` only): create/suspend organizations, create properties, assign packages (Essential, Professional, Enterprise with custom limits), view usage (rooms, users, active modules), subscription status and billing notes (manual invoicing — no payment gateway). Implement **plan enforcement** in the API: `max_rooms`, `max_users`, enabled `modules` (e.g. staff, maintenance, inventory, reports) are checked server-side with clear error codes (`PLAN_LIMIT_ROOMS`, `MODULE_DISABLED`); the UI hides disabled modules and explains upgrades. Implement **licence files for local installs:** an Ed25519-signed JSON licence (organization, max rooms/users, modules, expiry, hardware/installation ID) verified at startup with an embedded public key, a grace period after expiry with warnings, read-only mode afterwards (data is never locked away; export always works), and a `tools/issue-licence.js` script for the vendor (private key kept offline, never in the repo). Add a **data export** for customers (full CSV/JSON export of their data) to satisfy the "data export arrangements" promised in the contract, and a support-access feature: time-limited, audited super-admin impersonation that requires the customer's approval.

**Done when:**

- Exceeding the room limit is rejected; disabling a module blocks its API and hides its UI; a tampered or expired licence behaves as specified; super-admin access to guest data is impossible without an approved support session.

---

## PHASE 16 — Hardening, QA, security and load testing

_(Proposal Phase 6: testing and deployment preparation)_

**Prompt:**

> Do a full quality pass and produce `docs/TEST_PLAN.md` and `docs/QA_REPORT.md`. (1) **Security:** extend the permission/isolation matrix to every route; verify tenant isolation with two organizations; `npm audit`; input-fuzz tests on all write endpoints; JWT expiry/refresh-reuse behaviour; strict CSP/CORS/cookie flags; SQL-injection/XSS checks; request-size limits; verify PII encryption and masking; confirm no secrets in the repo; test backup **restore** from a mysqldump on a clean MAMP DB. (2) **E2E (Playwright)** the day-in-the-life: setup property → create rates → book a reservation → check in → post charges → take split payment → night audit → checkout → housekeeping task created → clean → inspect → room assignable again → close cashier shift → dashboards show correct numbers; plus a maintenance block, a refund requiring approval, and a group booking. (3) **Concurrency:** repeat the double-booking and invoice-numbering suites at higher load. (4) **Load (k6/Artillery):** 5 properties × 30 concurrent users, realistic mixes, p95 API latency < 500 ms for core flows and < 2 s for reports. (5) **Resilience:** API restart mid-night-audit, DB reconnect, socket reconnect re-sync, host idle spin-down. (6) **Usability:** keyboard-only front-desk flow, tablet layout for housekeeping, contrast/accessibility checks. Fix every defect; the QA report lists results and known limitations against the acceptance criteria in proposal §12 and KPIs in §13.

**Done when:**

- All suites green in CI; zero cross-tenant leaks; zero double bookings and zero numbering gaps under load; all functional and technical acceptance scenarios from the proposal pass; no unresolved critical defects.

---

## PHASE 17 — Deployment, documentation, training and pilot

_(Proposal Phase 7: pilot, training, and launch)_

**Prompt:**

> Productionise for **both** deployment models, without Docker. **Cloud (Yegara + Apache):** `npm run build` → `apps/web/dist` served by Apache with `deploy/apache/.htaccess` (SPA fallback excluding `/api` and `/socket.io`, gzip/brotli, long-cache hashed assets, no-cache for `index.html`, HTTPS redirect, security headers); API via cPanel **Setup Node.js App** (or PM2 + `mod_proxy`/`mod_proxy_wstunnel` on a VPS); MySQL via cPanel; env vars set in cPanel; Socket.IO long-polling fallback verified; cPanel cron hits `/api/internal/cron` every minute; nightly `mysqldump` with retention and a documented restore drill; manual deploy steps plus an optional GitHub Actions job that builds and uploads via SFTP and restarts the app; smoke tests and rollback checklist; `deploy/cpanel-notes.md` listing questions for Yegara support (Node version, WebSocket support, MySQL 8 vs MariaDB, SSH, cron, idle timeout, process/RAM limits). **Hotel-local:** `deploy/local-install/` with a step-by-step guide and scripts for a hotel server (Windows or Linux): install Node + MySQL 8 + Apache (or MAMP), set up the app as a service (PM2/NSSM), local TLS or LAN-only HTTP guidance, scheduled backups to an external drive, restore steps, update procedure, licence installation, and a **pre-installation readiness checklist** (server hardware, network, power/UPS, backup responsibility, support access). Document the cloud-vs-local trade-offs and the **explicit non-support of simultaneous cloud+local offline sync** in `RUNBOOK.md`. **Handover docs:** `RUNBOOK.md`, admin guide, role-by-role **user guides** with screenshots (front desk, cashier, housekeeping, maintenance, HR, GM), **staff training scripts and quick-reference cards**, data-migration template (CSV import for rooms, guests, opening balances) with validation report, a **pilot plan** (scope, success measures from proposal §13, baseline measurement sheet for check-in time, coordination delays, booking conflicts and end-of-day reporting time, feedback log, go/no-go criteria), and a known-limitations/future-work list matching proposal §15.

**Done when:**

- Following RUNBOOK.md alone gets a working system on the Yegara account **and** on a clean local server; restore from backup yields a working system; the CSV import loads a sample property; the pilot plan and training material are ready for the hotel.

---

## Phase order cheat-sheet

| #   | Phase                                                   | Proposal phase   | Est. weeks |
| --- | ------------------------------------------------------- | ---------------- | ---------- |
| 1   | Repo, tooling, MAMP dev environment                     | 3                | 1          |
| 2   | Schema, migrations, seeds                               | 2–3              | 1–2        |
| 3   | Auth, RBAC, tenancy, audit                              | 3                | 2–3        |
| 4   | Property, rooms, rates                                  | 4                | 2          |
| 5   | Guests                                                  | 4                | 1–2        |
| 6   | Reservations and availability engine                    | 4                | 2–3        |
| 7   | Check-in, stay, checkout                                | 4                | 2          |
| 8   | Folios, payments, invoices, cashier shifts, night audit | 4                | 2–3        |
| 9   | Housekeeping and room readiness                         | 5                | 1–2        |
| 10  | Maintenance and room blocking                           | 5                | 1          |
| 11  | Staff and workforce                                     | 5                | 1–2        |
| 12  | Expenses, suppliers, inventory, services                | 5                | 1–2        |
| 13  | Notifications and automation                            | 5                | 1–2        |
| 14  | Dashboards and reports                                  | 5                | 2          |
| 15  | Platform admin, packages, licensing                     | commercial model | 1–2        |
| 16  | Hardening, QA, load testing                             | 6                | 3–4        |
| 17  | Deployment, docs, training, pilot                       | 7                | 2–3        |
