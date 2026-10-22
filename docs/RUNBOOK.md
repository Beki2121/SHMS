# SmartHotel Runbook

## Local development with MAMP

1. Install Node.js 20 LTS and MAMP for Windows or macOS. Docker is not used.
2. Start the MySQL server from MAMP. The default MAMP MySQL port in this project is `3306`.
3. Copy `.env.example` to `.env`. Defaults are host `127.0.0.1`, port `3306`, database `smarthotel`, user `root`, password `root`. Change these values if the local MAMP configuration differs.
4. From the repository root run `npm install`.
5. Create the local database with `npm run db:create`.
6. Start both development servers with `npm run dev`. The API listens on `127.0.0.1:3000`; Vite serves the web app at `http://localhost:5173` and proxies `/api` to the API.
7. The dashboard health banner reports whether both the API and database are available.

## Useful commands

- `npm run lint` — lint JavaScript and JSX.
- `npm test` — run API and web Vitest suites.
- `npm run build` — validate the API entry point and build the web app.
- `npm run db:create` — create the configured utf8mb4 database if missing.

## Production environment

Configure environment variables in the hosting control panel. Do not upload `.env` or commit credentials. See `.env.example` for the variable names. Production deployment is documented in a later phase.
