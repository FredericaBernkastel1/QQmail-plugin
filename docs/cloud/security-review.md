# QQmail 云端迁移安全评审

日期：2026-10-21。范围为远程 HTTPS MCP、外部 OAuth、固定单 owner/client 邮箱、可移植草稿存储和委托总预算。本记录只包含设计与静态源码审阅结论；未连接真实 QQ 邮箱、外部生产 IdP 或 Dot，未上传私密证据。

## 发现与修复状态

| ID | 风险与具体触发 | 处置 | 记录时状态 |
| --- | --- | --- | --- |
| R01 | 将 OAuth mail.authorize 直接当成当前任务的人类批准，连接权限被描述成逐封同意 | 写模式需操作者配置用户明确授予的有限 standing delegation；无 delegation 时只读；模型 purpose/approved 不建立同意 | 方案已收敛；最终 IdP/宿主同意承载待部署验收 |
| R02 | 每 grant <=100，但模型反复申请 grant 可无限重置额度 | 新增 `CloudDelegationBudget`；所有 grant 的完整额度先从整份 consent 的持久化总预算预留，写成功才批准，不退款 | 两个新文件已完成，待主代理隔离测试 |
| R03 | grant 只有账户绑定，多个 OAuth client 可共享 owner 的授权 | 首版固定一个 issuer、owner subject 和 client；配置和 verifier 拒绝多 client | 已见源码实现；不宣称多租户隔离 |
| R04 | 只在 OAuth 初始化或申请 grant 时检查权限，之后降权 token 可继续写 | 每请求验签，工具白名单按当前请求 scopes 筛选；写入前仍检查对应 scope、mail.authorize、owner policy 与 token 到期 | 已见认证及 Authority/service 接线；待并发/降权集成测试 |
| R05 | JWT exp 秒与应用时钟毫秒比较，导致过期判定错误 | verifier 输出毫秒 expiresAt，Authority 使用毫秒；JSON token claims 保持标准秒格式 | 已见修正；需未来/到期 token 回归 |
| R06 | HTTP 超时/断连只关闭 transport，业务 Promise 继续运行并在之后投递 | 将 HTTP AbortSignal 传入请求上下文；最终 SMTP/IMAP 写入检查取消状态；实际未结束工作不能靠超时反复释放并发槽 | 已见 Authority 检查 aborted；HTTP 代理报告延后清理与并发槽释放，已补回归；待统一隔离测试 |
| R07 | 附件 acquire、MIME 编译、邮箱选择等待后授权失效仍执行 | 复用 service 最终授权检查；SMTP gateway 在 MIME 完成后、建立 transport 前再次检查；IMAP 每次写前检查 | 本地基线已修；云 token/请求 signal 分支需要新证据 |
| R08 | 使用任意 token key URL、错误 issuer/audience、ID token 或其他 client | 固定 HTTPS JWKS、禁止重定向、限定 RS256/ES256 与 at+jwt；要求 owner、client 和 audience；JWKS 限时限量 | 已见 `auth.ts` 实现；具体外部 IdP 尚未联调 |
| R09 | 多实例分别恢复 grant 和发送状态，导致超额度或重复发送 | 首版单进程，预算/草稿分别持生命周期锁；SMTP 发送前持久化在途终态；未知结果不自动重试 | 存储代码已见；重启/锁/崩溃/实际 Linux fsync 待验收 |
| R10 | 把 HMAC 账本视为防回滚保证，删除/恢复旧卷后重置额度 | 明确 HMAC 只鉴别内容；部署保护同一持久卷、禁止回滚旧余额，operator 新 consent 才能续期 | 已加入部署文档；不具备硬件或外部不可回退计数器 |
| R11 | Windows 桌面批准被继续当作云端授权前提 | 云入口不使用 Windows 确认窗口；外部 OAuth + owner delegation + 宿主指令权限形成新边界 | 已见独立 cloud 入口，实际云运行尚待验证 |
| R12 | 静态工具注解被当成授权/同意证明，或 OAuth scope 升级没有可识别提示 | 保留真实写工具注解；逐工具 securitySchemes 与认证错误元数据必须一致 | 已新增纯响应适配器与 14 项测试，补 17 工具 OAuth 元数据和 scope 错误 challenge；待入口接线及统一隔离测试，仍是 C07/C17 上线门槛 |

OpenAI 官方文档明确要求资源服务器自行验证访问令牌；工具注解辅助宿主判断，不替代服务端授权。认证方案和实现应据此验收，不能宣称与 Gmail 内部安全机制等同。[插件认证](https://developers.openai.com/plugins/build/auth)、[MCP 工具注解](https://developers.openai.com/plugins/build/mcp-server)

## 新增总预算模块的契约

`src/cloud/delegation-budget.ts` 使用注入的 `DraftJournalStorage`、独立复制的 32 字节 key，以及操作者提供的 `{consentId, policyDigest, maxOperations}`。初始化读取并认证全部 ledger 字段；同 consentId 的 digest 改变拒绝；新 consentId 只在旧账本认证后作为明确续期处理。

`reserve(units)` 串行检查余额并持久化，成功前不向上层返回可用授权。写入失败可能已经提交，因此当前进程进入 failed，余额显示为 unknown，后续 reservation 与再次 initialize 都失败。关闭等待正在进行的写入后清除内部 key 并释放锁；没有退款、MCP 重置或自动续期接口。

`tests/cloud-delegation-budget.test.ts` 覆盖并发预留、最后额度竞争、持久化屏障、写入提交前/后故障、重启余额、同 ID 政策改变、显式续期、字段篡改、错误 key、独占锁、close 等待及非法额度。这里仅记录测试已编写，执行结果由主代理本轮隔离验收输出提供。

policyDigest 必须覆盖全部委托策略与账户/身份范围。服务器当前还将账户与凭据版本、issuer、owner、client 绑定到 account scope，因此这些改变需新同意并失效旧引用。账本文件和配置只有服务器操作者可以控制，不能交由 Dot 的任意文件工具管理。

## 发布前仍须明确的边界

- 本版单 owner、单 client、单账户和单实例，不提供多租户隔离、通用账户添加或 OAuth 令牌签发服务。
- 远程服务和外部 IdP 由用户选定的长期托管承担，不假设 Dot 的临时电脑能持久保存密钥、长期监听或成为公网服务器。
- 云端不暴露附件文件操作、账户设置、任意路径、通用代码执行或 Windows UI；读取邮件会把内容提供给宿主与模型上下文。
- 离线 JWT 验签不保证 IdP 侧撤销立刻传播；短 token 有效期、明确关闭写策略和必要的在线吊销机制需按部署要求验证。
- SMTP 已分派后不能因 HTTP 取消而保证“未发送”；必须保留 unknown/成功状态并查询状态，不能盲目重试。
- 没有外部 IdP、HTTPS、Dot 连接和真实 QQ 的验收结果；旧 361 项本地合成通过不能覆盖这些项目。完整门槛见 [DEPLOYMENT.md](DEPLOYMENT.md) 的 C01–C22。

本审查没有修改工作区 AGENTS、发布成品或上传历史证据。新源码与文档仍需主代理统一构建、隔离运行和版本化验收。
