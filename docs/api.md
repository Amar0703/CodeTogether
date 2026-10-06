# Phase 1 API

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
