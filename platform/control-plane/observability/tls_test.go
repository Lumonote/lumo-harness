package observability

import (
	"os"
	"testing"
)

func TestTLSConfigFailsClosedOnPartialConfiguration(t *testing.T) {
	t.Setenv("LUMO_TLS_CERT_FILE", "/tmp/cert.pem")
	t.Setenv("LUMO_TLS_KEY_FILE", "")
	t.Setenv("LUMO_TLS_CLIENT_CA_FILE", "/tmp/ca.pem")
	if _, err := TLSConfigFromEnv(); err == nil {
		t.Fatal("expected partial TLS configuration to fail")
	}
}

func TestTLSDisabledByDefault(t *testing.T) {
	for _, k := range []string{"LUMO_TLS_CERT_FILE", "LUMO_TLS_KEY_FILE", "LUMO_TLS_CLIENT_CA_FILE"} {
		_ = os.Unsetenv(k)
	}
	cfg, err := TLSConfigFromEnv()
	if err != nil || cfg != nil {
		t.Fatalf("cfg=%v err=%v", cfg, err)
	}
}
