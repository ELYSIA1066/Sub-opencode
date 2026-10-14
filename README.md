# Codex → OpenCode 子 agent

这是一个 stdio MCP 服务，让 Codex 把任务委派给 OpenCode。MCP 先完成接入，在每个新任务提交模型之前准备用户默认共享服务：健康时复用；注册缺失或已严格证明失效时安全启动和登记。共享连接、SDK 身份核验及任务回收保持只读服务发现，不启动、不切换、不停止服务。身份未知、服务仍存活但异常、注册竞争或版本不兼容时返回 `service_unavailable`。每个任务绑定本次核验身份，不重放已提交的 prompt。MCP 退出后共享服务继续运行；`context_id` 保留持久续聊，attach 命令使用实际登记地址。

源码仓库包含生产代码、正式测试与可复用工具。`work/` 保存本机生成的历史报告、验收证据和预算账本，不纳入版本控制；下文涉及的历史现场路径需要在原运行机器上查看。认证文件、服务注册和 context 数据库也不随仓库发布。

## 要求

- Node.js 22.12 或更新版本
- 已安装并完成模型认证的 OpenCode CLI

安装依赖并检查：

```powershell
npm install
npm run typecheck
npm test
```

启动 MCP 服务：

```powershell
npm start
```

默认共享路径是用户主目录下 `.local\state\opencode\service.json`。可以显式运行 `npm run service:prepare`，它与任务前自动准备共用实现。注册异常时，只有原 PID 已退出，或进程创建时间、明确的非 OpenCode 可执行文件及无端口监听共同证明 PID 复用，才条件备份旧注册；未知状态保留现场。维护锁记录进程身份，不使用 TTL，竞争者有界等待；归属不明的旧锁不自动删除。

启动仅使用已安装的官方 CLI 2.0.18：`serve --hostname 127.0.0.1 --port 0`，不调用 `Service.ensure` 或 `serve --service`。子进程沿用原用户配置与数据目录，服务访问密码独立生成，不复制模型凭据。监听、PID、SDK 版本核验后，以不覆盖目标的原子操作发布受保护的注册。旧注册备份保留；登记竞争仅清理本次未发布的子进程，已登记共享服务永远不由 MCP 停止。准备最多 30 秒且计入任务总期限，失败清理另有界执行。状态无法确认时保留锁和现场。

`OPENCODE_AUTO_PREPARE=false` 可禁用自动准备；自定义注册路径始终只复用，正式验收显式关闭自动准备。`OPENCODE_REUSE_ONLY` 仍作为兼容变量被忽略。准备只发生在任务开始前，SDK 调用和任务回收不会触发恢复。

`node --import tsx tools/service-prepare-check.ts` 是显式的零 prompt 隔离 CLI 验证：两个维护进程竞争、健康复用、维护退出后存活，以及新 MCP 关闭不停止服务。它只在 SDK 身份和启动 PID 一致时停止本次自建的隔离测试服务，未知状态或目录清理失败时保留现场并返回非零。

本地测试目录的删除还要求进程退出、目录归属和路径边界均已确认。清理先完整枚举文件，拒绝符号链接、目录重定向和硬链接，再逐文件核对并删除，最后删除空目录；任何未知状态都保留现场。

Codex 的 MCP 配置示例（按实际安装位置修改路径）：

```toml
[mcp_servers.opencode-agent]
command = "node"
args = ["D:/codexprojects/codex-subagent-opencode/node_modules/tsx/dist/cli.mjs", "D:/codexprojects/codex-subagent-opencode/src/mcp.ts"]
env = { OPENCODE_COMMAND = "C:/path/to/opencode-cli.exe" }
```

若 OpenCode CLI 已加入 `PATH`，可省略 `env`。否则将 `OPENCODE_COMMAND` 指向 OpenCode CLI 可执行文件；服务发现可以复用 Desktop 的已注册服务，但返回的终端连接命令也会使用此路径。

## 工具

`delegate_to_opencode` 参数：

- `task`：委派给 OpenCode 的任务描述。
- `workspace_root`：现存工作目录的绝对路径。
- `context_id`：省略时新建上下文；传入先前结果中的值时继续对应 session。映射保存在本机 SQLite 中，MCP 进程重启后仍可恢复。
- `model`：可选，格式为 `provider/model-id`。省略时使用配置的默认模型 `opencode-go/deepseek-v4.1-flash`。
- `permission_scope.fileAccess`：`read_only` 或 `workspace_write`。
- `permission_scope.shellCommands`：本次允许执行的完整 shell 命令字符串。默认为空数组。

文件权限仅覆盖工作目录内的路径；拒绝目录穿越、工作区外路径和逃逸工作区的符号链接。`read_only` 会直接拒绝 edit；空 `shellCommands` 会直接拒绝 shell。允许的权限类别仍由事件流逐项审核，Shell 权限仅对本次明确列出的完整命令作一次性批准。事件监听就绪后才开放本次规则。

成功结果包含 `context_id`、OpenCode `session_id`、文本结果、服务地址和 `attach_command`。响应只会在 prompt 返回的 user ID、事件流中的 inbox 和 assistant step ID、以及消息历史边界三者匹配后返回；缺少关联证据、历史记录分页异常或最终 assistant step 未结束时会失败，不回退到旧结果。assistant 的 quota/provider error 优先于空文本处理，并保留错误类型、HTTP 状态和消息。

每次委派有一个总执行时限，包含服务发现、session 操作、执行和结果读取。失败结果包含 `error_code`；常见值包括 `task_timeout`、`event_stream_failed`、`permission_reply_failed`、`permission_rejected`、`provider_quota`、`turn_unmatched`、`permission_reset_failed`、`context_busy`、`session_quarantined` 和 `context_store_failed`。权限回复失败（包括 HTTP 状态错误）归为 `permission_reply_failed`，不等于事件流断连；回复发生在 prompt 提交后时，结果会隔离 context，因为服务端是否应用了决定无法确认。`permission.replied` 事件按 requestID 串行入队并去重：只有同一 id 的显式 `reject` 才判定为拒绝；若 reply 返回 HTTP 404，则在 ≤1 秒内等待该 id 的显式 `reject` 对账，对账成功按已拒绝处理且不因该回复隔离 context，否则按 `permission_reply_failed` 处理。取消会中断活动任务。任务退出后最多用 10 秒回收：发送 interrupt 后，以独立请求调用 `session.wait` 确认远端执行已空闲；之后排空本地请求和事件流，并尝试恢复 deny-all、读取 session 状态验证。即使 `session.wait` 失败，也会继续尝试权限恢复；但只有 wait 成功且 deny-all 更新及读取验证均成功，才释放 lease。仅本地请求结束或权限规则为 deny-all 不代表远端任务已停止；interrupt/wait/权限回收任一步骤失败或超时，会在 SQLite 中持久隔离 session 和 context，后续调用必须使用新 `context_id`。跨进程 SQLite lease 会阻止同一 context 同时被两个 MCP 调用操作。若 MCP 在任务中异常退出，残留 lease 会一直返回 `context_busy`，不会按时间或 PID 自动过期；需人工选择新 context，旧记录保留供诊断。数据库忙或损坏按 fail-closed 处理。session.wait 用于确认远端空闲，权限 API 返回的 deny-all 规则仍不是独立的执行效果证明。

权限生命周期诊断以 JSON 行写入标准错误，提供阶段、时间/耗时、截止时间剩余量、进程与服务身份，以及可关联的哈希标识。记录权限决策类别和允许的 shell 命令数量，不记录任务正文、命令、资源、权限消息、认证头或 SDK 原始错误文本；服务端版本不可用时记为 `unknown`。本地取消只表示停止等待，不证明远端回复请求已停止；未完成的回复会继续计入在途操作并记录其迟到结果。

事件流 EOF、断连或连接错误会使当前 endpoint/client 缓存失效；失败不会重放已提交的 prompt。后续新任务重新发现服务，并为结果保留本次捕获的服务地址。session 若已经提交 prompt 但无法确认结果/回收，会持久隔离，不能通过重连继续复用。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENCODE_COMMAND` | `opencode` | OpenCode CLI 命令或绝对路径 |
| `OPENCODE_MODEL` | `opencode-go/deepseek-v4.1-flash` | 未在工具调用中指定模型时使用的模型，格式为 `provider/model-id` |
| `OPENCODE_HOST` | 已废弃（忽略） | 地址不从 host 派生，自动准备固定使用回环地址 |
| `OPENCODE_PORT` | 已废弃（忽略） | 自动准备使用动态端口，连接使用实际登记端口 |
| `OPENCODE_PROMPT_TIMEOUT_MS` | `18000000` | 每个委派任务的总执行期限，默认 5 小时，包含服务准备、连接和模型执行 |
| `OPENCODE_CONTEXT_DB_PATH` | Windows: `%LOCALAPPDATA%\codex-subagent-opencode\contexts.sqlite` | 本机上下文映射数据库路径 |
| `OPENCODE_SERVER_USERNAME` | 已废弃（忽略） | 认证只从 registry 记录读取，不会回退到环境变量 |
| `OPENCODE_SERVER_PASSWORD` | 已废弃（忽略） | 认证只从 registry 记录读取，不会回退到环境变量 |
| `OPENCODE_REUSE_ONLY` | 忽略 | 兼容变量；不控制自动准备 |
| `OPENCODE_AUTO_PREPARE` | `true` | 仅默认注册支持任务前准备；`false` 禁用，自定义路径强制禁用 |

OpenCode service registry 的读取路径仍按显式配置、XDG 和用户默认路径解析。自动准备仅限用户默认路径，自定义路径只读复用。连接地址和认证来自登记记录；旧 host、port 和服务密码环境覆盖仍被忽略。准备控制器与只读连接职责分离：控制器仅备份已证明失效的记录并排他登记新实例，连接模块不负责启动或恢复。

服务地址、版本、健康状态和认证由注册及 SDK 共同核验；任务准备完成后固定本次身份，后续不转向其他实例。MCP 关闭不停止共享服务。兼容变量 OPENCODE_REUSE_ONLY 不再控制准备行为，OPENCODE_AUTO_PREPARE 控制用户默认路径的任务前准备。

首次关闭信号启动共享 10 秒期限：立即拒绝新委派、取消在途任务并并行关闭 MCP transport，同时释放本地连接缓存。最多 7 秒用于任务退出、权限锁定验证和隔离状态持久化。库层关闭会在清理未完成时拒绝；CLI 清理失败或超时以非零状态退出。活动任务未退出时数据库保持打开；不确定的 lease、quarantine 会保留供诊断。关闭只涉及本进程的本地状态，绝不会停止、注销或移动共享 OpenCode 服务。

## 架构边界

`src/service-bootstrap.ts` 负责显式维护和任务前准备，使用独立的 Windows 文件句柄辅助实现条件备份、排他发布和锁释放。MCP 装配层注入该准备依赖；连接模块、SDK 适配器和任务回收均不能调用它。

`src/delegation.ts` 是兼容 MCP 的委派入口与任务协调器，执行结果只在 `task-cleanup.ts` 返回回执后映射成最终输出。`session-permission-guard.ts` 管理锁定、按任务开放 scope、撤销和读回验证；`turn-result-matcher.ts` 将当前 inbox、assistant step ID 与分页 user 边界关联；`opencode-sdk-adapter.ts` 集中 SDK client 生命周期和调用转发，不作权限、模型回退或任务重放决策。清理回执记录 idle、deny-all、quarantine 与 lease 状态。`deadline.ts` 提供共享的限时及取消竞争工具。

`src/opencode-server.ts` 是 `SharedConnection` 之上的兼容外观，只负责发现、复核并复用已注册的共享服务；`src/shared-connection.ts` 负责读取 registry、校验实例身份与健康状态，并用官方 SDK 建立只读连接；`src/service-registry.ts` 统一注册路径解析和身份只读解析。它们绝不启动、停止或写入服务注册；共享服务始终不会被停止，身份或退出状态不明确时保留现场并 fail closed。

验收脚本只采用共享复用模式：只读官方 registry，不启动、停止或接管共享服务，也不使用私有注册或隔离 OAuth 凭据。预算以原账本现场计数为准。新 run 的注册选择顺序是显式参数、`OPENCODE_SERVICE_REGISTRY_FILE`、用户/XDG 默认路径，并保存规范化绝对路径及路径摘要。续跑以 manifest 中的路径和服务身份为准，继承 XDG 不改变目标；修改已保存路径或显式参数冲突都会在提交前失败。验收 MCP 子进程显式接收该路径。示例：`npm run acceptance:preflight -- --registry-file <absolute service.json>`；续跑 `npm run acceptance:live -- <runId> case3-recheck [--registry-file <same absolute service.json>]`。不会修改全局环境、注册、原账本或旧失败 run。

零 prompt 预检在清单指定工作区查询模型元数据：20 秒总期限、最多 6 轮、轮间隔 500 毫秒，每轮依次查询 provider 和 model。连续两轮发现启用的指定 Go 模型才通过；仅列表为空或目标缺失时继续查询，认证、连接、工作区或共享身份异常立即失败。持续缺失记录为 `model_metadata_unavailable`。预检由新 MCP 进程创建并读回独立 SQLite，另创建 deny-all 探针会话，确认没有消息后删除；这些检查不证明真实模型认证。

上下文数据库保存 `context_id`、OpenCode `session_id`、规范化工作区路径、时间戳、临时 lease 与隔离标记，不保存对话正文、权限范围或认证信息。lease 仅在 owner token 匹配且调用成功回收后释放。每次续聊仍按当次 `permission_scope` 重新执行权限控制。若 OpenCode 中的 session 已删除或不可访问，桥接器会返回错误并要求新建 `context_id`，不会静默创建替代 session。数据库文件损坏或无法访问时，服务会明确报错；请先备份并修复或配置新的数据库路径。既有 `contexts` 映射会原样兼容保留，新增安全表不覆盖旧映射。

## 验收边界

模拟服务测试覆盖权限策略、上下文与 session 复用、SQLite 跨进程 lease、持久隔离、服务健康检查、无效工作目录、启动失败、断连缓存失效、超时及取消，以及只读共享连接，以及任务前安全启动、PID 复用、排他登记、维护锁竞争与未知状态 fail-closed。`live <runId> case3-recheck` 需要既有的 ready run：attempt marker 保证同一 run 只能重查一次，且单次只向全局 prompt 预算预留一次（失败也计入，不重试）。真实 OpenCode 端到端验收需要本机安装并认证 OpenCode；完成后可用工具返回的 `attach_command` 检查共享会话。

消息采证只分页到本轮唯一 inbox 对应的 user ID；找到该边界后不再读取更早历史。边界前的分页错误仍按失败处理，不以短页或错误充当历史结束。Case 3 在消息采证前单独保存脱敏事件关联记录，避免分页故障同时丢失权限证据。未形成待处理请求级联拒绝的真实场景，不能作为旧权限回复 404 问题的验收通过依据。

OpenCode 2.0.18 的分页协议要求 cursor 与 order 互斥：生产结果定位与验收采证只在第一页传 `order: desc`，后续仅传 cursor。正式分页回归位于 `test/acceptance-pagination.test.ts`；绑定历史失败会话的只读复现脚本已归档，不作为通用入口。

`npm run acceptance:permission-probe -- <runId>` 显式执行零模型权限 API 探针：新建锁定的测试会话，订阅后创建三个权限请求，核验 shell 拒绝的级联结束与旧请求 404，最后锁定、确认空闲并删除。执行最多 30 秒，清理总计最多 10 秒；失败保留现场并阻止受控 live。它不执行工具、不伪造工具来源，不作为完整 MCP 工具验收。

`npm run acceptance:live -- <runId> case3-recheck --controlled` 要求同一 run 的权限探针通过，仍共用原 16 次账本和单次 marker。独立测试 MCP 使用生产委派器与权限队列，仅缓冲同 session、同一步的 shell/read/read 问询，收齐后优先交付 shell；原始接收顺序和交付顺序分别记录。5 秒未收齐就按原顺序释放，场景未验证；生产 MCP 没有测试开关。受控通过不等于正常调度通过，未实际发生 404 时真实工具的 404 对账仍记为未触发。

`npm run acceptance:live -- <runId> usability` 使用新 run 的空工作区和生产 MCP，最多两次 prompt：先正常读取、修改并核对文件，再关闭第一个 MCP、用同一数据库和 context 启动新 MCP 续聊。两次请求省略 model，测试子进程清除模型环境覆盖，验证默认 Go 模型；续聊还须返回只出现在第一轮提示中的随机标记。每轮必须有本轮 SDK inbox、assistant 和工具证据、正确文件及回复、deny-all、空闲、lease 释放和正常进程退出。首轮不通过则不提交第二轮。沿用原 16 次账本，`usability-attempt.json` 防止重放；所有结果保存于 `usability.json` 和逐轮证据。成功且归属、安全状态明确时才清理本轮临时根；共享服务和历史记录保留。

Case 3 新采证使用 evidenceVersion 3，保留本轮执行生命周期、中断 reason、SDK durable sequence 与接收顺序。桥接器实际发起 interrupt 时记录脱敏会话关联、调用来源和完成结果；诊断故障不改变回收期限或权限决定。控制审计要求连续 auditSequence、原始与交付事件一一对应、shell/read A/read B 顺序、完整 barrier 和结束计数；单个 `complete: true` 不能作为通过依据，截断或缺失日志保持未验证。

已核对官方 v2.0.18 提交 `cd9a14a6b688d4021bee381dfd39d2cef9c0f862`：带反馈的 shell 拒绝走 CorrectedError；级联拒绝的读取请求走 DeclinedError，随后读取和 assistant 记录 aborted 并结束执行。未显式标记的该中断在此版本默认 reason 为 shutdown，不能仅凭这个值认定服务关闭或权限拒绝。验收仅在版本匹配、三请求拒绝精确关联、本轮唯一执行区间、没有独立中断、文件及回收安全全部成立时接受读取及 assistant 的 aborted；受控模式还必须通过完整控制审计。其他错误、取消、超时、断流和不匹配的中断仍失败，必要证据缺失则未验证。MCP 输出及权限行为不变；旧失败记录不重写，持久日志只有 synced 标记时不视为恢复了执行证据。

Case 3 保留 SDK 原始错误类型。`tool.execution` 只有在工具来源、session、请求 ID 和显式 reject 全部匹配时才能支持权限拒绝证明；不能以任意工具错误或单个 404 推断拒绝。

## 代码清理记录

绑定旧共享实例的恢复脚本、固定日期的归档脚本、历史会话分页复现脚本和 `newtest` 副本已移入 `work/cleanup/2026-10-02T16-05-06-333Z-ea7cb376-16ae-4b4c-959a-ab7214c8cb83/archived/`。原路径、源码哈希和归档回执保留于同一目录；历史源码仅供审计及恢复，不是当前支持的执行入口。`newtest` 中有价值的清理边界、junction 和回执检查已迁入正式测试。

通用基线工具 `node --import tsx tools/cleanup/baseline.ts` 仍可显式运行，导入不会自动产生快照。`move-registry-if-unchanged.ps1` 仍被正式离线回归使用，保留为独立的受测维护辅助；MCP、共享服务准备和正式验收入口均不调用它。

内部配置类型不再携带 host、port、reuseOnly、username、password，服务管理选项也不再声明旧私有服务字段。旧环境变量继续接受并忽略；MCP 输入输出及四种状态保持兼容。SDK 客户端提供方式、测试注入点和身份核验链路本轮保留。类型检查已启用未使用局部变量和参数检查。
