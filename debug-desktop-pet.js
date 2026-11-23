#!/usr/bin/env node
/**
 * 桌宠服务诊断脚本
 *
 * 检查 workspaces 和 sessions 服务的就绪状态
 */

console.log('=== 桌宠服务诊断 ===\n')

// 检查是否在桌面环境中
if (typeof window !== 'undefined' && window.__LUMO_DESKTOP__) {
  console.log('✓ 检测到桌面环境')

  // 尝试获取桌宠服务
  const services = window[Symbol.for('@lumo/desktop-pet/services')]

  if (!services) {
    console.error('✗ 桌宠服务状态未初始化')
    process.exit(1)
  }

  const current = services.current
  if (!current) {
    console.error('✗ 桌宠服务未挂载')
    process.exit(1)
  }

  console.log('✓ 桌宠服务已挂载\n')

  // 检查 workspaces 服务
  console.log('--- Workspaces 服务 ---')
  if (!current.workspaces) {
    console.error('✗ workspaces 服务不存在')
  } else {
    const wsSnapshot = current.workspaces.list.getSnapshot()
    console.log(`  phase: ${wsSnapshot.phase}`)
    console.log(`  items: ${wsSnapshot.items?.length ?? 0}`)
    if (wsSnapshot.phase !== 'ready') {
      console.error(`  ✗ 工作空间未就绪 (phase="${wsSnapshot.phase}")`)
    } else {
      console.log('  ✓ 工作空间已就绪')
    }
  }

  // 检查 sessions 服务
  console.log('\n--- Sessions 服务 ---')
  if (!current.sessions) {
    console.error('✗ sessions 服务不存在')
  } else {
    const sessSnapshot = current.sessions.list.getSnapshot()
    console.log(`  phase: ${sessSnapshot.phase}`)
    console.log(`  byId keys: ${Object.keys(sessSnapshot.byId ?? {}).length}`)
    if (sessSnapshot.phase !== 'ready') {
      console.error(`  ✗ 会话列表未就绪 (phase="${sessSnapshot.phase}")`)
    } else {
      console.log('  ✓ 会话列表已就绪')
    }
  }

  // 检查其他必需服务
  console.log('\n--- 其他服务 ---')
  const required = ['conversation', 'uiWorkspace', 'layout']
  for (const name of required) {
    if (!current[name]) {
      console.error(`✗ ${name} 服务不存在`)
    } else {
      console.log(`✓ ${name} 服务存在`)
    }
  }

  // 检查可选的 fileUpload 服务
  if (current.fileUpload) {
    console.log('✓ fileUpload 服务存在 (可选)')
  } else {
    console.log('- fileUpload 服务不存在 (可选,不影响纯文本发送)')
  }

} else {
  console.error('✗ 非桌面环境或 __LUMO_DESKTOP__ 标记缺失')
  console.log('\n提示：此脚本需要在 Tauri 桌面应用的 WebView 中运行')
  console.log('请在浏览器开发者工具的 Console 中执行此诊断逻辑')
}
