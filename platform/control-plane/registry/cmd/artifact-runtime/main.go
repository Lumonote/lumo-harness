// Command artifact-runtime is the node-local process adapter for signed
// Component artifacts. It deliberately listens only on a mode-0600 Unix
// socket; exposing lifecycle controls on a network port would require a
// deployment-specific identity and authorization boundary.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lumo-harness/platform/registry/internal/artifactruntime"
	"github.com/lumo-harness/platform/registry/internal/provisioner"
)

var (
	artifactNameRe    = regexp.MustCompile(`^[a-z][a-z0-9-]{2,63}$`)
	artifactVersionRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "list", "start", "stop", "health", "logs", "uninstall":
		err = client(os.Args[1], os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: artifact-runtime {serve|list|start|stop|health|logs|uninstall} [options]")
	os.Exit(64)
}

func serve(args []string) error {
	flags := flag.NewFlagSet("artifact-runtime serve", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dir := flags.String("dir", env("PROVISIONER_INSTALL_DIR", "/var/lib/lumo/artifacts"), "verified artifact directory")
	socket := flags.String("socket", env("LUMO_ARTIFACT_RUNTIME_SOCKET", "/run/lumo/artifact-runtime.sock"), "mode-0600 Unix control socket")
	stopTimeout := flags.Duration("stop-timeout", 10*time.Second, "graceful stop timeout")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !filepath.IsAbs(*dir) || !filepath.IsAbs(*socket) {
		return errors.New("artifact-runtime: -dir and -socket must be absolute paths")
	}
	if info, err := os.Lstat(*socket); err == nil {
		if info.Mode()&os.ModeSocket != 0 {
			return fmt.Errorf("artifact-runtime: control socket already exists: %s", *socket)
		}
		return fmt.Errorf("artifact-runtime: refusing to replace non-socket path: %s", *socket)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("artifact-runtime: inspect control socket: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(*socket), 0o700); err != nil {
		return fmt.Errorf("artifact-runtime: create socket directory: %w", err)
	}
	listener, err := net.Listen("unix", *socket)
	if err != nil {
		return fmt.Errorf("artifact-runtime: listen: %w", err)
	}
	defer func() {
		_ = listener.Close()
		_ = os.Remove(*socket)
	}()
	if err := os.Chmod(*socket, 0o600); err != nil {
		return fmt.Errorf("artifact-runtime: restrict control socket: %w", err)
	}

	controller := &runtimeController{
		installer:  provisioner.New("", *dir),
		supervisor: artifactruntime.NewSupervisor(*stopTimeout),
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), *stopTimeout+time.Second)
		defer cancel()
		_ = controller.supervisor.StopAll(shutdown)
	}()
	server := &http.Server{Handler: controller.routes(), ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), *stopTimeout+time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("artifact-runtime: listening on unix socket %s", *socket)
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// client deliberately uses the same Unix socket as the service rather than a
// TCP loopback address. Its commands therefore inherit the filesystem ACL on
// the mode-0600 socket and cannot accidentally become a remote control plane.
func client(action string, args []string) error {
	flags := flag.NewFlagSet("artifact-runtime "+action, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	socket := flags.String("socket", env("LUMO_ARTIFACT_RUNTIME_SOCKET", "/run/lumo/artifact-runtime.sock"), "Unix control socket")
	name := flags.String("name", "", "artifact name")
	version := flags.String("version", "", "artifact version")
	tailBytes := flags.Int("tail-bytes", 64<<10, "log tail bytes (logs only)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !filepath.IsAbs(*socket) {
		return errors.New("artifact-runtime: -socket must be absolute")
	}
	path := "/v1/runtimes"
	method := http.MethodGet
	if action != "list" {
		if !validArtifactID(*name, *version) {
			return errors.New("artifact-runtime: -name and -version must identify an artifact")
		}
		path += "/" + *name + "/" + *version
		switch action {
		case "start":
			method, path = http.MethodPost, path+"/start"
		case "stop":
			method, path = http.MethodPost, path+"/stop"
		case "health":
			path += "/health"
		case "logs":
			if *tailBytes < 1 || *tailBytes > 1<<20 {
				return errors.New("artifact-runtime: -tail-bytes must be from 1 to 1048576")
			}
			path += "/logs?tail_bytes=" + strconv.Itoa(*tailBytes)
		case "uninstall":
			method = http.MethodDelete
		}
	}
	request, err := http.NewRequest(method, "http://artifact-runtime"+path, nil)
	if err != nil {
		return err
	}
	dialer := &net.Dialer{}
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", *socket)
		},
	}
	response, err := (&http.Client{Transport: transport, Timeout: 20 * time.Second}).Do(request)
	if err != nil {
		return fmt.Errorf("artifact-runtime: call local controller: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil {
		return err
	}
	if len(raw) > 1<<20 {
		return errors.New("artifact-runtime: controller response exceeds 1 MiB")
	}
	if _, err := os.Stdout.Write(raw); err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("artifact-runtime: controller returned HTTP %d", response.StatusCode)
	}
	return nil
}

type runtimeController struct {
	installer  *provisioner.Installer
	supervisor *artifactruntime.Supervisor
}

func (c *runtimeController) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runtimes", c.list)
	mux.HandleFunc("POST /v1/runtimes/{name}/{version}/start", c.start)
	mux.HandleFunc("POST /v1/runtimes/{name}/{version}/stop", c.stop)
	mux.HandleFunc("GET /v1/runtimes/{name}/{version}/health", c.health)
	mux.HandleFunc("GET /v1/runtimes/{name}/{version}/logs", c.logs)
	mux.HandleFunc("DELETE /v1/runtimes/{name}/{version}", c.uninstall)
	return mux
}

func (c *runtimeController) list(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"runtimes": c.supervisor.Statuses()})
}

func (c *runtimeController) start(w http.ResponseWriter, r *http.Request) {
	spec, ok := c.spec(w, r)
	if !ok {
		return
	}
	status, err := c.supervisor.Start(spec)
	if err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (c *runtimeController) stop(w http.ResponseWriter, r *http.Request) {
	id, ok := artifactID(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	status, err := c.supervisor.Stop(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (c *runtimeController) health(w http.ResponseWriter, r *http.Request) {
	id, ok := artifactID(w, r)
	if !ok {
		return
	}
	status, exists := c.supervisor.Status(id)
	if !exists || status.State != artifactruntime.StateRunning {
		if !exists {
			status = artifactruntime.Status{ID: id, State: artifactruntime.StateStopped}
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"healthy": false, "runtime": status})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"healthy": true, "runtime": status})
}

func (c *runtimeController) logs(w http.ResponseWriter, r *http.Request) {
	spec, ok := c.spec(w, r)
	if !ok {
		return
	}
	limit := 64 << 10
	if raw := r.URL.Query().Get("tail_bytes"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 1<<20 {
			writeError(w, http.StatusBadRequest, errors.New("tail_bytes must be an integer from 1 to 1048576"))
			return
		}
		limit = parsed
	}
	raw, err := os.ReadFile(spec.LogPath)
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, http.StatusOK, map[string]any{"logs": "", "truncated": false})
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	truncated := len(raw) > limit
	if truncated {
		raw = raw[len(raw)-limit:]
	}
	writeJSON(w, http.StatusOK, map[string]any{"logs": string(raw), "truncated": truncated})
}

func (c *runtimeController) uninstall(w http.ResponseWriter, r *http.Request) {
	spec, ok := c.spec(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if _, err := c.supervisor.Stop(ctx, spec.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := c.installer.UninstallRoot(r.PathValue("name"), r.PathValue("version")); err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"uninstalled": spec.ID,
		"advisory":    "a continuous provisioner will reinstall the configured desired root on its next reconcile cycle",
	})
}

func (c *runtimeController) spec(w http.ResponseWriter, r *http.Request) (artifactruntime.Spec, bool) {
	name, version := r.PathValue("name"), r.PathValue("version")
	if !validArtifactID(name, version) {
		writeError(w, http.StatusBadRequest, errors.New("invalid artifact name or version"))
		return artifactruntime.Spec{}, false
	}
	spec, err := c.installer.RuntimeSpec(name, version)
	if err != nil {
		writeError(w, http.StatusConflict, err)
		return artifactruntime.Spec{}, false
	}
	return spec, true
}

func artifactID(w http.ResponseWriter, r *http.Request) (string, bool) {
	name, version := r.PathValue("name"), r.PathValue("version")
	if !validArtifactID(name, version) {
		writeError(w, http.StatusBadRequest, errors.New("invalid artifact name or version"))
		return "", false
	}
	return name + "@" + version, true
}

func validArtifactID(name, version string) bool {
	return artifactNameRe.MatchString(name) && artifactVersionRe.MatchString(version)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": strings.TrimSpace(err.Error())})
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
