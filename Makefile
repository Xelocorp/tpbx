# TPBX -- Asterisk control console
#
# Common developer tasks. Configuration is via environment variables (see
# internal/config/config.go); the defaults below assume Asterisk + PostgreSQL
# on localhost.

DB_URL ?= postgres://tpbx:tpbx@127.0.0.1:5432/tpbx?sslmode=disable
PGADMIN ?= postgres           # superuser role used only to create the db/role
BIN     ?= bin/tpbx

export TPBX_DATABASE_URL=$(DB_URL)
export TPBX_WEB_DIR=web/dist

.PHONY: help
help:
	@echo "Targets:"
	@echo "  make db-create   Create the tpbx role + database (needs superuser)"
	@echo "  make db-migrate  Apply SQL migrations AS the app role (ownership matters)"
	@echo "  make web         Build the React frontend into web/dist"
	@echo "  make build       Build the Go backend into $(BIN)"
	@echo "  make run         Build everything and run the backend"
	@echo "  make dev         Run backend + Vite dev server (two terminals)"
	@echo "  make test        go vet + go test"

# --- Database ---------------------------------------------------------------
.PHONY: db-create
db-create:
	sudo -u $(PGADMIN) psql -tc "SELECT 1 FROM pg_roles WHERE rolname='tpbx'" | grep -q 1 || \
		sudo -u $(PGADMIN) psql -c "CREATE ROLE tpbx LOGIN PASSWORD 'tpbx';"
	sudo -u $(PGADMIN) psql -tc "SELECT 1 FROM pg_database WHERE datname='tpbx'" | grep -q 1 || \
		sudo -u $(PGADMIN) psql -c "CREATE DATABASE tpbx OWNER tpbx;"

# Migrations run AS the app role so it OWNS the tables. Running them as a
# superuser leaves the app role without privileges (a real gotcha).
.PHONY: db-migrate
db-migrate:
	@for f in migrations/*.sql; do \
		echo "applying $$f"; \
		psql "$(DB_URL)" -v ON_ERROR_STOP=1 -f "$$f" >/dev/null; \
	done
	@echo "migrations applied"

# --- Build ------------------------------------------------------------------
.PHONY: web
web:
	cd web && npm install && npm run build

.PHONY: build
build:
	CGO_ENABLED=0 go build -o $(BIN) ./cmd/tpbx

.PHONY: run
run: web build
	./$(BIN)

.PHONY: dev
dev:
	@echo "Run in two terminals:"
	@echo "  1) go run ./cmd/tpbx"
	@echo "  2) cd web && npm run dev   # http://localhost:5173"

# --- QA ---------------------------------------------------------------------
.PHONY: test
test:
	go vet ./...
	go test ./...
