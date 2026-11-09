// Opt-in reference adapter. No deployment manifest enables it by default.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/lumo-harness/platform/governance/internal/recoveryprovider"
	"github.com/lumo-harness/platform/observability"
)

func run() error {
	configFile := flag.String("config", "", "explicit frozen-snapshot clone config JSON")
	listen := flag.String("listen", "127.0.0.1:8098", "HTTP or configured mTLS listener")
	vaultFile := flag.String("vault-readback", "", "read only this explicit Vault transit target JSON and exit")
	flag.Parse()
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected arguments")
	}
	decode := func(path string, value any) error {
		raw, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("cannot read explicit configuration")
		}
		if len(raw) > 64<<10 {
			return fmt.Errorf("configuration too large")
		}
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		if d.Decode(value) != nil || d.Decode(new(any)) != io.EOF {
			return fmt.Errorf("invalid configuration")
		}
		return nil
	}
	if *vaultFile != "" {
		if *configFile != "" {
			return fmt.Errorf("select one operation")
		}
		var target recoveryprovider.VaultTarget
		if err := decode(*vaultFile, &target); err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		observation, err := recoveryprovider.ReadVaultKey(ctx, target, os.Getenv("LUMO_VAULT_READBACK_TOKEN"))
		if err != nil {
			return fmt.Errorf("Vault readback failed")
		}
		return json.NewEncoder(os.Stdout).Encode(observation)
	}
	if *configFile == "" {
		return fmt.Errorf("--config is required; no target is inferred")
	}
	var config recoveryprovider.Config
	if err := decode(*configFile, &config); err != nil {
		return err
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		return fmt.Errorf("invalid listener")
	}
	if os.Getenv("LUMO_TLS_CERT_FILE") == "" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return fmt.Errorf("external listener requires configured mTLS")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	provider, err := recoveryprovider.New(ctx, config, os.Getenv("LUMO_RECOVERY_ADAPTER_PG_DSN"), os.Getenv("LUMO_RECOVERY_PROVIDER_TOKEN"), os.Getenv("LUMO_RECOVERY_RECEIPT_KEY"))
	if err != nil {
		return fmt.Errorf("provider configuration or database initialization failed")
	}
	defer provider.Close()
	server := &http.Server{Addr: *listen, Handler: provider.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 35 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	return observability.Serve(server)
}
func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
