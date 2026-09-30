package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"
)

const pidFile = "/tmp/lumo-control-plane-bundle-pids.json"

type service struct {
	name     string
	instance string
	port     string
	portKey  string
}

type child struct {
	service service
	cmd     *exec.Cmd
	done    chan error
}

type exitEvent struct {
	child *child
	err   error
}

var apiServices = []service{
	{name: "connector-gateway", instance: "connector-gateway-0", port: "8082"},
	{name: "edge-gateway", instance: "edge-gateway-0", port: "8080"},
	{name: "flows", instance: "flows-0", port: "8087"},
	{name: "governance", instance: "governance-0", port: "8089"},
	{name: "llm-gateway", instance: "llm-gateway-0", port: "8088"},
	{name: "projects", instance: "projects-0", port: "8086"},
	{name: "registry", instance: "registry-0", port: "8084", portKey: "REGISTRY_PORT"},
	{name: "session-control", instance: "session-control-0", port: "8092"},
	{name: "terminal-gateway", instance: "terminal-gateway-0", port: "8090"},
	{name: "usage-ledger", instance: "usage-ledger-0", port: "8085"},
}

func withServices(base []service, extra ...service) []service {
	result := append([]service(nil), base...)
	return append(result, extra...)
}

var bundles = map[string][]service{
	"api": apiServices,
	"platform-standalone": withServices(apiServices,
		service{name: "scheduler", instance: "scheduler-0", port: "8083"},
		service{name: "collaborator", instance: "collaborator-0", port: "8081"},
	),
	"platform-cluster": withServices(apiServices,
		service{name: "scheduler", instance: "scheduler-0", port: "8083"},
		service{name: "collaborator", instance: "collaborator-0", port: "8081"},
	),
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(os.Args[2]))
	}
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: lumo-control-plane-bundle {api|platform-standalone|platform-cluster}")
		os.Exit(64)
	}
	os.Exit(run(os.Args[1]))
}

func run(kind string) int {
	specs, ok := bundles[kind]
	if !ok {
		fmt.Fprintf(os.Stderr, "control-plane-bundle: unknown bundle %q\n", kind)
		return 64
	}
	_ = os.Remove(pidFile)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	exits := make(chan exitEvent, len(specs))
	children := make([]*child, 0, len(specs))

	for _, spec := range specs {
		cmd := exec.Command("/usr/local/bin/"+spec.name, os.Args[2:]...)
		cmd.Env = childEnvironment(kind, spec)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "control-plane-bundle: start %s: %v\n", spec.instance, err)
			stopChildren(children)
			return 1
		}
		c := &child{service: spec, cmd: cmd, done: make(chan error, 1)}
		children = append(children, c)
		go func(c *child) {
			err := c.cmd.Wait()
			c.done <- err
			close(c.done)
			exits <- exitEvent{child: c, err: err}
		}(c)
	}

	readyDeadline := time.Now().Add(180 * time.Second)
	for !allHealthy(specs) {
		if time.Now().After(readyDeadline) {
			fmt.Fprintln(os.Stderr, "control-plane-bundle: timed out waiting for service health")
			stopChildren(children)
			return 1
		}
		select {
		case event := <-exits:
			fmt.Fprintf(os.Stderr, "control-plane-bundle: %s exited during startup: %v\n", event.child.service.instance, event.err)
			stopChildren(children)
			return 1
		case sig := <-signals:
			fmt.Fprintf(os.Stderr, "control-plane-bundle: received %s during startup\n", sig)
			stopChildren(children)
			return 0
		case <-time.After(500 * time.Millisecond):
		}
	}

	pids := make([]int, 0, len(children))
	for _, c := range children {
		pids = append(pids, c.cmd.Process.Pid)
	}
	encoded, _ := json.Marshal(pids)
	if err := os.WriteFile(pidFile, encoded, 0600); err != nil {
		fmt.Fprintf(os.Stderr, "control-plane-bundle: write pid file: %v\n", err)
		stopChildren(children)
		return 1
	}
	defer os.Remove(pidFile)
	fmt.Fprintf(os.Stdout, "control-plane-bundle: %s ready with %d processes\n", kind, len(children))

	monitor := time.NewTicker(10 * time.Second)
	defer monitor.Stop()
	consecutiveHealthFailures := 0
	for {
		select {
		case event := <-exits:
			fmt.Fprintf(os.Stderr, "control-plane-bundle: %s exited: %v\n", event.child.service.instance, event.err)
			stopChildren(children)
			return exitCode(event.err)
		case sig := <-signals:
			fmt.Fprintf(os.Stdout, "control-plane-bundle: received %s, stopping children\n", sig)
			stopChildren(children)
			return 0
		case <-monitor.C:
			if allHealthy(specs) {
				consecutiveHealthFailures = 0
				continue
			}
			consecutiveHealthFailures++
			if consecutiveHealthFailures >= 3 {
				fmt.Fprintln(os.Stderr, "control-plane-bundle: health failed three times; stopping bundle")
				stopChildren(children)
				return 1
			}
		}
	}
}

func childEnvironment(kind string, spec service) []string {
	module := strings.ToUpper(strings.ReplaceAll(spec.name, "-", "_"))
	instance := strings.ToUpper(strings.ReplaceAll(spec.instance, "-", "_"))
	values := map[string]string{}
	instancePrefix := "LUMO_BUNDLE_" + instance + "_"
	modulePrefix := "LUMO_BUNDLE_" + module + "_"
	for _, prefix := range []string{
		"LUMO_BUNDLE_COMMON_",
		modulePrefix,
		instancePrefix,
	} {
		for _, entry := range os.Environ() {
			key, value, ok := strings.Cut(entry, "=")
			// Instance-prefixed keys also start with the module prefix for numbered
			// services such as collaborator-0. Keep only the longest matching key.
			if prefix == modulePrefix && strings.HasPrefix(key, instancePrefix) {
				continue
			}
			if ok && strings.HasPrefix(key, prefix) {
				values[strings.TrimPrefix(key, prefix)] = value
			}
		}
	}
	values["LUMO_INSTANCE"] = spec.instance
	if spec.portKey == "" {
		values["LUMO_LISTEN"] = ":" + spec.port
	} else {
		values[spec.portKey] = spec.port
	}

	// Bundle-only configuration must not leak into child processes. API bundle
	// children receive only their prefixed configuration. Scheduler and
	// Collaborator children inherit their normal service environment, then apply
	// instance-specific overrides (for example distinct listener and Nacos ports).
	base := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || strings.HasPrefix(key, "LUMO_BUNDLE_") {
			continue
		}
		if isAPIModule(spec.name) && (strings.HasPrefix(key, "LUMO_") || strings.HasPrefix(key, "REGISTRY_")) && key != "LUMO_YRS_KERNEL" {
			continue
		}
		base[key] = value
	}
	for key, value := range values {
		base[key] = value
	}
	keys := make([]string, 0, len(base))
	for key := range base {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+base[key])
	}
	return out
}

func isAPIModule(name string) bool {
	for _, spec := range apiServices {
		if spec.name == name {
			return true
		}
	}
	return false
}

func healthcheck(kind string) int {
	specs, ok := bundles[kind]
	if !ok {
		fmt.Fprintf(os.Stderr, "control-plane-bundle: unknown healthcheck bundle %q\n", kind)
		return 64
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return 1
	}
	var pids []int
	if json.Unmarshal(data, &pids) != nil || len(pids) != len(specs) {
		return 1
	}
	for _, pid := range pids {
		if err := syscall.Kill(pid, 0); err != nil {
			return 1
		}
	}
	if !allHealthy(specs) {
		return 1
	}
	return 0
}

func allHealthy(specs []service) bool {
	results := make(chan bool, len(specs))
	for _, spec := range specs {
		go func(port string) { results <- serviceHealthy(port) }(spec.port)
	}
	for range specs {
		if !<-results {
			return false
		}
	}
	return true
}

func serviceHealthy(port string) bool {
	client := &http.Client{
		Timeout:   1500 * time.Millisecond,
		Transport: &http.Transport{Proxy: nil},
	}
	response, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode >= 200 && response.StatusCode < 300
}

func stopChildren(children []*child) {
	for _, c := range children {
		if !finished(c) && c.cmd.Process != nil {
			_ = c.cmd.Process.Signal(syscall.SIGTERM)
		}
	}
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for _, c := range children {
		if finished(c) {
			continue
		}
		select {
		case <-c.done:
		case <-timer.C:
			for _, pending := range children {
				if !finished(pending) && pending.cmd.Process != nil {
					_ = pending.cmd.Process.Kill()
				}
			}
			for _, pending := range children {
				<-pending.done
			}
			return
		}
	}
}

func finished(c *child) bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func exitCode(err error) int {
	if err == nil {
		return 1
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() != 0 {
		return exitErr.ExitCode()
	}
	return 1
}
