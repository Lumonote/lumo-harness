// Package device exposes the outbound-only desktop management channel. Its
// public listener accepts device certificates, never control-plane tokens.
package device

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
	"github.com/lumo-harness/platform/observability"
)

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var artifactName = regexp.MustCompile(`^[a-z][a-z0-9-]{2,63}$`)
var artifactVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
var shaDigest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type Options struct {
	Store                                                        *store.Store
	Listen, PublicURL, RegistryURL, ControlToken                 string
	ServerCertFile, ServerKeyFile, IssuerCertFile, IssuerKeyFile string
	AllowedScopes                                                []string
	ProcessRuntime                                               bool
	PolicyURL                                                    string
}

type Gateway struct {
	options     Options
	tls         *tls.Config
	issuer      *x509.Certificate
	signer      crypto.Signer
	issuerPEM   string
	client      *http.Client
	connections sync.Map
}

func New(options Options) (*Gateway, error) {
	public, err := url.Parse(options.PublicURL)
	if err != nil || public.Scheme != "https" || public.Host == "" || public.Path != "" && public.Path != "/" || public.User != nil || public.RawQuery != "" || public.Fragment != "" {
		return nil, errors.New("device gateway requires an exact HTTPS public origin")
	}
	registry, err := url.Parse(options.RegistryURL)
	if err != nil || (registry.Scheme != "http" && registry.Scheme != "https") || registry.Host == "" || registry.User != nil || registry.RawQuery != "" || registry.Fragment != "" || options.ControlToken == "" || options.Store == nil || options.Listen == "" {
		return nil, errors.New("device gateway requires Registry, store, listener, and internal credentials")
	}
	if options.ProcessRuntime || options.PolicyURL != "" {
		policy, err := url.Parse(options.PolicyURL)
		if err != nil || (policy.Scheme != "http" && policy.Scheme != "https") || policy.Host == "" || policy.User != nil || policy.Fragment != "" {
			return nil, errors.New("device process runtime requires an explicit HTTP(S) policy decision endpoint")
		}
	}
	for i, scope := range options.AllowedScopes {
		options.AllowedScopes[i] = strings.TrimSpace(scope)
	}
	pair, err := tls.LoadX509KeyPair(options.ServerCertFile, options.ServerKeyFile)
	if err != nil {
		return nil, errors.New("device gateway TLS certificate unavailable")
	}
	issuerPair, err := tls.LoadX509KeyPair(options.IssuerCertFile, options.IssuerKeyFile)
	if err != nil {
		return nil, errors.New("device gateway issuer unavailable")
	}
	issuer, err := x509.ParseCertificate(issuerPair.Certificate[0])
	if err != nil {
		return nil, err
	}
	signer, ok := issuerPair.PrivateKey.(crypto.Signer)
	if !ok || !issuer.IsCA || issuer.KeyUsage&x509.KeyUsageCertSign == 0 || !issuer.NotAfter.After(time.Now().Add(time.Hour)) || issuer.NotBefore.After(time.Now()) {
		return nil, errors.New("device gateway requires a valid signing CA")
	}
	roots := x509.NewCertPool()
	roots.AddCert(issuer)
	client := observability.ConfiguredHTTPClient(30 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Gateway{options: options, issuer: issuer, signer: signer, issuerPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: issuer.Raw})), client: client,
		tls: &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{pair}, ClientAuth: tls.VerifyClientCertIfGiven, ClientCAs: roots}}, nil
}

func (g *Gateway) PublicURL() string { return strings.TrimRight(g.options.PublicURL, "/") }

func (g *Gateway) Serve(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /device/enroll", g.enroll)
	mux.HandleFunc("POST /device/renew", g.renew)
	mux.HandleFunc("GET /device/connect", g.connect)
	mux.HandleFunc("POST /device/registry/v1/plan", g.plan)
	mux.HandleFunc("GET /device/registry/v1/blobs/{digest}", g.blob)
	server := &http.Server{Addr: g.options.Listen, Handler: mux, TLSConfig: g.tls, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 45 * time.Second, MaxHeaderBytes: 16 << 10}
	go g.dispatchTasks(ctx)
	go func() {
		<-ctx.Done()
		g.connections.Range(func(key, value any) bool { _ = key.(*websocket.Conn).Close(); return true })
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	err := server.ListenAndServeTLS("", "")
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (g *Gateway) dispatchTasks(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastError := ""
	lastCancelError := ""
	for {
		_, err := g.options.Store.DispatchDeviceTasks(ctx, 32)
		if err != nil && ctx.Err() == nil {
			message := err.Error()
			if message != lastError {
				log.Printf("device gateway task dispatch unavailable: %s", message)
				lastError = message
			}
		} else if err == nil {
			lastError = ""
		}
		// Cancellations ride the same tick rather than a slower loop of their own:
		// a cancel that waits is a cancel that lets the work finish first, which is
		// the one outcome it exists to prevent. The two share no other state, and
		// each keeps its own last-error so one failing does not silence the other.
		_, cancelErr := g.options.Store.DispatchDeviceCancellations(ctx, 32)
		if cancelErr != nil && ctx.Err() == nil {
			message := cancelErr.Error()
			if message != lastCancelError {
				log.Printf("device gateway cancellation dispatch unavailable: %s", message)
				lastCancelError = message
			}
		} else if cancelErr == nil {
			lastCancelError = ""
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, value any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("single JSON object required")
	}
	return nil
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func denied(w http.ResponseWriter) {
	respond(w, http.StatusForbidden, map[string]string{"error": "device_not_authorized"})
}

type EnrollmentRequest struct {
	Realm  string `json:"realm"`
	NodeID string `json:"node_id"`
	Code   string `json:"code"`
	CSR    string `json:"csr"`
}
type CertificateResponse struct {
	Certificate string    `json:"certificate"`
	Issuer      string    `json:"issuer"`
	ExpiresAt   time.Time `json:"expires_at"`
}

func (g *Gateway) certificate(realm, id, rawCSR string) (CertificateResponse, string, string, error) {
	var out CertificateResponse
	if !identifier.MatchString(realm) || !identifier.MatchString(id) || len(rawCSR) > 16384 {
		return out, "", "", store.ErrBadRequest
	}
	block, rest := pem.Decode([]byte(rawCSR))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(bytes.TrimSpace(rest)) != 0 {
		return out, "", "", store.ErrBadRequest
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		return out, "", "", store.ErrBadRequest
	}
	switch key := csr.PublicKey.(type) {
	case *ecdsa.PublicKey:
		if key.Curve != elliptic.P256() {
			return out, "", "", store.ErrBadRequest
		}
	case ed25519.PublicKey:
	default:
		return out, "", "", store.ErrBadRequest
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return out, "", "", err
	}
	expires := time.Now().Add(24 * time.Hour)
	if expires.After(g.issuer.NotAfter) {
		expires = g.issuer.NotAfter
	}
	if !expires.After(time.Now().Add(time.Hour)) {
		return out, "", "", store.ErrForbidden
	}
	identity, _ := url.Parse("spiffe://lumo-device/realm/" + realm + "/node/" + id)
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "lumo-desktop"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: expires,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, URIs: []*url.URL{identity}}
	der, err := x509.CreateCertificate(rand.Reader, template, g.issuer, csr.PublicKey, g.signer)
	if err != nil {
		return out, "", "", err
	}
	h := sha256.Sum256(csr.RawSubjectPublicKeyInfo)
	return CertificateResponse{Certificate: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), Issuer: g.issuerPEM, ExpiresAt: expires}, hex.EncodeToString(h[:]), serial.Text(16), nil
}

func (g *Gateway) enroll(w http.ResponseWriter, r *http.Request) {
	var input EnrollmentRequest
	if readJSON(w, r, &input) != nil || len(input.Code) != 43 {
		denied(w)
		return
	}
	certificate, key, serial, err := g.certificate(input.Realm, input.NodeID, input.CSR)
	if err != nil {
		denied(w)
		return
	}
	if err = g.options.Store.EnrollDevice(r.Context(), input.Realm, input.NodeID, input.Code, key, serial, certificate.ExpiresAt); err != nil {
		denied(w)
		return
	}
	respond(w, http.StatusOK, certificate)
}

func (g *Gateway) identity(r *http.Request) (store.DeviceConnection, error) {
	return g.authenticatedIdentity(r, false)
}

func (g *Gateway) authenticatedIdentity(r *http.Request, renewal bool) (store.DeviceConnection, error) {
	if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 || len(r.TLS.PeerCertificates) == 0 {
		return store.DeviceConnection{}, store.ErrForbidden
	}
	cert := r.TLS.PeerCertificates[0]
	if len(cert.URIs) != 1 {
		return store.DeviceConnection{}, store.ErrForbidden
	}
	u := cert.URIs[0]
	parts := strings.Split(u.Path, "/")
	if u.Scheme != "spiffe" || u.Host != "lumo-device" || len(parts) != 5 || parts[1] != "realm" || parts[3] != "node" || !identifier.MatchString(parts[2]) || !identifier.MatchString(parts[4]) {
		return store.DeviceConnection{}, store.ErrForbidden
	}
	h := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	if renewal {
		return g.options.Store.AuthenticateDeviceRenewal(r.Context(), parts[2], parts[4], hex.EncodeToString(h[:]), cert.SerialNumber.Text(16))
	}
	return g.options.Store.AuthenticateDevice(r.Context(), parts[2], parts[4], hex.EncodeToString(h[:]), cert.SerialNumber.Text(16))
}

func (g *Gateway) renew(w http.ResponseWriter, r *http.Request) {
	d, err := g.authenticatedIdentity(r, true)
	if err != nil {
		denied(w)
		return
	}
	var input struct {
		CSR string `json:"csr"`
	}
	if readJSON(w, r, &input) != nil {
		denied(w)
		return
	}
	out, key, serial, err := g.certificate(d.Realm, d.NodeID, input.CSR)
	if err != nil || key != d.PublicKeyHash {
		denied(w)
		return
	}
	d, err = g.options.Store.RotateDeviceCertificate(r.Context(), d.Realm, d.NodeID, key, r.TLS.PeerCertificates[0].SerialNumber.Text(16), serial, out.Certificate, out.ExpiresAt)
	if err != nil {
		denied(w)
		return
	}
	out.Certificate, out.ExpiresAt = d.CertificatePEM, *d.CertificateExpires
	respond(w, http.StatusOK, out)
}

func (g *Gateway) registry(ctx context.Context, method, path string, body any, limit int64) ([]byte, error) {
	var raw []byte
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(g.options.RegistryURL, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+g.options.ControlToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := g.client.Do(req)
	if err != nil {
		return nil, errors.New("device Registry unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, errors.New("device Registry denied request")
	}
	raw, err = io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, errors.New("device Registry response too large")
	}
	return raw, nil
}

type PolicyRequest struct {
	Revision      int64           `json:"revision"`
	Name          string          `json:"name"`
	Version       string          `json:"version"`
	ClientVersion string          `json:"client_version"`
	Shape         map[string]bool `json:"shape"`
}

func (g *Gateway) PreparePolicy(ctx context.Context, input PolicyRequest) (store.DevicePolicy, error) {
	var out store.DevicePolicy
	if !artifactName.MatchString(input.Name) || !artifactVersion.MatchString(input.Version) || len(input.ClientVersion) == 0 || len(input.ClientVersion) > 64 {
		return out, store.ErrBadRequest
	}
	for key := range input.Shape {
		if key != "olap" && key != "graph" && key != "vector" && key != "object" && key != "gpu" {
			return out, store.ErrBadRequest
		}
	}
	raw, err := g.registry(ctx, http.MethodPost, "/v1/plan", map[string]any{"name": input.Name, "version": input.Version, "shape": input.Shape}, 4<<20)
	if err != nil {
		return out, err
	}
	var plan struct {
		Root  string `json:"root"`
		Items []struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Digest  string `json:"digest"`
		} `json:"items"`
		Scopes []string `json:"scopes"`
	}
	if json.Unmarshal(raw, &plan) != nil || plan.Root != input.Name+"@"+input.Version || len(plan.Items) == 0 || len(plan.Items) > 200 {
		return out, store.ErrBadRequest
	}
	allowed := map[string]bool{}
	for _, scope := range g.options.AllowedScopes {
		allowed[scope] = true
	}
	for _, scope := range plan.Scopes {
		if !allowed[scope] {
			return out, fmt.Errorf("%w: desktop artifact scope not allowed: %s", store.ErrForbidden, scope)
		}
	}
	seen := map[string]bool{}
	for _, item := range plan.Items {
		if !artifactName.MatchString(item.Name) || !artifactVersion.MatchString(item.Version) || !shaDigest.MatchString(item.Digest) || seen[item.Name+"@"+item.Version] {
			return out, store.ErrBadRequest
		}
		seen[item.Name+"@"+item.Version] = true
		manifest, err := g.registry(ctx, http.MethodGet, "/v1/blobs/"+item.Digest, nil, 4<<20)
		if err != nil {
			return out, err
		}
		h := sha256.Sum256(manifest)
		if "sha256:"+hex.EncodeToString(h[:]) != item.Digest {
			return out, store.ErrBadRequest
		}
		var content struct {
			Name          string `json:"name"`
			Version       string `json:"version"`
			PayloadDigest string `json:"payload_digest"`
		}
		if json.Unmarshal(manifest, &content) != nil || content.Name != item.Name || content.Version != item.Version {
			return out, store.ErrBadRequest
		}
		if content.PayloadDigest != "" && !shaDigest.MatchString(content.PayloadDigest) {
			return out, store.ErrBadRequest
		}
		out.Artifacts = append(out.Artifacts, store.DeviceArtifact{Name: item.Name, Version: item.Version, Digest: item.Digest, PayloadDigest: content.PayloadDigest})
	}
	out.Root, out.Name, out.Version, out.ClientVersion, out.Scopes, out.Shape, out.Plan = plan.Root, input.Name, input.Version, input.ClientVersion, plan.Scopes, input.Shape, raw
	return out, nil
}

func sameArtifacts(a, b []store.DeviceArtifact) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]store.DeviceArtifact{}
	for _, item := range a {
		seen[item.Name+"@"+item.Version] = item
	}
	for _, item := range b {
		if seen[item.Name+"@"+item.Version] != item {
			return false
		}
	}
	return true
}

func (g *Gateway) ProcessRuntimeEnabled() bool {
	return g.options.ProcessRuntime && g.options.PolicyURL != ""
}

func (g *Gateway) AuthorizeRuntime(ctx context.Context, d store.DeviceConnection, actor, name, version string) error {
	if !g.ProcessRuntimeEnabled() || actor != d.Owner {
		return store.ErrForbidden
	}
	var selected *store.DeviceArtifact
	for _, artifact := range d.Policy.Artifacts {
		if artifact.Name == name && artifact.Version == version {
			item := artifact
			selected = &item
			break
		}
	}
	if selected == nil {
		return store.ErrForbidden
	}
	raw, err := json.Marshal(map[string]any{"input": map[string]any{"actor": actor, "realm": d.Realm, "node_id": d.NodeID, "action": "desktop.runtime.start", "artifact": selected, "scopes": d.Policy.Scopes, "revision": d.Revision}})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.options.PolicyURL, bytes.NewReader(raw))
	if err != nil {
		return store.ErrForbidden
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := g.client.Do(req)
	if err != nil {
		return store.ErrForbidden
	}
	defer res.Body.Close()
	var decision struct {
		Result bool `json:"result"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 16<<10)).Decode(&decision) != nil || !decision.Result {
		return store.ErrForbidden
	}
	return nil
}

func (g *Gateway) plan(w http.ResponseWriter, r *http.Request) {
	d, err := g.identity(r)
	if err != nil {
		denied(w)
		return
	}
	var input struct {
		Name    string          `json:"name"`
		Version string          `json:"version"`
		Shape   map[string]bool `json:"shape"`
	}
	if readJSON(w, r, &input) != nil || input.Name != d.Policy.Name || input.Version != d.Policy.Version {
		denied(w)
		return
	}
	for key, value := range input.Shape {
		if value && !d.Policy.Shape[key] {
			denied(w)
			return
		}
	}
	current, err := g.PreparePolicy(r.Context(), PolicyRequest{Name: d.Policy.Name, Version: d.Policy.Version, ClientVersion: d.Policy.ClientVersion, Shape: input.Shape})
	if err != nil || !sameArtifacts(current.Artifacts, d.Policy.Artifacts) {
		denied(w)
		return
	}
	respond(w, http.StatusOK, current.Plan)
}

func (g *Gateway) blob(w http.ResponseWriter, r *http.Request) {
	d, err := g.identity(r)
	if err != nil {
		denied(w)
		return
	}
	digest := r.PathValue("digest")
	allowed := false
	if !shaDigest.MatchString(digest) {
		denied(w)
		return
	}
	for _, item := range d.Policy.Artifacts {
		if item.Digest == digest || item.PayloadDigest == digest {
			allowed = true
			break
		}
	}
	if !allowed {
		denied(w)
		return
	}
	raw, err := g.registry(r.Context(), http.MethodGet, "/v1/blobs/"+digest, nil, 64<<20)
	if err != nil {
		denied(w)
		return
	}
	h := sha256.Sum256(raw)
	if "sha256:"+hex.EncodeToString(h[:]) != digest {
		denied(w)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(raw)
}

type Message struct {
	Type          string                 `json:"type"`
	Revision      int64                  `json:"revision,omitempty"`
	ClientVersion string                 `json:"client_version,omitempty"`
	OS            string                 `json:"os,omitempty"`
	Arch          string                 `json:"arch,omitempty"`
	Installed     []store.DeviceArtifact `json:"installed,omitempty"`
	Error         string                 `json:"error,omitempty"`
	CommandID     string                 `json:"command_id,omitempty"`
	State         string                 `json:"state,omitempty"`
	Result        json.RawMessage        `json:"result,omitempty"`
	Policy        *store.DevicePolicy    `json:"policy,omitempty"`
	Commands      []store.DeviceCommand  `json:"commands,omitempty"`
}

func (g *Gateway) connect(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" {
		denied(w)
		return
	}
	d, err := g.identity(r)
	if err != nil {
		denied(w)
		return
	}
	connection, err := g.options.Store.ConnectDevice(r.Context(), d.Realm, d.NodeID, d.PublicKeyHash, d.CertificateSerial)
	if err != nil {
		denied(w)
		return
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = g.options.Store.DisconnectDevice(cleanup, d.Realm, d.NodeID, connection)
	}()
	upgrader := websocket.Upgrader{HandshakeTimeout: 5 * time.Second, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	g.connections.Store(ws, true)
	defer g.connections.Delete(ws)
	defer ws.Close()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	ws.SetReadLimit(1 << 20)
	_ = ws.SetReadDeadline(time.Now().Add(30 * time.Second))
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		defer ws.Close()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		var lastRevision int64 = -1
		for {
			current, err := g.options.Store.AuthenticateDevice(ctx, d.Realm, d.NodeID, d.PublicKeyHash, d.CertificateSerial)
			if err != nil || current.ConnectionID != connection || current.ConnectionExpires == nil || !current.ConnectionExpires.After(time.Now()) {
				return
			}
			if current.Revision != lastRevision {
				if lastRevision >= 0 {
					return
				}
				policy := current.Policy
				policy.Plan = nil
				_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if ws.WriteJSON(Message{Type: "desired", Revision: current.Revision, Policy: &policy}) != nil {
					return
				}
				lastRevision = current.Revision
			}
			_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if ws.WriteJSON(Message{Type: "status", Revision: current.Revision, State: current.Status}) != nil {
				return
			}
			commands, err := g.options.Store.ClaimDeviceCommands(ctx, d.Realm, d.NodeID, connection)
			if err != nil {
				return
			}
			if len(commands) > 0 {
				_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if ws.WriteJSON(Message{Type: "commands", Commands: commands}) != nil {
					return
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	defer func() { cancel(); _ = ws.Close(); <-writerDone }()
	for {
		var message Message
		if ws.ReadJSON(&message) != nil {
			return
		}
		_ = ws.SetReadDeadline(time.Now().Add(30 * time.Second))
		switch message.Type {
		case "heartbeat":
			if _, err = g.options.Store.DeviceHeartbeat(ctx, d.Realm, d.NodeID, d.PublicKeyHash, d.CertificateSerial, connection, message.Revision, message.Installed, message.Error, message.ClientVersion, message.OS, message.Arch); err != nil {
				return
			}
		case "result":
			if _, err = g.options.Store.AuthenticateDevice(ctx, d.Realm, d.NodeID, d.PublicKeyHash, d.CertificateSerial); err != nil {
				return
			}
			if err = g.options.Store.CompleteDeviceCommand(ctx, d.Realm, d.NodeID, connection, message.CommandID, message.State, message.Result); err != nil {
				return
			}
		case "task_result":
			// A device reports the outcome of a task it already accepted. The
			// payload is domain.TaskResult-shaped, but none of it is trusted for
			// identity: RecordDeviceTaskResult re-reads the run from the command
			// row and refuses any mismatch. Rejections are logged because this
			// path also drops the connection, and "device keeps reconnecting" is
			// otherwise very easy to misattribute.
			if _, err = g.options.Store.AuthenticateDevice(ctx, d.Realm, d.NodeID, d.PublicKeyHash, d.CertificateSerial); err != nil {
				return
			}
			var reported domain.TaskResult
			if err = json.Unmarshal(message.Result, &reported); err != nil {
				log.Printf("device gateway rejected task result from %s: malformed payload", d.NodeID)
				return
			}
			if err = g.options.Store.RecordDeviceTaskResult(ctx, d.Realm, d.NodeID, connection, message.CommandID, reported); err != nil {
				log.Printf("device gateway rejected task result from %s: %v", d.NodeID, err)
				return
			}
		default:
			return
		}
	}
}
