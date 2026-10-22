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
  backend/          # Express API
    src/{config,db,middleware,modules,realtime,jobs,services,utils}
    migrations/  seeds/  tests/
  frontend/         # React (Vite)
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
