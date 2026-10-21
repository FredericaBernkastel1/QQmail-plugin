# QQmail plugin

面向 Codex 等 MCP 宿主的本地 Windows 邮箱插件。此分支开发 **0.4.1**，从已交付 **0.3.0** 独立演进，默认提供 **26 个工具**。通过本机 stdio 连接宿主，无需部署远程服务器、域名或 OAuth 服务。

## 功能与使用

- 保留账户设置、连接测试、多账户档案与经确认的账户切换。
- 支持邮件搜索、分页读取、会话读取、标记、移动和移入垃圾箱；不提供永久删除。
- 支持草稿准备、查询、编辑、取消、加密保存和恢复，以及发送、回复、回复全部和转发。
- 附件仍由用户通过独立 Windows 文件选择窗口导入，工具只接收 `attachmentId`，不接收任意本地路径、URL 或文件内容。
- 新增 `request_mail_authorization`、`list_mail_authorizations` 和 `revoke_mail_authorization`，让用户在独立 Windows 窗口批准有限任务。

需要 Windows 交互式桌面、Node.js 22 或以上版本和系统自带 Windows PowerShell。账户和服务商的 IMAP/SMTP 授权码只在本地设置页面输入。插件正常连接用户配置的邮件服务器；读取结果会返回 MCP 宿主，宿主可能将其发送给模型服务。

`QQmailplugin/` 是与源码分开的运行包。以其 `plugin.json` 标示的版本为准：仅更新源码分支不会自动升级该目录，只有独立发布验收和交付完成后才替换。候选源码、CI 成功或旧包均不代表本版本已完成桌面验收。

1. 将完整运行包放到本机固定目录；支持插件的宿主使用其中的插件清单和 `.mcp.json`。
2. 普通 MCP stdio 配置可使用 `node` 启动该包的 `dist/server.mjs`，工作目录为插件根目录。
3. 调用 `get_account_status`，再用 `open_settings` 保存账户和授权码；敏感设置操作仍须原生确认。
4. 发送附件时，先 `select_attachments`，把返回的 ID 加入 `prepare_email.attachmentIds`，再调用 `send_email`。

运行包完整性可用保留的验证工具检查：

```powershell
python scripts/verify-runtime.py
```

## 有界任务授权

默认 `interactive` 模式保留原来的 23 项功能，再加入 3 项授权管理工具。未提供 `authorizationId` 时，发送及移动/垃圾箱操作保持原有逐次原生确认。草稿编辑和标记操作保留原有交互式行为。

`request_mail_authorization` 本身不批准请求。用户必须在独立窗口确认账户、动作、目标、次数和有效期，之后才能获得授权 ID。用户应亲自阅读并操作确认窗口，不应让宿主代理代点批准。

- `send` 覆盖每一项 To、Cc 和 Bcc 收件人；允许列表最多 20 个地址。
- `trash` 和 `flags` 绑定最多 100 个精确消息引用，不根据邮件正文决定权限。
- `edit_draft` 允许本账户的本地草稿准备、编辑和取消；它不授予发送权限。
- 每份授权最多 100 个操作、24 小时。发送和草稿编辑每次计 1；标记和垃圾箱按不同消息数计数。已扣额度不会因后续失败而退还。
- 授权只在当前进程内保存；重启、撤销、过期或账户版本变更后失效。无效 ID 不会在同一次调用中降级为免授权执行或重新弹窗。

任务授权允许代理在上述范围内选择正文，**不是逐封正文确认**；`purpose` 只是展示说明，不是正文过滤规则。准备草稿返回 `confirmationRequired: false` 仅反映本次使用了编辑授权，发送仍须另行满足 `send` 权限和全部收件人限制。附件的选择、大小与有效期限制继续适用。

启动参数由可信宿主配置决定，工具不能修改模式：

| 模式 | 工具数 | 写操作 |
| --- | ---: | --- |
| 默认 `interactive` | 26 | 原有交互流程，可选有效任务授权 |
| `--profile=authorized` | 17 | 所有已暴露写操作均要求有效授权 ID |
| `--profile=read-only` | 6 | 只暴露读取操作，无授权管理工具 |

安全边界和正在进行的验收见 [SECURITY.md](SECURITY.md) 与 [验证说明](docs/VALIDATION.md)。

## 源码开发

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test -- --maxWorkers=2 --no-file-parallelism
npm run build
```

构建只生成根目录 `dist/` 和 `ui/settings.html`，不会覆盖 `QQmailplugin/`。请在独立受限环境中运行完整程序和依赖，只使用合成账户。原生测试需要 Windows；CI 使用 Windows runner，不把 Linux 结果当作原生验收。浏览器测试沿用仓库 Playwright 配置，通过 `npm run test:ui` 单独执行。

`tests/fixtures/` 的 TLS 证书和密钥是公开合成 fixture，不能用于生产或加入系统信任库。`QQMAIL_APPCONTAINER_TEST` 仅用于原有外部受控测试基础设施，普通开发环境不要开启。

## 来源和许可

改编自 [moondream69/QQmail-plugin](https://github.com/moondream69/QQmail-plugin)，基线提交为 `146923e7277988b451ff69b772966d6e4f723d1a`。保留 [MIT 许可证](LICENSE) 和原作者版权声明。本仓库维护本地改编版本，不是腾讯官方产品。

运行包的依赖版本和来源见 [SBOM](QQmailplugin/SBOM.json)，第三方许可见 [THIRD_PARTY_NOTICES](QQmailplugin/THIRD_PARTY_NOTICES.md)。历史云端候选保留在独立分支，本分支不包含云端服务或云端测试。
