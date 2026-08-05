package store

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Settings holds runtime-editable configuration that must not be baked into
// install.sh because it varies per deployment (LAN, public VPS, Oracle 1:1
// NAT, external TURN provider). Today that is the WebRTC/TURN parameters.
type Settings struct {
	pool *pgxpool.Pool
}

// NewSettings returns a Settings store bound to a connection pool.
func NewSettings(pool *pgxpool.Pool) *Settings {
	return &Settings{pool: pool}
}

// WebRTCSettings is the dashboard-editable WebRTC/TURN configuration.
type WebRTCSettings struct {
	PublicHost         string `json:"publicHost"`         // "" = derive from request host
	WSSPort            string `json:"wssPort"`            // Asterisk secure-WebSocket port
	STUNEnabled        bool   `json:"stunEnabled"`        //
	TURNEnabled        bool   `json:"turnEnabled"`        //
	TURNMode           string `json:"turnMode"`           // builtin | static | none
	TURNHost           string `json:"turnHost"`           // "" = same as PublicHost
	TURNURLs           string `json:"turnUrls"`           // explicit comma-separated URLs (static)
	TURNStaticUser     string `json:"turnStaticUser"`     // static-mode username
	TURNStaticPassword string `json:"turnStaticPassword"` // static-mode password
	TURNTLS            bool   `json:"turnTls"`            // also offer turns:5349
	ICETransportPolicy string `json:"iceTransportPolicy"` // all | relay
}

const webrtcCols = `public_host, wss_port, stun_enabled, turn_enabled, turn_mode,
	turn_host, turn_urls, turn_static_user, turn_static_password, turn_tls,
	ice_transport_policy`

// GetWebRTC returns the WebRTC settings, seeding the singleton row if missing.
func (s *Settings) GetWebRTC(ctx context.Context) (WebRTCSettings, error) {
	var c WebRTCSettings
	err := s.pool.QueryRow(ctx, `SELECT `+webrtcCols+`
		  FROM tpbx_webrtc_settings WHERE id=1`).
		Scan(&c.PublicHost, &c.WSSPort, &c.STUNEnabled, &c.TURNEnabled, &c.TURNMode,
			&c.TURNHost, &c.TURNURLs, &c.TURNStaticUser, &c.TURNStaticPassword,
			&c.TURNTLS, &c.ICETransportPolicy)
	if err != nil {
		// The row is seeded by migration 0009; if it is somehow absent, fall
		// back to sane defaults rather than failing the softphone.
		return WebRTCSettings{
			WSSPort: "8089", STUNEnabled: true, TURNEnabled: true,
			TURNMode: "builtin", TURNTLS: true, ICETransportPolicy: "all",
		}, nil
	}
	return c, nil
}

// UpdateWebRTC persists the WebRTC settings (upserting the singleton row).
func (s *Settings) UpdateWebRTC(ctx context.Context, c WebRTCSettings) error {
	if c.WSSPort == "" {
		c.WSSPort = "8089"
	}
	if c.TURNMode == "" {
		c.TURNMode = "builtin"
	}
	if c.ICETransportPolicy != "relay" {
		c.ICETransportPolicy = "all"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tpbx_webrtc_settings
		    (id, public_host, wss_port, stun_enabled, turn_enabled, turn_mode,
		     turn_host, turn_urls, turn_static_user, turn_static_password,
		     turn_tls, ice_transport_policy, updated_at)
		VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
		ON CONFLICT (id) DO UPDATE SET
		    public_host=EXCLUDED.public_host,
		    wss_port=EXCLUDED.wss_port,
		    stun_enabled=EXCLUDED.stun_enabled,
		    turn_enabled=EXCLUDED.turn_enabled,
		    turn_mode=EXCLUDED.turn_mode,
		    turn_host=EXCLUDED.turn_host,
		    turn_urls=EXCLUDED.turn_urls,
		    turn_static_user=EXCLUDED.turn_static_user,
		    turn_static_password=EXCLUDED.turn_static_password,
		    turn_tls=EXCLUDED.turn_tls,
		    ice_transport_policy=EXCLUDED.ice_transport_policy,
		    updated_at=now()`,
		c.PublicHost, c.WSSPort, c.STUNEnabled, c.TURNEnabled, c.TURNMode,
		c.TURNHost, c.TURNURLs, c.TURNStaticUser, c.TURNStaticPassword,
		c.TURNTLS, c.ICETransportPolicy)
	return err
}
