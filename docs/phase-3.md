# Phase 3 collaborative editor

Phase 3 adds Yjs 13 text collaboration and the maintained y-codemirror.next CodeMirror 6 binding to the existing Express/Socket.IO service. It keeps Vercel, Render and Neon, the same-origin ticket exchange, and a single realtime instance. No Redis, separate collaboration service or new secret is required.

## Source of truth and migration

Migration 0003_documents.sql adds one documents row per file, with a cascading foreign key and a bounded base64 Yjs snapshot. The SQL is additive, transactional and idempotent. Existing file content is untouched during migration.

The first authorized document open locks the room and file rows, checks membership, and initializes Y.Text('content') from the current files.content exactly once. Concurrent first opens serialize; they receive the same CRDT identifiers and do not insert a second copy of the text. Empty files initialize too. The process room queue orders HTTP membership/file mutations with document actions and post-commit delivery; database locks protect the durable transaction.

Once the document row exists, its Yjs state is authoritative. Every changed snapshot updates documents.state, files.content and files.version in the same transaction. The content field is a readable/exportable projection. Version increments once per changed committed snapshot, not per keystroke; duplicate delivery does not increment it. Initialization alone does not change the version. HTTP PATCH /api/files/:id returns 409 COLLABORATIVE_DOCUMENT for initialized files, regardless of supplied version. Uninitialized files retain Phase 1 optimistic version checks. Renaming preserves the file UUID and CRDT state; deleting a file/folder/room cascades its documents.

## Persistence and acknowledgments

Clients send incremental Yjs binary updates, encoded as base64 for the shared JSON contract. The binding edits Y.Text directly; React does not replace the buffer on each keystroke. Local writes debounce for 200 ms and one write is in flight per editor. The API builds a fresh candidate from PostgreSQL, validates and applies the update, and commits a compacted snapshot and text projection before either broadcast or acknowledgment. A failed candidate is destroyed without changing durable state. A database outage cannot produce a Saved acknowledgment.

The UI shows Saved only after the authoritative server copy covers the local document. Saving, Offline and Sync pending indicate uncertainty. Ctrl/Cmd+S and Sync now request a flush; neither uses HTTP snapshot save. Download your draft exports the current editor text, including unacknowledged work. Automatic retries use the same CRDT identifiers: delivery is at least once, application is idempotent. An ack lost after commit is safe to retry.

Each transaction compacts updates into one snapshot; there is no append-only update table. Yjs garbage collection discards deleted payloads while preserving the identifiers needed by offline peers. History metadata still grows. The API caps the snapshot at 2 MiB and plain text at 200,000 UTF-16 code units. Reaching the history cap stops writes with an export/recreate-file message; it never silently resets CRDT identifiers. This is bounded persistence, not a version-history product.

There is no long-lived server document cache or write-behind buffer. At most eight document transactions can hold candidate documents at once; candidates are destroyed in finally blocks. Different rooms can progress independently. Loading and compacting on each write trades throughput for straightforward durability and restart behavior; performance/load capacity has not been measured.

## Document and awareness contracts

All incoming events require the existing ticket-authenticated socket, a current room subscription, current session/membership and the correct room/file relationship. Every incoming action rechecks access. Owners/editors can send updates; viewers can join and publish cursors. Client identities/roles are not accepted. Outgoing document and awareness recipients are reauthorized. Role changes immediately gate future writes; removal, logout, session expiry and deletion revoke connected subscriptions through the existing mechanisms.

All acks use the existing { ok, data } / { ok: false, error: { code, message } } envelope. Schemas/types are in packages/contracts/src/index.ts.

| Event                          | Payload and result                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| doc:join                       | { roomId, fileId, clientId, vector }; one document per socket. Returns { userId, update, vector, version, role }. A duplicate active clientId for the same file is rejected. userId is server-derived and must match the browser backup account. |
| doc:update client to server    | { roomId, fileId, update, vector }; requires the current document subscription and writer role. Returns the same sync result after commit.                                                                                                       |
| doc:update server to peers     | { fileId, update }; only committed incremental updates, excluding the sender.                                                                                                                                                                    |
| doc:leave                      | { roomId, fileId }; clears this tab's subscription and cursor; ack data null.                                                                                                                                                                    |
| doc:awareness client to server | { roomId, fileId, cursor: null or { anchor, head } }; strict bounded Yjs relative positions. No names, colors, roles or arbitrary JSON are accepted. Ack data null.                                                                              |
| doc:awareness server to peers  | { fileId, peers: [{ clientId, user: { name, color, colorLight }, cursor }] }; authoritative transient snapshot of authorized subscribed tabs.                                                                                                    |
| doc:revoked                    | { fileId, reason }; deleted file/folder closes document synchronization while retaining local work. Room revocation uses existing room:revoked.                                                                                                  |

Relative positions survive concurrent insertions and deletions. Names come from authenticated server identity; a six-color palette is allocated to distinct authenticated users in the active document (colors repeat beyond six users). Tabs have separate Yjs client IDs. Switching files sends leave, destroys the old binding and undo manager, and creates independent state for the new file. Disconnect/leave removes cursors. A 15-second client heartbeat refreshes awareness; states older than 45 seconds are filtered on delivery/sweep. Engine.IO heartbeat cleanup and the existing 15-second authorization sweep remain active. Awareness is never stored in PostgreSQL or browser document backups. Cursor names are visible next to selections.

## Reconnect and browser recovery

The provider keeps a local working Y.Doc and a separate replica containing only confirmed server state. On reconnect it obtains a fresh single-use ticket via the authenticated same-origin API proxy, rejoins the room, then sends the confirmed replica's state vector. Yjs returns missing structs plus delete sets; these merge into both replicas. Only after current authorization succeeds does the provider send the remaining local difference. Using a separate confirmed replica matters because state vectors alone do not describe pending deletions. Ack comparisons normalize garbage collection so local undo retention is not mistaken for an unsaved edit.

A browser IndexedDB database is named codetogether-v3:<authenticated account UUID>:<room UUID>:<file UUID>. It stores a bounded merged snapshot. Read/merge/write runs in one read-write transaction, so separate tabs cannot overwrite each other's backups. No session cookie or socket ticket is stored. Backups are created for remote and local content; restoring them never seeds text from files.content. Fresh tabs generate fresh Yjs client IDs while retaining the stored CRDT structs.

Completed IndexedDB writes survive reload/browser restart subject to browser storage availability. Writes are asynchronous: a crash can lose the last uncompleted transaction; eviction, private browsing, user-cleared storage and quota failures can also lose backups. Storage failures are surfaced; download is the recovery fallback. Saved means database acknowledgment, not a promise about browser storage. Offline loading of the entire app is not supported (no service worker); reconnect the browser to load the app and recover its stored edits.

If access is removed, downgraded with pending edits, the account changes, or the file is deleted, synchronization stops and the buffer stays available to download. No file is automatically recreated. After a denied room reload, Recover local drafts reads only that authenticated account/room's browser databases and offers plain-text downloads without contacting document endpoints. Drafts remain in browser storage until site data is cleared; they are not encrypted against someone with access to that browser profile. Explicit rejoining with a still-valid invitation remains Phase 1 behavior, not a bypass in the replay protocol.

Undo/redo is scoped to the binding's local transaction origin. Remote updates, server synchronization and browser restoration are excluded from the undo manager. Undo history is reset on file switch/reload and is not a durable cross-session timeline.

## Bounds and operational limits

WebSocket JSON packets are capped at 2,840,000 bytes to accommodate base64 updates. Decoded updates/snapshots are capped at 2 MiB, state vectors at 32,768 base64 characters, plain text at 200,000 code units, and decoded update struct counts at 100,000. Only the content text root is accepted; maps, embedded values, formatting, extra roots, malformed binary and missing dependencies are rejected without committing. Awareness is a strict relative-position schema.

Per-user limits are shared across tabs: 600 document writes/minute, 1,800 cursor events/minute, 120 document joins/minute, 3,000 document packets/minute, and 12,000,000 base64 update characters/minute. The process room queue admits at most 64 active/waiting actions, bounding queued payloads. Phase 2's separate 120 non-document packets/minute, 30 chat sends/minute, ticket limits, ten sockets/user and exact-origin checks remain. Limits and coordination are process-local. One realtime instance is required. Resource limits are safeguards, not a measured capacity claim.

## Local startup and checks

Use Node 22+ (verification uses Node 24). From the repository root:

```sh
npm ci
npm run dev
```

Development applies numbered migrations automatically and retains PGlite in .data/postgres. Run only one API against that directory. Optional PostgreSQL: set DATABASE_URL in apps/api/.env, run npm run db:migrate, then npm run dev. Do not point TEST_DATABASE_URL at production; API tests default to isolated PGlite, or use an empty disposable PostgreSQL database for that variable.

Checks: npm run lint; npm run typecheck; npm test; npm run build; npm run test:e2e. Chromium must be installed with npx playwright install chromium. Browser tests create unique local test accounts/rooms; ignored test-results contains traces/screenshots.

## Exact production deployment

Existing Phase 2 values remain sufficient. No new environment variables are required.

| Provider          | Variable                 | Value                                                              |
| ----------------- | ------------------------ | ------------------------------------------------------------------ |
| Render            | NODE_ENV                 | production                                                         |
| Render            | DATABASE_URL             | Existing secret Neon PostgreSQL URL, retaining TLS settings        |
| Render            | APP_ORIGIN               | https://code-together-rust.vercel.app                              |
| Render            | API_HOST                 | 0.0.0.0                                                            |
| Render            | API_PORT                 | 10000, or retain the existing explicitly configured listening port |
| Vercel Production | API_URL                  | https://codetogether-p51q.onrender.com                             |
| Vercel Production | NEXT_PUBLIC_REALTIME_URL | https://codetogether-p51q.onrender.com                             |

PGLITE_DATA_DIR is ignored when DATABASE_URL is set. API_URL and NEXT_PUBLIC_REALTIME_URL must exist before the Vercel build. The browser's HttpOnly cookie stays on Vercel; the socket uses a short-lived single-use ticket, never a cookie copied to Render. Keep exact origin checks and WebSocket upgrades enabled. Preview origins need a separate correctly configured backend.

1. Review the changes. Commit, push and deployment each require the user's explicit instruction; none is implied by local implementation.
2. Confirm a Neon backup/recovery point and keep one Render API instance. Ask current users to download unsubmitted Phase 1/2 drafts before upgrading and reload after release.
3. Render build command from repository root: npm ci && npm run build --workspace=@codetogether/api.
4. Run npm run db:migrate once in the Render production environment before starting the new API. Use a pre-deploy command when available. Otherwise use start command npm run db:migrate && npm run start --workspace=@codetogether/api. With a pre-deploy migration, start remains npm run start --workspace=@codetogether/api. Health check stays /api/health.
5. Deploy the API first, then rebuild the existing Vercel project with its existing monorepo settings (root build npm run build, or npm run build --workspace=@codetogether/web). Migration is additive; a file switches to CRDT authority only on its first document open. Old frontend tabs attempting snapshot saves after that will receive an explicit conflict and must download/reload, never silently overwrite.
6. Run the deployed acceptance checklist below with two accounts. Include Render restart and a genuine disconnection. Local results do not establish production acceptance.
7. Roll back only to a compatible Phase 3 API that preserves the documents authority/HTTP-save guard. Rolling back to the old API after CRDT initialization permits stale HTTP projection writes and is unsafe. Leave migration/table/data in place; do not drop document state as a rollback shortcut.

## Acceptance record

Local verification completed on 11 October 2026: all 30 API/socket/database tests and all four Chromium browser tests passed; lint, TypeScript and production build passed. Desktop 1440 × 1000 and mobile 390 × 844 screenshots were inspected. PostgreSQL-server/Neon acceptance and hosted CI were not run in this task; local database tests used PGlite. Existing Phase 1/2 browser assertions about manual-save conflicts are replaced by collaborative convergence; legacy version-conflict behavior is still covered by API tests.

- [x] Final lint, TypeScript, API/database/socket suite and production build.
- [x] Two-context simultaneous editing, convergence and selections without refresh.
- [x] Local undo/redo preserves peer contributions; switching files isolates content and undo.
- [x] Offline edits merge once after reload; revoked offline work stays recoverable and is never replayed.
- [x] Concurrent legacy-file initialization, malformed updates, viewer restrictions, cross-room/file isolation and connected permission changes.
- [x] Forced database failure rolls back snapshot and projection, emits no success, and retries safely; stale awareness expires.
- [x] Restart retains CRDT identity; on-disk PGlite survives close/reopen and migration replay.
- [x] Desktop/mobile screenshots inspected.

Read-only live checks on 10 October 2026 returned HTTP 200 with {"status":"ok"} from both the Vercel /api/health proxy and Render /api/health. These establish health-route reachability only; no authenticated live acceptance or deployment was performed.

Production checks remain distinct:

- [ ] Two authorized accounts connect through Vercel/Render and converge without refresh.
- [ ] Viewer writes fail; demotion/removal/logout/session expiry stop existing document sessions.
- [ ] Offline edits merge after reconnect; removal while offline blocks replay and permits export.
- [ ] Confirmed text and CRDT IDs survive Render restart on Neon.
- [ ] File/folder/room deletion cleans subscriptions and awareness; multiple tabs clean up correctly.
- [ ] Mobile editing/export/chat and named cursors are usable on the deployed build.

Not included: multiple realtime instances, Redis, voice/video, execution, queues, AI, Git integration, historical version browsing, a service worker, encrypted browser backups, measured load/latency guarantees, or permanent membership bans/invitation revocation.

References: [Yjs update protocol](https://docs.yjs.dev/api/document-updates), [CodeMirror binding](https://github.com/yjs/y-codemirror.next), [Yjs undo manager](https://docs.yjs.dev/api/undo-manager), [awareness](https://docs.yjs.dev/api/about-awareness).
