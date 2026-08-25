# XeloVoice API (`/api/v1`)

A token-authenticated, machine-to-machine control plane that mirrors what the
admin console can do: manage extensions, list trunks, place/drop calls, and pull
call-center reports. It is independent of the browser session cookie — external
systems (e.g. TawasulCX) authenticate with an **API token**.

- **Base URL:** `https://<your-host>/api/v1`
- **Interactive docs:** `https://<your-host>/api/v1/docs`
- **Machine spec:** `https://<your-host>/api/v1/openapi.json` (OpenAPI 3.0)

## Authentication

Create a token in the console under **Settings → API**. The full token is shown
**once** at creation and stored only as a SHA-256 hash; revoking it takes effect
immediately.

Send it on every request, in priority order:

1. `Authorization: Bearer <token>` — preferred
2. `X-API-Token: <token>` — header alternative
3. `?api_token=<token>` — query param, for quick tests only

Unauthenticated or revoked tokens get `401` with a `WWW-Authenticate` hint.
`/docs` and `/openapi.json` are public (documentation only); every other
endpoint requires a token.

## Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/ping` | Verify a token; echoes its name |
| GET | `/extensions` | List SIP extensions |
| GET | `/extensions/{id}` | Get one extension |
| POST | `/extensions` | Create an extension |
| DELETE | `/extensions/{id}` | Delete an extension |
| GET | `/trunks` | List SIP trunks |
| GET | `/reports/overview` | Call-center KPIs (`?days`, `?queue`, `?sla`) |
| GET | `/reports/queues` | Queue names |
| GET | `/reports/agents` | Per-agent stats (`?days`) |
| GET | `/calls` | Live channels (active calls) |
| POST | `/calls/originate` | Place a call |
| DELETE | `/calls/{id}` | Hang up a channel |
| WS | `/events` | Live event stream (`?events=` CSV filter) |

### Reporting window

`/reports/*` accept either an explicit `?from=&to=` (RFC3339) or a rolling
`?days=N` (default 7). `/reports/overview` also accepts `?queue=<name>` to scope
to one ACD queue and `?sla=<seconds>` to override the service-level threshold
(otherwise the global **Settings → System → Service level target** is used).

## Events (real-time)

External systems can react to telephony activity the instant it happens, two
ways:

### WebSocket

Connect to `wss://<your-host>/api/v1/events?api_token=<TOKEN>` (the token goes in
the query string because browsers can't set headers on a WebSocket). Optionally
filter with `&events=call.started,call.ended`. The server sends a `hello` frame,
then one JSON event per occurrence, and pings every 30s.

### Webhooks

Register an HTTPS endpoint under **Settings → API → Webhooks** (or via the
console API). XeloVoice POSTs each event as JSON with a bounded retry, signed
with an HMAC-SHA256 of the **raw body** under the endpoint's own secret:

```
X-XeloVoice-Signature: sha256=<hex>
```

Verify it before trusting the payload — compute `HMAC_SHA256(secret, body)` as
lowercase hex and compare constant-time. The most recent delivery status is
shown in the console.

### Event shape

```json
{
  "id": "evt_1735920000000000000_42",
  "type": "call.answered",
  "time": "2026-08-25T10:00:00Z",
  "data": {
    "channelId": "1735920000.12",
    "channel": "PJSIP/1001-00000abc",
    "extension": "1001",
    "state": "Up",
    "callerNumber": "1001",
    "connectedNumber": "1002",
    "context": "from-internal",
    "exten": "1002"
  }
}
```

Types: `call.started`, `call.answered`, `call.ended` (plus `webhook.test` from
the console's "Test" button).

## Examples

```bash
# Verify a token
curl -H "Authorization: Bearer $TOKEN" https://pbx.example.com/api/v1/ping

# Place a call from 1001 to 1002
curl -X POST https://pbx.example.com/api/v1/calls/originate \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"endpoint":"PJSIP/1001","extension":"1002","context":"from-internal"}'

# Call-center KPIs for the last day
curl -H "Authorization: Bearer $TOKEN" \
  "https://pbx.example.com/api/v1/reports/overview?days=1"
```

## Security notes

- Tokens grant the same telephony control the console has — treat them like
  passwords and scope integrations to their own named token so they can be
  revoked independently.
- Responses are marked `Cache-Control: no-store`.
- Token administration (`/api/settings/tokens`) lives behind the console session
  and the `settings` permission, so only admins/authorized operators can mint or
  revoke tokens.
