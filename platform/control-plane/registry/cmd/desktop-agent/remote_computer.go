package main

import (
	"context"
	"github.com/lumo-harness/platform/registry/internal/computerbridge"
	"net/http"
)

func computerBridgeOptions(o options) computerbridge.Options {
	return computerbridge.Options{HostFile: o.computerHostFile, StateDir: o.stateDir, Realm: o.realm, NodeID: o.nodeID, Gateway: o.gateway}
}
func deliverComputerCommand(ctx context.Context, o options, cmd command) error {
	return computerbridge.Deliver(ctx, computerBridgeOptions(o), computerbridge.Command{Action: cmd.Action, Body: cmd.Body})
}
func startComputerLeaseBridge(ctx context.Context, o options, client *http.Client) (func(), error) {
	return computerbridge.Start(ctx, computerBridgeOptions(o), client)
}
