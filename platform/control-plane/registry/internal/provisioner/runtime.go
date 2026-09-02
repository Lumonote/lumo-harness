package provisioner

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/lumo-harness/platform/registry/internal/artifactruntime"
	"github.com/lumo-harness/platform/registry/internal/manifest"
)

var (
	runtimeArtifactNameRe    = regexp.MustCompile(`^[a-z][a-z0-9-]{2,63}$`)
	runtimeArtifactVersionRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

// RuntimeSpec returns an execution request only after revalidating the
// installed manifest against the atomically written install state and payload.
// A local operator cannot substitute an arbitrary file path through this API:
// name/version select an already-installed item, and the signed manifest selects
// the entrypoint inside its own verified payload.
func (i *Installer) RuntimeSpec(name, version string) (artifactruntime.Spec, error) {
	if !validRuntimeArtifactID(name, version) {
		return artifactruntime.Spec{}, errors.New("provisioner: runtime 制品名或版本格式非法")
	}
	state, err := i.installedState()
	if err != nil {
		return artifactruntime.Spec{}, err
	}
	var item *Item
	for index := range state.Installed {
		if state.Installed[index].Name == name && state.Installed[index].Version == version {
			item = &state.Installed[index]
			break
		}
	}
	if item == nil {
		return artifactruntime.Spec{}, errors.New("provisioner: 指定制品尚未安装")
	}
	dir := filepath.Join(i.InstallDir, name, version)
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return artifactruntime.Spec{}, fmt.Errorf("provisioner: 读取已安装 manifest 失败: %w", err)
	}
	if digest(raw) != item.Digest {
		return artifactruntime.Spec{}, errors.New("provisioner: 已安装 manifest digest 不匹配")
	}
	m, err := manifest.Parse(raw)
	if err != nil {
		return artifactruntime.Spec{}, fmt.Errorf("provisioner: 已安装 manifest 非法: %w", err)
	}
	if m.Name != name || m.Version != version {
		return artifactruntime.Spec{}, errors.New("provisioner: 已安装 manifest 身份不匹配")
	}
	if m.Runtime == nil {
		return artifactruntime.Spec{}, errors.New("provisioner: 制品未声明本地运行时")
	}
	if m.PayloadDigest == "" || m.PayloadDigest != item.PayloadDigest || !i.matchesPayload(dir, m.PayloadDigest) {
		return artifactruntime.Spec{}, errors.New("provisioner: 运行时 payload 未通过完整性校验")
	}
	// A safe relative path is not enough: it must be an entry in the signed
	// bundle. Otherwise a manifest can name a file that was never part of the
	// verified payload and a later local write could turn it into an executable.
	if !i.matchesPayloadEntry(dir, m.PayloadDigest, m.Runtime.Entrypoint) {
		return artifactruntime.Spec{}, errors.New("provisioner: runtime entrypoint is not a verified payload entry")
	}
	payloadDir := filepath.Join(dir, "payload")
	entrypoint := filepath.Join(payloadDir, filepath.FromSlash(m.Runtime.Entrypoint))
	rel, err := filepath.Rel(payloadDir, entrypoint)
	if err != nil || rel == "." || rel == ".." || len(rel) > 3 && rel[:3] == ".."+string(filepath.Separator) {
		return artifactruntime.Spec{}, errors.New("provisioner: runtime entrypoint 越出 payload")
	}
	return artifactruntime.Spec{
		ID:         name + "@" + version,
		Executable: entrypoint,
		Args:       append([]string(nil), m.Runtime.Args...),
		Dir:        payloadDir,
		LogPath:    filepath.Join(i.InstallDir, "runtime-logs", name, version+".log"),
	}, nil
}

// UninstallRoot removes one complete, currently installed closure. It is
// deliberately restricted to the recorded root so a caller cannot remove a
// dependency shared by the active closure. A continuous provisioner will
// reconcile the configured desired root again on its next cycle; callers that
// need a durable removal must clear or replace that desired rollout as well.
func (i *Installer) UninstallRoot(name, version string) error {
	if !validRuntimeArtifactID(name, version) {
		return errors.New("provisioner: runtime 制品名或版本格式非法")
	}
	state, err := i.installedState()
	if err != nil {
		return err
	}
	if state.Root != name+"@"+version {
		return errors.New("provisioner: 只能卸载当前安装闭包的根制品")
	}
	dirs := make([]string, 0, len(state.Installed))
	for _, item := range state.Installed {
		if !validRuntimeArtifactID(item.Name, item.Version) {
			return errors.New("provisioner: 安装状态中含非法制品路径")
		}
		dir := filepath.Join(i.InstallDir, item.Name, item.Version)
		raw, readErr := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if readErr != nil || digest(raw) != item.Digest {
			return errors.New("provisioner: 无法安全卸载完整性不匹配的制品")
		}
		m, parseErr := manifest.Parse(raw)
		if parseErr != nil || m.Name != item.Name || m.Version != item.Version {
			return errors.New("provisioner: 无法安全卸载身份不匹配的制品")
		}
		dirs = append(dirs, dir)
	}
	for _, dir := range dirs {
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("provisioner: 卸载制品失败: %w", err)
		}
	}
	for _, path := range []string{
		filepath.Join(i.InstallDir, installStateFile),
		filepath.Join(i.InstallDir, "skill-snapshot.json"),
		filepath.Join(i.InstallDir, "skills"),
		filepath.Join(i.InstallDir, "runtime-logs", name),
	} {
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("provisioner: 清理卸载状态失败: %w", err)
		}
	}
	return nil
}

func (i *Installer) installedState() (*InstallState, error) {
	raw, err := os.ReadFile(filepath.Join(i.InstallDir, installStateFile))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("provisioner: 尚无已安装制品")
		}
		return nil, fmt.Errorf("provisioner: 读取安装状态失败: %w", err)
	}
	state, err := decodeInstallState(raw)
	if err != nil {
		return nil, fmt.Errorf("provisioner: 安装状态非法: %w", err)
	}
	return state, nil
}

func validRuntimeArtifactID(name, version string) bool {
	return runtimeArtifactNameRe.MatchString(name) && runtimeArtifactVersionRe.MatchString(version)
}
