package store

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// TOTP parameters. These are the values Google Authenticator (and effectively
// every other authenticator app) assumes by default, so we don't encode them
// in the otpauth URI beyond the standard.
const (
	totpDigits = 6
	totpPeriod = 30 * time.Second
	totpIssuer = "XeloVoice"
)

// b32 is base32 without padding, which is what authenticator apps expect in the
// otpauth secret parameter.
var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// GenerateTOTPSecret returns a fresh random base32 secret (160 bits).
func GenerateTOTPSecret() (string, error) {
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return b32.EncodeToString(buf), nil
}

// TOTPURI builds the otpauth:// URI an authenticator app scans as a QR code.
func TOTPURI(secret, account string) string {
	label := url.PathEscape(totpIssuer + ":" + account)
	v := url.Values{}
	v.Set("secret", secret)
	v.Set("issuer", totpIssuer)
	v.Set("algorithm", "SHA1")
	v.Set("digits", fmt.Sprintf("%d", totpDigits))
	v.Set("period", fmt.Sprintf("%d", int(totpPeriod.Seconds())))
	return "otpauth://totp/" + label + "?" + v.Encode()
}

// totpAt computes the TOTP code for a secret at a given counter step.
func totpAt(secret string, counter uint64) (string, error) {
	key, err := b32.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", err
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	bin := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	mod := uint32(1)
	for i := 0; i < totpDigits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", totpDigits, bin%mod), nil
}

// VerifyTOTPCode reports whether code is valid for secret right now, allowing a
// ±1 step of clock drift. Comparison is constant-time.
func VerifyTOTPCode(secret, code string) bool {
	code = strings.TrimSpace(code)
	if len(code) != totpDigits || secret == "" {
		return false
	}
	step := uint64(time.Now().Unix()) / uint64(totpPeriod.Seconds())
	for _, c := range []uint64{step - 1, step, step + 1} {
		want, err := totpAt(secret, c)
		if err != nil {
			return false
		}
		if hmac.Equal([]byte(want), []byte(code)) {
			return true
		}
	}
	return false
}
