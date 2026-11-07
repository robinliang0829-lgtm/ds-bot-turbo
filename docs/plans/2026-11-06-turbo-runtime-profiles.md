# Turbo：OpenMausBot 工具控制与 Magpie 连接

日期：2026-11-06。状态：首批实现，随本分支提供。研究依据见 [RESEARCH](../turbo/RESEARCH.md)，后续范围见 [ROADMAP](../turbo/ROADMAP.md)。

## 目标

在 DS-Bot 的长期身份、独聊、群成员 Session 和历史分段上增加实际可执行的 OpenMausBot 工具选择能力，并让每个 Bot 选择 Magpie 连接。继续使用 DSH 的模型、凭据、审批和工具执行服务，不引入第二套 Electron 服务端，不修改 DSH。

## 连接实例与模型

设置页的 Models → Connect Magpie 创建一个新的 `magpie-<uuid>` provider route。每次创建都有不同的 route id 和 credential reference；相同模型 ID 可同时出现在多个连接中。凭据由 DSH credentials 保存，Bot 记录只保存 `provider/model` 与 effort。连接共享仍是 profile 范围，**这不是每 Bot 的私有账号 ACL**。

默认端点 `http://127.0.0.1:3425/v1`，默认 OpenAI Responses，可选 Chat Completions。发现操作只请求 `/models`，不生成付费对话；支持手工输入带 `/` 的模型 ID。保留服务端报告的上下文、输出容量、文本/图片输入和 DSH 支持的 effort，不编造模型名或把未知 effort 映射成另一等级。发现有超时、大小限制，拒绝重定向，不把响应正文或凭据放入错误消息。

本机未鉴权服务可不填 key；由于 DSH 的 OpenAI 适配器要求非空凭据，该连接自己的凭据引用会写入非秘密占位值 `magpie-local`。只对 localhost、127.0.0.1、[::1] 允许此行为；远程必须填写 key。不要将占位值当成服务认证或网络隔离。

Bot 设置里的 **Keep this model connection** 保存 `modelFallback:false`。启用后：

- 指定连接不可用时保留选择并报错，不改为其他 Bot、默认或上次连接。
- 独聊、群成员和新分段发送前复核所选 route/model；不匹配不发送。
- 群 Session 选择失败必须向上传播；复制不可用的固定连接 Bot 时拒绝复制。
- 标题等宿主辅助请求遵循 DSH 自己的模型策略。
- 用户仍可主动改选模型；此选项阻止的是自动回退。

旧 Bot 不设置这个字段时保留上游回退行为。选择 Session 模型仍使用上游串行队列，在 `finally` 恢复原 DSH 默认；恢复失败会告警，这并不提供跨宿主所有 UI 操作的事务。

## OpenMausBot 工具选择移植

`src/shared/tool-scope.js` 从 OpenMausBot 固定提交的 `shared/tool-scope.ts` 移植，保留 allow/deny、deny 优先、继承与空白名单的区别、非法输入拒绝、MCP 匹配及权限扩大检查。来源、修改和许可证写入根 NOTICE。未移植 OpenMausBot 特有的 agents 别名。

用户在 Bot 设置里保存 `toolScope`：

```json
{"allow":["native:read","mcp:github:*"],"deny":["mcp:github:delete"]}
```

`native:name` 选择一个原生工具，`native:*` 选择所有原生工具；`mcp:server:name` 选择指定 MCP 服务的工具，只有工具名可为 `*`，服务名不支持通配符。省略 allow 继承可用工具，`allow:[]` 禁止全部工具；deny 始终优先。关闭限制删除字段，保留上游行为。

执行集成使用公开 `ctx.tools.guard`。每次执行从 Agent Session 找所属 Bot 并读取最新配置，独聊、群成员及新旧分段都使用同一策略；已生成的调用也在执行前复核。模型侧的 update_bot 工具不能修改这些用户权限字段。Bot 的系统提示说明选择器与拒绝行为。

**不重写 llm/stream 请求。** DSH 的 LOOP 请求来自 Session 日志且绑定 prepared adapter；复制请求并重开 stream 会破坏绑定，工具历史也可能重新生成目录。这里只读取请求来校验模型和配置。工具 schema/SDK 描述可能仍然可见，看到工具不等于有执行权限。

PTC 的 `run_code` 是传输入口，不等同于所有原生能力：非空策略保留入口，各嵌套工具调用经同一 guard。`allow:[]` 或显式 `deny:["native:run_code"]` 禁用入口。`deny:["native:*"]` 针对实际原生工具，仍可通过入口调用允许的 MCP 工具。

DSH 对某些 MCP 工具名的转换不可逆。包含歧义分隔符或哈希后缀的名字在显式策略下保守拒绝，不能猜测所属服务。普通未设策略的 Bot 不受这一限制。

## CLI 与运行中变更

CLI 自带的文件、命令等工具可能不经过 DSH guard，因此不得声称同一个开关能约束它们。给当前或已应用 CLI 连接的 Bot 设置策略会在写入前拒绝；已设策略的 Bot 不能改到 CLI。请求入口也拒绝持有策略的 CLI 调用。

运行时按 Bot 计数尚未结束的 CLI stream，包含群 Session。即使用户先把模型改成 API，只要旧 CLI 请求未结束，保存工具策略仍会拒绝。用户需要停止或等待 CLI turn，再切换 API 连接，最后启用限制。该策略不会撤销已经完成或已开始执行的工具操作。

## 技能与接口的边界

沿用上游每 Bot 的 `capabilities` 挂载和技能文本。接口实例可以用不同名称的 MCP capability，Bot 分别挂载；执行策略可进一步限定服务和工具。通用连接器的 `offFor`、全局工具、工作目录原生技能和 CLI 技能仍遵循上游语义。完整私有连接、私有技能库与账号 ACL 留给后续里程碑。

`runtime-profile.js` 是独立的严格解析器，示例展示 model connection / interface / skill 显式授权及冲突拒绝；**当前生产发送不调用它**。不要据其测试宣称生产已经实现 connection ownership。

工具选择也不是 OS 沙盒：允许 shell、网络或文件工具，就允许它们在 DSH 宿主权限下执行。审批与文件沙盒仍由 DSH 决定，本移植不改变审批默认值。

## 验收

单测检查解析器、真实 guard、Bot 归属、错误请求不发送、配置无部分写入、CLI 活动计数、复制及群模型失败、UI 编辑与连接创建。公开 DSH 的隔离 profile 加 mock 模型用于主机 smoke；用户实际配置和聊天不参与测试。客户端从源码重建，提交生成文件；发布源代码不表示已给用户现有 DSH 安装升级。
