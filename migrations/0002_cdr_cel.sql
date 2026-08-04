-- 0002_cdr_cel.sql
--
-- Call reporting sinks.
--
--   cdr  -- one row per call, written by cdr_adaptive_odbc.
--   cel  -- fine-grained channel events, written by cel_odbc.
--
-- "adaptive" ODBC means Asterisk maps CDR variables to whatever columns of the
-- same name exist in this table, so the schema below is also the menu of what
-- the GUI can report on. Extra CDR variables with no matching column are
-- silently dropped, which is the desired behaviour.

BEGIN;

CREATE TABLE IF NOT EXISTS cdr (
    id           BIGSERIAL PRIMARY KEY,
    calldate     TIMESTAMPTZ NOT NULL DEFAULT now(),
    clid         VARCHAR(80)  DEFAULT '',
    src          VARCHAR(80)  DEFAULT '',
    dst          VARCHAR(80)  DEFAULT '',
    dcontext     VARCHAR(80)  DEFAULT '',
    channel      VARCHAR(80)  DEFAULT '',
    dstchannel   VARCHAR(80)  DEFAULT '',
    lastapp      VARCHAR(80)  DEFAULT '',
    lastdata     VARCHAR(80)  DEFAULT '',
    duration     INTEGER      DEFAULT 0,
    billsec      INTEGER      DEFAULT 0,
    disposition  VARCHAR(45)  DEFAULT '',   -- ANSWERED | NO ANSWER | BUSY | FAILED
    amaflags     INTEGER      DEFAULT 0,
    accountcode  VARCHAR(20)  DEFAULT '',
    uniqueid     VARCHAR(150) DEFAULT '',
    linkedid     VARCHAR(150) DEFAULT '',
    userfield    VARCHAR(255) DEFAULT '',
    peeraccount  VARCHAR(80)  DEFAULT '',
    sequence     INTEGER      DEFAULT 0
);

CREATE INDEX IF NOT EXISTS cdr_calldate_idx ON cdr (calldate DESC);
CREATE INDEX IF NOT EXISTS cdr_src_idx      ON cdr (src);
CREATE INDEX IF NOT EXISTS cdr_dst_idx      ON cdr (dst);
CREATE INDEX IF NOT EXISTS cdr_uniqueid_idx ON cdr (uniqueid);

CREATE TABLE IF NOT EXISTS cel (
    id            BIGSERIAL PRIMARY KEY,
    eventtype     VARCHAR(30)  DEFAULT '',
    eventtime     TIMESTAMPTZ NOT NULL DEFAULT now(),
    cid_name      VARCHAR(80)  DEFAULT '',
    cid_num       VARCHAR(80)  DEFAULT '',
    cid_ani       VARCHAR(80)  DEFAULT '',
    cid_rdnis     VARCHAR(80)  DEFAULT '',
    cid_dnid      VARCHAR(80)  DEFAULT '',
    exten         VARCHAR(80)  DEFAULT '',
    context       VARCHAR(80)  DEFAULT '',
    channame      VARCHAR(80)  DEFAULT '',
    appname       VARCHAR(80)  DEFAULT '',
    appdata       VARCHAR(512) DEFAULT '',
    amaflags      INTEGER      DEFAULT 0,
    accountcode   VARCHAR(20)  DEFAULT '',
    peeraccount   VARCHAR(20)  DEFAULT '',
    uniqueid      VARCHAR(150) DEFAULT '',
    linkedid      VARCHAR(150) DEFAULT '',
    userfield     VARCHAR(255) DEFAULT '',
    peer          VARCHAR(80)  DEFAULT '',
    extra         VARCHAR(512) DEFAULT ''
);

CREATE INDEX IF NOT EXISTS cel_eventtime_idx ON cel (eventtime DESC);
CREATE INDEX IF NOT EXISTS cel_linkedid_idx  ON cel (linkedid);

COMMIT;
