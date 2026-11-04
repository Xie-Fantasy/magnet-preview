# Magnet Preview

**先了解，再决定。** 一个注重隐私与操作控制的浏览器扩展，帮助你整理网页中的磁力链接、查看可用的资源信息，并收藏值得保留的内容。

[English](README_EN.md) · [功能与截图](#功能) · [安装](#安装) · [隐私与权限](#隐私与权限) · [参与开发](#开发)

> 项目仍在开发中，目前通过源码构建安装；尚未完成最终的真实 Chrome 发布验收。预览结果取决于第三方服务与资源可用性。

## 为什么需要它？

面对一个包含多个磁力链接的网页，你可能只想先看看资源信息，确认是否值得保存。Magnet Preview 把**当前页扫描、去重、预览和收藏**放在同一个轻量工作流中，让你不必在多个页面之间反复整理链接。

它适合整理你有权访问的电影、纪录片、公开资料和其他资源。扩展本身**不下载文件、不播放视频，也不内置 BitTorrent 客户端**。

## 功能

- **扫描当前网页**：主动扫描页面中的 Magnet 链接，相同 InfoHash 自动合并，快速了解资源数量。
- **按需获取预览**：用户同意后，可通过 WhatsLink 查询可用的资源信息和图片；没有预览时也能继续使用本地扫描结果。
- **页面内快捷操作**：可选择在链接附近显示信息，或在当前页启用悬停预览；悬停预览默认关闭。
- **收藏与离线导出**：保存感兴趣的资源，支持 HTML、ZIP 和 JSON 导出。收藏与可清理的预览缓存分开管理。
- **自己的使用方式**：支持中文和英文、浅色和深色主题，以及可配置的页面工具。

### 当前页扫描与在线预览

扫描结果显示三个真实资源；启用在线预览后，可查看缩略图、大小和文件数量。

![三部开放电影的真实扫描结果](docs/screenshots/live-scan-multiple.png)

点击资源可查看截图画廊、InfoHash 和磁力链接。

![真实资源的在线预览详情](docs/screenshots/live-preview-detail.png)

### 在网页中预览

| 页面内预览 | 悬停预览 |
| --- | --- |
| ![链接下方的页面内预览](docs/screenshots/live-inline.png) | ![磁力链接的悬停预览](docs/screenshots/live-hover.png) |

| 悬浮工具设置 | 隐藏范围选择 |
| --- | --- |
| ![悬浮工具设置面板](docs/screenshots/live-floating-tool.png) | ![悬浮工具隐藏范围选项](docs/screenshots/live-floating-hide-options.png) |

### 收藏、导出与设置

| 收藏详情 | 导出的离线 HTML |
| --- | --- |
| ![收藏详情及预览图片](docs/screenshots/live-favorites.png) | ![离线 HTML 中的收藏](docs/screenshots/live-offline-export.png) |

| 缓存管理 | 设置 |
| --- | --- |
| ![缓存管理页面](docs/screenshots/live-cache.png) | ![扩展设置页面](docs/screenshots/live-settings.png) |

### 深色主题

![真实扫描结果的深色主题](docs/screenshots/live-scan-dark.png)

### 截图来源与说明

以上截图来自真实扩展运行：演示网页为专门搭建的本地页面，使用 [WebTorrent 免费种子列表](https://webtorrent.io/free-torrents) 中的公开 Magnet；资源信息和影片画面由 WhatsLink 实时返回，并非模拟预览。截图中分别展示了本地扫描、用户授权后的在线预览、页面工具与收藏导出。截图采集时第三方服务的部分图片返回错误，因此收藏和离线导出可能显示部分图片不可用；在线数据随服务状态变化。

影片画面版权归原作者所有，以下项目均按 [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) 提供，截图为界面展示而进行了缩放和局部呈现：

- *Sintel* — © Blender Foundation | [sintel.org](https://durian.blender.org/sharing/)。
- *Big Buck Bunny* — © 2008 Blender Foundation / [bigbuckbunny.org](https://peach.blender.org/about/)。
- *Tears of Steel* — © Blender Foundation / Blender Institute | [mango.blender.org](https://mango.blender.org/about/)。

## 安装

当前需要从源码构建。请先安装 [Node.js](https://nodejs.org/) 22 LTS（22.12 或更高的 22.x 版本）或 24 LTS，以及 npm 和支持 Manifest V3 的 Chromium 浏览器。

```bash
git clone https://github.com/Xie-Fantasy/magnet-preview.git
cd magnet-preview
npm ci
npm run build
```

1. 在 Chrome 中打开 `chrome://extensions`，启用右上角的「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择项目中的 `.output/chrome-mv3` 文件夹。
3. 打开包含 Magnet 链接的网页，点击扩展图标，选择「扫描当前页面」。
4. 按界面提示决定是否启用在线预览；页面内悬停和自动显示页面工具均需单独设置。

更新源码后重新执行 `npm ci`（依赖变化时）和 `npm run build`，然后在扩展管理页面点击重新加载。首次使用和权限提示的具体外观可能随浏览器版本变化。

## 隐私与权限

扫描在本地完成。在线预览由用户选择启用：请求预览时，相关 Magnet/InfoHash 会从浏览器发送给第三方服务 [WhatsLink](https://whatslink.info/)，预览图片也可能由第三方提供。项目不运营接收这些请求的自有后端。请勿对不希望发送给该服务的链接启用在线预览，并自行了解第三方服务的数据处理方式。

| 权限 | 用途 |
| --- | --- |
| `activeTab`、`scripting` | 在用户主动操作时访问当前标签页并运行扫描或页面工具。 |
| `storage` | 保存设置与本地状态。 |
| `alarms` | 安排预览缓存清理。 |
| `https://whatslink.info/*` | 连接预览服务；服务请求由用户的预览操作触发。 |
| 可选的网站访问权限 | 仅在用户为指定网站开启自动显示页面工具时申请；不是默认授权全部网站。 |

预览缓存可以清理；收藏以独立的持久记录保存。卸载扩展或清除扩展数据可能删除本地记录，请使用导出功能保存需要保留的数据。

## 开发

```bash
npm ci
npm run dev          # 开发构建
npm run check        # 类型检查、lint、单元测试与生产构建
npm run test:e2e     # 构建并运行 Playwright 浏览器测试
```

浏览器测试需要安装 Playwright 的 Chromium：`npx playwright install chromium`。项目使用 TypeScript、React、WXT 和 Manifest V3；页面交互、预览请求和本地存储分别位于 `src/content`、`src/application`、`src/entrypoints` 等目录。在线请求由后台服务经统一的预览管理器和服务适配器处理。

欢迎提交问题和改进建议。报告问题时，请说明复现步骤、浏览器版本与预期行为；请先移除真实磁力链接、个人信息和其他敏感数据。请尊重资源权利人的合法权益，并遵守所在地区适用的法律。

## 许可证

项目代码采用 [MIT](LICENSE) 许可证；README 中开放电影画面的版权和许可见上方截图来源说明。
