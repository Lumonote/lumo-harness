/** Only curated vendor packages/installers can be executed by the local manager. */
export interface CliRecipe {
  engineId: string
  method: 'npm' | 'trae'
  packageName?: string
  binary: string
  companions?: string[]
  minimumSpace: number
}

const npm = (engineId: string, packageName: string, binary: string, companions?: string[]): CliRecipe => ({
  engineId, method: 'npm', packageName, binary, ...(companions ? { companions } : {}), minimumSpace: 1024 ** 3,
})
export const CLI_RECIPES: readonly CliRecipe[] = [
  npm('codex', '@openai/codex', 'codex'),
  npm('claude-code', '@agentclientprotocol/claude-agent-acp', 'claude-agent-acp', ['@anthropic-ai/claude-code']),
  npm('codex-acp', '@zed-industries/codex-acp', 'codex-acp'),
  npm('gemini', '@google/gemini-cli', 'gemini'),
  npm('codebuddy', '@tencent-ai/codebuddy-code', 'codebuddy'),
  npm('github-copilot', '@github/copilot', 'copilot'),
  npm('opencode', 'opencode-ai', 'opencode'),
  npm('qwen-code', '@qwen-code/qwen-code', 'qwen'),
  { engineId: 'trae', method: 'trae', binary: 'traecli', minimumSpace: 2 * 1024 ** 3 },
]
export const CLI_VERSION = /^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u
export const RELEASE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
export const TRAE_INSTALLER = 'https://trae.cn/trae-cli/install_v2.sh'
export const NPM_REGISTRY = 'https://registry.npmjs.org'

export type CliJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface CliInstallation { releaseId: string; version: string; installedAt: string }
export interface CliInstallJob {
  id: string; action: 'install' | 'reinstall'; requestedVersion: string; status: CliJobStatus
  stage: string; startedAt: string; finishedAt?: string; log: string; error?: string
}
export interface CliToolView {
  engineId: string; supported: boolean; reason?: string; source: string
  directory: string; executable?: string; installation?: CliInstallation; job?: CliInstallJob
}
