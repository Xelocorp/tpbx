# Call-center (ACD) dashboard

The **Overview** tab is a live call-center dashboard driven by Asterisk's queue
(ACD) data — Service Level, Calls Offered/Handled/Abandoned, AHT, Allocation
Failed, plus live Present Call Status and Agent Status. It works with **any**
softphone that registers to Asterisk (the metrics come from the switch, not the
client).

## What it shows
- **Gauges:** Service Level % (answered within SLA / offered), Answered %
  (handled / offered), AHT (avg queue talk time).
- **Overall Call Status:** Calls Offered, Calls Handled, Abandoned, Pending
  Abandoned, Dropped in IVR, Allocation Failed, + a Handled/Abandoned/Dropped
  pie.
- **Present Call Status (live):** In IVR, In Queue, Transferring, Talking.
- **Agent Status:** total / online / on-call, plus the live extension list.
- **Process selector:** filter every number to one queue, or ALL.

## Data source — `queue_log`
Everything queue-related is computed from Asterisk's **`queue_log`** (app_queue).
It's wired to write into Postgres in real time:

1. **Migration `0023_queue_log.sql`** creates the `queue_log` table (applied on
   deploy/upgrade like the other migrations).
2. **`asterisk/extconfig.conf`** maps it to realtime:
   `queue_log => pgsql,tpbx,queue_log`. With `res_config_pgsql` preloaded (it
   already is, for PJSIP realtime), app_queue writes every event straight to the
   table.

No file parsing, no cron — it's live.

## What you must have for the numbers to populate
- **Use Asterisk queues** (`app_queue`) for inbound distribution — callers enter
  a queue and are handed to agents. The "Process" entries are your queue names.
- Point inbound routes at `Queue(<name>)` in the dialplan. Each queue's members
  are your agents' extensions.
- After deploying, place a few queued test calls; the dashboard fills in.

## Tuning
- **Service-level threshold (SLA):** defaults to **20s**. Override per request
  with `?sla=<seconds>` on `/api/analytics/overview` (a global setting can be
  added on request).
- **Windows:** the top-bar day selector drives the reporting window; live tiles
  (In Queue / Talking / Agent Status) refresh every 15s.

## Metric definitions (from queue_log events)
| Metric | Derivation |
|---|---|
| Calls Offered | `ENTERQUEUE` count |
| Calls Handled | `CONNECT` count |
| Abandoned | `ABANDON` count |
| Allocation Failed | `EXITEMPTY` (no agent available) |
| Service Level % | `CONNECT` with hold-time ≤ SLA ÷ Offered |
| Answered % | Handled ÷ Offered |
| AHT | avg talk-time from `COMPLETECALLER`/`COMPLETEAGENT` |
| Pending Abandoned | abandoned callers with no later `CONNECT` |
| In Queue / Talking (live) | open `ENTERQUEUE` / `CONNECT` sessions with no terminal event |
| Dropped in IVR | inbound CDR, not answered, never entered a queue (best-effort) |

`In IVR` and `Transferring` live tiles are placeholders (0) until a dialplan/AMI
feed is added — everything else is live from `queue_log` + CDR + ARI.

## Bring-your-own-softphone
Because these come from Asterisk, agents can use **any** SIP client (Zoiper,
Linphone, MicroSIP, Bria, desk phones) and still appear in the dashboard. Give
each agent their extension + SIP secret + your domain + a transport
(UDP/TCP/TLS/WSS). The only metrics that need our XeloVoice app (or the planned
web wrap-up panel) are the agent-tagged ones: Nature of Calls, Resolution Rate,
Hangup Cause, and DND telemetry.
