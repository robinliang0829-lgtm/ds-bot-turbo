# DS-Bot 与 OpenMausBot 源码研究

日期：2026-11-06。目标：在 DS-Bot 上建立 ds-bot-turbo，融合 OpenMausBot 的交互方式，让每个 Bot 明确选择自己的模型连接、接口账号和技能。

这是源码研究与第一阶段设计依据；不代表融合界面或真实账号隔离已经上线。

## 研究基线与许可

- 开发基线：[Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot/tree/434e9daa474da8991fa525253e65df2cc995cdf5)，`dev` 提交 `434e9daa474da8991fa525253e65df2cc995cdf5`，版本字段为 `0.3.0`，提交主题为 release preparation。公开仓库从上游 fork，保留历史及 Apache-2.0 归属。上游 `main` 当时是 `71d344bf193f3f18185f25de3d8e5c483046910a` / `0.2.7`。
- OpenMausBot：[milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot/tree/fb31cb7dc56a90a00a6f07001219335a1afdff08)，源码版本 `0.1.143`，归档 ZIP 的 comment 确认提交 `fb31cb7dc56a90a00a6f07001219335a1afdff08`。以下链接固定到该提交。
- 已安装的 DS-Bot `0.2.4` 也做了只读对照，但它不是本项目开发基线；旧版发现不能直接作为新版缺陷报告。
- DS-Bot 和 OpenMausBot 的开源部分均为 Apache-2.0。OpenMausBot 的 [enterprise/LICENSE](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/enterprise/LICENSE) 另有商业限制，`enterprise/` 不进入 Turbo。本分支已移植 `shared/tool-scope.ts` 的开源代码，来源与修改记录在 [NOTICE](../../NOTICE)；未复制 enterprise 代码或桌面资源。后续移植同样必须逐文件记录来源、修改、许可证及适用 NOTICE。商标、logo、字体、图标不能仅凭主仓库许可证推定可随意复用。

## DS-Bot 已经具备的基础

| 需求 | 源码事实 | 对 Turbo 的意义 |
|---|---|---|
| Bot 独立身份与历史 | [roster.js](../../ds-bot/src/host/roster.js)、[store.js](../../ds-bot/src/host/store.js) 保存 Bot 并索引其独聊、群成员及历史分段 Session | 保留身份和存储，不新造第二套 Bot 数据库 |
| 每 Bot 模型与思考等级 | [models.js](../../ds-bot/src/host/models.js) 维护 `bot.model`、`bot.effort`，向独聊和群成员 Session 应用 | 不是从零添加模型下拉框；重点是稳定的连接实例绑定 |
| 每 Bot 技能/MCP | [capabilities.js](../../ds-bot/src/host/capabilities.js) 共享定义库，按 `bot.capabilities` 向 Agent 挂载 | 复用挂载生命周期；补齐接口账号实例与完整有效能力视图 |
| 本地 Agent CLI | [local-agents](../../ds-bot/src/host/local-agents/) 已适配多种 CLI，并通过 DSH 路由与工具桥运行 | 不需要为了 Codex/Claude CLI 引入 OpenMausBot 整个服务端 |
| 通用连接器 | [connectors/index.js](../../ds-bot/src/host/connectors/index.js) 已支持 OAuth、key、MCP、邮箱、按 Bot 关闭 | “关闭某 Bot”仍不同于“每个 Bot 使用不同账号实例” |
| 桌面与 Web | 同一个插件运行在 DSH；[app](../../app/) 提供独立桌面壳 | 优先在现有插件中融合体验，后续再发布 Turbo 桌面包 |

### 模型选择独立，不等于账号独立

[providers.js](../../ds-bot/src/host/providers.js) 的 `addProvider` / `setProviderKey` 使用 DSH 的配置与凭据服务；provider route 的凭据引用在 profile 范围内共享。同 provider 的两个 Bot 并不自然拥有不同 API Key。

可复用的桥梁是**独立 provider route id**：不同账号映射不同 route，Bot 只引用 connection id；相同账号要共享时，显式授予多个 Bot 同一个 connection。连接登记和凭据保存仍交给宿主，Bot 状态只存引用。route 名不同只是路由基础，不构成操作系统安全边界。

### 当前回退与群聊处理需要单独验收

上游开发基线的 `desiredModel` 会在指定模型消失后回退到已应用模型或默认模型。本分支增加用户控制的 `modelFallback:false`：固定连接不可用时拒绝发送，群 Session 选择失败向上传播，复制时也不替换连接。未启用该选项的旧 Bot 保留上游行为。

上游 `selectSessionModel` 串行选择后恢复全局默认，但选择抛错时没有 `finally` 恢复路径。本分支已加入 `finally`，并用失败选择的 mock 回归验证；恢复失败仍为告警，这不是跨所有 DSH UI 操作的事务。

开发分支已经新增 `sessionSelections`，会重新核对群 Session；这修正了旧版 Bot 级“已应用”字段不能反映群会话的部分问题。仍需检验群选择失败后不在错误路由上发送，以及独聊、群聊、换段和辅助请求是否使用同一解析规则。

### 能力挂载不是完整隔离

能力库是共享的，单 Bot 挂载是增量行为。宿主全局工具、CLI 原生技能和工作目录技能也可能可见。前端勾选框及 Bot 的列表无法证明未勾选工具不可调用。

`connectors/index.js` 的 `offFor` 默认允许已连接的账号给其他 Bot 使用；连接器 nonce 网关注入凭据，与 shell 中的 secret scope 是不同通道。Turbo 必须在模型发送和工具执行时都复核授权，不能仅隐藏 UI。

## OpenMausBot 值得采用的机制

### 稳定实例身份

[shared/wire.ts:50](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/shared/wire.ts#L50) 的 `ModelSelection` 是 `{ instanceId, model, effort?, variant? }`。`instanceId` 与 provider 或 model 名不同，才是账号/端点实例身份。

[server/store.ts:2037](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/server/store.ts#L2037) 以线程覆盖或 Bot 默认生成每次执行的配置；[server/index.ts:7642](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/server/index.ts#L7642) 查找指定实例，不存在时拒绝请求。这种“明确引用、失效报错”的语义已用于 Turbo 第一阶段解析器。

[openai-compat.ts](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/server/drivers/openai-compat.ts) 支持多实例。[config.ts:1103](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/server/config.ts#L1103) 的 `instanceOwnsRouting` 会避免将工作区通用凭据注入自带端点的实例。Turbo 的实际连接创建也必须保持端点与凭据成对绑定。

### UI 按小块移植

- [styles.css](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/src/styles.css) 的 app/panel/raised/ink/accent/edge 语义 token 和子树级主题适合映射到 Turbo；整份 Tailwind 全局样式会污染 DSH，不能直接装入。
- [BotSettingsDialog.tsx](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/src/components/BotSettingsDialog.tsx) 的身份、模型、技能、权限分区可用来组织 Bot 自己的设置。首屏需要直接回答“当前 Bot 使用哪个连接、哪些工具”。
- [ComposerSendButton.tsx](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/src/components/ComposerSendButton.tsx) 是 props 边界较小的候选；依然要替换翻译、菜单和类型依赖。
- [ModelPicker.tsx](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/src/components/ModelPicker.tsx)、Sidebar、ChatView 和 [store.tsx](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/src/state/store.tsx) 深度依赖原 REST/SSE/store/桌面桥；不能当独立 UI 库复制。

因此传统模式与 BOT 模式最终应在同一 DSH 会话壳内切换，使用同一套 Bot 身份和服务。启动另一个 OpenMausBot Electron 窗口不能作为融合完成的验收。

### 技能来源与工具授权

[SkillsSection.tsx](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/src/components/bot-settings/SkillsSection.tsx) 区分私有、共享库、导入和引擎原生技能。技能内容变更会影响已审核状态；实际有效集合必须在执行前计算。

[shared/tool-scope.ts](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/shared/tool-scope.ts) 提供显式 allow/deny、deny 优先和非法配置拒绝的可借鉴规则。MCP 配置中，未设置名单与空名单不同；Turbo 新 profile 明确使用引用数组，省略或空数组都表示不增加挂载，**不用于推断旧配置的继承语义**。未来迁移器必须单独处理旧版继承/pack。

不要复制 [approval-mode.ts:67](https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/shared/approval-mode.ts#L67) 的默认 `full` 策略。继续由 DSH 宿主提供审批和沙盒；切换模型不能顺带提升权限。

## 决定与当前交付

保留 DS-Bot/DSH 的会话、工具、凭据、群聊、记忆和存储。本分支实际提供 Magpie 连接创建/模型发现、每连接独立 route 与 credential reference、Bot 固定模型连接开关，以及 OpenMausBot 工具选择核心和 DSH 执行 guard。Bot 设置界面可保存 allow/deny，作用于独聊、群成员及分段。详细行为见[设计](../plans/2026-11-06-turbo-runtime-profiles.md)。

工具权限采用执行检查，不重写 `llm/stream`。公开 DSH API 规定 LOOP 请求由会话日志重建并绑定 adapter；复制请求重新发送会丢失这个绑定，工具历史还能恢复被过滤的声明。因此工具 schema/SDK 可能可见，但调用仍被 guard 拒绝。CLI 原生工具不在该 guard 中，带策略的 CLI 组合及未结束 CLI stream 会被拒绝，不能将界面开关当作沙盒。

[runtime-profile.js](../../ds-bot/src/shared/runtime-profile.js) 仍是未接入生产的严格配置解析器，不能据此声称已实现每 Bot 私有账号 ACL。完整 OpenMausBot 界面、私有技能管理和其他能力继续按[路线图](ROADMAP.md)移植。隔离主机验证见 [SMOKE](SMOKE.md)。
