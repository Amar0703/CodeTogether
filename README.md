# CodeTogether

A shared coding workspace built from Phase 1 of the project blueprint. Two authenticated users can join the same room, open the same persisted files, and work in a syntax-highlighted editor with explicit save and refresh controls.

## Run locally

Requires Node.js 22 or newer and npm. Node 24 is used in CI.

```sh
npm install
npm run dev
```

Open **http://localhost:3000** and create an account. The API listens on `127.0.0.1:4000`. Next.js proxies `/api` requests so the browser uses one origin and secure cookie semantics.

The default development database is **PGlite**, an embedded PostgreSQL runtime persisted in `.data/postgres`. It requires no database installation. Stopping and restarting the application preserves accounts, memberships, rooms, invitations and files. Run only one local API process against this directory. This is a development convenience; production requires a PostgreSQL server.

### Use a PostgreSQL server

```sh
docker compose -f infra/compose.yaml up -d
```

Copy `apps/api/.env.example` to `apps/api/.env`, uncomment `DATABASE_URL`, then run:

```sh
npm run db:migrate
npm run dev
```

The example Compose credentials are for local development. Local PGlite data is separate from a configured PostgreSQL server; switching drivers does not transfer existing records.

## Phase 1 features

- Email/password registration, login, logout, and protected API access.
- Password hashing with Node scrypt; hashed opaque session tokens; HttpOnly, SameSite cookies.
- Dashboard with search, creation, and invitation/public-link joining.
- Private/public rooms, descriptions, room settings, deletion, and membership.
- Expiring invitations with editor or viewer access; only owners can invite, remove others, and change roles. Existing members retain their role when reusing an invite.
- File and folder creation, rename, deletion, nested explorer, and syntax highlighting for JS/TS, Python, C/C++, JSON, HTML, CSS, and Markdown.
- Persistent save/load, Ctrl/Cmd+S, dirty-state prompts, viewer read-only mode, and conflict recovery with draft download.
- Optimistic concurrency: an outdated save returns `409 VERSION_CONFLICT` and preserves both the stored file and the client draft.
- Backend authorization, validated inputs, authentication rate limits, and a same-origin CSRF check.

Public rooms require a signed-in account. Anyone with a public room link can join as a **viewer**. Private rooms require an invitation. Room lists show the 100 most recently updated memberships.

## Try the two-account milestone

1. Create an account and a room in one browser.
2. Click **Invite**, choose Editor, generate and copy the link.
3. Open a separate browser profile or private window, follow the link, create another account, and accept the invitation.
4. Save changes as either account. Click **Refresh files** in the other browser to load them.
5. Reload the page and restart the server to confirm persistence.
6. Give the second account Viewer access, refresh its room, and verify it cannot edit. The API enforces role changes immediately, even before refresh.

There is no live synchronization in Phase 1. If both accounts edit the same saved version, the second save is rejected. Download or copy that draft, reload the latest file, and merge manually.

## Commands and checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

API tests use an isolated in-memory PostgreSQL runtime by default. Set `TEST_DATABASE_URL` to an **empty disposable PostgreSQL database** to use a real server; CI does this. Do not use an existing application database for tests. Browser tests create uniquely named accounts and a room in the local development database. Screenshots and failure traces go in `test-results/`.

## Repository

```text
apps/web          Next.js App Router, React, CodeMirror, responsive UI
apps/api          Express API, authentication, authorization, validation
packages/contracts Shared Zod validators and TypeScript response types
packages/db       Drizzle schema, PostgreSQL/PGlite connections, SQL migration
infra             Local PostgreSQL Docker Compose
docs              Architecture, API reference, phase status and deployment
tests             Two-browser-context acceptance test
```

See [architecture](docs/architecture.md), [API](docs/api.md), and [Phase 1 status and deployment](docs/phase-1.md).

Realtime presence/chat, simultaneous collaborative editing, WebRTC, code execution, queues, and version history belong to later blueprint phases. The editor stores the current file snapshot and a concurrency version, not a historical timeline.
