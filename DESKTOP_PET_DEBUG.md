# 桌宠模式诊断指南

## 问题症状

- 桌宠模式工作空间显示"读取失败"
- 消息无法发送

## 根本原因

`workspaces.list.getSnapshot()` 或 `sessions.list.getSnapshot()` 返回的 `phase` 不是 `'ready'`。

## 诊断步骤

### 1. 打开开发者工具

在桌面应用中按 `Cmd+Option+I` (macOS) 或 `F12` (Windows/Linux) 打开 DevTools。

### 2. 在 Console 中运行诊断代码

```javascript
// 检查桌宠服务状态
(function diagnose() {
  console.log('=== 桌宠服务诊断 ===\n')

  // 检查桌面环境标记
  if (!window.__LUMO_DESKTOP__) {
    console.error('✗ __LUMO_DESKTOP__ 标记缺失')
    return
  }
  console.log('✓ 桌面环境标记存在')

  // 获取服务状态
  const state = window[Symbol.for('@lumo/desktop-pet/services')]
  if (!state) {
    console.error('✗ 桌宠服务状态对象未初始化')
    return
  }

  const services = state.current
  if (!services) {
    console.error('✗ 当前服务未挂载')
    console.log('提示：插件可能尚未加载完成')
    return
  }
  console.log('✓ 服务已挂载\n')

  // 检查 workspaces 服务
  console.log('--- Workspaces 服务 ---')
  if (!services.workspaces) {
    console.error('✗ workspaces 服务不存在')
  } else if (!services.workspaces.list) {
    console.error('✗ workspaces.list 不存在')
  } else {
    try {
      const ws = services.workspaces.list.getSnapshot()
      console.log('phase:', ws.phase)
      console.log('items:', ws.items?.length ?? 0)

      if (ws.phase !== 'ready') {
        console.error('✗ 工作空间未就绪')
        console.log('  可能的 phase 值: "loading", "error", 等')
      } else {
        console.log('✓ 工作空间已就绪')
        console.log('  工作空间列表:', ws.items?.map(w => ({
          id: w.workspaceId,
          title: w.title,
          path: w.path,
          sessions: w.sessionIds.length
        })))
      }
    } catch (err) {
      console.error('✗ 获取工作空间快照失败:', err.message)
    }
  }

  // 检查 sessions 服务
  console.log('\n--- Sessions 服务 ---')
  if (!services.sessions) {
    console.error('✗ sessions 服务不存在')
  } else if (!services.sessions.list) {
    console.error('✗ sessions.list 不存在')
  } else {
    try {
      const sess = services.sessions.list.getSnapshot()
      console.log('phase:', sess.phase)
      console.log('会话数:', Object.keys(sess.byId ?? {}).length)

      if (sess.phase !== 'ready') {
        console.error('✗ 会话列表未就绪')
      } else {
        console.log('✓ 会话列表已就绪')
        const retained = Object.entries(sess.byId ?? {})
          .filter(([_, s]) => s?.retainedBy?.mainView)
        console.log('  当前激活会话:', retained.length > 0 ? retained[0][0] : '无')
      }
    } catch (err) {
      console.error('✗ 获取会话快照失败:', err.message)
    }
  }

  // 检查其他必需服务
  console.log('\n--- 其他必需服务 ---')
  const required = ['conversation', 'uiWorkspace', 'layout']
  for (const name of required) {
    if (!services[name]) {
      console.error(`✗ ${name} 服务缺失`)
    } else {
      console.log(`✓ ${name}`)
    }
  }

  // 检查可选服务
  console.log('\n--- 可选服务 ---')
  if (services.fileUpload) {
    console.log('✓ fileUpload (附件上传)')
  } else {
    console.log('- fileUpload 未加载 (不影响纯文本)')
  }

  // 尝试调用 workspaces() 方法
  console.log('\n--- 测试 workspaces() 方法 ---')
  const bridge = window.__lumoDesktopPet
  if (!bridge) {
    console.error('✗ 桌宠桥未安装')
  } else {
    try {
      const result = bridge.workspaces()
      if (result.error) {
        console.error('✗ 错误:', result.error)
      } else {
        console.log('✓ 成功')
        console.log('  工作空间数:', result.workspaces.length)
        console.log('  已选:', result.selectedWorkspaceId)
      }
    } catch (err) {
      console.error('✗ 调用失败:', err.message)
    }
  }
})()
```

## 常见原因与解决方案

### 原因 1: 插件未完全加载

**症状**: `services.workspaces` 或 `services.sessions` 为 `undefined`

**解决方案**:
1. 检查 `deepseek-harness/packages/client/ui-workspace` 是否正确构建
2. 检查 Cordis 配置中是否启用了 `ui-workspace` 插件
3. 查看控制台是否有插件加载错误

### 原因 2: 快照 store 初始化失败

**症状**: `phase` 显示为 `'loading'` 或 `'error'`

**解决方案**:
1. 检查是否有异步初始化错误（查看 Console 错误日志）
2. 检查是否有网络请求失败（查看 Network 面板）
3. 尝试重启应用

### 原因 3: 服务依赖缺失

**症状**: `getSnapshot()` 抛出异常

**解决方案**:
1. 检查 `platform/dsh-plugins/lumo-ui/src/client/index.tsx:3186` 的依赖注入
2. 确认所有依赖 `['sessions', 'workspaces', 'conversation', 'uiWorkspace', 'layout']` 都已注册

## 修复建议

### 临时修复：添加重试逻辑

如果服务初始化较慢，可以在桥安装时添加等待逻辑：

```typescript
// platform/dsh-plugins/lumo-ui/src/client/index.tsx
ctx.inject(['sessions', 'workspaces', 'conversation', 'uiWorkspace', 'layout'], (desktopCtx) => {
  const services = Object.fromEntries(['sessions', 'workspaces', 'conversation', 'uiWorkspace', 'layout'].map(name => [name, desktopCtx.get(name)]))
  if (Object.values(services).some(service => service === undefined)) return

  // 等待服务就绪
  const waitForReady = () => {
    const ws = services.workspaces.list.getSnapshot()
    const sess = services.sessions.list.getSnapshot()
    if (ws.phase === 'ready' && sess.phase === 'ready') {
      desktopCtx.effect(() => installDesktopPetBridge(window, services as unknown as DesktopPetServices), 'lumo-ui: desktop pet messaging')
    } else {
      // 订阅状态变化
      const unsubWs = services.workspaces.list.subscribe?.(() => {
        const ws = services.workspaces.list.getSnapshot()
        const sess = services.sessions.list.getSnapshot()
        if (ws.phase === 'ready' && sess.phase === 'ready') {
          unsubWs?.()
          unsubSess?.()
          desktopCtx.effect(() => installDesktopPetBridge(window, services as unknown as DesktopPetServices), 'lumo-ui: desktop pet messaging')
        }
      })
      const unsubSess = services.sessions.list.subscribe?.(() => {
        const ws = services.workspaces.list.getSnapshot()
        const sess = services.sessions.list.getSnapshot()
        if (ws.phase === 'ready' && sess.phase === 'ready') {
          unsubWs?.()
          unsubSess?.()
          desktopCtx.effect(() => installDesktopPetBridge(window, services as unknown as DesktopPetServices), 'lumo-ui: desktop pet messaging')
        }
      })
    }
  }

  desktopCtx.effect(() => {
    waitForReady()
    return () => {}
  }, 'lumo-ui: desktop pet readiness check')
})
```

### 根本修复：改进错误提示

在 `desktop-pet.ts` 中提供更详细的诊断信息：

```typescript
// platform/dsh-plugins/lumo-ui/src/client/desktop-pet.ts:102
const workspaces = services.workspaces.list.getSnapshot()
const sessions = services.sessions.list.getSnapshot()
if (workspaces.phase !== 'ready' || sessions.phase !== 'ready') {
  const details = []
  if (workspaces.phase !== 'ready') details.push(`工作区: ${workspaces.phase}`)
  if (sessions.phase !== 'ready') details.push(`会话: ${sessions.phase}`)
  throw Error(`服务尚未就绪 (${details.join(', ')})，请稍后重试或重启应用。`)
}
```

## 进一步诊断

如果问题持续，请提供：
1. 诊断脚本的完整输出
2. Console 中的错误日志（红色）
3. 应用启动时的加载顺序日志
