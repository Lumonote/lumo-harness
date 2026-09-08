#!/usr/bin/env bash
# Shared by up.sh and build.sh: make sure the read-only DSH source exists.
#
# Semantics both callers depend on and that must never diverge:
#   - an existing directory is used as-is and is NEVER fetched, pulled, reset
#     or checked out — it may be a developer's checkout (第一铁律);
#   - only an absent directory is bootstrapped, by a shallow clone of the
#     upstream default branch;
#   - a directory that exists but is not a usable source tree is an error,
#     never overwritten.
#
# Usage (from a bash script with `set -euo pipefail`):
#   source "$repo_root/platform/deploy/lib/dsh-source.sh"
#   ensure_dsh_source "$repo_root/deepseek-harness"
#
# Env: DSH_REPOSITORY overrides the clone URL.

ensure_dsh_source() {
  local dsh_root="$1"
  local dsh_repo="${DSH_REPOSITORY:-https://github.com/deepseek-ai/deepseek-harness.git}"

  if [[ -e "$dsh_root" ]]; then
    if [[ -f "$dsh_root/package.json" && -d "$dsh_root/packages" ]]; then
      echo "deepseek-harness exists; using it unchanged: $dsh_root"
      return
    fi
    echo "deepseek-harness exists but is not a usable source checkout: $dsh_root" >&2
    echo "Refusing to overwrite it. Repair or remove that directory, then retry." >&2
    exit 1
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to retrieve deepseek-harness but was not found in PATH" >&2
    exit 127
  fi

  echo "deepseek-harness is absent; cloning latest default branch from $dsh_repo ..."
  git clone --depth 1 "$dsh_repo" "$dsh_root"
  if [[ ! -f "$dsh_root/package.json" || ! -d "$dsh_root/packages" ]]; then
    echo "cloned deepseek-harness is missing expected source files: $dsh_root" >&2
    exit 1
  fi
}
