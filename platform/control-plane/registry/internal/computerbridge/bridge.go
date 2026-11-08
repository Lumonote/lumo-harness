package computerbridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Options struct{ HostFile, StateDir, Realm, NodeID, Gateway string }
type Command struct {
	Action string
	Body   json.RawMessage
}

func writeDiscovery(path string, value Discovery) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	nonce := make([]byte, 16)
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	temp := path + "." + base64.RawURLEncoding.EncodeToString(nonce) + ".tmp"
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer os.Remove(temp)
	if _, err = file.Write(raw); err == nil {
		err = file.Sync()
	}
	closed := file.Close()
	if err != nil {
		return err
	}
	if closed != nil {
		return closed
	}
	return os.Rename(temp, path)
}

type Discovery struct {
	Version int    `json:"version"`
	Origin  string `json:"origin"`
	Token   string `json:"token"`
	Realm   string `json:"realm"`
	NodeID  string `json:"node_id"`
}

var computerID = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var computerDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

func privateComputerFile(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("computer bridge requires an absolute private path")
	}
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 || (runtime.GOOS != "windows" && parent.Mode().Perm()&0o077 != 0) {
		return errors.New("computer bridge directory is not private")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil || resolved != filepath.Clean(filepath.Dir(path)) {
		return errors.New("computer bridge parent is not direct")
	}
	return nil
}
func ReadDiscovery(path, realm, node string) (Discovery, error) {
	var out Discovery
	if err := privateComputerFile(path); err != nil {
		return out, err
	}
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() > 4096 || (runtime.GOOS != "windows" && before.Mode().Perm()&0o077 != 0) {
		return out, errors.New("computer bridge file is not private")
	}
	file, err := os.Open(path)
	if err != nil {
		return out, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return out, errors.New("computer bridge file changed")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&out) != nil || decoder.Decode(&struct{}{}) != io.EOF || out.Version != 1 || out.Realm != realm || out.NodeID != node || !computerID.MatchString(out.Token) {
		return out, errors.New("invalid computer bridge discovery")
	}
	u, err := url.Parse(out.Origin)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return out, errors.New("computer bridge requires an exact loopback origin")
	}
	return out, nil
}
func Deliver(ctx context.Context, o Options, cmd Command) error {
	if o.HostFile == "" {
		return errors.New("remote computer bridge is disabled")
	}
	var envelope struct {
		Version   int    `json:"version"`
		RequestID string `json:"request_id"`
		Digest    string `json:"digest"`
		PlanJSON  string `json:"plan_json,omitempty"`
	}
	decoder := json.NewDecoder(bytes.NewReader(cmd.Body))
	decoder.DisallowUnknownFields()
	if len(cmd.Body) > 65536 || decoder.Decode(&envelope) != nil || decoder.Decode(&struct{}{}) != io.EOF || envelope.Version != 1 || !computerID.MatchString(envelope.RequestID) || !computerDigest.MatchString(envelope.Digest) {
		return errors.New("invalid remote computer command")
	}
	action := "/ingest"
	if cmd.Action == "computer_use_revoke" {
		action = "/revoke"
		if envelope.PlanJSON != "" {
			return errors.New("invalid revoke envelope")
		}
	} else if cmd.Action != "computer_use_request" || envelope.PlanJSON == "" {
		return errors.New("invalid computer action")
	}
	target, err := ReadDiscovery(o.HostFile, o.Realm, o.NodeID)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.Origin+action, bytes.NewReader(cmd.Body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+target.Token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	res, err := client.Do(req)
	if err != nil {
		return errors.New("computer bridge delivery uncertain")
	}
	defer res.Body.Close()
	var response struct {
		Accepted bool `json:"accepted"`
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 1024)).Decode(&response) != nil || !response.Accepted {
		return errors.New("computer bridge refused request")
	}
	return nil
}
func Handler(ctx context.Context, o Options, token string, upstream *http.Client) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "Bearer " + token
		if r.Method != "POST" || r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expected)) != 1 || ctx.Err() != nil {
			http.Error(w, "denied", 403)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/lease/")
		if !strings.HasPrefix(r.URL.Path, "/lease/") || !computerID.MatchString(id) || r.URL.RawQuery != "" || !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			http.Error(w, "invalid lease endpoint", 400)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 8193))
		if err != nil || len(raw) > 8192 {
			http.Error(w, "invalid lease", 400)
			return
		}
		var input struct {
			Digest   string `json:"digest"`
			Revision int64  `json:"expected_revision"`
			Phase    string `json:"phase"`
			State    string `json:"state,omitempty"`
			Summary  string `json:"summary,omitempty"`
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || !computerDigest.MatchString(input.Digest) || input.Revision < 1 {
			http.Error(w, "invalid lease", 400)
			return
		}
		active, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		stop := context.AfterFunc(r.Context(), cancel)
		defer stop()
		req, err := http.NewRequestWithContext(active, "POST", o.Gateway+"/device/computer-use/"+id+"/lease", bytes.NewReader(raw))
		if err != nil {
			http.Error(w, "lease unavailable", 503)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := upstream.Do(req)
		if err != nil {
			http.Error(w, "lease uncertain", 503)
			return
		}
		defer res.Body.Close()
		body, err := io.ReadAll(io.LimitReader(res.Body, 8193))
		if err != nil || len(body) > 8192 || !json.Valid(body) {
			http.Error(w, "invalid authority response", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(res.StatusCode)
		_, _ = w.Write(body)
	})
}
func Start(ctx context.Context, o Options, upstream *http.Client) (func(), error) {
	if o.HostFile == "" {
		return func() {}, nil
	}
	path := filepath.Join(o.StateDir, "computer-bridge.json")
	if err := privateComputerFile(path); err != nil {
		return nil, err
	}
	unlock, err := lockGeneration(path + ".generation")
	if err != nil {
		return nil, errors.New("computer bridge already has an active generation or cannot obtain its private lock")
	}
	started := false
	defer func() {
		if !started {
			unlock()
		}
	}()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	server := &http.Server{Handler: Handler(ctx, o, token, upstream), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 6 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 4096}
	if err = writeDiscovery(path, Discovery{1, "http://" + listener.Addr().String(), token, o.Realm, o.NodeID}); err != nil {
		listener.Close()
		return nil, err
	}
	go func() { _ = server.Serve(listener) }()
	var once sync.Once
	close := func() {
		once.Do(func() {
			if err := server.Close(); err != nil {
				return
			} // Retain the fence after uncertain teardown.
			if current, err := ReadDiscovery(path, o.Realm, o.NodeID); err == nil && current.Token == token {
				_ = os.Remove(path)
			}
			unlock()
		})
	}
	started = true
	return close, nil
}
