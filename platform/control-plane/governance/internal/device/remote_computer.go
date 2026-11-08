package device

import (
	"context"
	"encoding/json"
	"github.com/lumo-harness/platform/governance/internal/store"
	"io"
	"net/http"
)

// Configured once before Serve. The current team service and policy are checked
// before every approval/action, in addition to the store's transaction fences.
type RemoteComputerAuthorizer func(context.Context, store.RemoteComputerRequest) error

func (g *Gateway) SetRemoteComputerAuthorizer(authorize RemoteComputerAuthorizer) {
	g.remoteComputer = authorize
}
func (g *Gateway) remoteComputerLease(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" || g.remoteComputer == nil {
		denied(w)
		return
	}
	d, err := g.identity(r)
	if err != nil {
		denied(w)
		return
	}
	request, err := g.options.Store.RemoteComputerRequest(r.Context(), d.Realm, r.PathValue("requestID"))
	if err != nil || request.Plan.NodeID != d.NodeID || request.Plan.Owner != d.Owner {
		denied(w)
		return
	}
	var input store.RemoteComputerLeaseInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		respond(w, 400, map[string]string{"error": "invalid_request"})
		return
	}
	if input.Phase == "approve" || input.Phase == "check" {
		if err = g.remoteComputer(r.Context(), request); err != nil {
			denied(w)
			return
		}
	}
	out, err := g.options.Store.RemoteComputerLease(r.Context(), d.Realm, d.NodeID, d.ConnectionID, request.RequestID, input)
	if err != nil {
		respond(w, http.StatusConflict, map[string]string{"error": "remote_computer_lease_refused"})
		return
	}
	respond(w, http.StatusOK, out)
}
