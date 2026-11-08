import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const retryDelays = [5_000, 15_000]

export function isRetryableBundleDownload(output) {
  const plain = stripVTControlCharacters(output)
  // Only Tauri's download failure is retryable. A compiler, hash verification
  // or makensis failure must retain its original failure and exit status.
  return /\bDownloading\s+https:\/\//i.test(plain)
    && /failed to bundle project:\s*`?http status:\s*(?:408|429|500|502|503|504)\b/i.test(plain)
}

function runCargo(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('cargo', args, {
      cwd: desktopRoot,
      env: { ...process.env, LUMO_DESKTOP_TARGET: 'win-x64' },
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
    })
    let output = ''
    for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      source.setEncoding('utf8')
      source.on('data', chunk => {
        destination.write(chunk)
        output = (output + chunk).slice(-128 * 1024)
      })
    }
    child.once('error', reject)
    child.once('close', (code, signal) => resolveResult({ code, signal, output }))
  })
}

export async function buildWindows({ run = runCargo, wait = delay, log = console.warn } = {}) {
  // Preserve beforeBuildCommand/runtime preparation, but never repeat it when
  // a tool download fails after Rust compilation has already succeeded.
  const build = await run(['tauri', 'build', '--no-bundle'])
  if (build.code !== 0 || build.signal) return build

  for (let attempt = 0; ; attempt++) {
    const bundle = await run(['tauri', 'bundle', '--bundles', 'nsis'])
    if (bundle.code === 0 || bundle.signal || attempt >= retryDelays.length
      || !isRetryableBundleDownload(bundle.output)) return bundle
    const milliseconds = retryDelays[attempt]
    log(`NSIS 工具下载暂时失败，${milliseconds / 1000} 秒后重试打包（${attempt + 2}/${retryDelays.length + 1}），复用已编译产物。`)
    await wait(milliseconds)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('Windows NSIS 安装包需要在 Windows x64 构建机上生成')
    }
    const result = await buildWindows()
    process.exitCode = result.code ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
