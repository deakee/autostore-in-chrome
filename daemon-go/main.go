// autostore-in-chrome daemon — self-contained Go port of the Node daemon.
//
// Why Go: the Node daemon needed a `node` runtime on the user's Mac, which a
// typical (esp. Intel) consumer doesn't have → the daemon never started →
// "fetch failed -1004" / extension can't connect. This is a single static
// binary (stdlib only, no module deps), bundled + signed in the app like
// llama-server. No runtime dependency on any machine.
//
// Wire-compatible with the existing Chrome extension and Mac client:
//   HTTP  GET /health, GET /pair, POST /auth, POST /rpc (Bearer token)
//   WS    /ws  — extension service worker; hello/hello-ack, rpc relay, ping
//
// Loopback only (127.0.0.1). Auto-resolves a free port if 43117 is busy and
// writes the chosen port to ~/.autostore-in-chrome/port.
package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const daemonVersion = "0.1.0"
const defaultPort = 43117
const portScanRange = 13

var rpcMethods = []string{
	"daemon_status", "list_open_tabs", "snapshot", "click", "open_url",
	"type", "eval", "find_by_text", "click_by_text", "fill_submit", "computer",
}

// ── config files (~/.autostore-in-chrome) ──────────────────────────────────

func configDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".autostore-in-chrome")
}

func loadOrCreateToken() string {
	dir := configDir()
	_ = os.MkdirAll(dir, 0o700)
	tf := filepath.Join(dir, "token")
	if b, err := os.ReadFile(tf); err == nil {
		if t := strings.TrimSpace(string(b)); t != "" {
			return t
		}
	}
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	t := hex.EncodeToString(raw)
	_ = os.WriteFile(tf, []byte(t), 0o600)
	return t
}

func writePort(port int) {
	dir := configDir()
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(filepath.Join(dir, "port"), []byte(strconv.Itoa(port)), 0o600)
}

func readPairedUser() interface{} {
	uf := filepath.Join(configDir(), "user.json")
	b, err := os.ReadFile(uf)
	if err != nil {
		return nil
	}
	var v map[string]interface{}
	if json.Unmarshal(b, &v) != nil {
		return nil
	}
	if _, ok := v["id"]; !ok {
		return nil
	}
	return v
}

// ── extension bus (WS to the Chrome extension) ──────────────────────────────

type pending struct {
	ch     chan rpcResult
	method string
}

type rpcResult struct {
	ok     bool
	result json.RawMessage
	errMsg string
}

type bus struct {
	mu              sync.Mutex
	active          *wsConn
	pend            map[string]pending
	lastConnectedAt time.Time
}

func newBus() *bus { return &bus{pend: map[string]pending{}} }

func (b *bus) setActive(c *wsConn) {
	b.mu.Lock()
	old := b.active
	b.active = c
	b.lastConnectedAt = time.Now()
	b.mu.Unlock()
	if old != nil && old != c {
		old.close(1000, "superseded")
	}
}

func (b *bus) clearIfActive(c *wsConn) {
	b.mu.Lock()
	if b.active == c {
		b.active = nil
		for id, p := range b.pend {
			p.ch <- rpcResult{ok: false, errMsg: "extension disconnected"}
			delete(b.pend, id)
		}
	}
	b.mu.Unlock()
}

func (b *bus) connected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.active != nil
}

func (b *bus) status() map[string]interface{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	var since interface{}
	if b.active != nil {
		since = time.Since(b.lastConnectedAt).Milliseconds()
	} else {
		since = nil
	}
	return map[string]interface{}{
		"connected":        b.active != nil,
		"connectedSinceMs": since,
		"pendingCalls":     len(b.pend),
	}
}

func (b *bus) resolve(id string, r rpcResult) {
	b.mu.Lock()
	p, ok := b.pend[id]
	if ok {
		delete(b.pend, id)
	}
	b.mu.Unlock()
	if ok {
		p.ch <- r
	}
}

// call sends an rpc-request to the extension and waits for the response.
func (b *bus) call(method string, params json.RawMessage, timeout time.Duration) (json.RawMessage, error) {
	b.mu.Lock()
	c := b.active
	if c == nil {
		b.mu.Unlock()
		return nil, fmt.Errorf("AutoStore Chrome extension is not connected. Install the extension and paste the bridge token into its popup.")
	}
	idb := make([]byte, 16)
	_, _ = rand.Read(idb)
	id := hex.EncodeToString(idb)
	ch := make(chan rpcResult, 1)
	b.pend[id] = pending{ch: ch, method: method}
	b.mu.Unlock()

	if params == nil {
		params = json.RawMessage("{}")
	}
	reqMsg, _ := json.Marshal(map[string]interface{}{
		"type": "rpc-request", "id": id, "method": method, "params": json.RawMessage(params),
	})
	if err := c.writeText(reqMsg); err != nil {
		b.mu.Lock()
		delete(b.pend, id)
		b.mu.Unlock()
		return nil, fmt.Errorf("extension disconnected")
	}

	select {
	case r := <-ch:
		if !r.ok {
			if r.errMsg == "" {
				r.errMsg = method + " failed"
			}
			return nil, fmt.Errorf("%s", r.errMsg)
		}
		return r.result, nil
	case <-time.After(timeout):
		b.mu.Lock()
		delete(b.pend, id)
		b.mu.Unlock()
		return nil, fmt.Errorf("%s timed out after %dms", method, timeout.Milliseconds())
	}
}

// ── dispatch ────────────────────────────────────────────────────────────────

func isKnownMethod(m string) bool {
	for _, k := range rpcMethods {
		if k == m && m != "daemon_status" {
			return true
		}
	}
	return false
}

func dispatch(b *bus, method string, params json.RawMessage) (interface{}, error) {
	if method == "daemon_status" {
		return b.status(), nil
	}
	if !isKnownMethod(method) {
		return nil, fmt.Errorf("unknown method: %s", method)
	}
	// Forward verbatim; the extension validates params. (The Node daemon ran
	// a zod check here; the Mac app always sends valid params, and skipping it
	// avoids reimplementing every schema — the extension rejects bad params.)
	res, err := b.call(method, params, 60*time.Second)
	if err != nil {
		return nil, err
	}
	if res == nil {
		return nil, nil
	}
	var anyv interface{}
	if json.Unmarshal(res, &anyv) == nil {
		return anyv, nil
	}
	return json.RawMessage(res), nil
}

// ── HTTP ────────────────────────────────────────────────────────────────────

func sendJSON(w http.ResponseWriter, status int, body interface{}) {
	j, _ := json.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(j)))
	w.WriteHeader(status)
	_, _ = w.Write(j)
}

func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Max-Age", "86400")
}

type server struct {
	token, backendURL string
	b                 *bus
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// WS upgrade on /ws.
	if r.URL.Path == "/ws" && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		s.handleWS(w, r)
		return
	}

	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}

	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/health":
		sendJSON(w, 200, map[string]interface{}{
			"ok": true, "daemonVersion": daemonVersion,
			"extension": s.b.status(), "methods": rpcMethods,
		})
		return

	case r.Method == http.MethodGet && r.URL.Path == "/pair":
		sendJSON(w, 200, map[string]interface{}{
			"ok": true, "bridgeToken": s.token,
			"user": readPairedUser(), "daemonVersion": daemonVersion,
		})
		return

	case r.Method == http.MethodPost && r.URL.Path == "/auth":
		var body struct {
			JWT string `json:"jwt"`
		}
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1_000_000))
		if json.Unmarshal(raw, &body) != nil {
			sendJSON(w, 400, map[string]interface{}{"ok": false, "error": "invalid json"})
			return
		}
		if body.JWT == "" {
			sendJSON(w, 400, map[string]interface{}{"ok": false, "error": "missing jwt"})
			return
		}
		backend := s.backendURL
		if backend == "" {
			backend = "https://api.spriterock.com"
		}
		req, _ := http.NewRequest("GET", backend+"/api/auth/me", nil)
		req.Header.Set("Authorization", "Bearer "+body.JWT)
		cl := &http.Client{Timeout: 10 * time.Second}
		resp, err := cl.Do(req)
		if err != nil {
			sendJSON(w, 502, map[string]interface{}{"ok": false, "error": "Could not reach AutoStore backend: " + err.Error()})
			return
		}
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			sendJSON(w, 401, map[string]interface{}{"ok": false, "error": "Invalid or expired token. Please sign in again."})
			return
		}
		sendJSON(w, 200, map[string]interface{}{"ok": true, "token": s.token})
		return
	}

	// Everything else requires the bearer token.
	presented := ""
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
		presented = strings.TrimSpace(a[len("Bearer "):])
	}
	if presented != s.token {
		sendJSON(w, 401, map[string]interface{}{"ok": false, "error": "unauthorized"})
		return
	}

	if r.Method == http.MethodPost && r.URL.Path == "/rpc" {
		var body struct {
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1_000_000))
		if json.Unmarshal(raw, &body) != nil {
			sendJSON(w, 400, map[string]interface{}{"ok": false, "error": "invalid json"})
			return
		}
		if body.Method == "" {
			sendJSON(w, 400, map[string]interface{}{"ok": false, "error": "missing method"})
			return
		}
		result, err := dispatch(s.b, body.Method, body.Params)
		if err != nil {
			sendJSON(w, 200, map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		sendJSON(w, 200, map[string]interface{}{"ok": true, "result": result})
		return
	}

	sendJSON(w, 404, map[string]interface{}{"ok": false, "error": "not found"})
}

// ── WebSocket (minimal RFC6455, stdlib only) ────────────────────────────────

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	conn   net.Conn
	rw     *bufio.ReadWriter
	wmu    sync.Mutex
	closed bool
}

func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "bad ws", 400)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "no hijack", 500)
		return
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return
	}
	h := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(h[:])
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := brw.WriteString(resp); err != nil {
		_ = conn.Close()
		return
	}
	_ = brw.Flush()

	c := &wsConn{conn: conn, rw: brw}
	go s.wsLoop(c)
}

func (s *server) wsLoop(c *wsConn) {
	defer func() {
		s.b.clearIfActive(c)
		c.close(1000, "")
	}()
	authed := false
	stopKeepalive := make(chan struct{})
	defer close(stopKeepalive)

	for {
		op, payload, err := c.readMessage()
		if err != nil {
			return
		}
		if op == 0x8 { // close
			return
		}
		if op == 0x9 { // ping → pong
			c.writeFrame(0xA, payload)
			continue
		}
		if op == 0xA { // pong
			continue
		}
		if op != 0x1 { // only text JSON beyond control frames
			continue
		}
		var msg struct {
			Type          string          `json:"type"`
			Token         string          `json:"token"`
			ChromeVersion string          `json:"chromeVersion"`
			ID            string          `json:"id"`
			OK            bool            `json:"ok"`
			Result        json.RawMessage `json:"result"`
			Error         string          `json:"error"`
		}
		if json.Unmarshal(payload, &msg) != nil {
			c.close(1002, "bad json")
			return
		}

		if !authed {
			if msg.Type != "hello" {
				c.close(1008, "expected hello")
				return
			}
			if msg.Token != s.token {
				c.close(1008, "bad token")
				return
			}
			authed = true
			s.b.setActive(c)
			ack, _ := json.Marshal(map[string]string{"type": "hello-ack", "daemonVersion": daemonVersion})
			c.writeText(ack)
			fmt.Fprintf(os.Stderr, "[daemon] extension connected (chrome=%s)\n", msg.ChromeVersion)
			go c.keepalive(stopKeepalive)
			continue
		}

		switch msg.Type {
		case "ping":
			pong, _ := json.Marshal(map[string]string{"type": "pong"})
			c.writeText(pong)
		case "rpc-response":
			s.b.resolve(msg.ID, rpcResult{ok: msg.OK, result: msg.Result, errMsg: msg.Error})
		}
	}
}

func (c *wsConn) keepalive(stop chan struct{}) {
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	ping, _ := json.Marshal(map[string]string{"type": "ping"})
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			if c.writeText(ping) != nil {
				return
			}
		}
	}
}

// readMessage reassembles a full application message, handling fragmentation
// and returning control frames (ping/pong/close) directly to the caller.
func (c *wsConn) readMessage() (byte, []byte, error) {
	var msgOpcode byte
	var buf []byte
	for {
		fin, opcode, payload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		if opcode == 0x8 || opcode == 0x9 || opcode == 0xA {
			return opcode, payload, nil // control frame — deliver immediately
		}
		if opcode != 0x0 { // new data frame
			msgOpcode = opcode
			buf = payload
		} else { // continuation
			buf = append(buf, payload...)
		}
		if fin {
			return msgOpcode, buf, nil
		}
	}
}

func (c *wsConn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	b0, err := c.rw.ReadByte()
	if err != nil {
		return
	}
	b1, err := c.rw.ReadByte()
	if err != nil {
		return
	}
	fin = b0&0x80 != 0
	opcode = b0 & 0x0f
	masked := b1&0x80 != 0
	length := int(b1 & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.rw, ext[:]); err != nil {
			return
		}
		length = int(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.rw, ext[:]); err != nil {
			return
		}
		length = int(binary.BigEndian.Uint64(ext[:]))
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(c.rw, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(c.rw, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return
}

func (c *wsConn) writeText(p []byte) error { return c.writeFrame(0x1, p) }

func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed {
		return io.ErrClosedPipe
	}
	var hdr []byte
	hdr = append(hdr, 0x80|opcode)
	n := len(payload)
	switch {
	case n < 126:
		hdr = append(hdr, byte(n))
	case n < 65536:
		hdr = append(hdr, 126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 127)
		for i := 7; i >= 0; i-- {
			hdr = append(hdr, byte(n>>(8*uint(i))))
		}
	}
	if _, err := c.rw.Write(hdr); err != nil {
		return err
	}
	if _, err := c.rw.Write(payload); err != nil {
		return err
	}
	return c.rw.Flush()
}

func (c *wsConn) close(code int, reason string) {
	c.wmu.Lock()
	if c.closed {
		c.wmu.Unlock()
		return
	}
	c.closed = true
	c.wmu.Unlock()
	_ = c.conn.Close()
}

// ── port resolution + main ──────────────────────────────────────────────────

func portFree(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func isOurDaemon(port int) bool {
	cl := &http.Client{Timeout: time.Second}
	resp, err := cl.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var v struct {
		DaemonVersion string `json:"daemonVersion"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 64_000)).Decode(&v) != nil {
		return false
	}
	return v.DaemonVersion != ""
}

func resolvePort(preferred int) int {
	for p := preferred; p <= preferred+portScanRange; p++ {
		if portFree(p) {
			return p
		}
		if isOurDaemon(p) {
			fmt.Fprintf(os.Stderr, "[daemon] an AutoStore daemon is already running on %d; nothing to do\n", p)
			writePort(p)
			os.Exit(0)
		}
		fmt.Fprintf(os.Stderr, "[daemon] port %d is held by another process; trying %d\n", p, p+1)
	}
	fmt.Fprintf(os.Stderr, "[daemon] no free port in %d..%d\n", preferred, preferred+portScanRange)
	os.Exit(1)
	return 0
}

func main() {
	token := loadOrCreateToken()
	preferred := defaultPort
	if v := os.Getenv("AUTOSTORE_IN_CHROME_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			preferred = n
		}
	}
	port := resolvePort(preferred)
	backend := os.Getenv("AUTOSTORE_BACKEND_URL")
	if backend == "" {
		backend = "https://api.spriterock.com"
	}

	s := &server{token: token, backendURL: backend, b: newBus()}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fmt.Fprintf(os.Stderr, "[daemon] fatal: %v\n", err)
		os.Exit(1)
	}
	writePort(port)
	extra := ""
	if port != preferred {
		extra = fmt.Sprintf(" (preferred %d was busy)", preferred)
	}
	fmt.Fprintf(os.Stderr, "[daemon] autostore-in-chrome v%s listening on 127.0.0.1:%d%s\n[daemon] waiting for Chrome extension...\n", daemonVersion, port, extra)

	srv := &http.Server{Handler: s}
	_ = srv.Serve(ln)
}
