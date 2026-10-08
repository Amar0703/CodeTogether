# Phase 2 realtime rooms

Phase 2 implements authenticated subscriptions, online presence, persistent chat and typed room events on the existing Express service. Save/load and version conflicts remain explicit. CRDT/Yjs, live cursors, voice/video, execution, Redis and multiple realtime instances are outside this phase.

## Authentication and deployment decision

Vercel owns the browser's HttpOnly session cookie. A direct Render WebSocket does **not** receive that cookie. The client first calls `POST /api/realtime/ticket` through Vercel's existing same-origin proxy with `X-CodeTogether: 1`. Express validates the cookie/session and origin, then returns a random 32-byte ticket. Only its hash and session reference are held in server memory; it expires after 30 seconds and can be consumed once. The client keeps it in memory and sends `{ ticket }` in the Socket.IO auth packet over WSS, never in a URL or local storage.

Render accepts only the exact configured browser Origin, including for the WebSocket upgrade (not just CORS). Authentication resolves identity from the database; no user ID or role comes from the client. On every action and outgoing room delivery, current session and membership are checked. Role changes refresh existing clients; removal/room deletion evicts all affected subscriptions before later room deliveries. Logout and session rotation disconnect that session's sockets. Idle expiry is detected within 15 seconds; Engine.IO ping/pong cleans up dead transports after a 25-second ping interval plus 20-second timeout.

The server stores transient tickets, limits, socket mappings and room queues in memory. Restart discards those; clients reconnect with fresh tickets and recover durable data from PostgreSQL. This intentionally supports one API/realtime instance. Viewers can chat, as well as read files; only owners/editors can save files.

## Shared contracts

Types and strict Zod input validators live in `packages/contracts/src/index.ts`. Client events require an acknowledgment callback. Acks are `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

| Direction                | Event or route                | Contract and behavior                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP POST                | `/api/realtime/ticket`        | Authenticated, CSRF-protected; returns `{ ticket, expiresAt }`. No session secrets returned.                                                                                                                                                                                                                                 |
| Client → server          | `room:join`                   | `{ roomId: UUID }`; authorizes, subscribes and acknowledges a presence snapshot. One room per socket, up to 10 connections per user.                                                                                                                                                                                         |
| Client → server          | `room:leave`                  | `{ roomId }`; checks session/membership and removes this socket only; ack data is null. Does not remove durable membership.                                                                                                                                                                                                  |
| Server → room            | `presence:update`             | `{ roomId, members: [{ id, name, role }] }`; full authoritative online snapshot, one entry per user across tabs.                                                                                                                                                                                                             |
| Client → server          | `chat:send`                   | `{ roomId, clientMessageId: UUID, body }`; trimmed body is 1–2000 characters. Requires a current subscription.                                                                                                                                                                                                               |
| Server → room / send ack | `chat:message`                | `{ id, sequence, roomId, clientMessageId, sender: { id, name }, body, createdAt }`; server identity, name snapshot and timestamp; sequence is a decimal string.                                                                                                                                                              |
| HTTP GET                 | `/api/rooms/:roomId/messages` | Authenticated membership required. Optional `limit` (1–100, default 50), and exactly one of `before` or `after` decimal sequence cursors. Returns `{ messages, nextCursor }`. Messages are chronological; `nextCursor` is null at the boundary. No cursor gives the latest page; before pages backward; after pages forward. |
| Server → room            | `room:event`                  | `{ roomId, actorId, type }`; `membership.changed` adds `userId`; `file.changed` adds `fileId` and `change: created/saved/renamed/deleted`; `room.updated` invalidates settings. No document patches or file bodies.                                                                                                          |
| Server → affected socket | `room:revoked`                | `{ roomId, reason }`; membership/session loss or room deletion. `room.deleted` is a server-side invalidation type; deletion's terminal client notification is revocation because no members remain authorized.                                                                                                               |

Clients cannot submit room events, roles, identities or file mutations through sockets. Unknown fields on supported event payloads are rejected. HTTP file saves retain their optimistic version check.

## Delivery and recovery

Each composer submission gets one UUID. A retry reuses both UUID and original text. PostgreSQL uniqueness on `(room_id, user_id, client_message_id)` prevents duplicate records, including concurrent retries, process restarts and lost acknowledgments. Reusing a key for another body returns `IDEMPOTENCY_CONFLICT`. Broadcast and ack happen only after commit. Receivers merge by server message ID, so rebroadcasts are harmless.

The UI shows Sending, Failed to send and Retry message. A 10-second ack timeout leaves delivery uncertain; retry is safe. Offline sends remain visible in memory as failed messages. A received broadcast or history record also confirms delivery. Pending messages and unsaved drafts are **not durable across page closure/reload**. Confirmed messages are durable.

Reconnect retries with jitter, obtains a fresh ticket and reauthorizes the room. It snapshots its last recovered message cursor before subscribing, then merges live messages with all forward history pages after that cursor. The recovery cursor advances only after catch-up succeeds, so newer live messages cannot hide a gap if a history request fails. Initial entry loads the latest 50, with a Load older messages control. Settings/membership/file metadata refetch on reconnect and room events. These events never overwrite the open editor buffer/base version, including after file deletion or demotion. Reloading saved content still requires explicit refresh and a dirty-draft confirmation.

## Bounds

- WebSocket frames: 16 KiB maximum; strict UUID/schema validation; chat body 2000 characters maximum.
- Chat: 30 attempts per user per minute across tabs, including retries. Returns `RATE_LIMITED` with a visible retry state.
- All incoming packets: 120 per user per minute across tabs; floods disconnect. Unknown packets count too.
- Tickets: 30 per user per minute, 10,000 outstanding tickets process-wide; 30-second lifetime.
- Auth handshakes: 120 per transport peer address per minute; at most 10 connected sockets per user. Behind a proxy the peer-address limit may group clients; it deliberately does not trust arbitrary forwarded headers.
- History: 120 requests per user per minute, at most 100 messages per response.
- Limits are process-local and reset on restart. History pages are bounded, but messages loaded into a long-lived browser session accumulate in memory; virtualization/retention and load measurements are deferred.

## Database and local startup

`packages/db/migrations/0002_chat.sql` adds `messages`, cascading room deletion, a room/sequence index and retry uniqueness. It is additive and retains Phase 1 data. The migration runner reads numbered SQL files in lexical order on one connection. Files are transactional and idempotent, record their version in `schema_migrations`, and may safely replay. Do not edit already deployed migrations; add new numbered, idempotent files. Run migrations from a single deployment process.

```sh
npm install
npm run dev
```

Open `http://localhost:3000` (use that hostname consistently). Express and Socket.IO use port 4000. PGlite remains persistent in `.data/postgres`; development startup applies both migrations. Only run one API process against that directory.

Optional files: copy `apps/api/.env.example` to `apps/api/.env`, and `apps/web/.env.example` to `apps/web/.env.local`. The frontend's localhost realtime default works in development. For server PostgreSQL, set `DATABASE_URL`, run `npm run db:migrate`, then start. Tests use in-memory PGlite unless `TEST_DATABASE_URL` points to an **empty disposable** PostgreSQL server database. Never aim tests at Neon production.

## Exact production configuration

Keep the existing Vercel frontend, Render API and Neon database. No new paid service or secret signing key is needed. Configure these in provider dashboards; never commit real connection strings.

**Render API environment**

| Variable       | Value                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| `NODE_ENV`     | `production`                                                                        |
| `DATABASE_URL` | Existing secret Neon PostgreSQL connection string, preserving required TLS settings |
| `APP_ORIGIN`   | `https://code-together-rust.vercel.app`                                             |
| `API_HOST`     | `0.0.0.0`                                                                           |
| `API_PORT`     | `10000` (or retain the existing explicit listening port if configured)              |

`PGLITE_DATA_DIR` is unused with `DATABASE_URL`. `APP_ORIGIN` now canonicalizes a harmless trailing slash; it rejects credentials, paths, query strings and fragments. Actual browser Origin comparisons remain exact. Do not add wildcards, disable checks or use a preview URL against this production API.

**Vercel Production environment**

| Variable                   | Value                                    |
| -------------------------- | ---------------------------------------- |
| `API_URL`                  | `https://codetogether-p51q.onrender.com` |
| `NEXT_PUBLIC_REALTIME_URL` | `https://codetogether-p51q.onrender.com` |

Both are build-time settings; rebuild/redeploy Vercel after changing them. `API_URL` supplies the HTTPS proxy; `NEXT_PUBLIC_REALTIME_URL` supplies the public Socket.IO origin (`https` causes WSS). Never set it to a session credential or Neon URL. Production intentionally shows realtime Offline if it is missing. The socket endpoint is `/socket.io/` on Render, bypassing the Vercel rewrite. Preview deployments need a separate backend with that preview's exact allowed origin.

## Deployment sequence (requires user instruction)

1. Review the local changes and authorize commit/push separately. No commit, push or deployment is part of this implementation task.
2. Confirm a Neon backup/recovery point and the Render variables above. Keep one Render instance.
3. From repository root, Render build command: `npm ci && npm run build --workspace=@codetogether/api`.
4. Run `npm run db:migrate` against the production environment once before the new API starts. Where a pre-deploy command is unavailable, use Render start command `npm run db:migrate && npm run start --workspace=@codetogether/api`. Otherwise keep migration as the pre-deploy step and start with `npm run start --workspace=@codetogether/api`.
5. Keep Render health check `/api/health`. Deploy API first; the additive schema and old HTTP routes remain compatible with the existing frontend. Keep WebSocket upgrades enabled; Socket.IO shares the HTTP listening port.
6. Add the two Vercel Production variables and rebuild the existing Next.js project. Retain its monorepo install/root settings; the root build command is `npm run build`, or `npm run build --workspace=@codetogether/web` when invoking from root for only the web workspace.
7. Perform the deployed checklist below using two real browser contexts. API health alone does not establish socket/cookie correctness. Service sleep/redeploy interrupts presence; fresh-ticket reconnect must recover chat and drafts.
8. If rolling back the application, leave the additive messages table in place to preserve chat. Do not drop production data as part of rollback.

## Acceptance and verification

Local verification on 8 October 2026:

- [x] Existing Phase 1 API suite and persistence regression.
- [x] Socket authentication: unauthenticated, malformed, expired/reused tickets; foreign/missing origins; ticket CSRF checks.
- [x] Unauthorized joins/actions, room isolation, payload limits and per-user limits across tabs.
- [x] Join/leave, multiple-tab presence, half-open heartbeat cleanup and fresh-ticket reconnect.
- [x] Persistent chat, chronological cursor pages, reconnect catch-up, concurrent retries and retry after gateway restart.
- [x] Chat survives closing/reopening an on-disk PGlite database and reapplying migrations.
- [x] Existing sockets react to role change/removal, room deletion, logout and idle session expiry.
- [x] Two browser contexts see presence/chat/file events without refresh; draft conflict protection, offline retry, reconnect and demotion/removal tested.
- [x] Interrupted history recovery with a newer live message retries without skipping the missed chat.
- [x] `npm run lint`, `npm run typecheck` and the production `npm run build` passed.
- [x] All 21 API/socket/database tests and both Chromium browser acceptance tests passed.
- [x] Final desktop (1440 × 1000) and mobile (390 × 844) screenshots inspected; panel controls and chat composer stay visible, with no horizontal overflow. Screenshots are in ignored `test-results/realtime-desktop.png` and `test-results/realtime-mobile.png`.

Deployed acceptance remains pending until the user authorizes deployment and the following checks run against the deployed versions:

Unauthenticated production health checks and deliberately invalid-body origin probes were attempted on 8 October 2026, but requests timed out from this environment. This does not establish a production outage or a successful origin configuration. No provider dashboard variables, credentials or live acceptance results were accessed; confirm the exact values above in Render/Vercel before deployment.

- [ ] Two authenticated accounts show Connected via Vercel and Render without cross-domain session-cookie assumptions.
- [ ] Both see presence and chat without refresh; closing one of two tabs keeps that user online.
- [ ] Chat survives page reload and API restart; a lost acknowledgment/retry produces one message.
- [ ] Reconnect recovers missed chat/settings/files; unsaved editor text remains unchanged.
- [ ] Demotion disables saving; removal revokes every tab and prevents further room history/chat access.
- [ ] The public origin succeeds; a foreign origin and unauthenticated joins fail.
- [ ] Desktop and phone chat composition, member controls and explicit save/conflict recovery are usable.

No load/capacity/latency claim or production PostgreSQL test run is implied by local PGlite tests. CI is configured to run the API suite against disposable PostgreSQL. Redis, distributed authorization coordination, multi-instance deployments, durable unsent outboxes, chat moderation/retention, unread counts and typing indicators remain deferred.

Phase 1 invitations remain reusable until expiry; a removed member can explicitly rejoin with a still-valid invite (or a public-room link). Removal terminates existing socket access immediately, but is not a permanent account ban. Invite revocation is still deferred.

References: [Socket.IO authentication middleware](https://socket.io/docs/v4/middlewares/), [delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/), and [server options](https://socket.io/docs/v4/server-options/).
