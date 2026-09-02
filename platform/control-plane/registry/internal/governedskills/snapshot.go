// Package governedskills converts Governance's reviewed source projection into
// one ordinary Registry Skill artifact. Keeping this compiler in the Registry
// module lets it reuse the exact Bundle and manifest validators used by every
// other artifact; it does not create a second, weaker package format.
package governedskills

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/lumo-harness/platform/registry/internal/bundle"
	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
)

const maxSnapshotBytes = 32 << 20

var skillName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// Source is one Governance revision already selected by its published pointer.
// Digest is the source database's SHA-256 projection, which this compiler
// recomputes before a Registry Bundle is produced.
type Source struct {
	SkillID string `json:"skill_id"`
	Name    string `json:"name"`
	Version string `json:"version"`
	Digest  string `json:"digest"`
	Content string `json:"content"`
}

// Snapshot is the exact API document returned by Governance. It contains only
// released revisions, never drafts or an installed-node claim.
type Snapshot struct {
	Realm  string   `json:"realm"`
	Skills []Source `json:"skills"`
}

type FetchConfig struct {
	GovernanceURL string
	Token         string
	Realm         string
	UserID        string
	Roles         string
	Client        *http.Client
}

// Fetch reads the privileged Governance build input. The caller identity is
// explicit and must be a realm administrator at Governance; the Registry token
// alone never becomes an authorization substitute for source access.
func Fetch(ctx context.Context, cfg FetchConfig) (Snapshot, error) {
	if strings.TrimSpace(cfg.Token) == "" || strings.TrimSpace(cfg.Realm) == "" || strings.TrimSpace(cfg.UserID) == "" {
		return Snapshot{}, errors.New("governed skills: token, realm, and user ID are required")
	}
	base, err := url.Parse(cfg.GovernanceURL)
	if err != nil || base.Scheme == "" || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return Snapshot{}, errors.New("governed skills: governance URL must be an absolute http(s) URL without credentials, query, or fragment")
	}
	client := cfg.Client
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("governed skills: Governance redirects are disabled")
		}}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base.String(), "/")+"/v1/skills/runtime-snapshot", nil)
	if err != nil {
		return Snapshot{}, err
	}
	request.Header.Set("Authorization", "Bearer "+cfg.Token)
	request.Header.Set("X-Lumo-Realm", cfg.Realm)
	request.Header.Set("X-Lumo-User", cfg.UserID)
	request.Header.Set("X-Lumo-Roles", cfg.Roles)
	response, err := client.Do(request)
	if err != nil {
		return Snapshot{}, fmt.Errorf("governed skills: fetch Governance snapshot: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxSnapshotBytes+1))
	if err != nil {
		return Snapshot{}, fmt.Errorf("governed skills: read Governance snapshot: %w", err)
	}
	if len(raw) > maxSnapshotBytes {
		return Snapshot{}, fmt.Errorf("governed skills: Governance snapshot exceeds %d bytes", maxSnapshotBytes)
	}
	if response.StatusCode != http.StatusOK {
		return Snapshot{}, fmt.Errorf("governed skills: Governance returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(raw)))
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var snapshot Snapshot
	if err := decoder.Decode(&snapshot); err != nil {
		return Snapshot{}, fmt.Errorf("governed skills: decode Governance snapshot: %w", err)
	}
	if err := requireEOF(decoder); err != nil {
		return Snapshot{}, err
	}
	if snapshot.Realm != cfg.Realm {
		return Snapshot{}, errors.New("governed skills: Governance snapshot realm does not match request")
	}
	return snapshot, nil
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("governed skills: Governance snapshot has extra JSON values")
		}
		return fmt.Errorf("governed skills: decode trailing Governance snapshot data: %w", err)
	}
	return nil
}

type BuildConfig struct {
	ArtifactName    string
	ArtifactVersion string
	Publisher       string
	Scopes          []string
}

type BuildResult struct {
	Manifest []byte
	Bundle   []byte
}

// Build makes an ordinary signed-artifact input. A metadata entry is always
// included, so even an empty published catalog can be released as a real
// Bundle; Provisioner then atomically replaces a previous non-empty local
// snapshot with the empty one instead of retaining withdrawn skills.
func Build(snapshot Snapshot, cfg BuildConfig) (BuildResult, error) {
	if strings.TrimSpace(snapshot.Realm) == "" {
		return BuildResult{}, errors.New("governed skills: snapshot realm is required")
	}
	entries := make([]Source, len(snapshot.Skills))
	copy(entries, snapshot.Skills)
	sort.Slice(entries, func(left, right int) bool {
		if entries[left].Name == entries[right].Name {
			return entries[left].SkillID < entries[right].SkillID
		}
		return entries[left].Name < entries[right].Name
	})
	seenNames := map[string]struct{}{}
	for _, source := range entries {
		if _, exists := seenNames[source.Name]; exists {
			return BuildResult{}, fmt.Errorf("governed skills: duplicate published skill name %q", source.Name)
		}
		seenNames[source.Name] = struct{}{}
		if err := validateSource(source); err != nil {
			return BuildResult{}, err
		}
	}

	metadata, err := json.Marshal(struct {
		Realm  string `json:"realm"`
		Skills []struct {
			SkillID string `json:"skill_id"`
			Name    string `json:"name"`
			Version string `json:"version"`
			Digest  string `json:"digest"`
		} `json:"skills"`
	}{
		Realm:  snapshot.Realm,
		Skills: sourceMetadata(entries),
	})
	if err != nil {
		return BuildResult{}, fmt.Errorf("governed skills: encode snapshot metadata: %w", err)
	}
	bundleEntries := []bundle.Entry{{
		Path: "metadata/governed-skill-snapshot.json", Encoding: "utf8", SHA256: objstore.Digest(metadata), Data: string(metadata),
	}}
	for _, source := range entries {
		bundleEntries = append(bundleEntries, bundle.Entry{
			Path: "skills/" + source.Name + "/SKILL.md", Encoding: "utf8", SHA256: source.Digest, Data: source.Content,
		})
	}
	bundleRaw, _, err := bundle.Create(bundle.Header{SchemaVersion: bundle.SchemaVersion, Bundle: cfg.ArtifactName, Version: cfg.ArtifactVersion}, nil, bundleEntries)
	if err != nil {
		return BuildResult{}, fmt.Errorf("governed skills: create Bundle: %w", err)
	}
	manifestRaw, err := json.Marshal(struct {
		APIVersion    string        `json:"apiVersion"`
		Kind          manifest.Kind `json:"kind"`
		Name          string        `json:"name"`
		Version       string        `json:"version"`
		Publisher     string        `json:"publisher"`
		Scopes        []string      `json:"scopes"`
		PayloadDigest string        `json:"payload_digest"`
	}{
		APIVersion: manifest.APIVersion, Kind: manifest.KindSkill, Name: cfg.ArtifactName, Version: cfg.ArtifactVersion,
		Publisher: cfg.Publisher, Scopes: normalizedScopes(cfg.Scopes), PayloadDigest: objstore.Digest(bundleRaw),
	})
	if err != nil {
		return BuildResult{}, fmt.Errorf("governed skills: encode manifest: %w", err)
	}
	if _, err := manifest.Parse(manifestRaw); err != nil {
		return BuildResult{}, fmt.Errorf("governed skills: generated manifest is invalid: %w", err)
	}
	return BuildResult{Manifest: manifestRaw, Bundle: bundleRaw}, nil
}

func sourceMetadata(sources []Source) []struct {
	SkillID string `json:"skill_id"`
	Name    string `json:"name"`
	Version string `json:"version"`
	Digest  string `json:"digest"`
} {
	result := make([]struct {
		SkillID string `json:"skill_id"`
		Name    string `json:"name"`
		Version string `json:"version"`
		Digest  string `json:"digest"`
	}, 0, len(sources))
	for _, source := range sources {
		result = append(result, struct {
			SkillID string `json:"skill_id"`
			Name    string `json:"name"`
			Version string `json:"version"`
			Digest  string `json:"digest"`
		}{SkillID: source.SkillID, Name: source.Name, Version: source.Version, Digest: source.Digest})
	}
	return result
}

func normalizedScopes(scopes []string) []string {
	result := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		if scope = strings.TrimSpace(scope); scope != "" {
			result = append(result, scope)
		}
	}
	sort.Strings(result)
	return result
}

func validateSource(source Source) error {
	if source.SkillID == "" || source.Version == "" || !skillName.MatchString(source.Name) {
		return fmt.Errorf("governed skills: invalid published skill identity %q", source.Name)
	}
	if len(source.Content) == 0 || len(source.Content) > 128<<10 || source.Digest != objstore.Digest([]byte(source.Content)) {
		return fmt.Errorf("governed skills: published skill %q content digest mismatch", source.Name)
	}
	if !strings.HasPrefix(source.Content, "---\n") {
		return fmt.Errorf("governed skills: published skill %q lacks frontmatter", source.Name)
	}
	closing := strings.Index(source.Content[4:], "\n---\n")
	if closing < 0 {
		return fmt.Errorf("governed skills: published skill %q has unterminated frontmatter", source.Name)
	}
	fields := map[string]string{}
	for _, line := range strings.Split(source.Content[4:closing+4], "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			fields[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), "\"'")
		}
	}
	if fields["name"] != source.Name || strings.TrimSpace(fields["description"]) == "" {
		return fmt.Errorf("governed skills: published skill %q frontmatter does not match its identity", source.Name)
	}
	for _, key := range []string{"model_invocable", "user_invocable"} {
		if value, exists := fields[key]; exists && value != "true" && value != "false" {
			return fmt.Errorf("governed skills: published skill %q has invalid %s", source.Name, key)
		}
	}
	return nil
}
