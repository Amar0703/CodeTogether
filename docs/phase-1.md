# Phase 1 status and deployment

The implementation covers authentication, dashboard, room CRUD, membership, invitations, file/folder operations, CodeMirror, persistence, and basic permissions. API integration tests exercise two-account access, conflict prevention, authorization, authentication, expiry, and cascade behavior. The browser acceptance test exercises signup, a shared room, saving, refresh persistence, nested files and a viewer account.

## Local verification

Verified on 6 October 2026 with Node 24 on Windows:

- All 11 API and database-persistence tests passed using PGlite, including closing and reopening the on-disk database.
- The Chromium two-account acceptance test passed, including nested-file rename, viewer restrictions, and desktop/mobile layout checks.
- Desktop dashboard/editor and mobile dashboard/editor/login screenshots were visually inspected.
- `npm run lint`, `npm run typecheck`, and `npm run build` passed.
- The dependency audit reported zero vulnerabilities after updating Drizzle.

The PostgreSQL-server CI job is configured but has not been run on a hosted runner in this local task. No public deployment or load/performance test was performed.

## Remaining external acceptance step

The blueprint also asks for a deployed demo before Phase 2. For this iteration, the requested delivery is local only. Provision PostgreSQL and two Node services when ready, then follow the deployment sequence below and repeat the two-account demo over HTTPS. No live deployment is claimed.

## Deployment sequence

1. Provision a PostgreSQL database with a private connection URL, backups, and provider-required TLS.
2. Run `npm ci` and `npm run build` from the repository root.
3. Configure the API service with `NODE_ENV=production`, `DATABASE_URL`, `APP_ORIGIN=https://your-app.example`, `API_PORT=4000` and `API_HOST=0.0.0.0` if it must accept requests from another service.
4. Run `npm run db:migrate` once, with those API variables available. Start the API with `npm run start --workspace=@codetogether/api`.
5. Set `API_URL` in the web build environment to the private API address. Rebuild the web app when changing it: Next.js rewrites capture this value at build time. Start the web service with `npm run start --workspace=@codetogether/web -- --hostname 0.0.0.0 --port 3000`.
6. Put HTTPS in front of the web service. Keep the API private and route browser API calls through Next.js. Use `/api/health` as a readiness check.
7. Create two real accounts, invite the second account, save and reload a file, verify viewer restrictions, and restart the API to confirm database persistence.

`APP_ORIGIN` must exactly match the browser origin without a trailing slash. Production refuses to start without a PostgreSQL URL and HTTPS app origin. Do not expose local Compose credentials or commit `.env` files. The default API listener is loopback for local development.

## Deliberately deferred blueprint phases

- Phase 2: sockets, presence, live chat and room events.
- Phase 3: CRDT editing, cursors, reconnect synchronization and historical snapshots.
- Phase 4: voice/video and TURN.
- Phase 5: isolated execution, queues and workers.
- Phases 6–7: distributed rate limits, observability, deployment automation, abuse controls, scaling and measurements.

Production hardening still includes email verification/password reset, session management and expiry cleanup, invite revocation, room/file quotas, more complete pagination, and operational monitoring. No performance or scale claims have been measured for this phase.
