// Command provisioner installs a signed registry closure on a node.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/lumo-harness/platform/registry/internal/plan"
	"github.com/lumo-harness/platform/registry/internal/provisioner"
)

func main() {
	name := flag.String("name", env("PROVISIONER_ARTIFACT_NAME", ""), "root artifact name")
	version := flag.String("version", env("PROVISIONER_ARTIFACT_VERSION", ""), "root artifact version")
	registry := flag.String("registry", env("REGISTRY_URL", "http://127.0.0.1:8084"), "registry URL")
	dir := flag.String("dir", env("PROVISIONER_INSTALL_DIR", "/var/lib/lumo/artifacts"), "install directory")
	shapeRaw := flag.String("shape", env("PROVISIONER_SHAPE", `{"object":true}`), "target shape JSON")
	interval := flag.Duration("interval", durationEnv("PROVISIONER_INTERVAL", 0), "reconcile interval; 0 performs one install/reconcile")
	flag.Parse()
	var shape plan.Shape
	if err := json.Unmarshal([]byte(*shapeRaw), &shape); err != nil {
		log.Fatalf("provisioner: shape 解析失败: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	installer := provisioner.New(*registry, *dir)
	installer.ControlPlaneToken = env("LUMO_CONTROL_PLANE_TOKEN", "")
	reconcile := func() error {
		state, changed, err := installer.Reconcile(ctx, *name, *version, shape)
		if err != nil {
			return err
		}
		if changed {
			log.Printf("provisioner: installed %s (%d items)", state.Root, len(state.Installed))
		} else {
			log.Printf("provisioner: already converged %s (%d items)", state.Root, len(state.Installed))
		}
		return nil
	}
	if *interval <= 0 {
		if err := reconcile(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *name == "" || *version == "" {
		log.Fatal("provisioner: -name 与 -version 是持续 reconcile 的必填参数")
	}
	if err := reconcile(); err != nil {
		log.Print(err)
	}
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := reconcile(); err != nil {
				log.Print(err)
			}
		}
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		log.Printf("provisioner: 忽略非法 %s=%q: %v", key, value, err)
		return fallback
	}
	return parsed
}
