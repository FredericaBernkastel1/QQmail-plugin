# QQmail plugin

本分支正在开发 **0.4.0 云端连接器候选**：使用远程 HTTPS MCP 与外部 OAuth 身份服务，供 ChatGPT / Dot 等宿主连接。代码和合成测试可供审阅；尚未完成真实域名、IdP、Dot 和 QQ 邮箱联调。部署步骤见 [云端说明](docs/cloud/README.md)。`QQmailplugin/` 仍是下面说明的 **0.3.0 Windows 成品**，不会被开发候选覆盖。

云端首版支持邮件读取、草稿编辑、受限发送、标记及移入垃圾箱。写入由用户预先同意的操作策略、当前 OAuth scope 和有限任务授权共同约束；不提供任意命令、宿主配置修改、永久删除或云端附件上传接口。“类似 Gmail”指连接与授权方式，不表示拥有 Gmail 的全部功能或内部安全认证。

面向 Codex 等 MCP 宿主的本地 Windows 邮箱插件。当前版本 **0.3.0**，提供 **23 个工具**，支持 QQ 邮箱、腾讯企业邮箱及用户配置的 IMAP/SMTP 服务。

## 功能

- 账户设置、连接测试、多账户档案与经确认的账户切换。
- 邮件搜索、分页读取、线程读取、标记、移动及移入垃圾箱。
- 草稿准备、查询、编辑、取消，以及加密保存和恢复。
- 发送、回复、回复全部、转发；支持由用户在原生窗口选择的本地附件。
- 附件下载、待发送附件查询和移除。
- 发送、移动和移入垃圾箱需要独立 Windows 确认；不提供永久删除。

## 安装和运行

需要 Windows 交互式桌面、Node.js 22 或以上版本、系统自带的 Windows PowerShell。需要使用邮箱服务商提供的 IMAP/SMTP 授权码。授权码只在本地设置页面输入。

仓库中的 [`QQmailplugin/`](QQmailplugin/) 是已构建的可运行包，依赖已打包，无需执行 `npm install`。也可从 [Releases](https://github.com/FredericaBernkastel1/QQmail-plugin/releases) 下载运行包。

1. 将完整 `QQmailplugin` 文件夹放到本机固定位置。
2. 支持 Codex 插件的宿主使用其中的 `.codex-plugin/plugin.json` 和 `.mcp.json`；其他 MCP 宿主使用 stdio 配置：

   ```json
   {
     "mcpServers": {
       "qq-mail": {
         "command": "node",
         "args": ["C:/Tools/QQmailplugin/dist/server.mjs"]
       }
     }
   }
   ```

   将示例路径替换为自己的实际路径，工作目录使用插件根目录。

3. 调用 `get_account_status`，再调用 `open_settings`。在设置页保存账户和授权码，按提示确认并测试连接。
4. 发送附件时先调用 `select_attachments`，再将返回的 `attachmentId` 传给 `prepare_email`，最后调用 `send_email` 并在原生窗口确认。

完整操作、限制与数据流见 [运行说明](QQmailplugin/README.md)。校验运行包：

```powershell
python scripts/verify-runtime.py
```

## 安全边界

插件只暴露邮箱操作和账户设置，不提供任意命令、代码执行、宿主行为修改或任意文件路径上传接口。邮件和附件内容作为不可信数据处理。插件正常连接已确认配置的邮箱服务器；没有自建遥测或云端转发服务。

读取结果会返回 MCP 宿主，宿主可能将其发送给模型服务。普通安装不自动获得操作系统沙箱；插件也不能限制宿主已有的其他工具权限。详情见 [SECURITY.md](SECURITY.md)。

## 源码开发

仓库根目录包含 TypeScript 源码、设置页面源码和合成测试；`QQmailplugin/` 单独保存可运行成品。

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` 生成根目录 `dist/` 和 `ui/settings.html`，不会覆盖 `QQmailplugin/`。原生 Windows 测试需要 Windows；浏览器测试使用 Microsoft Edge，也可通过 `QQMAIL_TEST_BROWSER` 指定测试浏览器后执行 `npm run test:ui`。开发测试只能使用合成邮箱和测试配置，不要复用日常邮箱配置。完整插件和依赖应在单独的受限测试环境运行。

测试目录中的 TLS 证书和密钥为公开合成 fixture，不能用于生产。`QQMAIL_APPCONTAINER_TEST` 是原有受控测试基础设施的选择开关；该外部基础设施未随本仓库提供，普通开发环境无需启用。

0.3.0 的既有受控验收包括 246/246 项业务测试，以及浏览器、原生确认、附件选择、隔离和独立安装检查。公开仓库不包含原始系统元数据、个人运行记录或测试环境。验收范围和未测项见 [验证说明](docs/VALIDATION.md)。

## 来源和许可

改编自 [moondream69/QQmail-plugin](https://github.com/moondream69/QQmail-plugin)，基线提交 [`146923e`](https://github.com/moondream69/QQmail-plugin/commit/146923e7277988b451ff69b772966d6e4f723d1a)。保留 [MIT 许可证](LICENSE) 及原作者版权声明。本仓库维护本地改编版本，不是腾讯官方产品。

依赖来源、版本及完整性见 [SBOM](QQmailplugin/SBOM.json)，第三方许可见 [THIRD_PARTY_NOTICES](QQmailplugin/THIRD_PARTY_NOTICES.md)。
