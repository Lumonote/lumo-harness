package observability

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

// TLSConfigFromEnv builds a fail-closed TLS configuration. TLS is enabled only
// when LUMO_TLS_CERT_FILE is set; in that mode cert, key and client CA are all
// mandatory. Files are re-read before each handshake, so rotation needs no
// process restart.
func TLSConfigFromEnv() (*tls.Config, error) {
	cert, key, ca := os.Getenv("LUMO_TLS_CERT_FILE"), os.Getenv("LUMO_TLS_KEY_FILE"), os.Getenv("LUMO_TLS_CLIENT_CA_FILE")
	if cert == "" && key == "" && ca == "" {
		return nil, nil
	}
	if cert == "" || key == "" || ca == "" {
		return nil, errors.New("LUMO_TLS_CERT_FILE, LUMO_TLS_KEY_FILE and LUMO_TLS_CLIENT_CA_FILE must be configured together")
	}
	pool := x509.NewCertPool()
	pem, err := os.ReadFile(ca)
	if err != nil {
		return nil, fmt.Errorf("read client CA: %w", err)
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("client CA contains no valid certificates")
	}
	if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
		return nil, fmt.Errorf("load server certificate: %w", err)
	}
	return &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: pool, GetCertificate: reloadingCertificate(cert, key)}, nil
}

func reloadingCertificate(certFile, keyFile string) func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	var mu sync.Mutex
	var last certSnapshot
	var current *tls.Certificate
	return func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		mu.Lock()
		defer mu.Unlock()
		st1, e1 := os.Stat(certFile)
		st2, e2 := os.Stat(keyFile)
		if e1 != nil || e2 != nil {
			return nil, fmt.Errorf("stat TLS certificate: %v %v", e1, e2)
		}
		s := certSnapshot{certSize: st1.Size(), certMod: st1.ModTime(), keySize: st2.Size(), keyMod: st2.ModTime()}
		if current == nil || s != last {
			pair, err := tls.LoadX509KeyPair(certFile, keyFile)
			if err != nil {
				return nil, fmt.Errorf("reload TLS certificate: %w", err)
			}
			current, last = &pair, s
		}
		return current, nil
	}
}

type certSnapshot struct {
	certSize, keySize int64
	certMod, keyMod   time.Time
}

// Serve starts an HTTP or mTLS listener according to environment. In TLS mode
// it never falls back to plaintext.
func Serve(srv *http.Server) error {
	cfg, err := TLSConfigFromEnv()
	if err != nil {
		return err
	}
	if cfg == nil {
		return srv.ListenAndServe()
	}
	srv.TLSConfig = cfg
	return srv.ListenAndServeTLS("", "")
}

// HTTPClientFromEnv returns a client that verifies the configured CA and
// presents a client certificate. It fails closed when only part of the bundle
// is configured; callers should use it for north/south and control-plane calls.
func HTTPClientFromEnv() (*http.Client, error) {
	cert, key, ca := os.Getenv("LUMO_TLS_CERT_FILE"), os.Getenv("LUMO_TLS_KEY_FILE"), os.Getenv("LUMO_TLS_CA_FILE")
	if cert == "" && key == "" && ca == "" {
		return &http.Client{Timeout: 30 * time.Second}, nil
	}
	if cert == "" || key == "" || ca == "" {
		return nil, errors.New("LUMO_TLS_CERT_FILE, LUMO_TLS_KEY_FILE and LUMO_TLS_CA_FILE must be configured together")
	}
	pem, err := os.ReadFile(ca)
	if err != nil {
		return nil, fmt.Errorf("read server CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("server CA contains no valid certificates")
	}
	pair, err := tls.LoadX509KeyPair(cert, key)
	if err != nil {
		return nil, fmt.Errorf("load client certificate: %w", err)
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, Certificates: []tls.Certificate{pair}, ServerName: os.Getenv("LUMO_TLS_SERVER_NAME")}}}, nil
}

func ConfiguredHTTPClient(timeout time.Duration) *http.Client {
	c, err := HTTPClientFromEnv()
	if err != nil {
		panic(err)
	}
	if timeout > 0 {
		c.Timeout = timeout
	}
	return c
}
