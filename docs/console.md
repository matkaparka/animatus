# Console

The console is the only place anything is configured or approved. It is a React page that is opened in a
normal browser window, never in the captured stage window, and it talks to a small HTTP and WebSocket
server inside the orchestrator.

| Part | Where |
|---|---|
| Contract (schemas, constants) | `packages/protocol/src/console.ts` |
| Server | `packages/orchestrator/src/console/` |
| Page | `packages/console/` |

## Opening it

The orchestrator creates a fresh token every time it starts and prints the whole address once, with the
token in the URL fragment:

```
http://127.0.0.1:<port>/#token=<token>
```

Open that address in a normal browser window. The page reads the token, keeps it in memory (and in
`sessionStorage`, so a reload of that tab still works), and removes it from the address bar at once. A new
tab, or a restart of the orchestrator, needs the printed address again. Pasting the new address into a tab
that still has the old console open works too: the page follows changes of the fragment.

Opened without a token, the page only explains this. It never asks for one.

Starting the server from code:

```ts
const server = createConsoleServer({ port, staticDir, backend, logger })
await server.start()
process.stderr.write(`Console: ${server.openUrl}\n`) // the one place the token is printed, on purpose
backend.onEvent((event) => server.publish(event))
```

## Security model

### What the token protects

Everything under `/api/*`: reading the status and the configuration, starting and stopping plugins,
entering modes, making the character speak, injecting audience events, and writing secrets. Nothing under
`/api/*` answers without it. Static files (the page itself) are served without it: they contain no token,
and the token never reaches the server through the address, because browsers do not send the fragment.

### Why the stage cannot get it

The stage page is served by the stage server on another port, and it is the one page whose window is
captured on stream. It has no way to the token:

- The token exists in the orchestrator's memory, in the address the orchestrator printed, and in the
  console tab (memory and `sessionStorage`, which is private to an origin, and the console's origin is not
  the stage's). No route returns it, no log line contains it, the stage server never sees it.
- Even a stage page that guessed or was handed the token could not use it: its requests carry the stage's
  `Origin`, and the console server refuses any `Origin` that is not its own (or a listed extra one) with 403
  before it looks at the token.
- The console server sends no CORS header, ever, so a page on another origin cannot read a response even
  when a request got through.
- There are no cookies. Cookies are shared between ports of one host, so a cookie session would have been
  visible to the stage page. The token travels as `Authorization: Bearer`, and on the socket as a
  subprotocol.
- The stage's own channel is one-way: it sends reports and can never send a command.

### Checks, in order

Every HTTP request and every WebSocket upgrade:

1. **Host** must be exactly `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence: a page on
   `evil.example` that resolves to 127.0.0.1 is same-origin with itself, so the server refuses any other
   name). 403 `forbidden_host`.
2. **Origin**, when present, must be `http://127.0.0.1:<port>`, `http://localhost:<port>` or one of
   `extraOrigins` (exact match; `null`, an empty value and a trailing slash all fail). 403
   `forbidden_origin`, with a valid token too. A request with no `Origin` (`curl`, a top-level navigation)
   passes this step and still needs the token for `/api/*`.
3. **Rate limit**: after ten refused tokens inside a minute, an address is answered with 429 (`Retry-After`)
   for a minute, whatever it presents, so the answer never tells a guesser it guessed right. Host and Origin
   refusals, static files and unknown paths do not count.
4. **Token**: `Authorization: Bearer <token>` on HTTP, `token.<token>` as the second WebSocket subprotocol.
   Compared with `crypto.timingSafeEqual` after hashing both sides, so length does not leak. Missing or wrong
   is 401 `unauthorized`. Exactly one `token.*` subprotocol counts: offering several would be several guesses
   for one refusal. A token in a query string, a cookie or any other header is not looked at.
5. Only then does the caller learn whether the route exists (404 `not_found`, 405 `method_not_allowed`).

The server binds to `127.0.0.1` only and refuses any other `host` option.

### Requests and answers

- Bodies are JSON only (`application/json`), at most 64 KiB (413), checked against the protocol schemas. A
  field the schema does not know is an error, not something dropped (400 `unknown_field`). Error messages
  name types and limits, never the value that was sent, and a JSON parser's own message (which can quote its
  input) is never passed on.
- Every success body is validated with its schema before it is sent; a backend that breaks the contract gets
  a 500 and a log line, not a broken page.
- Any error that is not an `ApiFailure` is a generic 500 (`internal_error`); its text goes to the log, not to
  the client.
- Every response carries `Content-Security-Policy: default-src 'self'; connect-src 'self' ws://127.0.0.1:*
  ws://localhost:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri
  'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy:
  same-origin`. API answers also carry `Cache-Control: no-store`.
- Static files: each path segment is decoded once and checked (no `..`, hidden names, backslashes, NUL,
  drive letters, alternate streams, device names), the real path must still be inside the build folder
  (symlinks and junctions that leave it fail), only regular files are served, and only paths without a file
  extension fall back to `index.html`.

### Secrets

Secrets are write-only. `PUT /api/secrets/:name` stores a value; no route, event or log line ever returns
one. The server never logs a request body, logs the route pattern (`/api/secrets/:name`) instead of the real
path, masks the submitted value in anything a backend answers with, and drops an answer that contains it.
The page reads the value at the moment of submitting, wipes the field in the same step and never puts it in
component state. `GET /api/config` masks string values under keys that name a secret (`token`, `password`,
`api_key`, `cookie`, ...) as a second line of defence behind the backend's own sanitising.

## API

Contract: `packages/protocol/src/console.ts`. All routes need the token. Lists are objects, not bare
arrays; single resources come back as themselves.

| Route | Body | Answer |
|---|---|---|
| `GET /api/status` | | `StatusView` |
| `GET /api/plugins` | | `{ plugins: PluginView[] }` |
| `POST /api/plugins/:id/start`, `/stop`, `/restart` | none | `PluginView` after the action |
| `GET /api/plugins/:id/logs?lines=N` | | `text/plain`, one log line per line; `N` defaults to 200, at most 1000; lines are cut at 4000 characters |
| `GET /api/modes` | | `{ modes: ModeView[] }` |
| `POST /api/modes/:id/enter`, `/exit`, `/act` | optional `ModeRequest`: `replace`, `force`, and `params` (up to 16 string, number or boolean details that the mode's own code understands: which dance, tuning numbers; anything it does not know is ignored) | `ModeView` after the action; a refusal is a 409 whose message says why |
| `GET /api/secrets` | | `{ secrets: SecretView[] }`: names, `set`, `source` |
| `PUT /api/secrets/:name` | `SecretPut` | `SecretView` |
| `DELETE /api/secrets/:name` | | `SecretView` after the delete (an environment variable may still set it) |
| `POST /api/say` | `SayRequest` | `{ ok: true }` |
| `POST /api/inject` | `InjectRequest` | `{ ok: true }`; enters as an untrusted viewer event |
| `POST /api/stop` | none | `{ ok: true }`; cancels what is being said and everything queued |
| `GET /api/events?limit=N` | | `{ events: RunEvent[] }`, oldest first; default 100, at most 500 |
| `GET /api/traces?limit=N` | | `{ traces: SpeechTraceView[] }`, oldest first; default 50, at most 200 |
| `GET /api/config` | | `{ config: {...} }`, sanitised |

Other methods on these paths are 405 with an `Allow` header (`HEAD` and `OPTIONS` included: there is no
CORS).

Errors are `ApiError` bodies, `{ "error": { "code", "message" } }`, with the code at most 64 and the message at
most 600 characters:

| Status | Codes |
|---|---|
| 400 | `invalid_request`, `invalid_json`, `invalid_body`, `unknown_field`, `body_required`, `unexpected_body`, `invalid_id`, `invalid_name`, `invalid_query`, `invalid_path` |
| 401 | `unauthorized` (with `WWW-Authenticate: Bearer`) |
| 403 | `forbidden_host`, `forbidden_origin` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 429 | `rate_limited` (with `Retry-After`) |
| 500 | `internal_error` |
| refusals by the backend | its own code and status, for example 409 `already_running`, `not_running`, `plugin_disabled`, `no_fit`, `excluded`, `blocked`, `read_only` |

### Live socket

`/api/ws`, subprotocol `animatus.console.v1` plus `token.<token>`. The server selects only the first; the token
is never echoed. Messages are `ConsoleEvent`s:

| Event | When |
|---|---|
| `hello` | on connect, first |
| `status` | right after `hello`, then every 2 seconds |
| `run`, `trace`, `alarm`, `plugin`, `mode` | whatever the backend passes to `server.publish()`; invalid events are refused and logged |

Anything a client sends is ignored, and a frame over 4 KiB closes the socket (1009). Protocol-level pings are
answered; the server pings every 15 seconds and drops a client that does not answer. A client that falls a
megabyte behind is dropped. At most 16 consoles connect at once (503 beyond that). Closing the server ends
every socket with 1001.

## The backend

The server owns transport and security; a `ConsoleBackend` (`backend.ts`) owns what the routes do, one method
per route, in terms of the contract types only. It refuses with `ApiFailure(code, message, httpStatus)`;
those messages reach the browser, so they carry no paths, stack traces or values. `FakeBackend` (`fake.ts`)
is an in-memory implementation with made-up data, used by the tests and the demo.

## The page

React 19 and Vite, no router and no UI library, one stylesheet with a dark theme that follows the system,
usable at phone width. Everything is rendered as text nodes; there is no `dangerouslySetInnerHTML`, no
`eval`, and no request to any other origin.

| Tab | What |
|---|---|
| Run | Status cards (stage, audio and AudioContext counts, frame rate, underruns, T-pose frames, speech, GPU memory, language models), alarms, the live event stream (audience lines carry an "untrusted" badge), the speech trace table, a form to make the character say a line, a button to stop speech, and a form to inject a fake audience event |
| Plugins | Status, pid, restarts, health, GPU memory estimate against measurement ("not measured" for a missing figure), start / stop / restart, a logs drawer |
| Modes | One card per mode: state, priority, exclusions, services, the admission verdict, pairs that do not fit. Enter is disabled, with the reason as its tooltip and as visible text, when the verdict is no; an option replaces conflicting modes |
| Settings | Read-only, collapsible view of `/api/config`. Editing comes later |
| Keys | Names, set or not, where stored; a password field to set one; delete. Values are write-only |

The page validates every answer with the protocol schemas and shows a clear error when the shape is wrong.
It reconnects the socket with an exponential, jittered backoff (500 ms doubling to 15 s), counts a connection
as healthy only once `hello` arrived, and drops one that has gone quiet. A token the server refuses ends in
an explanation, not a retry loop, and costs the server one refused request.

## Development

Run the console against made-up data, without an orchestrator:

```bash
npm run build -w @animatus/console
npx tsx packages/orchestrator/src/console/demo.ts
```

It prints the address to open. Optional environment: `ANIMATUS_CONSOLE_PORT` (default: a free port),
`ANIMATUS_CONSOLE_TOKEN` (default: random), `ANIMATUS_CONSOLE_EXTRA_ORIGINS` (comma separated). When
`packages/orchestrator/package.json` gets a `console:demo` script, it is the same command run from that
package (`tsx src/console/demo.ts`).

To rebuild the page on every change while the server serves it, run `npx vite build --watch` in
`packages/console` (the server reads files on each request, so a reload picks the new build up).

For hot reload, the Vite dev server has to forward `/api` and the socket to the console server, because the
console server refuses cross-origin requests and sends no CORS headers:

```bash
# terminal 1: the demo, allowing the dev page's origin
ANIMATUS_CONSOLE_EXTRA_ORIGINS=http://127.0.0.1:5174 npx tsx packages/orchestrator/src/console/demo.ts
# terminal 2: from packages/console
npx vite --config vite.dev.config.ts
# then open http://127.0.0.1:5174/#token=<the token the demo printed>
```

`vite.dev.config.ts` adds the proxy (`changeOrigin: true`, so `Host` becomes the console server's, and
`ws: true` for the socket) to the normal config; `ANIMATUS_CONSOLE_URL` points it at a server that is not on
`127.0.0.1:7411`. A real orchestrator needs the same `extraOrigins` entry. Only list origins you control.

## Tests

```bash
npx vitest run --project orchestrator test/console   # server: real HTTP and WebSocket clients
npx vitest run --project console                     # page: happy-dom and Testing Library
```

The server tests cover authentication (including that `timingSafeEqual` is what compares), the rate limit
with an injected clock, Host and Origin for HTTP and WebSocket including a cross-origin page holding a valid
token, subprotocol handling, every route and its validation errors, that a secret never appears in any
response, socket message or log line, static serving and traversal attempts, the security headers, the body
limit, event delivery to several clients, and shutdown. The page tests cover the token from the fragment, the
API client's validation, the Keys page never rendering a value, the blocked Enter button, the untrusted badge,
the socket's reconnect and backoff with fake timers, and the say and inject forms.
