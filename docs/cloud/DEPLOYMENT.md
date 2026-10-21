# QQmail 云端部署与 readiness 验收

更新时间：2026-10-21。当前状态为部署设计稿。此文档不包含生产令牌、邮箱授权码、私密日志或已部署地址；示例占位名称不能用于生产。

## 部署前须确定的输入

| 输入 | 必须明确的值 | 当前状态 |
| --- | --- | --- |
| 长期托管 | 用户选定的 VM、容器服务或等价平台，地区、维护人及费用归属 | 待提供 |
| 公网域名 | 持续可用的 HTTPS MCP 地址，例如 `https://mail.example.invalid/mcp` | 待提供 |
| OAuth resource | 唯一、规范的 HTTPS 资源标识，供元数据与 token audience 精确匹配 | 待提供 |
| 外部 IdP | issuer、固定 JWKS URL、授权/令牌发现元数据、PKCE S256 | 待提供 |
| 用户与客户端 | 固定 owner subject 和一个 client ID；本版拒绝多 client，禁止用邮箱显示名替代 subject | 待提供 |
| 连接回调 | 从插件管理页面取得的精确 redirect URI，在 IdP 中登记 | 待提供 |
| 密钥位置 | QQ 账户及授权码、草稿加密密钥的受限挂载；不可提交仓库或放进插件清单 | 待提供 |
| 草稿存储 | 服务身份可读写的持久卷、加密备份、保留时间与恢复负责人 | 待提供 |
| 自动化规则 | `delegation` 中的 consentId、expiresAt、actions、recipients、maxOperations（整份同意总预算，最多 100） | 默认不启用写 |
| 外联 | IdP JWKS 所需 HTTPS、固定 QQ IMAP/SMTP 的 TLS 连接及 DNS | 待环境验证 |
| 最终启动契约 | 源入口 `src/cloud/server.ts`，构建产物 `dist/cloud-server.mjs`，Node >= 22；发布包仍须构建与验收 | 已有实现，待验收 |

配置以 `src/cloud/config.ts` 的严格 schema 为准，当前顶层字段为 `schemaVersion`、`publicUrl`、`listen`、`oauth`、`mailbox`、`stateDirectory`、`masterKeyBase64` 和可选 `delegation`。`oauth` 包含 `issuer`、`jwksUrl`、`ownerSubject`、`clientId`；`mailbox` 包含固定账户、授权码、TLS 服务器和目录配置。省略 `delegation` 即关闭所有写操作；不要在配置示例中填入真实密钥。

通过验收后的构建包可按以下方式启动；本轮没有执行 Linux 生产启动或 Docker 命令。秘密文件必须为私有普通文件，Linux 权限不能向 group/other 开放。默认后端监听 `127.0.0.1:8787`，由受控 HTTPS 入口转发；不能把旧的 `dist/server.mjs` stdio 入口作为 HTTP 服务。

## 配置样例与直接启动

[config.example.json](config.example.json) 的字段对应当前 `cloudConfigSchema`，默认没有 `delegation`。它故意包含 `INVALID` secret 和保留域名，尤其 `masterKeyBase64` 不满足 32 字节密钥校验，因此不能原样运行。操作者应在服务器私有秘密路径创建实际配置，替换每个占位值，核对固定邮箱的 TLS 服务器和目录名。不要把填好秘密的配置保存回样例、构建上下文或插件目录。

[delegation.example.json](delegation.example.json) 仅展示可选 `delegation` 对象的结构，不会被服务器自动读取或合并。示例已过期，consentId 与收件人为占位值。用户明确授予有限任务规则后，操作者才可生成新 consentId、设置到期时间、动作、精确收件人和整份同意总预算，再加入私有配置的 `delegation` 字段。这里的 3 次预算是整个 consent 的总量，例如 prepare、update、send 各一次会用完；不能循环重建 grant 续量。

以下为 Linux 部署模板，绝对路径须按操作者环境替换。构建产物提前经过本版本的隔离构建和验收，运行机器使用已审阅的 Node 22。`/opt/qqmail` 中的程序及 LEGAL 文件只读，独立服务身份仅可读取秘密文件，并读写受限持久状态目录。

```sh
node /opt/qqmail/dist/cloud-server.mjs --config=/run/secrets/qqmail.json
```

直接运行时，秘密普通文件应归服务 UID 所有、权限 0400 或 0600；状态目录 `/var/lib/qqmail` 归同一 UID 所有、权限 0700。配置中的 `listen.host` 保持 `127.0.0.1`，端口 8787。由服务管理器以该非 root 身份启动单个进程，公网 HTTPS 反向代理负责转发并保留正确的 Host / Origin。配置文件所在父目录也须阻止非操作者替换文件。

## 仅含已构建文件的容器

[Dockerfile](Dockerfile) 使用 Node 22，固定 UID/GID 1000，固定启动参数 `--config=/run/secrets/qqmail.json`。镜像只复制 `dist/cloud-server.mjs` 和 `dist/cloud-server.mjs.LEGAL.txt`；[.dockerignore](.dockerignore) 默认排除全部，仅允许 Dockerfile、ignore 文件和这两个产物。镜像构建不安装 npm 依赖，也不打包源码、测试、配置或历史证据。

先建立一个全新的最小构建目录，再从已验收产物复制下面四个文件。以下命令是待执行模板，`/absolute/...` 为操作者替换的路径；不要把整个开发工作区直接上传到云构建服务。

```sh
mkdir -p /absolute/new/qqmail-image-context/dist
cp /absolute/cloud-docs/Dockerfile /absolute/new/qqmail-image-context/Dockerfile
cp /absolute/cloud-docs/.dockerignore /absolute/new/qqmail-image-context/.dockerignore
cp /absolute/accepted/dist/cloud-server.mjs /absolute/new/qqmail-image-context/dist/cloud-server.mjs
cp /absolute/accepted/dist/cloud-server.mjs.LEGAL.txt /absolute/new/qqmail-image-context/dist/cloud-server.mjs.LEGAL.txt
docker build --tag qq-mail-cloud:0.4.0 /absolute/new/qqmail-image-context
```

Dockerfile 的 `node:22-bookworm-slim` 是可变标签。正式发布应先审阅选定 Node 22 基础镜像及其摘要，用 `--build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:<已核验摘要>` 固定，并记录最终应用镜像摘要。此处没有臆造摘要或声称已经拉取、扫描或运行镜像。

容器内部私有配置须改为 `listen.host: "0.0.0.0"`、`listen.port: 8787`、`stateDirectory: "/var/lib/qqmail"`。对宿主仅绑定 loopback；远程服务通过受控 HTTPS 代理公开。容器镜像根文件系统保持只读，秘密 bind mount 只读，状态 mount 必须持久可写。操作者预先创建状态目录和实际秘密文件，并把所有权设置成容器 UID/GID 1000；秘密权限为 0400 或 0600，状态目录为 0700。不要让容器以 root 运行来绕过权限配置。

```sh
docker run --name qq-mail-cloud --init --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 \
  --memory 512m --cpus 1 --restart no \
  --publish 127.0.0.1:8787:8787 \
  --mount type=bind,src=/absolute/private/qqmail.json,dst=/run/secrets/qqmail.json,readonly \
  --mount type=bind,src=/absolute/private/qqmail-state,dst=/var/lib/qqmail \
  qq-mail-cloud:0.4.0
```

这组资源限额是部署起点，需按负载验收；它们不代表已通过容量测试。只允许一个运行实例访问同一持久卷，禁止临时卷、并行副本和滚动并存。受控出口需允许指定 IdP 和邮箱服务器，入口只允许 HTTPS 代理访问；不要挂载 Docker socket、宿主目录或任意秘密目录。宿主不在同一机器时，应使用私有容器网络和对应代理策略，而不是把 8787 开放公网。

Linux 文件权限、fsync/rename、卷锁、容器只读根、用户映射和镜像运行均为 `NOT_RUN`；Windows 合成测试不能替代这些验收。实际部署后再填写 C13/C15/C20，并保留脱敏证据。

## 生成公开连接清单

工作区的 `tools/render-cloud-plugin.py` 是仅依赖 Python 标准库的操作者工具。它接收已确定的公网 HTTPS `/mcp` 地址、公开 OAuth client ID 和绝对的新输出目录，生成 `plugin.json` 与 `mcp.json`。输出保留 `qq-mail` / `0.4.0` 身份，使用 remote `streamable-http`、provided public OAuth client（`tokenEndpointAuthMethod: "none"`）以及基础 scopes `mail.read`、`mail.drafts.read`。外部 IdP 需支持相应公共客户端和 PKCE S256；不支持时应先处理 IdP 集成，不能把 client secret 写进清单。

```sh
python3 /absolute/QQmail/tools/render-cloud-plugin.py \
  --url "$QQMAIL_PUBLIC_URL" \
  --client-id "$QQMAIL_PUBLIC_CLIENT_ID" \
  --output /absolute/new/qqmail-cloud-plugin
```

上述两个变量只包含操作者已核对的公开 URL/client ID，不包含密码或 token。程序拒绝 example/invalid 等占位、本地名称、IP 字面量、非 HTTPS、非 `/mcp` 路径、userinfo、query/fragment，以及已经存在的输出目录；父目录须先存在。它不会访问 DNS/网络、读取邮箱配置、部署或安装插件，也不会自动启用写 scopes。语法验证不能证明域名解析到公网、证书有效或服务可用，这些仍需部署验收。

清单遵循 OpenAI 官方打包页的扩展位置和 canonical `$schema` 标识。当前公开通用 MCP JSON schema 的 `streamableHttpServer` 尚未列出 `extensions`，而同页官方 OAuth 示例明确使用它；因此不能把独立通用 schema 校验误报为已通过。须在实际 ChatGPT/Dot 插件加载流程核验 OpenAI 扩展解析与 OAuth 连接。[官方打包与 OAuth 示例](https://developers.openai.com/plugins/build/plugins)、[通用 MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json)

## OAuth 与插件连接配置

外部 IdP 承担用户登录、同意、PKCE 授权码流程、令牌签发与刷新；QQmail 只作为资源服务器验证访问令牌。资源元数据、issuer、audience/resource 必须互相一致，JWKS 固定配置。PKCE 使用 S256；client 与 redirect URI 采用插件管理页面的实际值，不从聊天中猜测。[OpenAI 插件认证要求](https://developers.openai.com/plugins/build/auth)

连接端 manifest 使用远程 `streamable-http` 地址。OAuth 描述位于该 MCP server 的 `extensions["com.openai"].auth`；manifest 只声明连接信息，不携带 QQ 授权码、OAuth client secret 或 Bearer token。公网发布与私有测试连接是不同步骤，本轮不自动上传或发布。[插件打包与 OAuth 配置](https://developers.openai.com/plugins/build/plugins)

每个工具应声明实际 `securitySchemes` 与所需 scopes；需要重新连接或增加权限时，HTTP challenge 和工具层 `_meta["mcp/www_authenticate"]` 必须与资源元数据一致，不能只抛一个不带认证信息的内部错误。用户明确同意的写权限必须在实际 IdP 同意页面和宿主连接许可中被正确表达。[工具级认证流程](https://developers.openai.com/plugins/build/auth)

当前 scope 契约如下；发布时须再与实现和 IdP 配置核对。

| Scope | 允许的工具能力 |
| --- | --- |
| `mail.read` | 邮箱状态、目录、搜索和正文/线程读取；也是 MCP 请求的基本访问范围 |
| `mail.drafts.read` | 列出草稿和读取草稿状态/预览 |
| `mail.drafts.write` | 在有效任务授权下准备、编辑、取消草稿 |
| `mail.send` | 在有效任务授权与精确收件人范围内发送 |
| `mail.flags.write` | 在有效任务授权内修改指定邮件标记 |
| `mail.trash` | 在有效任务授权内将指定邮件移入 Trash |
| `mail.authorize` | 申请/管理任务授权；不能单独完成邮件写操作 |

申请授权同时要求 `mail.authorize` 和每个请求动作对应的 scope。拥有授权 ID 不能弥补当前令牌缺失的 scope。使用不同 client 重新连接需要操作者明确迁移配置；不会自动接受任意 DCR client。

已确定的 HTTP 路径是 `POST /mcp`、`GET /.well-known/oauth-protected-resource` 和 `GET /healthz`。当前使用无会话的 JSON 响应模式，`GET /mcp` 返回 405；没有 Windows 设置页面或任意文件资源入口。公网 resource 为完整 HTTPS `/mcp` URL，令牌 audience 必须精确对应。

当前访问令牌 profile 要求 `typ: at+jwt`，签名为 RS256 或 ES256；固定 issuer、audience、owner subject 与 client。IdP 若只签发其他 token profile，应先调整并验证集成，不能放宽为任意 JWT。`azp` 与 `client_id` 同时存在时必须一致。服务内部 `expiresAt` 为毫秒，JWT `exp` 为秒，转换需有回归证据。

## 首次部署顺序

1. 冻结本轮源代码、依赖锁、构建输出与 SHA-256 清单；在既有隔离测试环境运行新的 cloud 测试。保存失败证据，修正后产生新结果，不借用旧版本的通过记录。
2. 在长期托管环境创建独立服务身份。生产密钥只由操作者挂载；代码与静态包只读，持久卷仅存加密草稿及必要状态。秘密配置不得通过 HTTP 静态路由、MCP 资源或工具输出读取。
3. 默认启动只读、单进程服务。公网 TLS 在受控入口终止；后端只监听受保护网络接口，若用本机反向代理则绑定 loopback。校验受信 Host / Origin，不能靠任意 `X-Forwarded-*` 声称自己来自可信代理。
4. 配置外部 IdP 并测试元数据、PKCE、token claims 和 key rotation。无 token、错误 issuer/audience/subject/client 的请求必须在触发邮箱连接或正文读取前失败。
5. 先以开发用例和合成邮箱服务完成下方矩阵。只读端点可提供资源发现元数据，但不能匿名暴露账户状态或邮件。
6. 安装私有远程插件并连接授权账户。在实际 ChatGPT / Dot 界面验证允许的工具、OAuth 连接、scope 升级和宿主操作许可。没有这一步的证据，不得标记“Dot 已可用”。
7. 用户确认有限任务规则及同意承载方式后，才启用写策略和对应 OAuth scopes。验证发送白名单与精确邮件引用的服务端约束；保留所有写工具真实的变更注解，不能伪装为只读来减少宿主提示。
8. 真实 QQ 邮箱验收是后续独立步骤，须使用用户明确指定的测试账户、收件人与测试邮件；本轮开发不执行真实发送、删除或读取个人内容。

## Cloud readiness 矩阵

状态规则：`NOT_RUN` 表示没有本部署的运行证据；`BLOCKED_CONFIG` 表示生产输入尚未确定；`PASS` 必须附本版本、环境、时间、用例和脱敏结果。以下初始状态不得被旧 361 项合成结果自动覆盖。

| ID | 验收面 | 必须满足的结果 | 初始状态 |
| --- | --- | --- | --- |
| C01 | 默认只读 | 未开启已获同意的写策略时，只能读；直接调用隐藏写工具也失败 | NOT_RUN |
| C02 | 私有数据认证 | 缺失/损坏 Bearer、错误签名、过期、未生效 token 均拒绝；零邮箱动作 | NOT_RUN |
| C03 | 身份绑定 | issuer、resource audience、owner subject、client ID 不匹配均拒绝；不接受自报身份 header 或工具参数 | NOT_RUN |
| C04 | JWT 类型和密钥 | 固定算法/固定 JWKS；拒绝无签名、算法混淆、任意 jku/x5u、错误用途 token；key rotation 有界且失败关闭 | NOT_RUN |
| C05 | 逐请求授权 | 旧 session ID、同一连接的降权/过期 token、并发不同 scope 请求均不能复用高权限上下文 | NOT_RUN |
| C06 | Scope 隔离 | mail.authorize 单独不能发信；有 send scope 但无 task grant 也不能发信；每个 action 均独立检查 | NOT_RUN |
| C07 | 用户同意 | 实际 IdP/宿主连接界面清楚表示有限自动化规则；没有同意承载则写不可用 | BLOCKED_CONFIG |
| C08 | 任务策略 | 超出 operator 动作、收件人、TTL 或 quota 的请求被拒绝；purpose、approved、配置字段均不能改变权限 | NOT_RUN |
| C09 | 授权归属 | 非 owner 或其他 client 拒绝；配置显式拒绝多个 client | NOT_RUN |
| C10 | 批量和总预算 | 每封计费、整批原子预扣；任务 grant 全额先持久化预留；并发、重启、反复申请均不能重置整份 consent 的总量；写入不确定即停用 | NOT_RUN |
| C11 | 最终分派重检 | 附件/MIME/邮箱选择等 await 期间撤销、到期或 HTTP 取消后，下一次写入停止；token expiry 同样生效 | NOT_RUN |
| C12 | SMTP 幂等 | 并发重复、HTTP 重试、进程崩溃恢复不重复投递；delivery_unknown 保持终态；Sent 副本失败不改称发送失败 | NOT_RUN |
| C13 | 草稿持久化 | 未知结果在 SMTP 前持久化；加密、损坏拒绝、锁、完整性、容量、路径/权限及密钥错误均有测试 | NOT_RUN |
| C14 | 邮件范围 | To/Cc/Bcc 都受精确地址限制；flags/Trash 仅批准引用；UIDVALIDITY 变化拒绝，部分完成准确返回 | NOT_RUN |
| C15 | HTTP 边界 | HTTPS入口、请求体/头/并发/超时有界；非法 method/path/Origin/Host 拒绝；代理和 CORS 不形成认证绕过 | NOT_RUN |
| C16 | 无任意资源访问 | MCP 不能控制账户/主机/任意路径/URL/秘密文件；token 不可控制 JWKS 目的地 | NOT_RUN |
| C17 | OAuth 发现与错误 | protected-resource metadata、WWW-Authenticate、工具 securitySchemes、scope 升级错误契约一致 | NOT_RUN |
| C18 | 外部 IdP 联调 | 实际 PKCE S256、resource 参数、签发 audience、redirect、刷新、key rotation 全链路通过 | BLOCKED_CONFIG |
| C19 | Dot 插件联调 | 实际安装、登录、只读调用、写权限请求/拒绝/允许、到期重新连接均有脱敏证据 | BLOCKED_CONFIG |
| C20 | 长期托管 | 域名/TLS续期、重启、持久卷恢复、资源限额、进程数、监控和关闭写能力流程经过演练 | BLOCKED_CONFIG |
| C21 | 真实 QQ 兼容 | 用户另行指定的测试账户完成读取/发送/flags/Trash；不继承合成 TLS 或本地通过状态 | NOT_RUN |
| C22 | 发布与信息最小化 | 包内无秘密/私密日志/测试自动批准代码；仅公布必要域名与文档；出站/日志/备份脱敏复核 | NOT_RUN |

## 运行与撤销

首版固定单进程，避免多个实例各自拥有 grant 额度或草稿锁。未完成共享原子状态和重复投递验收前，不启用多个 worker、滚动并存副本或会复制内存授权的自动扩容。

委托总预算与草稿使用不同的固定存储目录及锁。预算账本包含 version、consentId、policyDigest、remainingOperations 和 HMAC，不含邮件或授权码。该账本的密钥与文件由操作者保护，Dot 无权读取、修改或选择其路径。创建新 consentId 是新的用户明确授权，不是自动续期；不能把旧 consentId 反复重新使用。

当前存储实现复用固定文件名：加密草稿位于 `<stateDirectory>/drafts/drafts.enc.json`，HMAC 总预算账本位于 `<stateDirectory>/delegation/drafts.enc.json`，两处各自有 `drafts.lock`。预算文件名虽然带 `enc`，其内容仅认证、不加密，不能往其中加入秘密或邮件内容。两处目录必须位于同一部署持续保留的受限本地文件系统；Linux 目录为 0700、文件为 0600，并依赖可靠的独占创建、rename 和 fsync。

相同 consentId 必须保持相同 policyDigest，重启时恢复已经扣除的余额。改变策略、重建目录、删除账本、回滚卷或恢复旧备份都不能当作额度恢复手段。HMAC 不提供防回滚计数器；若部署需要抵御操作者或存储回滚，需要独立的不可回退状态服务，本版不具备该能力。

任务授权撤销用于停止其后续动作，不能撤回已投递邮件。服务重启会清空内存 grant，但不能清空需要保留的发送终态。不要通过删除加密日志、重建草稿或代理自动重试来“修复”未知发送结果。

纯离线 JWT 验签一般只能在 token 到期或服务端规则改变后发现某些撤销。撤销 refresh token、断开宿主连接或删除客户端，不应被描述为所有已签发 access token 即时失效；若要求即时吊销，需额外的 IdP introspection/事件或服务端撤销机制，并完成相应用例。紧急处理可关闭写策略、撤销任务授权并按操作者流程禁用服务访问。

日志只保留必要的时间、操作名、结果类别及不可逆脱敏关联标识。不要记录原始 JWT、OAuth 授权码、QQ 授权码、邮件正文、完整 recipients、任务 grant ID 或加密密钥。禁止把 `evidence/` 私密采集内容和历史原始日志上传到云部署、GitHub、插件目录或聊天附件。诊断只提供经过审阅的最小脱敏证据。

每次发布保留旧包、版本化验收与失败记录。回滚时检查加密草稿格式和发送终态兼容性，禁止把已分派的记录恢复成可自动发送的草稿。更换账户、密钥、owner、client 或策略必须明确失效旧授权，并记录迁移方式。
