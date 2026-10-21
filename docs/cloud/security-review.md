# QQmail 云端迁移安全评审

日期：2026-10-21。范围为 0.4.0 远程 HTTPS MCP 候选、外部 OAuth、固定单 owner/client 邮箱、可移植草稿存储和委托总预算。本记录汇总设计评审、源码修复与本轮 Windows AppContainer/Linux CI 结果；未连接真实 QQ 邮箱、外部生产 IdP 或 Dot，未上传私密证据。

## 发现与修复状态

| ID | 风险与具体触发 | 处置 | 记录时状态 |
| --- | --- | --- | --- |
| R01 | 将 OAuth mail.authorize 直接当成当前任务的人类批准，连接权限被描述成逐封同意 | 写模式需操作者配置用户明确授予的有限 standing delegation；无 delegation 时只读；模型 purpose/approved 不建立同意 | 方案已收敛；最终 IdP/宿主同意承载待部署验收 |
| R02 | 每 grant <=100，但模型反复申请 grant 可无限重置额度 | 新增 `CloudDelegationBudget`；所有 grant 的完整额度先从整份 consent 的持久化总预算预留，写成功才批准，不退款 | 已修复；并发、重启和故障合成回归通过 |
| R03 | grant 只有账户绑定，多个 OAuth client 可共享 owner 的授权 | 首版固定一个 issuer、owner subject 和 client；配置和 verifier 拒绝多 client | 已实现并通过相关回归；不宣称多租户隔离 |
| R04 | 只在 OAuth 初始化或申请 grant 时检查权限，之后降权 token 可继续写 | 每请求验签，工具白名单按当前请求 scopes 筛选；写入前仍检查对应 scope、mail.authorize、owner policy 与 token 到期 | 已修复；请求上下文和授权合成回归通过 |
| R05 | JWT exp 秒与应用时钟毫秒比较，导致过期判定错误 | verifier 输出毫秒 expiresAt，Authority 使用毫秒；JSON token claims 保持标准秒格式 | 已修复；token 时间与授权回归通过 |
| R06 | HTTP 超时/断连只关闭 transport，业务 Promise 继续运行并在之后投递 | 将 HTTP AbortSignal 传入请求上下文；最终 SMTP/IMAP 写入检查取消状态；实际未结束工作不能靠超时反复释放并发槽 | 已修复；取消、最终检查和并发槽回归通过；已分派 SMTP 仍须按终态处理 |
| R07 | 附件 acquire、MIME 编译、邮箱选择等待后授权失效仍执行 | 复用 service 最终授权检查；SMTP gateway 在 MIME 完成后、建立 transport 前再次检查；IMAP 每次写前检查 | 已修复；授权与 SMTP 最终边界回归通过，真实邮箱未验收 |
| R08 | 使用任意 token key URL、错误 issuer/audience、ID token 或其他 client | 固定 HTTPS JWKS、禁止重定向、限定 RS256/ES256 与 at+jwt；要求 owner、client 和 audience；JWKS 限时限量 | 认证合成回归通过；具体外部 IdP 尚未联调 |
| R09 | 多实例分别恢复 grant 和发送状态，导致超额度或重复发送 | 首版单进程，预算/草稿分别持生命周期锁；SMTP 发送前持久化在途终态；未知结果不自动重试 | 存储与状态合成回归通过，Linux 包括 POSIX 测试；真实卷与崩溃部署演练未完成 |
| R10 | 把 HMAC 账本视为防回滚保证，删除/恢复旧卷后重置额度 | 明确 HMAC 只鉴别内容；部署保护同一持久卷、禁止回滚旧余额，operator 新 consent 才能续期 | 已加入部署文档；不具备硬件或外部不可回退计数器 |
| R11 | Windows 桌面批准被继续当作云端授权前提 | 云入口不使用 Windows 确认窗口；外部 OAuth + owner delegation + 宿主指令权限形成新边界 | 独立 cloud bundle 启动冒烟和 Linux CI 通过；真实云部署尚待验证 |
| R12 | 静态工具注解被当成授权/同意证明，或 OAuth scope 升级没有可识别提示 | 保留真实写工具注解；17 工具 securitySchemes 与认证错误元数据一致，保留既有 metadata | 已接线并通过适配器回归；bundle 资源元数据通过；实际宿主 scope 升级仍须 C07/C17 验收 |
| R13a / P2 | operator 收件人域名大小写与请求规范化规则不同，导致有效授权被错误拒绝 | 配置复用 `normalizeMailAuthorizationAddress`，统一地址比较规则 | 已修复；`cloud-authority.test.ts` 新增大小写回归通过 |
| R13b / P2 | 云端有效授权草稿仍套用 Windows 窗口 512 KiB 预检，较大正文被错误拒绝 | 窗口预检仅用于 `!requireAuthorization` 路径，保留其他邮件大小限制 | 已修复；`dot-authorization-integration.test.ts` 的 300k HTML 与 `confirmationRequired: false` 回归通过 |
| R13c / P2 | server socket 关闭后仍有已断连 SMTP 工作，过早关闭 journal 会丢失已知终态 | `handler.drain` 等待实际工作完成，server stop 在 drain 后关闭 journal | 已修复；HTTP drain 回归通过；真实 SMTP 已分派后不承诺可取消 |
| R14 | 嵌套状态目录创建前未逐级校验祖先，junction 可改变路径实际落点 | 创建 nested 目录前逐祖先 realpath 校验并拒绝 junction | `cloud-tests-001` 首次暴露后已修复生产代码；后续存储回归通过，清理故障另见下文 |

OpenAI 官方文档明确要求资源服务器自行验证访问令牌；工具注解辅助宿主判断，不替代服务端授权。认证方案和实现应据此验收，不能宣称与 Gmail 内部安全机制等同。[插件认证](https://developers.openai.com/plugins/build/auth)、[MCP 工具注解](https://developers.openai.com/plugins/build/mcp-server)

## 本轮验证与失败记录

- Windows AppContainer：`cloud-compile-003` typecheck PASS，`cloud-build-001` build PASS；`cloud-bundle-002` 对真实 bundle 的启动、health、资源元数据及未认证 POST 先拒绝均 PASS。
- `cloud-tests-001` 的祖先 junction 问题是生产缺陷，已修复；之后 `cloud-tests-002` 共 472 项，469 通过、1 项测试清理 `ENOTEMPTY` 失败、2 项 POSIX 跳过。保留原断言，仅修改测试 junction 清理后，`cloud-storage-003` 共 24 项，22 通过、2 项 POSIX 跳过。综合 470 个已执行用例通过，不能写成单次全套通过。
- Linux [CI 运行记录](https://github.com/FredericaBernkastel1/QQmail-plugin/actions/runs/39554963087)：提交 `ec440ee4` 的 npm ci、typecheck、选定 cloud/authorization 测试和 build 全部 success，包含两项 POSIX 测试。它不是全套 Windows 测试，也不证明 Docker 或生产持久卷已验证。
- 181 个公开依赖的当次公告检查匹配 0 条，不等于没有未知漏洞。纯 Python 清单生成工具 34 项检查及合成 CLI 生成通过；公开源码路径是 `scripts/render-cloud-plugin.py`，本地开发工具路径是 `tools/render-cloud-plugin.py`。

本节记录本轮汇总证据，失败记录与复验必须一起保留。Docker、生产公网 TLS、外部 IdP、实际 Dot 与真实 QQ 仍未验证，版本保持候选状态。

## 新增总预算模块的契约

`src/cloud/delegation-budget.ts` 使用注入的 `DraftJournalStorage`、独立复制的 32 字节 key，以及操作者提供的 `{consentId, policyDigest, maxOperations}`。初始化读取并认证全部 ledger 字段；同 consentId 的 digest 改变拒绝；新 consentId 只在旧账本认证后作为明确续期处理。

`reserve(units)` 串行检查余额并持久化，成功前不向上层返回可用授权。写入失败可能已经提交，因此当前进程进入 failed，余额显示为 unknown，后续 reservation 与再次 initialize 都失败。关闭等待正在进行的写入后清除内部 key 并释放锁；没有退款、MCP 重置或自动续期接口。

`tests/cloud-delegation-budget.test.ts` 覆盖并发预留、最后额度竞争、持久化屏障、写入提交前/后故障、重启余额、同 ID 政策改变、显式续期、字段篡改、错误 key、独占锁、close 等待及非法额度。相关合成回归已在上述 Windows 和选定 Linux 验证中通过；实际部署卷的可靠性仍须另验。

policyDigest 必须覆盖全部委托策略与账户/身份范围。服务器当前还将账户与凭据版本、issuer、owner、client 绑定到 account scope，因此这些改变需新同意并失效旧引用。账本文件和配置只有服务器操作者可以控制，不能交由 Dot 的任意文件工具管理。

## 发布前仍须明确的边界

- 本版单 owner、单 client、单账户和单实例，不提供多租户隔离、通用账户添加或 OAuth 令牌签发服务。
- 远程服务和外部 IdP 由用户选定的长期托管承担，不假设 Dot 的临时电脑能持久保存密钥、长期监听或成为公网服务器。
- 云端不暴露附件文件操作、账户设置、任意路径、通用代码执行或 Windows UI；读取邮件会把内容提供给宿主与模型上下文。
- 离线 JWT 验签不保证 IdP 侧撤销立刻传播；短 token 有效期、明确关闭写策略和必要的在线吊销机制需按部署要求验证。
- SMTP 已分派后不能因 HTTP 取消而保证“未发送”；必须保留 unknown/成功状态并查询状态，不能盲目重试。
- 没有 Docker、生产公网 TLS、外部 IdP、Dot 连接和真实 QQ 的验收结果；本轮合成/CI 通过不能覆盖这些项目。完整门槛见 [DEPLOYMENT.md](DEPLOYMENT.md) 的 C01–C22。

本审查没有修改工作区 AGENTS、发布成品或上传历史证据。实现验证已经完成上述范围，正式上线须补齐环境验收，不能把候选版本标成已接通 Dot 的生产服务。
