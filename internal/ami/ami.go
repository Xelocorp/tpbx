// Package ami implements a small Asterisk Manager Interface (AMI) client.
//
// AMI is a line-oriented text protocol: messages are a series of
// "Key: Value\r\n" lines terminated by a blank line. We implement it directly
// over a TCP connection rather than pulling in a third-party dependency,
// because the protocol is tiny and this keeps the surface we control small.
//
// The client is used for management-style operations and event streaming that
// ARI does not cover as cleanly: PJSIP contact/registration state, queue
// events, and "core reload" style commands.
package ami

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/textproto"
	"strings"
	"sync"
	"time"
)

// Message is a single AMI packet decoded into its key/value pairs. Keys are
// canonicalised to their textproto form (e.g. "Event", "Response").
type Message map[string]string

// Get returns the value for key (case-insensitive), or "".
func (m Message) Get(key string) string {
	return m[textproto.CanonicalMIMEHeaderKey(key)]
}

// Client is a connected AMI session.
type Client struct {
	conn    net.Conn
	reader  *textproto.Reader
	writeMu sync.Mutex

	events chan Message
	closed chan struct{}
	once   sync.Once
}

// Dial connects to AMI and logs in. The returned client streams unsolicited
// events on Events() until Close is called or the connection drops.
func Dial(ctx context.Context, addr, username, password string, timeout time.Duration) (*Client, error) {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial ami %s: %w", addr, err)
	}

	c := &Client{
		conn:   conn,
		reader: textproto.NewReader(bufio.NewReader(conn)),
		events: make(chan Message, 256),
		closed: make(chan struct{}),
	}

	// AMI greets us with a banner line such as
	// "Asterisk Call Manager/8.0.0". Consume it before logging in.
	if _, err := c.reader.ReadLine(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("read ami banner: %w", err)
	}

	if err := c.login(username, password); err != nil {
		conn.Close()
		return nil, err
	}

	go c.readLoop()
	return c, nil
}

func (c *Client) login(username, password string) error {
	resp, err := c.action(Message{
		"Action":   "Login",
		"Username": username,
		"Secret":   password,
	})
	if err != nil {
		return fmt.Errorf("ami login: %w", err)
	}
	if !strings.EqualFold(resp.Get("Response"), "Success") {
		return fmt.Errorf("ami login rejected: %s", resp.Get("Message"))
	}
	return nil
}

// action writes a message and reads exactly one reply packet. It is only safe
// to call before readLoop starts (i.e. during login); once streaming, use
// Send and correlate on ActionID via the event stream.
func (c *Client) action(m Message) (Message, error) {
	if err := c.write(m); err != nil {
		return nil, err
	}
	return c.readMessage()
}

// Send writes an action to AMI. Responses arrive asynchronously on Events().
func (c *Client) Send(m Message) error {
	return c.write(m)
}

func (c *Client) write(m Message) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	var b strings.Builder
	for k, v := range m {
		b.WriteString(k)
		b.WriteString(": ")
		b.WriteString(v)
		b.WriteString("\r\n")
	}
	b.WriteString("\r\n")
	_, err := c.conn.Write([]byte(b.String()))
	return err
}

func (c *Client) readMessage() (Message, error) {
	header, err := c.reader.ReadMIMEHeader()
	if err != nil {
		return nil, err
	}
	m := make(Message, len(header))
	for k, v := range header {
		if len(v) > 0 {
			m[k] = v[0]
		}
	}
	return m, nil
}

func (c *Client) readLoop() {
	defer c.close()
	for {
		m, err := c.readMessage()
		if err != nil {
			return
		}
		select {
		case c.events <- m:
		case <-c.closed:
			return
		default:
			// Drop events if nobody is draining fast enough rather than
			// blocking the read loop and stalling the connection.
		}
	}
}

// Exec opens a short-lived AMI session, runs a single CLI command via the
// Command action, and returns its textual output. It is used for one-off
// management operations the GUI cannot express through ARI -- notably
// restarting Asterisk to re-bind PJSIP transports.
//
// It is best-effort about the reply: a restart command tears down AMI as it
// executes, so a closed connection after the command was accepted is treated
// as success rather than an error.
func Exec(ctx context.Context, addr, username, password string, timeout time.Duration, command string) (string, error) {
	c, err := Dial(ctx, addr, username, password, timeout)
	if err != nil {
		return "", err
	}
	defer c.Close()

	if err := c.Send(Message{"Action": "Command", "Command": command}); err != nil {
		return "", err
	}
	select {
	case msg, ok := <-c.Events():
		if !ok {
			return "", nil // connection dropped (expected for a restart)
		}
		return msg.Get("Output") + msg.Get("Message"), nil
	case <-time.After(2 * time.Second):
		return "", nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Events returns the channel of unsolicited AMI messages.
func (c *Client) Events() <-chan Message { return c.events }

// Close terminates the session.
func (c *Client) Close() error {
	c.close()
	return nil
}

func (c *Client) close() {
	c.once.Do(func() {
		close(c.closed)
		_ = c.conn.Close()
	})
}
