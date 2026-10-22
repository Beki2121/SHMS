# SmartHotel implementation plan

Build the system in the 17 gated phases in `PROJECT_SPEC.md`. Complete each phase's acceptance checks, update `docs/PROGRESS.md`, and stop for review before advancing. Keep the security, tenancy, append-only finance, and booking invariants from the Master Brief in scope throughout implementation.

| Phase | Scope | Gate |
|---|---|---|
| 1 | Repository, tooling, MAMP and health-check foundation | API and web run together; DB create works; lint and tests pass locally and in CI |
| 2 | Complete schema, Knex migrations, seed and demo data | Clean and repeatable migrate/seed/rollback; uniqueness constraints verified |
| 3 | Authentication, RBAC, tenancy, audit and user/role UI | Permission/isolation matrix passes; no cross-property access |
| 4 | Property setup, rooms, rates and quoting | Property configured in UI; rate calculator fixtures pass |
| 5 | Guest records, privacy, company/group records and requests | ID encryption/masking, audit reveal, anonymisation checks pass |
| 6 | Reservations, availability, room nights and calendar | Concurrency suite proves no double bookings |
| 7 | Check-in, stays, room moves, checkout and walk-ins | State-machine and full stay flow checks pass |
| 8 | Folios, payments, night audit, documents and cashier shifts | Ledger reconciliation, idempotency and gapless numbering checks pass |
| 9 | Housekeeping tasks, checklists and room readiness | Room cannot be assigned until inspection; live status updates work |
| 10 | Maintenance tickets, assets and room blocking | Conflicts surfaced; blocked rooms excluded; clearance audited |
| 11 | Staff, departments, rosters, attendance, leave and handovers | Conflict, overtime, CSV and access checks pass |
| 12 | Expenses, suppliers, inventory and additional services | Stock and folio reconciliation checks pass |
| 13 | Notifications and explainable, idempotent automation | All eight rules produce one notification/log entry on repeat runs |
| 14 | Dashboards, reports, exports and metric definitions | Fixtures reconcile; scoped reports meet the performance target |
| 15 | Platform administration, package limits and local licensing | Limits enforced; signature and support-access rules verified |
| 16 | Security, QA, concurrency, load and resilience | Suites green; zero leaks, duplicate bookings, or numbering gaps |
| 17 | Cloud/local deployment, docs, training and pilot readiness | Runbook deploy and restore drills succeed; handover materials ready |

## Current execution

Phases 1–15 are implemented. Phase 15 passed local checks, including the full backend/frontend suites, lint, build, and rollback/remigration of all 21 migrations on a dedicated disposable database. Phase 16 is not started: Phase 14's generated 50k-reservation benchmark and supported MySQL 8 / MariaDB 10.5 verification remain open, and must be completed before advancing. Production also requires a unique guest encryption key and the real vendor license public key; the private signing key must remain outside the repository. See `docs/PROGRESS.md` for detailed validation notes.
