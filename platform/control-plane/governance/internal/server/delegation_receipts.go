package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"github.com/lumo-harness/platform/governance/internal/store"
)

func delegationReceipt(r *http.Request, request any) ([]store.DelegationReceipt, error) {
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		return nil, nil
	}
	raw, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(raw)
	receipt := store.DelegationReceipt{Key: key, Hash: hex.EncodeToString(digest[:])}
	if err := receipt.Validate(); err != nil {
		return nil, err
	}
	return []store.DelegationReceipt{receipt}, nil
}
