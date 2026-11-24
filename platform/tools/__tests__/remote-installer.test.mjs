// 远端安装脚本的静态契约测试（不执行 ssh）：幂等/锁/回滚/校验关键点存在，且是 POSIX sh。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../remote/lumo-remote.sh', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../remote/lumo-node.sh', import.meta.url), 'utf8')

test('posix shebang and strict mode', () => {
  for (const s of [src, entry]) {
    assert.match(s, /^#!\/bin\/sh\n/)
    assert.match(s, /\nset -eu\n/)
    assert.doesNotMatch(s, /\[\[|\bfunction\b|\$\{[A-Z_]+\/\/|\blocal\b|<\(/)
  }
})
test('idempotent, locked, atomic switch, rollback', () => {
  for (const needle of ['result=already-installed', 'mkdir "$ROOT/.lock"', 'ln -sfn', 'swap_link previous', 'do_rollback', 'self check failed', 'result=rolled-back']) assert.ok(src.includes(needle), needle)
})
test('dsh pin and https-only bundle with checksum', () => {
  assert.match(src, /\^\[0-9a-f\]\{40\}\$/)
  assert.ok(src.includes("--proto '=https'"))
  assert.ok(src.includes('bundle checksum mismatch'))
})
test('versioned bundle name, SHA256SUMS fail-closed, optional signature', () => {
  assert.ok(src.includes('lumo-server-$VERSION-$(host_os)-$(host_arch).tar.gz'))
  assert.ok(src.includes('$base/SHA256SUMS'))
  assert.ok(src.includes('no trusted sha256 for bundle'))
  assert.ok(src.includes('openssl dgst -sha256 -verify'))
  assert.ok(src.includes('sha256_check "$1" files.sha256'))
  assert.ok(src.includes("grep -Eq '^/|(^|/)\\.\\.(/|$)'"), 'reject unsafe tar members')
})
test('offline scp push via incoming directory', () => {
  assert.ok(src.includes('"$ROOT/incoming/$name"'))
  assert.ok(src.includes('"$ROOT/incoming/$name.sha256"'))
})
test('systemd unit, nohup fallback and health check with rollback', () => {
  for (const needle of ['ExecStart=$ROOT/current/bin/lumo-node run', 'Restart=on-failure', 'EnvironmentFile=-$ROOT/lumo.env', 'systemctl --user', 'daemon-reload', 'nohup "$ROOT/current/bin/lumo-node" run', '--healthcheck', 'health || ok=0', 'swap_link current "$old"; svc_start']) assert.ok(src.includes(needle), needle)
  assert.ok(entry.includes('--healthcheck'))
  assert.ok(entry.includes('LUMO_WEB_PORT:-7420'))
  assert.ok(entry.includes('exec "$node_bin"'))
})
