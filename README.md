# SmartHotel Ethiopia

SmartHotel is a hotel operations platform for Ethiopian hotels, built in gated phases from the implementation playbook.

## Project layout

- `backend/` — Express API, MySQL connection, environment validation, health endpoint, and API tests.
- `frontend/` — React 18, Vite, React Router, responsive CSS, English interface strings, and web tests.
- `docs/` — implementation progress, API notes, decisions, runbook, and phase roadmap.
- `PROJECT_SPEC.md` — product, architecture, security, and phase requirements.

## Local development

1. Install Node.js 20 LTS and start MySQL from MAMP.
2. Copy `.env.example` to `.env`; the MAMP defaults use `127.0.0.1:3306`, user `root`, password `root`.
3. Run `npm install` from the repository root.
4. Run `npm run db:create` to create the utf8mb4 database.
5. Run `npm run dev` to start the API and Vite frontend.
6. Open `http://localhost:5173`. The dashboard displays API/database health.

Run `npm run lint`, `npm test`, and `npm run build` for the local checks.

Phases 1–15 are implemented, including guest privacy, transactional reservations, front-desk stay operations, append-only folio billing, cashier reconciliation, night audit, invoice/receipt documents, housekeeping room readiness, maintenance workflows, staff operations, expenses, inventory, additional services, automation, role-oriented reports, and platform administration with package limits, licensing, and approved support access. Phase 15's backend/frontend suites, lint, build, and disposable rollback/remigration checks pass. Phase 14's generated 50k-reservation benchmark and supported-server verification remain outstanding, so Phase 16 is not started. The available database reports MySQL 5.7.24, below the required MySQL 8 / MariaDB 10.5 minimum; upgrade it or verify on a supported server before deployment. Production requires a unique stable `GUEST_PII_ENCRYPTION_KEY` and the vendor's real license public key; keep the private signing key outside the repository. See [docs/PROGRESS.md](docs/PROGRESS.md) for verification status and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the phase gates.
