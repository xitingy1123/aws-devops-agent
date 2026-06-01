# 代码架构说明

> English: [ARCHITECTURE.en.md](ARCHITECTURE.en.md)

面向开发/维护者的代码内部结构文档。**部署 / 使用步骤请看仓库根目录的 [README.md](../README.md)**。

---

## 1. 一句话概括

CloudWatch 告警 → EventBridge → Step Functions(挂起等回调)→ HMAC 签名 webhook 调 DevOps Agent → DevOps Agent 异步跑 investigation,通过 EventBridge 事件回流唤醒 SFN → 渲染飞书卡片(根因)→ 自动触发 mitigation → mitigation 完成事件再触发第二条卡片(缓解计划)。

---

## 2. 全链路时序图

```
[T+0]   CloudWatch Alarm → ALARM 状态
        ↓ EventBridge (source=aws.cloudwatch)
        Step Functions: AlarmRCAWorkflow 启动
        ├─ InvokeAlarmRouter        (alarm-router Lambda:解析 + 过滤)
        ├─ CheckFiltered            (Choice)
        ├─ InvokeAlarmGrouper       (alarm-grouper Lambda:同资源 2 分钟内告警合并)
        ├─ CheckShouldWait + WaitForGroupWindow
        └─ InvokeRCAAnalyzer        (.waitForTaskToken 模式)
                ↓
[T+0+5s]        rca-analyzer Lambda
                    1. 从 Secrets Manager 读 webhook 凭据
                    2. POST + HMAC-SHA256 → DevOps Agent webhook
                    3. 写 pending 记录到 DDB(incidentId, taskToken, alarms, ...)
                    4. Lambda 退出 → SFN 挂起,等回调

                                  ⋮ DevOps Agent 异步执行调查 ⋮

[T+5min] EventBridge: aws.aidevops "Investigation Completed"
        → investigation-event-handler Lambda(phase 1 分支)
            1. DDB Scan 找时间窗口内最近 pending 记录
            2. ListJournalRecords(executionId, "investigation_summary_md")
            3. 解析 markdown → 构造 root-cause RCAReport(reportPhase='investigation')
            4. SendTaskSuccess(taskToken, payload)        ← 唤醒 SFN
            5. UpdateBacklogTask(taskStatus=PENDING_START) ← 触发 mitigation 阶段
            6. DDB 更新 status=investigation_completed,stamp taskId

        SFN 恢复执行
        ├─ CheckRCAStatus           (Choice: 看 rcaReport.status)
        ├─ InvokeFeishuNotifierComplete / Partial
        │       → 渲染第 1 张卡片(标题:🔍 根因分析完成)
        │       → 卡片内显示"⏳ 缓解计划生成中...第二条卡片单独推送"
        └─ RecordSuccess / RecordFailure / RecordPartial

                                  ⋮ DevOps Agent 异步生成 mitigation ⋮

[T+8min] EventBridge: aws.aidevops "Mitigation Completed"
        → investigation-event-handler Lambda(phase 2 分支)
            1. DDB 用 taskId 精确反查记录
            2. ListExecutions(taskId) 找 agentType=mitigation 的 execution
            3. ListJournalRecords(mitigationExecutionId, "mitigation_summary_md")
            4. 解析 markdown(## Action / ## Reasoning / 散文)→ mitigation RCAReport
            5. lambda:Invoke(Event) → FeishuNotifier(绕过 SFN,SFN 已结束)
                    → 渲染第 2 张卡片(标题:🛠️ 缓解计划已生成)
            6. DDB 更新 status=mitigation_completed
```

---

## 3. 仓库布局

```
.
├── bin/
│   ├── app.ts                        ← 主 stack 入口,从 context/env 读配置
│   └── verdaccio-proxy.ts            ← ⚠ 独立 stack,与本 RCA 流程无关
│
├── lib/
│   ├── cloudwatch-alarm-auto-rca-stack.ts  ← 主 stack 全部 AWS 资源
│   └── verdaccio-proxy-stack.ts            ← ⚠ 独立 stack,见上
│
├── src/
│   ├── shared/                       ← 跨 Lambda 复用
│   │   ├── types.ts                  ← 全局类型定义(RCAReport / SystemConfig 等)
│   │   ├── workflow-definition.ts    ← Step Functions 状态机定义
│   │   ├── config-manager.ts         ← SSM 配置读取 + 5 分钟缓存
│   │   ├── dynamodb-client.ts        ← DDB 操作封装
│   │   └── index.ts                  ← shared 模块统一导出
│   │
│   └── lambdas/
│       ├── alarm-router/             ← 解析 EventBridge 告警事件 + 过滤
│       │   ├── index.ts              (handler)
│       │   ├── parser.ts
│       │   └── filter.ts
│       │
│       ├── alarm-grouper/            ← 同资源 2 分钟内告警聚合
│       │   └── index.ts
│       │
│       ├── rca-analyzer/             ← 触发 DevOps Agent webhook(.waitForTaskToken)
│       │   ├── index.ts              (handler:webhook 触发 + 写 pending)
│       │   ├── agent-client.ts       (HMAC 签名 webhook 客户端)
│       │   ├── context-builder.ts    (RCAContext 组装)
│       │   ├── pending-store.ts      (写 pending 记录到 DDB)
│       │   └── report-generator.ts   ⚠ legacy fallback,详见 §6
│       │
│       ├── investigation-event-handler/   ← phase-1 + phase-2 事件分发器
│       │   └── index.ts
│       │
│       ├── feishu-notifier/          ← 渲染飞书卡片 + HTTP POST 到 webhook
│       │   ├── index.ts              (handler)
│       │   ├── card-formatter.ts     (lark_md 卡片渲染、phase-1/phase-2 双模板)
│       │   ├── webhook-router.ts     (按 namespace/tag 路由到不同飞书群)
│       │   └── sender.ts             (HTTP POST + 重试 + dead letter)
│       │
│       └── feishu-bot/               ← ⚠ 独立功能:飞书对话式 Bot,与告警 RCA 解耦
│
├── scripts/
│   └── stress-tests/                 ← 真实压测脚本(EC2/Lambda/S3,触发真实告警链路)
│       ├── 01-ec2-cpu-stress.sh
│       ├── 02-lambda-errors-stress.sh
│       └── 03-s3-4xx-stress.sh
│
├── test/
│   ├── unit/                         ← Jest 单元测试(每个 Lambda + 工具函数一一对应)
│   ├── property/                     ← fast-check 属性测试(过滤、路由、TTL 等)
│   └── integration/                  ← 多 Lambda 串联 / SFN 模拟器
│
├── docs/
│   └── ARCHITECTURE.md               ← (本文)
│
└── README.md                         ← 部署 + 使用文档
```

---

## 4. 关键 Lambda 职责详解

### 4.1 `alarm-router/index.ts`

- **输入**: EventBridge `CloudWatch Alarm State Change` 事件
- **输出**: `AlarmRouterOutput`(包含 `filtered: boolean`)
- 逻辑:
  - 用 `parser.ts` 把嵌套的 `detail` 拍平成 `AlarmRouterOutput`
  - 用 `filter.ts` 应用 SSM 配置里的 `alarmSelectionMode` + `alarmFilters`
  - 发 CloudWatch 自定义指标 `AlarmsReceived` / `AlarmsFiltered`

### 4.2 `alarm-grouper/index.ts`

- **输入**: `{ alarm: AlarmRouterOutput }`
- **输出**: `AlarmGrouperOutput`(`groupId / alarms / shouldWait / waitUntil`)
- 逻辑:
  - 在 `AlarmGroupTable` 找 `resourceArn = X AND status='collecting' AND windowEnd > now`
  - 找到则追加到该 group;没找到则创建新 group(2 分钟窗口)
  - DynamoDB 失败时降级为单告警 group(不阻塞主流程)

### 4.3 `rca-analyzer/index.ts`(webhook 触发版本)

- **以 SFN `.waitForTaskToken` 模式被调用**,SFN 自动注入 `taskToken`
- 流程:
  1. `loadWebhookCredentials()` — 读 Secrets Manager,容器内缓存
  2. `buildRCAContext(alarms)` → `triggerDevOpsAgentInvestigation()`
  3. 成功 → `writePendingInvestigation()` 写 DDB → 返回简单 ack
  4. 失败 → `SendTaskFailureCommand` 让 SFN 立即走 partial 分支
- **关键设计:Lambda 返回值不是 SFN 步骤输出**(`waitForTaskToken` 模式下输出由后续的 `SendTaskSuccess` 决定)。Lambda 只需要"成功触发或失败兜底"二选一,return 体本身被 SFN 忽略。

#### `agent-client.ts`(HMAC webhook 客户端)

- 从 Secrets Manager 读 `{url, secret}`,容器内 cache(避免每次 invoke 都拉)
- HMAC-SHA256 签名规则: `HMAC(secret, "${timestamp}:${payload}")` → base64
- 必填请求头: `Content-Type` / `x-amzn-event-signature` / `x-amzn-event-timestamp`
- 重试策略:5xx + 429 重试,4xx 立即放弃,timeout 单独标记
- 测试钩子:`setHttpTransport()` / `setSecretsManagerClient()` / `resetCredentialCache()`

#### `pending-store.ts`

- 把 `{incidentId, triggeredAt, taskToken, groupId, alarms}` 写到 `WorkflowExecutionTable`
  - PK = `incidentId`(注意:复用了表的 `executionId` 字段名)
  - SK = `triggeredAt`(ISO 时间戳)
- TTL = 2 小时(超时未被 phase-1 事件领走的 pending 自动过期)

### 4.4 `investigation-event-handler/index.ts`(双 phase 分发器)

**两类事件用同一个 Lambda 处理,按 `detail-type` 前缀分发**:

#### Phase 1: `Investigation *` 事件

- **关联方式**:**时间窗口启发式**(±10 分钟内最早的 `status='pending'` 记录)
  > 因为我们触发 webhook 时塞的 `incidentId` 没法从 EventBridge 事件里拿回来,只能用时间窗口匹配。低并发场景下足够准。
- 拉 journal:`recordType = 'investigation_summary_md'`
- `SendTaskSuccess(taskToken, RCAReport)` 唤醒 SFN
- 接着 `UpdateBacklogTask(taskStatus='PENDING_START', currentVersion)` ←
  **这是控制台"Generate mitigation plan"按钮的等价 API**(从 CloudTrail 反向工程出来的)。
- DDB 更新 `status='investigation_completed'` + `taskId=<event.task_id>`

#### Phase 2: `Mitigation *` 事件

- **关联方式**:**精确 taskId 匹配**(phase 1 已经把 taskId 写进 DDB)
- ⚠ **关键陷阱**:EventBridge 在 `Mitigation Completed` 事件里给的 `metadata.execution_id` 是
  investigation execution(`agentType=ops1`),**不是** mitigation execution。
  必须先 `ListExecutions(taskId)` 过滤出 `agentType='mitigation'` 的 execution,
  再从它的 journal 拉 `mitigation_summary_md`。
- 用 `lambda:Invoke(InvocationType='Event')` 异步触发 FeishuNotifier(绕过 SFN,SFN 已结束)

### 4.5 `feishu-notifier/index.ts` + `card-formatter.ts`

#### Card formatter 关键概念

- `lark_md` 飞书富文本格式**只支持 `**bold**` / `_italic_` / 链接 / 代码块**,不支持 ATX 标题(`#` / `##`)。
- DevOps Agent journal 输出大量带 `## Symptoms` / `### EC2 实例` 标题,直接传给飞书会原样显示成字面量 `#`。
- 解决方案:`normalizeHeadings()` 把 ATX 标题转成 `**bold**`,`### h3` 加 `▸` 前缀以保留层级感。
- `sanitizeAgentText()` = `normalizeHeadings()` + `escapeMd()`,所有从 Agent journal 来的不可信文本都过这个。

#### Phase-1 vs Phase-2 卡片

通过 `RCAReport.reportPhase` 字段(`'investigation' | 'mitigation' | undefined`)区分:

|  | Phase-1 (investigation) | Phase-2 (mitigation) |
|---|---|---|
| `reportPhase` | `'investigation'` | `'mitigation'` |
| 卡片标题 | 🔍 根因分析完成 | 🛠️ 缓解计划已生成 |
| 默认配色 | red/orange/green by confidence | green |
| 渲染段落 | 告警概要 / Investigation timeline / Root cause / Mitigation plan(占位提示) | 告警概要 / Mitigation plan |
| Mitigation 段内容 | "⏳ 缓解计划生成中,会作为第二条卡片..." | 真实 mitigation 内容 |

`isMitigationOnlyReport()` 优先看 `reportPhase`,没设置时再用启发式(有 `mitigationPlan` 且无 `rootCauses`/`keyFindings`)。
**关键: 不依赖 `mitigationPlan` 数组是否为空来判断卡片身份**——因为 DevOps Agent 在"无需操作"等场景下输出散文,正则解不出步骤,但卡片仍然必须以 mitigation 身份渲染。

#### 散文 fallback

mitigation 卡片在没解析出结构化步骤时,**回退到展示 `agentRawText` 全文**(经 `sanitizeAgentText` 处理)。
这覆盖了"## Action / ## Reasoning / 一段说明文字"这类输出形态。

---

## 5. 数据存储

### `WorkflowExecutionTable`

| 字段 | 类型 | 说明 |
|---|---|---|
| `executionId` | PK string | 实际存的是 webhook payload 里的 `incidentId`(`cw-alarm-{groupId}-{ms}`) |
| `createdAt` | SK string (ISO) | webhook 触发时间 |
| `status` | string | `pending` / `investigation_completed` / `mitigation_completed` / `mitigation_failed` / `failed` / `timed_out` |
| `taskToken` | string | SFN 注入的 callback token,phase-1 用 |
| `taskId` | string | phase-1 写入,phase-2 用它精确反查 |
| `alarms` | list | 完整 AlarmRouterOutput 数组,事件 handler 重新合成 RCAReport 用 |
| `groupId` | string | SFN 透传过来的 group id |
| `stateTransitions` | list | 状态变更日志(append-only) |
| `ttl` | number | 2 小时过期 |

### `AlarmGroupTable`

| 字段 | 类型 | 说明 |
|---|---|---|
| `resourceArn` | PK string | 资源 ARN |
| `groupId` | SK string | UUID |
| `windowStart` / `windowEnd` | ISO string | 聚合窗口 |
| `status` | string | `collecting` / `processing` / `done` |
| `alarms` | list | 该 group 下的告警 |

### `DeadLetterNotificationTable`

存所有重试 3 次仍失败的飞书通知,便于事后人工补发。

---

## 6. ⚠ Legacy 残留:`report-generator.ts`

`generateFullReport / generatePartialReport / generateTimeoutReport / generateRCAReport / AgentResponse`
这一组函数在新版 webhook 流程中**已不再被 rca-analyzer 调用**,但仍然保留:

1. `test/unit/rca-report-generator.test.ts`、`test/property/rca-report.test.ts`、`test/integration/workflow.test.ts` 仍在用 `generateFullReport` 等做 RCAReport 形状校验
2. 万一 webhook 触发链路彻底失效需要切回老逻辑时,这些函数是可用的兜底
3. 当前 RCAReport 的字段映射规则集中在这一处,改 RCAReport 时容易找

如果将来确认 webhook 路径稳定,可以连同这些函数和它们的测试一起删。

---

## 7. EventBridge Rules

| Rule | source | detail-type | target |
|---|---|---|---|
| `CloudWatchAlarmRule` | `aws.cloudwatch` | `CloudWatch Alarm State Change`(只匹配 ALARM 状态) | Step Functions `AlarmRCAWorkflow` |
| `DevOpsAgentInvestigationRule` | `aws.aidevops` | `Investigation Completed/Failed/Timed Out/Cancelled/Skipped` + `Mitigation Completed/Failed/Timed Out/Cancelled` | Lambda `investigation-event-handler` |

---

## 8. 关键 IAM 权限(主要 Lambda)

| Lambda | aidevops:* | 其他 |
|---|---|---|
| RCAAnalyzer | — | `secretsmanager:GetSecretValue/DescribeSecret`(限定 ARN)、`states:SendTaskSuccess/Failure/Heartbeat`、`workflowExecutionTable:Read+Write` |
| InvestigationEventHandler | `ListJournalRecords / GetBacklogTask / UpdateBacklogTask / ListExecutions / GetAgentSpace` | `states:SendTaskSuccess/Failure/Heartbeat`、`workflowExecutionTable:Read+Write`、`lambda:InvokeFunction`(限定 FeishuNotifier ARN) |
| FeishuNotifier | — | `deadLetterTable:Write` |
| AlarmRouter | — | `workflowExecutionTable:Read+Write` |
| AlarmGrouper | — | `alarmGroupTable:Read+Write` |

所有 Lambda 都有 `cloudwatch:PutMetricData`(限定 namespace)和 SSM 配置参数 read。

---

## 9. 配置入口

### CDK Context / 环境变量(部署时)

| context key | env var | 用途 |
|---|---|---|
| `agentSpaceId` | `AGENT_SPACE_ID` | 注入到 RCAAnalyzer / FeishuNotifier / InvestigationEventHandler / FeishuBot |
| `feishuWebhookUrl` | `FEISHU_WEBHOOK_URL` | 写入 SSM config 默认 webhook |
| `feishuAppId` | `FEISHU_APP_ID` | FeishuBot 用(可选) |
| `feishuAppSecret` | `FEISHU_APP_SECRET` | FeishuBot 用(可选) |
| `feishuVerificationToken` | `FEISHU_VERIFICATION_TOKEN` | FeishuBot 用(可选) |
| `devopsAgentWebhookSecretName` | — | Secrets Manager secret 名,默认 `cloudwatch-alarm-auto-rca/devops-agent-webhook` |
| `deployFeishuBot` | — | `false` 关闭 FeishuBot,默认 `true` |

### Secrets Manager(运行时)

`cloudwatch-alarm-auto-rca/devops-agent-webhook`(默认名,可改):

```json
{
  "url": "https://event-ai.us-east-1.api.aws/webhook/generic/<webhook-id>",
  "secret": "<HMAC-secret>"
}
```

凭据从 DevOps Agent 控制台 → Capabilities → Webhook → Generate 获取。**轮换:**

```bash
aws secretsmanager update-secret \
  --region us-east-1 \
  --secret-id cloudwatch-alarm-auto-rca/devops-agent-webhook \
  --secret-string '{"url":"...","secret":"<新值>"}'
# Lambda 进程内有缓存,新值会在容器冷启动后生效。
```

### SSM Parameter(运行时)

`/cloudwatch-alarm-auto-rca/config`,字段定义见 [README.md §配置说明](../README.md#配置说明)。`ConfigManager` 5 分钟刷新一次。

---

## 10. 调试速查

### "卡片没收到 / 收到但内容空"

按链路从前往后查日志:

```bash
# 1. SFN 是否启动了执行
aws stepfunctions list-executions --region us-east-1 \
  --state-machine-arn arn:aws:states:us-east-1:<account>:stateMachine:AlarmRCAWorkflow* \
  --max-items 5

# 2. RCAAnalyzer 是否成功触发 webhook
aws logs tail /aws/lambda/<RCAAnalyzerFunction-name> --region us-east-1 --since 10m

# 3. EventBridge 事件是否到达 InvestigationEventHandler
aws logs tail /aws/lambda/<InvestigationEventHandler-name> --region us-east-1 --since 30m

# 4. FeishuNotifier 是否成功发送
aws logs tail /aws/lambda/<FeishuNotifierFunction-name> --region us-east-1 --since 30m
```

### 关键 CloudWatch 自定义指标(namespace = `CloudWatchAlarmAutoRCA`)

| Metric | 含义 |
|---|---|
| `AlarmsReceived` / `AlarmsFiltered` | alarm-router 处理量 |
| `RCAAnalysesInitiated` / `RCAWebhookSucceeded` / `RCAWebhookFailed` | rca-analyzer webhook 触发 |
| `InvestigationEventMatched` / `InvestigationEventUnmatched` / `InvestigationEventDeliveryFailed` | phase-1 关联结果 |
| `MitigationTriggered` / `MitigationTriggerFailed` | UpdateBacklogTask 调用结果 |
| `MitigationEventMatched` / `MitigationEventUnmatched` / `MitigationCardDispatchFailed` | phase-2 处理结果 |
| `NotificationsSent` / `NotificationsFailed` | 飞书通知交付结果 |

### 跑测试

```bash
npm test                # 全部 (单元 + 属性 + 集成模拟器)
npm run test:unit       # 仅单元
npm run test:property   # 仅 fast-check 属性测试
npm run lint            # tsc --noEmit
```

> **已知 lint 错误**:`lib/verdaccio-proxy-stack.ts` 报 `grantTaskDefinitionAccess` 不存在。这是
> 另一个独立的、与 RCA 流程无关的 stack(私有 npm registry 代理),CDK API 升级后破坏的接口。
> 不影响主 stack 的部署/运行;主 stack 在同一个 `tsc` 输出里没有报错。

---

## 11. 重要历史决策

收录是为了避免后人重蹈覆辙,**不要逆向**这些决策除非有新证据:

### 11.1 为什么用 webhook + EventBridge,而不是 CreateChat + SendMessage

最早的 v1 版本用 `aidevops:CreateChat + SendMessage` 流式拉根因 markdown。问题:

- chat session 的 `executionId` **不属于** investigation 命名空间,无法用于 DevOps Agent 控制台 deep link(`/home/activity/{id}` 永远 404)
- 长流式响应在尾部容易 emit `responseFailed` 事件,需要复杂的"保留 partial"逻辑
- 没有"自动触发 mitigation"的能力

webhook 路径是 DevOps Agent 文档推荐的"事件驱动"标准做法。

### 11.2 SFN `.waitForTaskToken` 而不是同步等待

DevOps Agent investigation 通常 5-10 分钟。Lambda 最大执行时间 15 分钟,虽然能 hold 住,但:

- 计费按 Lambda 运行时间,每条告警烧 600 秒
- 长连接容易被中间设施断
- 不优雅(本质是异步任务)

`.waitForTaskToken` 让 Lambda 触发完立即退出,SFN 挂起等回调,**不消耗 Lambda 计费时间**。

### 11.3 phase-1 关联用时间窗口,phase-2 关联用 taskId

EventBridge 事件 payload 不携带我们发的 `incidentId`。
- phase-1 时还没有 `taskId`(那一刻才从事件里拿到),只能时间窗口
- phase-1 把 `taskId` stamp 到 DDB,phase-2 就能精确匹配

### 11.4 phase-2 必须 ListExecutions,不能直接用事件给的 executionId

`Mitigation Completed` 事件里 `metadata.execution_id` = investigation execution(ops1),
而 `mitigation_summary_md` 只存在于 mitigation execution(`agentType='mitigation'`)的 journal 里。
直接用事件给的 id 永远拉不到内容。详见 §4.4。

### 11.5 `UpdateBacklogTask(PENDING_START)` 是触发 mitigation 生成的等价 API

[IAM 文档](https://docs.aws.amazon.com/devopsagent/latest/userguide/aws-devops-agent-security-devops-agent-iam-permissions.html)
原文:`aidevops:UpdateBacklogTask – Allows users to **approve a mitigation plan** or cancel an active investigation or evaluation`。

具体的 `taskStatus` 值文档没写,从 CloudTrail 反向工程出来是 `'PENDING_START'`,而且需要先 `GetBacklogTask` 拿当前 `version`(乐观锁)。SDK type 没声明 `currentVersion` 字段,但 wire 协议接受。

### 11.6 `lark_md` 不支持 `#` 标题

DevOps Agent 经常在 journal markdown 里用 `## ###`,不处理就会以字面量 `#` 显示在飞书卡片里。`normalizeHeadings()` 把它们转成 `**bold**`。
