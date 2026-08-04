// Package tpbx is the module root. It exists to embed assets that must travel
// inside the compiled binary — currently the SQL migrations, so that
// `tpbx migrate` always runs exactly the migration set that matches the binary.
package tpbx

import "embed"

// MigrationsFS holds the ordered SQL migration files. Because they are embedded
// in the binary, an upgraded binary carries its own new migrations and cannot
// be run against a mismatched set of files on disk.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS
