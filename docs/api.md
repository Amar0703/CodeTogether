# CodeTogether API

All paths start with `/api`. JSON responses use `{ error: { code, message } }` on failure. Unsafe requests require `Content-Type: application/json` when a body is sent and `X-CodeTogether: 1`. Browser requests use the Next.js same-origin proxy. Authenticate with the returned session cookie.

| Method | Path                             | Purpose / access                                                                 |
| ------ | -------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/health`                        | Database readiness                                                               |
| POST   | `/auth/signup`                   | `{ name, email, password }`; returns user and cookie                             |
| POST   | `/auth/login`                    | `{ email, password }`; returns user and cookie                                   |
| POST   | `/auth/logout`                   | Invalidate current session                                                       |
| GET    | `/auth/me`                       | Authenticated profile                                                            |
| GET    | `/rooms`                         | Current user's rooms, newest first, maximum 100                                  |
| POST   | `/rooms`                         | `{ name, description?, visibility? }`; creates owner membership and starter file |
| GET    | `/rooms/:roomId`                 | Room, members and files; members only                                            |
| PATCH  | `/rooms/:roomId`                 | `{ name, description, visibility }`; owner only                                  |
| DELETE | `/rooms/:roomId`                 | Delete room and descendants; owner only                                          |
| POST   | `/rooms/:roomId/invites`         | `{ role, expiresInHours? }`; owner only; returns URL                             |
| POST   | `/invites/:token/join`           | Accept valid unexpired invitation                                                |
| POST   | `/rooms/:roomId/join`            | Join a public room as viewer                                                     |
| PATCH  | `/rooms/:roomId/members/:userId` | `{ role }`; owner only; owner role protected                                     |
| DELETE | `/rooms/:roomId/members/:userId` | Owner removes member, or member leaves; owner cannot leave                       |
| POST   | `/rooms/:roomId/files`           | `{ name, kind?, parentId? }`; owner/editor                                       |
| GET    | `/files/:fileId`                 | Fresh file snapshot; members only                                                |
| PATCH  | `/files/:fileId`                 | `{ content, version }`; owner/editor; conditional save                           |
| PATCH  | `/files/:fileId/name`            | `{ name }`; owner/editor; recursively rename folder paths                        |
| DELETE | `/files/:fileId`                 | Owner/editor; folders cascade                                                    |

Visibility is `PRIVATE` or `PUBLIC`. Role is `OWNER`, `EDITOR`, or `VIEWER`; invitations and role updates only accept `EDITOR`/`VIEWER`. Kind is `FILE` or `FOLDER`. Invite expiry is 1–168 hours (24 default). Passwords are 10–128 characters. Content is limited to 200,000 characters per file and request bodies to 1 MB. Folder depth is limited to 12 levels. There is no arbitrary filesystem access: names and paths are database metadata.

Important error codes: `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `FORBIDDEN`, `ROOM_NOT_FOUND`, `FILE_NOT_FOUND`, `INVALID_INVITE`, `INVALID_ORIGIN`, `INVALID_PARENT`, `TREE_TOO_DEEP`, `OWNER_PROTECTED`, `ALREADY_EXISTS`, `VERSION_CONFLICT`, `VALIDATION_ERROR`, `RATE_LIMITED`.

Invites are reusable until expiry and never change an existing member's role. Revoking invite links, limiting uses and listing outstanding invitations are future hardening work. To remove access permanently today, keep the room private and remember that a removed member can rejoin using a still-valid invitation they possess.

## Phase 2 additions

`POST /api/realtime/ticket` issues a single-use, 30-second Socket.IO credential through the authenticated same-origin proxy. It requires the same CSRF header/origin checks as other unsafe requests.

`GET /api/rooms/:roomId/messages?limit=50&before=<sequence>` returns chronological chat history and `nextCursor`. Use `after=<sequence>` for forward reconnect catch-up; do not combine both cursors. Membership is required; limits are 1–100 messages per page.

See [Phase 2 contracts](phase-2.md#shared-contracts) for socket events, acknowledgments, delivery semantics, authorization and limits.

## Phase 3 documents

The existing same-origin ticket endpoint authenticates all collaboration. See [document/awareness event contracts](phase-3.md#document-and-awareness-contracts). HTTP PATCH /api/files/:fileId retains VERSION_CONFLICT checks until the first collaborative open, then rejects snapshot saves with 409 COLLABORATIVE_DOCUMENT. GET content is the last committed text projection; unsent local edits are available only in that browser. Document updates commit their snapshot, projection and version together before acknowledgment.

## Phase 4 calls

`POST /api/rooms/:roomId/ice` returns authorized, temporary ICE configuration through the same-origin proxy. It requires session, CSRF checks and current room membership, is limited to 12 requests/user/minute, and uses private/no-store caching headers. TURN signing secrets remain on the API. See [call contracts](phase-4.md#contracts) for participation, cancellation, media state, SDP/ICE forwarding and snapshot events. Owners, editors and viewers may call; viewers still cannot mutate documents.

## Phase 5 executions

All browser execution endpoints require the existing session through the same-origin proxy, are no-store, and enforce current membership. Unsafe requests keep CSRF protection. Strict schemas/types are in `packages/contracts/src/execution.ts`; unknown fields (including spoofed identities) fail validation.

| Method | Path                                                   | Contract                                                                               |
| ------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET    | `/executions/health`                                   | `{available, limits}`; signed-in user                                                  |
| POST   | `/rooms/:roomId/executions`                            | Owner/editor; `{fileId, idempotencyKey: UUID, language: 'javascript'                   | 'python' | 'cpp', version, sourceHash: lowercase SHA-256, stdin?}`; `202 {execution}` |
| GET    | `/rooms/:roomId/executions?before=<sequence>&limit=10` | Members including viewers; descending sequence; limit 1–20; `{executions, nextCursor}` |
| GET    | `/rooms/:roomId/executions/:id`                        | Members including viewers; `{execution}` with complete bounded persisted chunks        |
| POST   | `/rooms/:roomId/executions/:id/cancel`                 | Submitter or room owner; no payload fields; idempotent `{execution}`                   |

The API copies source from the saved file only after hash/version/language checks. Clients must confirm their visible Yjs replica is acknowledged before requesting Run. Result views expose snapshot hash/version/filename/language/submitter, status/failure, attempt/revision, creation/start/end times, duration/exit code, ordered `{sequence, stream, text}` chunks and truncation. They do not expose source, stdin or session hashes. Source/stdin are nevertheless retained privately for execution/diagnosis under the seven-day policy.

Errors include `EXECUTION_UNAVAILABLE` (503), `EXECUTION_BUSY` (503), `EXECUTION_LIMIT` (429), `RATE_LIMITED` (429), `SNAPSHOT_CONFLICT` / `IDEMPOTENCY_CONFLICT` (409), `LANGUAGE_MISMATCH` / `SOURCE_LIMIT` (400), and existing validation/auth/access errors. Wait/retry overload, wait for Saved on a snapshot conflict, and preserve the idempotency key when retrying an uncertain submission. A deliberate new run uses a new key.

The server emits `execution:event` only to authorized subscribed room sockets. Payload: `{roomId, executionId, attempt: UUID|null, revision, status, chunk?, truncated}`. Revisions and chunk sequences are monotonic per execution; duplicates/delays are possible. Delivery is volatile: discard older revisions, require contiguous chunk sequences and refetch durable detail on a gap/reconnect. No browser-to-server execution socket command or additional cookie forwarding is introduced.

Worker-only paths under `/internal/executions` require `Authorization: Bearer <EXECUTION_WORKER_TOKEN>` and `X-CodeTogether: 1` for POST. `POST /ready` accepts `{}`; `POST /claim` accepts `{executionId}` and returns `{claim: null|{executionId,attempt,language,source,stdin}}`. `POST /:id/heartbeat`, `/output`, `/finish` accept `{attempt}`, `{attempt,chunk}`, `{attempt,result}` respectively, returning `{active}`. A stale attempt is 409; deleted work may be 404. `GET /metrics` returns sanitized retained status counts/oldest timestamps/readiness. These are trusted service endpoints, not a browser API; never expose the worker token to frontend code.

See [Phase 5 policies, queue failure behavior and limits](phase-5.md). Execution status does not establish live TURN/call acceptance.
