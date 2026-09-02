// Command governed-skill-publisher turns Governance's explicit published
// pointers into one signed Skill artifact. It is intended for a protected CI
// or release host: the signing private key is never copied into Governance,
// the Registry, Provisioner, or a DSH node.
package main

import (
	"context"
	"crypto/ed25519"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/lumo-harness/platform/registry/internal/governedskills"
	"github.com/lumo-harness/platform/registry/internal/publisher"
)

type scopesFlag []string

func (values *scopesFlag) String() string { return strings.Join(*values, ",") }
func (values *scopesFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	governanceURL := flag.String("governance", envOr("GOVERNANCE_URL", "http://127.0.0.1:8089"), "Governance base URL")
	registryURL := flag.String("registry", envOr("REGISTRY_URL", "http://127.0.0.1:8084"), "Registry base URL")
	realm := flag.String("realm", os.Getenv("LUMO_REALM"), "Governance realm")
	userID := flag.String("user", os.Getenv("LUMO_GOVERNANCE_PUBLISHER_USER"), "realm-admin user ID for Governance snapshot export")
	roles := flag.String("roles", envOr("LUMO_GOVERNANCE_PUBLISHER_ROLES", "realm_admin"), "comma-separated Governance caller roles")
	artifactName := flag.String("artifact", os.Getenv("GOVERNED_SKILL_ARTIFACT_NAME"), "aggregate Registry artifact name")
	artifactVersion := flag.String("version", os.Getenv("GOVERNED_SKILL_ARTIFACT_VERSION"), "new immutable Registry artifact version")
	publisherID := flag.String("publisher", os.Getenv("GOVERNED_SKILL_PUBLISHER"), "trusted Registry publisher ID")
	privateKeyPath := flag.String("private-key", os.Getenv("GOVERNED_SKILL_PRIVATE_KEY_FILE"), "Ed25519 seed/private key/PKCS#8 PEM file")
	timeout := flag.Duration("timeout", 60*time.Second, "combined Governance + Registry timeout")
	var scopes scopesFlag
	flag.Var(&scopes, "scope", "manifest scope (repeatable; default skills:use)")
	flag.Parse()
	if len(scopes) == 0 {
		scopes = []string{"skills:use"}
	}
	if *artifactName == "" || *artifactVersion == "" || *publisherID == "" || *privateKeyPath == "" {
		return fmt.Errorf("governed-skill-publisher: -artifact, -version, -publisher, and -private-key are required")
	}
	keyRaw, err := os.ReadFile(*privateKeyPath)
	if err != nil {
		return fmt.Errorf("governed-skill-publisher: read private key: %w", err)
	}
	key, err := publisher.ParsePrivateKey(keyRaw)
	if err != nil {
		return fmt.Errorf("governed-skill-publisher: invalid private key: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	snapshot, err := governedskills.Fetch(ctx, governedskills.FetchConfig{
		GovernanceURL: *governanceURL, Token: os.Getenv("LUMO_CONTROL_PLANE_TOKEN"), Realm: *realm, UserID: *userID, Roles: *roles,
	})
	if err != nil {
		return err
	}
	build, err := governedskills.Build(snapshot, governedskills.BuildConfig{
		ArtifactName: *artifactName, ArtifactVersion: *artifactVersion, Publisher: *publisherID, Scopes: scopes,
	})
	if err != nil {
		return err
	}
	registry, err := publisher.NewClient(*registryURL, os.Getenv("LUMO_CONTROL_PLANE_TOKEN"), nil)
	if err != nil {
		return err
	}
	result, err := registry.Publish(ctx, build.Manifest, ed25519.Sign(key, build.Manifest), build.Bundle)
	if err != nil {
		return err
	}
	fmt.Println(string(result))
	return nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
