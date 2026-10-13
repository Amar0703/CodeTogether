# Phase 4 voice and video

Explicit small-room calls now share the workspace with Yjs editing and persistent chat. Owners, editors and viewers can call; file permissions are unchanged. Devices are not requested merely by entering a room. Screen sharing, recording, transcription, SFUs, Redis and multiple realtime instances remain deferred.

## Architecture and authorization

Native browser `RTCPeerConnection` transports encrypted media directly or through TURN. The existing Express/Socket.IO service on Render carries signaling, independently of document synchronization. Next.js on Vercel still owns the HttpOnly cookie. The browser exchanges that session through the same-origin API proxy for a single-use socket ticket; it never reads the cookie or assumes it reaches Render over WebSocket.

Each joined tab occupies one of **four** server-enforced call slots, including tabs of the same user. Room presence still deduplicates users; calls deliberately do not. Each tab has a separate socket, server-generated participant UUID and server-generated call UUID. Names and user IDs come from authenticated socket state. A client join UUID identifies an idempotent attempt, not an identity. Reconnect gets a new participant; an emptied or restarted call gets a new call UUID.

Every media action rechecks session, membership and room subscription under the existing room queue. Session-bound events additionally check call/participant IDs. Each signal's destination must be another active, currently authorized participant in that exact room/call. Strict validation rejects identity fields, cross-room destinations and stale sessions. Removal, room deletion, logout/session rotation, expiry, room leave and disconnect clear participation. Demotion does not end calling, but still immediately gates document writes.

Compliant clients close peers and stop capture on revocation. Signaling authorization **cannot forcibly terminate an established P2P connection between malicious or modified clients**. TURN credentials are usable until expiry and are not room-scoped at the relay. Stopping issuance is not immediate relay-allocation revocation. A future controlled SFU would need its own subscription and revocation enforcement.

## Contracts

Shared strict Zod validators and TypeScript types are in `packages/contracts/src/index.ts`. Every client event requires the existing acknowledgment envelope: `{ok:true,data}` or `{ok:false,error:{code,message}}`.

| Event / route                 | Payload and semantics                                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call:join`                   | `{roomId,joinId,media:{microphone,camera}}`; returns `{session,snapshot}`. Retrying the same current attempt is idempotent; a different attempt requires leaving.                                                                      |
| `call:cancel`                 | `{roomId,joinId}`; cancels the matching attempt on this socket, including a lost join ack. Last 32 canceled IDs are remembered per socket. Delayed cancellation cannot remove a newer attempt.                                         |
| `call:leave`                  | `{roomId,callId,participantId}`; ends that participation. Old sessions return `STALE_CALL`.                                                                                                                                            |
| `call:state`                  | Session fields plus `{media:{microphone,camera}}`; also renews the participant lease.                                                                                                                                                  |
| `call:signal`                 | Session fields plus `{to,sequence,signal}`. Description: `{kind:'description',type:'offer'\|'answer',sdp}`. ICE: `{kind:'candidate',candidate,sdpMid,sdpMLineIndex,usernameFragment}`. Forwarded only after destination authorization. |
| `call:snapshot`               | `{roomId,callId,revision,participants:[{id,userId,name,media}]}`; authoritative arrivals, state and departures. Clients ignore older revisions.                                                                                        |
| `POST /api/rooms/:roomId/ice` | Session, CSRF and current membership required; returns `{iceServers,iceTransportPolicy,turnConfigured,expiresAt}`. UUID validated; `Cache-Control: private, no-store`, `Vary: Cookie, Origin`.                                         |

Per-destination increasing sequence numbers deduplicate signals. Older/duplicate packets are acknowledged without forwarding. Socket.IO preserves sender order; offline signals are not queued for replay. Receivers check the full session/destination again and never create a peer from an unsolicited signal. SDP, ICE, streams and recordings are not persisted in the database or browser storage, and these payloads/credentials are not logged.

## Negotiation, reconnect and cleanup

Both peers create audio/video transceivers, including for audio-only calls. Perfect negotiation assigns the lexically larger participant UUID the polite role. It accepts colliding offers using automatic rollback; the impolite side ignores collided offers. Their candidates remain in the bounded buffer and can be applied if a later accepted description reuses those ICE fragments, as rollback answers can do. Peer operations are serialized. ICE arriving before a matching remote description is buffered; only the description's ICE username fragments are applied. Delayed candidates from obsolete ICE generations cannot contaminate a restart.

A new peer has a 15-second watchdog. Disconnection waits five seconds (or the existing watchdog), then requests ICE restart. At most two recovery restarts are attempted per peer lifetime, each with a 15-second watchdog. A failed tile requires Leave/Join. These budgets do not reset on every successful connection. Credential refresh also negotiates fresh ICE without increasing the recovery budget.

Transport loss closes all peers immediately and retains already-authorized local tracks for at most 30 seconds. After fresh-ticket authentication and room resubscription succeed, the call fetches fresh ICE credentials, obtains new participation and rebuilds peers without reacquiring devices. At most three reconnect participations follow the initial join. Rejoin failure/timeout ends capture and requires Join. Server-initiated disconnect, including logout/expiry, ends capture immediately. API restart discards transient calls and uses this same authenticated recovery path.

The client sends `call:state` every 15 seconds. A failed renewal ends its call. An unrenewed server lease expires after 45 seconds, checked by the 15-second sweep (up to approximately 60 seconds to detect). Empty call maps are swept even after all room sockets disappear. This bounds ghost slots after a lost cancellation. Browser background suspension can end a call; waking does not secretly reacquire devices.

Leave, access removal, navigation and pagehide stop local tracks, close peer connections, abort pending ICE requests and remove timers/listeners. Late device promises are guarded by generation IDs and their tracks are stopped. Explicit Leave clears reconnect intent; reload requires explicit Join. Audio analysers are disconnected and closed when tiles leave or their streams change. Media failures do not stop Yjs or chat.

## Controls and interface

Join requests a microphone and optionally a camera; camera defaults off. Camera denial can retain an audio-only call. Microphone denial gives an actionable error without joining. Mute/camera-off stop capture and replace outgoing tracks with null. Re-enabling explicitly requests the device again. Switching uses `replaceTrack` and stops the old track; unplugging turns off the affected device and asks for selection/re-enable. Device enumeration does not prompt and depends on browser support/permissions.

Tiles show authenticated remote names, camera-off avatars, microphone/camera flags and peer connection state. Video elements are muted; separate audio elements play remote audio so an inactive video track cannot stall audio-only playback. Local audio is never played. Speaking is measured locally with Web Audio, never persisted or signaled. Autoplay or audio-context restrictions expose **Enable audio playback**. Controls use labeled native buttons/selects and keyboard navigation. Desktop keeps editor/chat visible; mobile provides a scrollable call area and a members/chat overlay with a close button. The members list and chat history scroll independently, reserving space for the composer. In extremely short windows or with a virtual keyboard open, the panel itself scrolls so the composer remains reachable.

## Bounds and mesh tradeoffs

| Resource                            | Limit                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Participants / peers                | 4 per room / 3 per browser                                                                |
| Transient calls                     | 1,000 API-process entries                                                                 |
| SDP / candidate                     | 65,536 / 2,048 characters                                                                 |
| ICE metadata                        | 256-char fragment, 64-char mid, m-line index 0–8                                          |
| Media packets                       | 600 per user/minute across tabs, including malformed/unknown `call:*` packets             |
| Signals / descriptions / candidates | 480 / 60 / 384 per user/minute; 1,000,000 serialized signal characters/minute             |
| Join / state / ICE issuance         | 20 / 60 / 12 per user/minute                                                              |
| Client buffers                      | 64 pending candidates and 64 queued operations per peer; 8 ignored ICE fragments          |
| Recovery                            | 2 peer ICE restarts; 3 reconnect joins; initial credential-refresh attempt plus 2 retries |

The existing 64-action room queue, 10 sockets/user and ticket/origin/session rules remain. Socket.IO's frame ceiling remains 2,840,000 bytes for Yjs; smaller media bounds are checked before queued database work. Media rate-limit errors do not disconnect the shared socket. Limits are process-local, reset on restart and are safeguards rather than measured capacity claims.

Each participant sends N−1 copies and receives N−1 streams; mesh traffic grows quadratically across the room. Four callers means three outgoing media copies per user. Capture targets 640×360/20 fps, capped at 1280×720/24 fps; bandwidth depends on browser/codec/network. For larger rooms, an SFU such as LiveKit or mediasoup can receive one publication and forward selected layers. That future migration replaces media transport/signaling while retaining room identity, editor and chat. No SFU is implemented here.

## Local setup and tests

Run Node 22+, `npm ci`, then `npm run dev`; use **http://localhost:3000** consistently. PGlite remains in `.data/postgres`. Empty STUN/TURN defaults use host candidates, sufficient for local fake-device tests; the UI explicitly warns that remote networks may fail. These tests do not prove remote readiness.

API settings belong in `apps/api/.env`; see its example. `STUN_URLS` accepts comma-separated authorized `stun:`/`stuns:` URLs. TURN settings must be supplied together. Coturn-compatible shared-secret issuance and Metered temporary credentials are supported; other providers need a server-side adapter. Never put provider keys into browser variables or browser request URLs. Metered's documented management API uses a secret query parameter only in the server-to-provider request; do not enable outbound URL tracing for that request.

```sh
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

`tests/calls.spec.ts` uses two authenticated Chromium contexts and fake media flags. It checks remote tracks, incoming audio RTP bytes/packets, decoded video frames and offer collisions. Instrumentation exists only in Playwright, not the application. Ignored screenshots/traces are under `test-results`. Do not edit API source during tests: `tsx watch` restarts interrupt requests. Run suites without competing browser/API test processes on constrained machines, and wait for `/api/health` after restarting.

API tests use isolated PGlite. `TEST_DATABASE_URL` is optional and must target an **empty disposable PostgreSQL database**, never production Neon. Existing editor → viewer → editor keyboard/native-history regression coverage remains.

For forced-relay testing, configure usable TURN and `ICE_TRANSPORT_POLICY=relay` on the local API, restart it, then run in PowerShell:

```powershell
$env:TEST_TURN_RELAY='1'
npm run test:e2e -- tests/calls.spec.ts -g 'forced TURN relay'
Remove-Item Env:TEST_TURN_RELAY
```

The test requires actual incoming media and a selected relay candidate. Restore `ICE_TRANSPORT_POLICY=all` afterward. A localhost relay test does not replace physical-device calls across different networks.

## Exact production settings

Keep Vercel + one Render Express/Socket.IO instance + Neon. No Phase 4 database migration is required.

| Provider | Variable                   | Value                                                                                     |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| Render   | `NODE_ENV`                 | `production`                                                                              |
| Render   | `DATABASE_URL`             | Existing secret Neon URL, retaining TLS                                                   |
| Render   | `APP_ORIGIN`               | `https://code-together-rust.vercel.app`                                                   |
| Render   | `API_HOST`                 | `0.0.0.0`                                                                                 |
| Render   | `API_PORT`                 | `10000`, or existing explicit service port                                                |
| Render   | `STUN_URLS`                | Optional comma-separated authorized STUN URLs; empty default                              |
| Render   | `TURN_URLS`                | e.g. `turn:turn.YOUR-DOMAIN:3478?transport=udp,turns:turn.YOUR-DOMAIN:5349?transport=tcp` |
| Render   | `TURN_SHARED_SECRET`       | Protected relay shared secret, 32–512 characters                                          |
| Render   | `TURN_TTL_SECONDS`         | `600` default; range 300–3600 seconds                                                     |
| Render   | `ICE_TRANSPORT_POLICY`     | `all` normally; `relay` for acceptance testing                                            |
| Vercel   | `API_URL`                  | `https://codetogether-p51q.onrender.com`                                                  |
| Vercel   | `NEXT_PUBLIC_REALTIME_URL` | `https://codetogether-p51q.onrender.com`                                                  |

TURN URLs require either `TURN_SHARED_SECRET` (coturn) or both Metered variables below, never both providers. Relay-only policy requires TURN. Invalid settings fail startup. Vercel needs no new Phase 4 variable. Never put TURN shared secrets, provider keys or database credentials in `NEXT_PUBLIC_*` or source control.

Coturn issuance returns a random username suffix prefixed with expiry seconds and an HMAC-SHA1/base64 password. No application user ID is exposed to the relay. The browser necessarily receives ICE URLs, temporary username/password, policy and expiry to authenticate allocations; these can be copied until expiry. The signing secret stays server-side. Responses are authorized/rate-limited, not cached across users, and have distinct usernames.

The client refreshes 60 seconds before expiry, updates peer ICE configuration and restarts ICE. Requests time out after eight seconds and retry twice at five-second intervals; final failure ends calling visibly. Reconnect always fetches fresh credentials. Relay allocation lifetime is provider-controlled: credential expiry is not an immediate kill guarantee. Keep API/relay clocks synchronized and configure relay traffic quotas and spending limits.

## External TURN requirements

### Metered without buying a domain or server

The inspected account on 12 October 2026 offered a **500 MB free trial**, with no overages: relay service stops at the limit. Its 20 GB plan required a payment method, so it was not selected. Pricing and account eligibility can change; confirm the dashboard before enabling anything. The free trial's full API access supports temporary credentials.

In Render, use these variables instead of `TURN_SHARED_SECRET`:

```dotenv
METERED_DOMAIN=codetogether-amar.metered.live
METERED_SECRET_KEY=<private secret from Metered Developers>
STUN_URLS=stun:stun.relay.metered.ca:80
TURN_URLS=turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turns:global.relay.metered.ca:443?transport=tcp
TURN_TTL_SECONDS=600
ICE_TRANSPORT_POLICY=all
```

The domain and relay URLs above match the inspected trial account. Other accounts must use their own domain and supported relay region. `METERED_SECRET_KEY` is the existing **Developers secret**, not the credential-scoped key under “Show API Key,” and not the displayed TURN password. The backend needs it to create expiring credentials. Projects were unavailable in the inspected account, so this secret has application-wide privileges; restrict it to the API's secret configuration. No new frontend environment variable is needed.

Metered credentials can take **two minutes to propagate**. The API prepares them in the background, waits 120 seconds after creation, then hands each unused credential to exactly one authorized ICE response. It targets four fresh unused credentials and tracks at most eight active credentials in total, including those already assigned to callers. The inspected trial rejected creation at ten active credentials; the previous sixteen-item pool exceeded this limit. The account limit is shared across rooms, deployments and local test processes, independently of the four-participant room limit. Avoid running local and production pools against the same small trial at the same time. Rapid joins/rejoins or several rooms can exhaust this bounded pool and require a visible retry; this trial configuration is not a multi-room capacity guarantee.

Metered TTL is 600–3600 seconds. The API uses the ready credential with the longest remaining lifetime, excluding any with under three minutes remaining. It retires only credentials created by this process that have never been assigned: when they become too old to issue, or earlier at capacity when replacement propagation can finish before the next assigned credential needs renewal. Retirement uses Metered's [credential deletion API](https://www.metered.ca/docs/turn-rest-api/delete-credential/). Assigned credentials and unrelated dashboard credentials are never deleted by this pool. Metadata for assigned credentials is retained until expiry to account for provider slots, even if a caller has left.

Each background provider request has a 15-second timeout and redirect rejection; creation responses have a 16 KiB cap and schema validation. There is one request in flight and at most four creations per refill, with a 30-second retry delay on failure. Responses, request URLs and raw provider errors are never logged. Shutdown aborts the request and clears local credentials, metadata and timers; already-created provider credentials expire naturally. They can remain as expired entries in the Metered dashboard. Empty-pool/startup responses are 503 with a visible retry message; editing/chat continue. Restart recovery can exceed the client's 30-second capture window and require an explicit Join.

### Troubleshooting a join that stays unavailable

The API now distinguishes actual propagation (`MEDIA_WARMING_UP`, with remaining seconds), an empty pool (`MEDIA_UNAVAILABLE`), and provider failures (`MEDIA_PROVIDER_UNAVAILABLE`). Waiting two minutes only helps when credentials have actually been created. The browser stops capture on a failed join and still requires an explicit Join; editing/chat remain available. Neither `all` nor `relay` bypasses a configured provider's credential failure.

Render application logs emit `[TURN] Metered` with a fixed failure category and HTTP status only, once per category change, plus `recovered` when requests succeed again. No keys, usernames, passwords, URLs, SDP, ICE addresses or raw response bodies are logged.

| Diagnostic                            | Next check                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `authentication` (401)                | Confirm Developers secret and the matching application domain on Render.                                                            |
| `rejected` (other 4xx, including 403) | Check account/plan API access, quota and configuration. A 403 alone does not prove a wrong key.                                     |
| `rate-limit` (429)                    | Wait for the provider limit to reset; avoid repeatedly restarting services or running duplicate local pools.                        |
| `provider` (5xx)                      | Check provider availability.                                                                                                        |
| `timeout` / `network`                 | Check outbound connectivity from Render to Metered; local success does not prove Render connectivity.                               |
| `response`                            | Successful HTTP response failed size/JSON/credential schema validation; investigate provider compatibility without logging secrets. |

Confirm the Render deployment is Live and the frontend's same-origin `/api/health` succeeds before timing warmup. A free Render cold start can delay API availability before credential propagation even begins. Deploy the backend fix before the frontend; no new variables or migration are needed. When replacing the old oversized pool, its active credentials can occupy slots until their remaining TTL expires. With `TURN_TTL_SECONDS=600`, allow up to ten minutes after the old process stops, plus approximately two minutes for new credentials to propagate. Repeated restarts create additional overlap and delay recovery. Use `all` normally and `relay` only during deliberate acceptance testing; changing this policy alone does not fix credential issuance.

Metered documents credential expiry as a hard cutoff, including active allocations. The client refreshes 60 seconds early and restarts ICE with another already-propagated credential; failures end calling visibly. Long calls across a real expiry still require acceptance testing. This intentionally uses shorter lifetimes and unique response credentials than Metered's general shared-credential rotation example. See [credential creation](https://www.metered.ca/docs/turn-rest-api/post-create-credential/) and [propagation/rotation semantics](https://www.metered.ca/docs/turnserver-guides/rotating-turn-credentials/).

For local testing, put the variables in `apps/api/.env`, or a Git-ignored `apps/api/.env.metered.local` and set `DOTENV_CONFIG_PATH` to its absolute path before `npm run dev`. Turbo forwards all ICE settings and the custom dotenv path. Use `ICE_TRANSPORT_POLICY=relay` only for forced-relay testing, then restore `all`. A one-time dashboard credential is not used by this adapter; temporary credentials are created through the management API.

### Self-hosted coturn

Choose an existing coturn-compatible service or separate coturn host. No resource or purchase was provisioned. Render forwards public traffic to one HTTP port, so the existing web service is not the TURN relay. See [Render's port constraints](https://render.com/docs/web-services#binding-to-multiple-ports).

For coturn, set `use-auth-secret`, a protected `static-auth-secret` matching Render, and your relay `realm`. Supply TLS certificate/key for `turns:`. Open TCP/UDP 3478, TLS TCP 5349 (or dedicated TLS 443) and a configured UDP relay range. If behind NAT, configure the public/private mapping and direct port forwarding. Set allocation/bandwidth quotas and appropriate denied private/loopback/multicast peer ranges; avoid anonymous access and verbose sensitive logging. Test UDP and TLS/TCP separately. Check the installed version and host constraints against the [official coturn configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).

Browser references used: [WebRTC standard](https://www.w3.org/TR/webrtc/), [perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation), [ICE restart](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce).

## Deployment order

1. Review local commits, then separately authorize push/merge/deployment. This follow-up does not push or deploy. Keep a Neon backup and compatible rollback version.
2. Configure external TURN in Render: either coturn URLs/shared secret or Metered URLs/domain/Developers secret as shown above. If Metered is already configured, retain those values. With TURN absent, calling cannot meet the remote-network exit criterion.
3. Deploy API first. Render build: `npm ci && npm run build --workspace=@codetogether/api`. Keep the existing migration step, then `npm run start --workspace=@codetogether/api`; without pre-deploy migration support, use `npm run db:migrate && npm run start --workspace=@codetogether/api`. Health check stays `/api/health`.
4. Rebuild/deploy Vercel with its existing monorepo settings and two variables (`npm run build --workspace=@codetogether/web` from root, or existing root build). Refresh old tabs. The new API remains compatible with Phase 3 clients.
5. Run forced-relay checks in staging or a coordinated test window; confirm relay candidates and increasing inbound media without logging SDP/ICE addresses. Restore `all`.
6. Complete the manual acceptance below. Roll back frontend then API to compatible Phase 3 code if needed; retain all migrations/data. Calls close during rollback/restart.

## Manual acceptance still required

- Two physical devices on different networks: audible bidirectional sound and moving video, audio-only, mute/camera privacy, physical device switching/unplugging, denied/busy permissions, headset routing and autoplay recovery.
- Chromium, Firefox and Safari/iOS: permission prompts, orientation/backgrounding, keyboard focus, readable tiles, editor/chat usability with panels open and closed.
- Four participants and rejected fifth tab; simultaneous joins, leave/rejoin, prolonged outage, ICE restart, Render restart, TURN expiry renewal and relay outage without endless retry or capture after Leave.
- Viewers can call but cannot type/undo/redo; promotion restores editing. Removal, logout, expiry and room deletion stop compliant clients. Concurrent editing/autosave/cursors/chat persist throughout calling.
- Production proxy + WSS ticket flow, Neon durability, exact origins and temporary credentials. Health-route reachability alone is not acceptance.

## Verification record

Verified locally on Windows with Node and Chromium on 12 October 2026:

- `npm run lint`, `npm run typecheck` and `npm run build` passed. The browser test source also passed a standalone strict TypeScript check.
- `npm test`: **36 passed**, covering API, authenticated sockets, database/PGlite persistence, document collaboration and media authorization/resource limits. Media tests include removal, logout/expiry, room deletion, stale sessions, destination isolation, canceled joins, lease expiry and API restart.
- `npm run test:e2e`: **8 passed, 1 skipped**. Two authenticated contexts exchanged fake-device media verified by remote tracks, inbound audio RTP and decoded video frames. Tests exercised deterministic offer collisions, mute/camera controls, switching, leave/rejoin, reconnect, cleanup, concurrent editing/chat and viewer safety. The existing editor → viewer → editor regression passed.
- Permission denial, unavailable/busy devices, device removal and blocked autoplay were simulated. Playback recovery checked advancing remote audio playback. Credential renewal used an accelerated expiry response and verified ICE restart without reacquiring devices; it did not use a real TURN relay.
- The credential-renewal/playback scenario passed three additional consecutive runs after investigating an earlier intermittent connection failure.
- Desktop and mobile screenshots were inspected, including mobile editor and chat views during a call.

At the initial Phase 4 milestone, forced TURN was skipped because usable relay credentials were unavailable. Physical devices, different networks, Firefox/Safari, hosted deployment/CI, Neon/PostgreSQL-server tests, real TURN credential expiry and deployed Render restart were **not tested**. No push, deployment or paid resource provisioning was performed.

### Metered integration follow-up — 12 October 2026

- Created the requested dashboard credential on the existing no-card 500 MB trial. No paid plan or payment method was activated. The API adapter uses the Developers secret to prepare separate expiring credentials, not this manual credential.
- `npm test`: **42 passed**, including five Metered pool/configuration tests and a route integration test for authenticated, uncached warmup errors and distinct credential responses. TypeScript, lint and production build passed.
- `TEST_TURN_RELAY=1 npm run test:e2e -- tests/calls.spec.ts -g 'forced TURN relay'`: **1 passed** using the real Metered service. Both authenticated Chromium contexts received fake-device audio RTP and decoded video, and selected local relay candidates with `iceTransportPolicy=relay`. This was a short call between two contexts on one Windows machine, not a physical-device or different-network test. The full eight-test browser suite from the initial milestone was not rerun for this backend-only follow-up.
- Temporary credentials were successfully generated and propagated through Metered. The local test service was stopped afterward, and the ignored local configuration restored to `ICE_TRANSPORT_POLICY=all`. Provider secrets were not committed or deployed.
- A separate provider-response diagnostic request was rejected by automatic approval review and was not retried. The already-running relay test then completed successfully, so that diagnostic was unnecessary.

Real expiry during a long call, physical devices, different networks and production deployment acceptance remain pending. The blueprint's remote-user exit criterion is not yet claimed complete.

### Layout and Metered quota fix — 13 October 2026

- Reproduced the clipped composer after adding the call area. Members and messages now scroll independently; the composer fits tested desktop/mobile sizes, and the entire panel can scroll in very short windows. The regression checks viewport bounds and hit testing, sends messages at 1536×730, 1280×600, 390×700 and 640×360, and verifies receipt by the second authenticated context. Desktop/mobile screenshots during an active call were also inspected.
- Read-only production checks found the API and frontend proxy health routes reachable and the configured Metered Developers secret matched the account. Metered rejected credential creation with HTTP 403 and an explicit maximum-credential-limit response; its active list contained ten credentials. This was an active credential quota problem, not evidence that retained expired dashboard entries consumed slots. No live settings or plans were changed.
- Replaced the sixteen-item target with four unused/eight total active credentials, accounting for assigned credentials until expiry. A fake-clock provider test simulates four callers renewing for an hour under a ten-credential account limit with one unrelated manual credential. Tests also cover pending-delete races, safe diagnostics, recovery, bounded provider timeouts and log deduplication. This simulation is not a real long-duration relay test.
- `npm test`: **46 passed**. `npm run test:e2e`: **9 passed, 1 skipped**. The full suite retained actual fake-device audio RTP/video decoding checks, simultaneous offer collision, controls, reconnect/cleanup, concurrent editing/chat and editor → viewer → editor undo/redo protection. Lint, workspace TypeScript, strict browser-test TypeScript and the production build passed.
- Forced-relay attempts during diagnosis failed at credential issuance; the final reduced pool has not passed a new live relay run. The deployed old pool still shares this small account, so running another local pool would contend for the same slots. The earlier 12 October relay pass is historical and does not validate this fix. After deployment replaces the old process and its credentials expire, repeat forced relay, real expiry renewal and different-network acceptance.
- No push, merge, deployment, paid resource provisioning or database migration was performed for this follow-up. Physical devices, Firefox/Safari, production call acceptance and genuine calls between different networks remain unverified.
