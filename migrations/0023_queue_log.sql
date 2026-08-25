-- queue_log — Asterisk app_queue (ACD) event log, the source of the call-center
-- dashboard measures (Service Level, Calls Offered/Handled/Abandoned, AHT,
-- Allocation Failed, live In-Queue/Talking). Asterisk writes it here via the
-- realtime engine; see asterisk/queue_log.conf / docs/CALL_CENTER.md.
--
-- Schema matches Asterisk's realtime queue_log expectation (time, callid,
-- queuename, agent, event, data1..data5) so app_queue can INSERT into it.
CREATE TABLE IF NOT EXISTS queue_log (
    id         BIGSERIAL PRIMARY KEY,
    time       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    callid     VARCHAR(80)  DEFAULT '',
    queuename  VARCHAR(256) DEFAULT '',
    agent      VARCHAR(256) DEFAULT '',
    event      VARCHAR(32)  DEFAULT '',
    data1      VARCHAR(100) DEFAULT '',
    data2      VARCHAR(100) DEFAULT '',
    data3      VARCHAR(100) DEFAULT '',
    data4      VARCHAR(100) DEFAULT '',
    data5      VARCHAR(100) DEFAULT ''
);

CREATE INDEX IF NOT EXISTS queue_log_time_idx  ON queue_log (time DESC);
CREATE INDEX IF NOT EXISTS queue_log_event_idx ON queue_log (event);
CREATE INDEX IF NOT EXISTS queue_log_queue_idx ON queue_log (queuename);
CREATE INDEX IF NOT EXISTS queue_log_callid_idx ON queue_log (callid);
