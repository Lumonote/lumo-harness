import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian'

/**
 * Lumo Vault Source —— 把本 vault 作为 Lumo 桌面知识库（单机版）的来源。
 * 扫描 / 分块 / 关键词索引（sqlite FTS5）都在 Lumo 侧完成；vault 本体不被写入。
 */

interface LumoVaultSettings {
  apiBase: string
  token: string
}

const DEFAULT_SETTINGS: LumoVaultSettings = {
  apiBase: 'http://127.0.0.1:3080',
  token: '',
}

export default class LumoVaultSource extends Plugin {
  settings: LumoVaultSettings = Object.assign({}, DEFAULT_SETTINGS)

  async onload() {
    await this.loadSettings()

    this.addRibbonIcon('book-open-check', 'Lumo 知识库：同步 vault', () => {
      void this.sync()
    })

    this.addCommand({
      id: 'sync-to-lumo',
      name: '同步到 Lumo 知识库',
      callback: () => {
        void this.sync()
      },
    })

    this.addSettingTab(new LumoVaultSettingTab(this.app, this))
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  async sync() {
    const base = this.settings.apiBase.replace(/\/+$/u, '')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.settings.token !== '') {
      headers['Authorization'] = `Bearer ${this.settings.token}`
    }
    try {
      const response = await fetch(`${base}/lumo/api/knowledge/vault/sync`, {
        method: 'POST',
        headers,
      })
      if (!response.ok) {
        const body = (await response.text()).slice(0, 300)
        new Notice(`Lumo 同步失败（${response.status}）：${body}`)
        return
      }
      const outcome = (await response.json()) as { docs?: number }
      new Notice(`Lumo：已同步 ${outcome.docs ?? 0} 个 vault 文档`)
    } catch (error) {
      new Notice(`无法连接 Lumo（${base}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

class LumoVaultSettingTab extends PluginSettingTab {
  plugin: LumoVaultSource

  constructor(app: App, plugin: LumoVaultSource) {
    super(app, plugin)
    this.plugin = plugin
  }

  display() {
    const { containerEl } = this

    containerEl.empty()

    containerEl.createEl('h2', { text: 'Lumo Vault Source' })
    containerEl.createEl('p', {
      text: '把本 vault 作为 Lumo 桌面知识库的来源。构建入口为 Lumo 面板或本插件的「同步」命令。',
    })

    new Setting(containerEl)
      .setName('Lumo API 地址')
      .setDesc('Lumo 桌面工作台服务（本机回环）。')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:3080')
          .setValue(this.plugin.settings.apiBase)
          .onChange(async (value) => {
            this.plugin.settings.apiBase = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('工作台 token')
      .setDesc('Lumo 桌面握手文件中的 token；留空则匿名访问。')
      .addText((text) =>
        text
          .setPlaceholder('粘贴 token')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText('立即同步')
        .setCta()
        .onClick(() => {
          void this.plugin.sync()
        }),
    )
  }
}
