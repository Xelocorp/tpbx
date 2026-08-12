-- 0017_roles.sql
--
-- Custom console roles with per-feature permissions.
--
-- Previously the console had four hard-coded roles (admin/manager/operator/
-- viewer) enforced by name in the API and the nav. This introduces a real
-- role table so an admin can create arbitrary roles and toggle, per feature,
-- which of view/create/edit/delete each role may do.
--
-- permissions is a JSON object keyed by feature name; each value is an object
-- of the four action booleans, e.g.
--   {"extensions":{"view":true,"create":true,"edit":false,"delete":false}, ...}
-- A missing feature or action means "not allowed". The built-in admin role is
-- always granted everything in code regardless of what is stored here.
--
-- require_totp, when true, forces every user carrying this role to finish TOTP
-- (Google Authenticator) enrolment before the console will let them in.

CREATE TABLE IF NOT EXISTS tpbx_roles (
    name         VARCHAR(32) PRIMARY KEY,
    display_name VARCHAR(128) NOT NULL DEFAULT '',
    permissions  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    require_totp BOOLEAN      NOT NULL DEFAULT false,
    built_in     BOOLEAN      NOT NULL DEFAULT false, -- admin: cannot be edited/deleted
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Seed the four historical roles so existing accounts keep working unchanged.
-- The feature list mirrors the nav: extensions, trunks, routing, ivr, cdr,
-- analytics, transports, settings, users.

INSERT INTO tpbx_roles (name, display_name, permissions, built_in) VALUES
  ('admin', 'Administrator',
   '{"extensions":{"view":true,"create":true,"edit":true,"delete":true},
     "trunks":{"view":true,"create":true,"edit":true,"delete":true},
     "routing":{"view":true,"create":true,"edit":true,"delete":true},
     "ivr":{"view":true,"create":true,"edit":true,"delete":true},
     "cdr":{"view":true,"create":true,"edit":true,"delete":true},
     "analytics":{"view":true,"create":true,"edit":true,"delete":true},
     "transports":{"view":true,"create":true,"edit":true,"delete":true},
     "settings":{"view":true,"create":true,"edit":true,"delete":true},
     "users":{"view":true,"create":true,"edit":true,"delete":true}}'::jsonb,
   true),
  ('manager', 'Manager',
   '{"extensions":{"view":true,"create":true,"edit":true,"delete":true},
     "trunks":{"view":true,"create":true,"edit":true,"delete":true},
     "routing":{"view":true,"create":true,"edit":true,"delete":true},
     "ivr":{"view":true,"create":true,"edit":true,"delete":true},
     "cdr":{"view":true,"create":true,"edit":true,"delete":true},
     "analytics":{"view":true,"create":true,"edit":true,"delete":true}}'::jsonb,
   false),
  ('operator', 'Operator',
   '{"extensions":{"view":true,"create":true,"edit":true,"delete":true},
     "trunks":{"view":true,"create":true,"edit":true,"delete":true},
     "routing":{"view":true,"create":true,"edit":true,"delete":true},
     "ivr":{"view":true,"create":true,"edit":true,"delete":true},
     "cdr":{"view":true,"create":false,"edit":false,"delete":false}}'::jsonb,
   false),
  ('viewer', 'Viewer',
   '{"extensions":{"view":true,"create":false,"edit":false,"delete":false},
     "trunks":{"view":true,"create":false,"edit":false,"delete":false},
     "routing":{"view":true,"create":false,"edit":false,"delete":false},
     "ivr":{"view":true,"create":false,"edit":false,"delete":false},
     "cdr":{"view":true,"create":false,"edit":false,"delete":false}}'::jsonb,
   false)
ON CONFLICT (name) DO NOTHING;
