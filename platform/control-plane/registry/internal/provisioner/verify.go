package provisioner

import (
	"context"
	"errors"
	"fmt"

	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/plan"
	"github.com/lumo-harness/platform/registry/internal/resolve"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

// Reload the local trust file on every reconciliation, including cache hits.
// Neither a gateway response nor an old installation can restore a revoked key.
func (i *Installer) verifyPlan(ctx context.Context, p *plan.Plan, name, version string, shape plan.Shape) (*plan.Plan, error) {
	if p.Root != name+"@"+version || len(p.Items) == 0 || len(p.Items) > 200 {
		return nil, errors.New("provisioner: invalid plan root or closure size")
	}
	if i.PinnedDigests != nil && len(i.PinnedDigests) != len(p.Items) {
		return nil, errors.New("provisioner: approved closure does not match plan")
	}
	keys, err := trust.LoadFile(i.TrustFile)
	if err != nil {
		return nil, err
	}
	nodes := map[string]resolve.Node{}
	blobs := verifiedBlobs{}
	total := 0
	for _, item := range p.Items {
		if i.PinnedDigests != nil && i.PinnedDigests[item.Name+"@"+item.Version] != item.Digest {
			return nil, errors.New("provisioner: artifact differs from approved digest")
		}
		if !validRuntimeArtifactID(item.Name, item.Version) || !objstore.ValidDigest(item.Digest) {
			return nil, errors.New("provisioner: invalid artifact identity")
		}
		if _, exists := nodes[item.Name]; exists {
			return nil, errors.New("provisioner: duplicate artifact name")
		}
		raw, err := i.fetchBlob(ctx, item.Digest)
		if err != nil {
			return nil, err
		}
		total += len(raw)
		if total > 16<<20 || digest(raw) != item.Digest {
			return nil, errors.New("provisioner: invalid manifest bytes")
		}
		m, err := manifest.Parse(raw)
		if err != nil {
			return nil, err
		}
		if m.Name != item.Name || m.Version != item.Version {
			return nil, plan.ErrIdentityMismatch
		}
		if err := keys.Verify(m.Publisher, raw, item.Signature); err != nil {
			return nil, err
		}
		nodes[m.Name] = resolve.Node{Name: m.Name, Version: m.Version, Digest: item.Digest, Sig: item.Signature, Deps: m.Deps}
		blobs[item.Digest] = raw
	}
	closure, err := resolve.Closure(ctx, manifest.Dep{Name: name, Version: version}, func(_ context.Context, name, version string) (*resolve.Node, error) {
		node, exists := nodes[name]
		if !exists || node.Version != version {
			return nil, resolve.ErrMissing
		}
		return &node, nil
	})
	if err != nil {
		return nil, err
	}
	if len(closure) != len(nodes) {
		return nil, errors.New("provisioner: unreferenced artifacts in plan")
	}
	// Rebuild scopes, shape constraints and dependency order from signed bytes.
	return plan.Build(ctx, closure, shape, blobs, keys)
}

type verifiedBlobs map[string][]byte

func (b verifiedBlobs) Get(_ context.Context, key string) ([]byte, error) {
	raw, ok := b[key]
	if !ok {
		return nil, objstore.ErrNotFound
	}
	return raw, nil
}
func (b verifiedBlobs) Has(_ context.Context, key string) (bool, error) {
	_, ok := b[key]
	return ok, nil
}
func (b verifiedBlobs) Put(context.Context, string, []byte) error {
	return fmt.Errorf("provisioner: verification cache is read-only")
}
