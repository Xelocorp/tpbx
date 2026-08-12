-- 0018_totp.sql
--
-- Per-user TOTP (RFC 6238) two-factor authentication, compatible with Google
-- Authenticator and any other standard authenticator app.
--
-- totp_secret holds the base32 shared secret. It is written when a user starts
-- enrolment and only becomes active once totp_enabled flips true (after the
-- user proves they can generate a valid code). A role may also *require* TOTP
-- (tpbx_roles.require_totp, migration 0017): such users are forced to enrol
-- before the console lets them past the login screen.

ALTER TABLE tpbx_users ADD COLUMN IF NOT EXISTS totp_secret  TEXT    NOT NULL DEFAULT '';
ALTER TABLE tpbx_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
