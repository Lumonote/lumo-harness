import { fileURLToPath } from 'node:url'
import { stageWindowsCua } from '../desktop/windows-cua.mjs'
const packageRoot = fileURLToPath(new URL('../dsh-plugins/computer-use/', import.meta.url))
const result = stageWindowsCua({ packageRoot, targetArch: process.arch })
console.log(JSON.stringify(result))
