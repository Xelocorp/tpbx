package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// ErrAuth is returned for any failed authentication (bad user or password),
// deliberately vague so callers can't distinguish the two.
var ErrAuth = errors.New("invalid username or password")

// SessionTTL is how long a login stays valid.
const SessionTTL = 12 * time.Hour

// Users is the store for GUI login accounts and their sessions.
type Users struct {
	pool *pgxpool.Pool
}

// NewUsers returns a Users store bound to a connection pool.
func NewUsers(pool *pgxpool.Pool) *Users {
	return &Users{pool: pool}
}

// User is a GUI account (never carries the password hash outward).
type User struct {
	Username    string     `json:"username"`
	Role        string     `json:"role"` // admin | operator | viewer
	DisplayName string     `json:"displayName"`
	Disabled    bool       `json:"disabled"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastLoginAt *time.Time `json:"lastLoginAt,omitempty"`
}

// Session is an authenticated session resolved from a cookie token.
type Session struct {
	Username string
	Role     string
}

// EnsureAdmin creates the initial admin account if it does not already exist.
// It never overwrites an existing account, so re-running install.sh will not
// reset a changed password. Returns true if it created the account.
func (s *Users) EnsureAdmin(ctx context.Context, username, password string) (bool, error) {
	if username == "" || password == "" {
		return false, errors.New("admin username and password are required")
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tpbx_users WHERE username=$1)`, username).Scan(&exists); err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return false, err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO tpbx_users (username, password_hash, role, display_name)
		VALUES ($1, $2, 'admin', 'Administrator')`, username, string(hash))
	return err == nil, err
}

// Authenticate verifies credentials and returns the user on success.
func (s *Users) Authenticate(ctx context.Context, username, password string) (User, error) {
	var u User
	var hash string
	err := s.pool.QueryRow(ctx, `
		SELECT username, password_hash, role, COALESCE(display_name,''), disabled
		  FROM tpbx_users WHERE username=$1`, username).
		Scan(&u.Username, &hash, &u.Role, &u.DisplayName, &u.Disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		// Still run a bcrypt comparison against a dummy hash to reduce timing
		// signal about whether the username exists.
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$10$"+strings.Repeat("x", 53)), []byte(password))
		return u, ErrAuth
	}
	if err != nil {
		return u, err
	}
	if u.Disabled {
		return u, ErrAuth
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return u, ErrAuth
	}
	_, _ = s.pool.Exec(ctx, `UPDATE tpbx_users SET last_login_at=now() WHERE username=$1`, username)
	return u, nil
}

// ChangePassword sets a new password for username.
func (s *Users) ChangePassword(ctx context.Context, username, newPassword string) error {
	if len(newPassword) < 6 {
		return errors.New("password must be at least 6 characters")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `UPDATE tpbx_users SET password_hash=$2 WHERE username=$1`, username, string(hash))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// List returns all users (no hashes).
func (s *Users) List(ctx context.Context) ([]User, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT username, role, COALESCE(display_name,''), disabled, created_at, last_login_at
		  FROM tpbx_users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.Username, &u.Role, &u.DisplayName, &u.Disabled, &u.CreatedAt, &u.LastLoginAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// Create adds a new user.
func (s *Users) Create(ctx context.Context, u User, password string) error {
	if err := validateUsername(u.Username); err != nil {
		return err
	}
	if len(password) < 6 {
		return errors.New("password must be at least 6 characters")
	}
	if u.Role == "" {
		u.Role = "operator"
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO tpbx_users (username, password_hash, role, display_name)
		VALUES ($1,$2,$3,$4)`, u.Username, string(hash), u.Role, u.DisplayName)
	if err != nil && strings.Contains(err.Error(), "duplicate key") {
		return ErrConflict
	}
	return err
}

// Delete removes a user and their sessions.
func (s *Users) Delete(ctx context.Context, username string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM tpbx_users WHERE username=$1`, username)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	_, _ = s.pool.Exec(ctx, `DELETE FROM tpbx_sessions WHERE username=$1`, username)
	return nil
}

// --- Sessions ---------------------------------------------------------------

// CreateSession issues a new opaque session token for u.
func (s *Users) CreateSession(ctx context.Context, u User) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tpbx_sessions (token, username, role, expires_at)
		VALUES ($1,$2,$3, now() + $4::interval)`,
		token, u.Username, u.Role, fmt.Sprintf("%d seconds", int(SessionTTL.Seconds())))
	if err != nil {
		return "", err
	}
	return token, nil
}

// LookupSession resolves a token to a live session, or returns ok=false.
func (s *Users) LookupSession(ctx context.Context, token string) (Session, bool) {
	if token == "" {
		return Session{}, false
	}
	var sess Session
	err := s.pool.QueryRow(ctx, `
		SELECT username, role FROM tpbx_sessions
		 WHERE token=$1 AND expires_at > now()`, token).Scan(&sess.Username, &sess.Role)
	if err != nil {
		return Session{}, false
	}
	return sess, true
}

// DeleteSession revokes a session (logout).
func (s *Users) DeleteSession(ctx context.Context, token string) {
	_, _ = s.pool.Exec(ctx, `DELETE FROM tpbx_sessions WHERE token=$1`, token)
}

// Audit appends an entry to the configuration audit log (best-effort).
func (s *Users) Audit(ctx context.Context, username, action, objectID, remoteIP string) {
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO tpbx_audit_log (username, action, object_id, remote_ip)
		VALUES ($1,$2,$3,$4)`, username, action, objectID, remoteIP)
}

func validateUsername(u string) error {
	if len(u) < 2 {
		return errors.New("username too short")
	}
	for _, r := range u {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.') {
			return fmt.Errorf("username %q has invalid characters", u)
		}
	}
	return nil
}
