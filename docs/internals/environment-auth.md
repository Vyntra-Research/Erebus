# Environment authorization

> For maintainers. Using Erebus? See [docs/user](../user/).

The local Erebus server grants narrow capabilities to the desktop shell and paired development browsers. A client authenticates once, receives a scoped session, and exchanges that session for a short-lived WebSocket ticket.

## Active scopes

| Scope                   | Permission                                                |
| ----------------------- | --------------------------------------------------------- |
| `orchestration:read`    | Read task, project, filesystem, and source-control state. |
| `orchestration:operate` | Dispatch task operations and change workspace state.      |
| `terminal:operate`      | Create and control terminals.                             |
| `review:write`          | Read review diffs used to compose feedback.               |
| `access:read`           | Inspect pairing links and authorized clients.             |
| `access:write`          | Create or revoke pairing links and sessions.              |

Relay scopes remain in contracts for compatibility with inherited source. The current release uses the local desktop and paired development-browser scopes above.

## Browser session

`POST /api/auth/browser-session` consumes a one-time bootstrap credential and creates an HTTP-only browser session cookie. Browser JavaScript never receives the session secret.

The packaged desktop app supplies its bootstrap credential directly to the embedded client. A development server prints a one-time pairing URL.

## Bearer and DPoP sessions

Non-browser clients can exchange a bootstrap credential at `POST /oauth/token`. Requested scopes must be a subset of the bootstrap grant. Plain bearer sessions use the session store's normal lifetime. A valid DPoP proof binds the token to a key and uses a shorter lifetime.

This is not a general OAuth server. Erebus uses OAuth token and scope vocabulary for a small local authorization boundary.

## WebSocket tickets

`POST /api/auth/websocket-ticket` accepts an authenticated session and returns a five-minute, single-purpose ticket. The client places only that ticket in the socket URL. Long-lived credentials and browser cookies stay out of WebSocket URLs.

Each RPC method still checks its required scope through `RPC_REQUIRED_SCOPES` in `apps/server/src/auth/RpcAuthorization.ts`. Creating a ticket does not grant every operation.

## Upgrade behavior

Migration `031_AuthAuthorizationScopes` replaced role-bearing records with scoped records. It removes old pairing links and sessions while preserving other environment state. An upgraded browser must pair again.
