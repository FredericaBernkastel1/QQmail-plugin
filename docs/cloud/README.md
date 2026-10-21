# QQmail 远程 MCP 插件：云端设计与验收范围

更新时间：2026-10-21。本文对应 0.4.0 远程候选版本。Windows AppContainer 与 Linux CI 已完成下述验证；生产域名、外部身份提供商、长期托管环境和密钥挂载位置尚未配置，尚未部署或连接真实 Dot。

目标是把 QQmail 做成通过 OAuth 连接的远程 HTTPS MCP 插件，使 ChatGPT / Dot 能调用固定邮箱工具。邮箱服务运行在操作者管理的长期托管环境，不依赖用户 Windows 桌面或 Windows 确认窗口。Dot 的电脑不承担本方案的生产托管和持久化职责。

“类似 Gmail”指远程插件的连接和受权调用方式，不表示复用 Gmail 的内部实现、拥有 Gmail 同等能力或通过其安全认证。本版是固定单 owner、单 client、单 QQ 账户的私有部署，不能作为多租户邮箱服务。云端没有附件上传、选择、下载或发送接口，也没有 Windows 本机批准要求。

OpenAI 官方说明，Dot 可使用账户已安装并启用的受支持插件，具体访问受连接账户、权限及执行环境影响；已有应用权限同样适用于 Dot。这个产品能力不证明本插件已接通，也不提供自定义服务的托管保证。[Dot 的电脑与应用](https://learn.chatgpt.com/docs/dots/computers-and-apps)

## 三层授权

| 层次 | 谁控制 | 本方案检查什么 |
| --- | --- | --- |
| 连接授权 | 外部 OAuth 身份提供商与用户 | 访问令牌签名、固定 issuer/resource audience、有效期、固定 owner subject、允许的 OAuth client、工具 action scope |
| 预设任务规则 | 邮箱所有者与服务操作者 | 默认只读；明确授权的动作、固定发送收件人、授权到期时间、整份授权总预算，以及不可由模型提供的 consentId |
| 当前任务授权 | 已认证请求与服务器内存授权核 | 所有请求动作均有当前 scope，限制不能超过预设规则；实际操作绑定账户版本、任务授权、精确收件人或 messageRefs，并扣减额度 |

OAuth 连接同意不等于用户逐封确认了邮件。云端模式使用用户明确授予的有限自动化规则；宿主仍按用户指令与其插件权限执行操作。`request_mail_authorization` 只是申请这些规则内的任务授权，不能把邮件中的指令、`purpose` 描述或模型传入的 `approved` 转换成批准。

写操作只有在所有条件同时满足时可用：操作者启用了已获用户明确同意的有限规则；OAuth 令牌有 `mail.authorize` 及对应动作 scope；当前任务范围符合规则；每次写入仍有有效令牌权限与任务额度。没有承载这份用户同意的配置和连接流程，必须保持只读，不能用固定返回 `approved` 的回调或环境开关替代。

工具的 `readOnlyHint` / `destructiveHint` 用来准确告知宿主行为，不是人类同意的密码学凭证，也不能代替服务器的检查。官方同样要求服务自行完成授权与验证。[MCP 工具注解](https://developers.openai.com/plugins/build/mcp-server)

## 本版范围

- 一次部署只服务一个预配置 QQ 邮箱所有者。QQ 邮箱账户和授权码由操作者秘密文件或托管密钥系统注入，不接受 MCP 参数中的账户、密码、服务器、文件路径或密钥。
- 默认提供邮箱状态、目录、搜索、单封读取、批量读取和线程读取。读取仍需要 OAuth；“只读”不等于匿名，也不等于邮件内容仅在服务器本地使用。
- 可选写能力为准备/编辑/取消本地草稿、发送、设置已读/星标，以及移入 Trash。没有永久删除、任意邮箱移动、账户切换、配置编辑、任意代码、文件选择或下载接口。
- 发送白名单覆盖 To、Cc、Bcc 的实际地址。允许向这些地址发送代理选择的正文，因此 `purpose` 不是正文内容过滤器，授权规则必须明示这一点。
- flags 和 Trash 的任务范围是精确 messageRefs；执行前校验账户 scope、邮箱 UIDVALIDITY 等已有引用约束。不存在“所有邮件”通配授权。
- 任务授权只在内存中保存，重启后失效。准备/编辑/取消/发送各消耗一个操作单位，批量 flags/Trash 按不同邮件计费；失败不自动返还额度。
- 操作者配置的 `delegation.maxOperations` 是整份用户同意的总预算，最多 100。每次申请任务授权，先从持久化总预算预留该任务全部额度；未用完、任务失败或进程重启都不自动退款。相同 consentId 重启不会恢复额度；策略变化需由操作者提供新的明确同意及新 consentId。
- 总预算账本采用带独立域标识的 HMAC，固定保存到受限持久目录并持生命周期独占锁；持久化失败会禁用本进程后续预算使用。HMAC 检测篡改，但不能检测删除文件、恢复合法旧备份或回滚整个卷；操作者必须防止这些行为把已消费额度重新开放。
- 云端草稿使用独立的可移植加密存储。发送前必须持久化在途状态；SMTP 结果未知时保留终态与固定 Message-ID，不自动重发。加密存储不等于能够抵御拥有服务身份或密钥访问权的操作者。

## 设计评审提出的强制检查

| 风险 | 接受条件 |
| --- | --- |
| 获得一次 OAuth 令牌后无限制造任务额度 | 每个任务额度先从持久化总预算中预留，写入成功后才能批准；相同用户同意不能通过重启或再次申请恢复额度 |
| 不同连接共享任务授权 | 本版固定一个 issuer、owner subject 和允许的 OAuth client；配置拒绝多个 client，不宣称多用户或多客户端隔离 |
| 初始化时认证后长期复用 | 每个受保护 HTTP 请求和每次工具调用验证当前身份/权限，不从 MCP session ID、客户端标签或任意自报字段推断授权 |
| 异步等待后令牌已过期、授权撤销或请求取消 | SMTP 编译后实际分派前，以及每次 IMAP 变更前重检；检查 HTTP 请求取消状态，任务 TTL 不得延长 Bearer 令牌自身的有效期 |
| OAuth 读取权限借旧 grant 获得写权限 | 每次写调用都要求对应 action scope，不能只在申请 grant 时检查一次 |
| JWT 或 JWKS 被替换为任意来源 | 只使用操作者固定的 issuer、JWKS URL、audience 和算法集合；拒绝令牌携带的任意 key URL、错误用途令牌、缺失身份和时间声明 |
| 负载均衡导致重复发送或授权额度分叉 | 首版只启一个服务进程/写入者；多实例、滚动并存和自动扩容在共享原子状态与幂等设计验收前禁用 |
| 日志泄漏邮箱和令牌 | 日志不记录 Authorization、QQ 授权码、邮件正文、完整收件人列表、grant ID 或秘密配置；诊断证据保留在受限开发存储 |

这些约束已有对应实现和合成回归证据，真实部署仍须按 [验收矩阵](DEPLOYMENT.md#cloud-readiness-矩阵) 独立完成，不能把实现测试等同于公网或真实邮箱通过。

## 证据与当前状态

本轮证据汇总如下，不沿用旧本地版本测试数量作为云端结果。Windows 测试曾发现真实存储路径问题，生产修复后又遇到测试清理问题；两次失败均保留，不能改写成首次通过。

| 层级 | 本文件编写时状态 |
| --- | --- |
| Windows AppContainer 类型检查 | `cloud-compile-003`：PASS |
| Windows AppContainer 测试 | `cloud-tests-002`：472 项中 469 通过、1 项 junction 清理 `ENOTEMPTY` 失败、2 项 POSIX 跳过；仅修测试清理且保留原断言后，`cloud-storage-003`：24 项中 22 通过、2 项 POSIX 跳过。综合 470 个已执行用例通过，**不是单次全套 470 项通过** |
| 构建与真实 bundle 冒烟 | `cloud-build-001`：PASS；`cloud-bundle-002`：实际 bundle 启动、health、资源元数据、无认证 POST 在业务前拒绝均 PASS |
| Linux CI | 提交 `ec440ee4` 的 npm ci、typecheck、选定 cloud/authorization 测试及 build 全部成功；包含两项 POSIX 测试，范围不是 Windows 全套测试。见 [Actions 运行记录](https://github.com/FredericaBernkastel1/QQmail-plugin/actions/runs/39554963087) |
| 依赖与清单工具 | 本轮 181 个公开依赖公告检查匹配 0 条；纯 Python 清单工具 34 项检查及合成 CLI 生成通过。公告为当时数据库查询结果，不代表不存在未知漏洞 |
| 公网 HTTPS、外部 IdP、域名与密钥配置 | 待操作者提供和部署 |
| Docker 镜像构建、容器运行与实际持久卷 | 未运行；Linux CI 不替代容器或生产文件系统验收 |
| ChatGPT / Dot 安装、OAuth 连接、scope 升级及写操作许可 | 未验证 |
| QQ 服务真实收发、垃圾箱和旗标行为 | 未验证；本开发轮不接触真实邮箱 |
| 长期运行、故障恢复、监控与限额 | 待部署环境验收 |

具体部署输入、发布步骤和逐项验收见 [DEPLOYMENT.md](DEPLOYMENT.md)。既有 Windows 0.3.0/0.4.0 包、原生窗口测试及安装记录继续保留，不应被本云端设计覆盖或重新标记为云端通过。

部署素材包括默认只读且秘密占位无效的 [配置样例](config.example.json)、不会自动启用的 [委托结构样例](delegation.example.json)，以及只复制已构建产物的 [Dockerfile](Dockerfile) 和 [.dockerignore](.dockerignore)。公开源码仓库中的 `scripts/render-cloud-plugin.py` 可生成不含秘密的远程连接清单；本地 QQmail 开发工作区保存于 `tools/render-cloud-plugin.py`。两种路径的运行步骤与未验收边界见部署文档。

官方远程认证要求 OAuth 2.1、受保护资源元数据、PKCE 及每请求令牌验证；本项目选择外部 IdP，而非自建签发器。[插件认证](https://developers.openai.com/plugins/build/auth)
