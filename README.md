# CloudWatch Alarm Auto RCA

> English: [README.en.md](README.en.md)

基于 AWS DevOps Agent 的 CloudWatch 告警自动根因分析系统。当 CloudWatch 告警触发时，系统自动调用 DevOps Agent 进行根因调查，生成结构化 RCA 报告，并通过飞书 Webhook 推送给团队。同时提供飞书 Bot 对话助手，支持直接在飞书中与 DevOps Agent 交互对话以及运行和查看改进建议。


---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        告警自动处理链路                                │
│                                                                     │
│  CloudWatch Alarm ──→ EventBridge ──→ Step Functions ──→ Lambda     │
│       (ALARM)           (规则匹配)       (工作流编排)      (处理逻辑)   │
│                                                                     │
│  Lambda 链路:                                                        │
│  AlarmRouter → AlarmGrouper → RCAAnalyzer → FeishuNotifier          │
│  (解析过滤)     (告警聚合)     (调用Agent)    (飞书通知)               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      飞书 Bot 对话助手 (Lambda + API Gateway)         │
│                                                                     │
│  用户 @Bot ──→ 飞书云端 ──→ POST API Gateway ──→ Lambda ──→ DevOps Agent
│                                        ↓                            │
│                              飞书交互式卡片 ←── Agent 响应             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 功能特性

- **自动告警捕获**：EventBridge 规则自动捕获 CloudWatch 告警状态变化
- **智能过滤**：支持 all/custom 告警选择模式，namespace/name_pattern 过滤
- **告警聚合**：同一资源 2 分钟内的多个告警自动聚合为一次调查
- **自动根因分析**：调用 AWS DevOps Agent 进行 RCA，生成结构化报告
- **飞书通知**：RCA 结果以交互式卡片推送到飞书群，支持多 Webhook 路由
- **飞书 Bot 对话**：直接在飞书中 @机器人 与 DevOps Agent 对话
- **一键部署**：全部基础设施通过 CDK 定义，`cdk deploy` 即可完成
- **配置热加载**：SSM Parameter Store 管理配置，5 分钟自动刷新

---

## 前置条件

- Node.js >= 20
- AWS CLI 已配置（`aws configure`）
- AWS CDK CLI（`npm install -g aws-cdk`）

---

## 一键部署

### 步骤一：配置飞书（部署前准备）

部署前先在飞书侧完成配置，获取需要的凭证。

> **两个机器人的区别说明**：本系统使用了两种不同的飞书机器人，它们互相独立、互不关联：
>
> | | 自定义机器人（Webhook） | 企业自建应用机器人 |
> |---|---|---|
> | **用途** | 告警自动推送（系统→飞书，单向通知） | 对话式交互（用户↔系统，双向问答） |
> | **创建位置** | 在飞书群聊设置中直接添加 | 在飞书开放平台（开发者后台）创建 |
> | **工作方式** | 系统通过 HTTP POST 往群里发消息 | 用户 @机器人，机器人调用 Agent 后回复 |
> | **凭证** | 一个 Webhook URL | App ID + App Secret + Verification Token |
> | **是否必须** | ✅ 必须（否则收不到告警通知） | ❌ 可选（不需要对话功能可以不配） |
>
> 简单说：「自定义机器人」只是一个接收消息的入口（URL），没有交互能力。「企业自建应用」是一个完整的应用，添加「机器人能力」后它本身就变成一个机器人，可以接收消息并回复。

#### A. 告警自动推送（自定义机器人 Webhook）

1. 打开要接收告警的飞书**群聊**
2. 群设置（右上角 ···）→ **群机器人** → **添加机器人** → 选择 **「自定义机器人」**
3. 填写名称（如"告警通知"），点击「添加」
4. **立即复制 Webhook URL** → 记为 `feishuWebhookUrl`

> ⚠️ Webhook URL 创建时只显示一次，关掉就看不到了。

#### B. 对话式交互（企业自建应用机器人，可选）

如果需要在飞书中 @机器人 与 DevOps Agent 对话：

1. 登录 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**
2. 填写应用名称（如 `DevOps Agent 助手`）
3. **添加应用能力** → 点击「机器人」的「添加」
4. **权限管理** → 开通以下权限：

| 权限标识 | 说明 |
|---------|------|
| `im:message` | 获取与发送单聊、群组消息 |
| `im:message:send_as_bot` | 以应用的身份发送消息 |
| `im:message.group_at_msg:readonly` | 接收群聊中 @机器人消息 |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的单聊消息 |
| `im:chat:readonly` | 获取群组信息 |
| `im:resource` | 获取消息中的资源文件（图片/文件） |

5. **凭证与基础信息** → 记录 **App ID** 和 **App Secret**
6. **事件与回调** → **加密策略** → 记录 **Verification Token**
7. 事件订阅方式先选择「将事件发送至请求地址」，请求地址**先留空**（部署后回来填）
8. **事件与回调** → **事件配置** → 「添加事件」 → 选择 **「接收消息 v2.0」**（`im.message.receive_v1`）→ 保存。

### 步骤二：获取 AWS DevOps Agent 信息

#### 获取 Agent Space ID

从 DevOps Agent 控制台 URL 中获取：
```
https://4XXXXXXXXXXXXXXXXXXXXc.aidevops.global.app.aws/home
        └── Agent Space ID ──┘
```

或通过 CLI 查询：
```bash
aws devops-agent list-agent-spaces --region us-east-1 --query 'agentSpaces[].{ID:agentSpaceId,Name:name}' --output table
```

#### 获取 DevOps Agent Webhook URL 和 HMAC Secret

在 Agent Space → Settings → Integrations → **Webhooks** → 点 **Add** 创建一个新的 webhook。

> ⚠️ Webhook URL 和 HMAC Secret 都**只在创建时显示一次**，关掉对话框就找不回来，必须当场复制好。

把这两个值组装成 JSON 写进 AWS Secrets Manager（默认 secret 名 `cloudwatch-alarm-auto-rca/devops-agent-webhook`，Lambda 启动时会读它）：

```bash
aws secretsmanager create-secret \
  --region us-east-1 \
  --name cloudwatch-alarm-auto-rca/devops-agent-webhook \
  --secret-string '{"url":"https://event-ai.us-east-1.api.aws/webhook/generic/<webhook-id>","secret":"<HMAC-secret>"}'
```

如果之后要轮换密钥，用 `update-secret` 改值即可，无需重新部署：

```bash
aws secretsmanager update-secret \
  --region us-east-1 \
  --secret-id cloudwatch-alarm-auto-rca/devops-agent-webhook \
  --secret-string '{"url":"...","secret":"..."}'
```

### 步骤三：克隆代码并安装依赖

```bash
git clone https://github.com/xitingy1123/aws-devops-agent.git
cd aws-devops-agent
npm install
```

### 步骤四：CDK Bootstrap（首次部署必须）

```bash
npx cdk bootstrap aws://<account-ID>/us-east-1
```

> 如果之前已 bootstrap 过可跳过。

### 步骤五：部署

所有飞书配置通过 CDK 参数一次性传入，**无需再手动执行 `aws ssm put-parameter`**。DevOps Agent 的 webhook URL + HMAC Secret 走 Secrets Manager（步骤二已创建），不在这里传。

```bash
# 完整部署（告警推送 + 对话 Bot）
npx cdk deploy \
  -c agentSpaceId="你的agentspaceID" \
  -c feishuWebhookUrl="https://open.feishu.cn/open-apis/bot/v2/hook/你的token" \
  -c feishuAppId="cli_a5xxxxxxxx" \
  -c feishuAppSecret="你的App Secret" \
  -c feishuVerificationToken="你的Verification Token"

# 仅部署告警推送（不含对话 Bot）
npx cdk deploy \
  -c agentSpaceId="你的agentspaceID" \
  -c feishuWebhookUrl="https://open.feishu.cn/open-apis/bot/v2/hook/你的token" \
  -c deployFeishuBot=false
```

### 步骤六：配置飞书事件回调地址（仅对话 Bot）

部署完成后 CDK 会输出：
```
FeishuBotWebhookUrl = https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/webhook
```

回到飞书开放平台 → **事件与回调**，**事件配置**和**回调配置**两个 Tab 都要配（用同一个 URL）：

**A. 事件配置**（接收用户发来的消息）

1. 订阅方式 → 编辑 → 选择「将事件发送至请求地址」→ 填上面那个 URL
2. 飞书会自动发验证请求（Lambda 自动响应 challenge）
3. **已添加事件** → 点「添加事件」→ 搜索并添加 `接收消息 v2.0`（`im.message.receive_v1`）—— 默认会要求开通两个权限：「读取用户发给机器人的单聊消息」和「获取群组中用户@机器人消息」，按提示开通即可


**B. 回调配置**（接收卡片按钮的点击事件）

1. 订阅方式 → 编辑 → 选择「将回调发送至请求地址」→ 填**同一个** URL
2. 添加回调 `card.action.trigger`

> ⚠️ **回调配置必须配**——「立即运行改善计划」「发起调查」「查看改进建议」这些卡片按钮都通过这个事件触发。不配的话按钮按下去没任何反应。

**C. 发布**

4. 版本管理 → 创建版本 → 提交审核 → 发布
5. 在目标群聊中：群设置 → 群机器人 → 添加你创建的应用

### 步骤七：验证

```bash
# 验证告警推送
aws cloudwatch set-alarm-state \
  --alarm-name "任意已存在的告警名" \
  --state-value ALARM \
  --state-reason "Testing RCA pipeline" \
  --region us-east-1

# 验证对话 Bot：在飞书群中 @你的机器人 发送消息
```
---

## CDK 部署的资源清单

| 资源 | 类型 | 说明 |
|------|------|------|
| WorkflowExecutionTable | DynamoDB | 工作流执行记录 |
| AlarmGroupTable | DynamoDB | 告警聚合组 |
| DeadLetterNotificationTable | DynamoDB | 未发送通知死信 |
| AlarmRouterFunction | Lambda | 告警解析与过滤 |
| AlarmGrouperFunction | Lambda | 告警聚合 |
| RCAAnalyzerFunction | Lambda | 调用 DevOps Agent |
| FeishuNotifierFunction | Lambda | 飞书通知 |
| FeishuBotFunction | Lambda | 飞书 Bot 对话（可选） |
| FeishuBotApi | API Gateway | 飞书事件回调端点（可选） |
| AlarmRCAWorkflow | Step Functions | 工作流编排 |
| CloudWatchAlarmRule | EventBridge | 告警事件捕获 |
| SystemConfig | SSM Parameter | 系统配置 |
| WorkflowFailureAlarm | CloudWatch Alarm | 系统健康监控 |
| NotificationFailureAlarm | CloudWatch Alarm | 通知失败监控 |

---

## 配置说明

### SSM 配置参数

路径：`/cloudwatch-alarm-auto-rca/config`

```json
{
  "version": "1.0.0",
  "alarmSelectionMode": "all",          // "all" 或 "custom"
  "selectedAlarmNames": [],             // custom 模式下的白名单
  "alarmFilters": [                     // 过滤规则
    {"type": "namespace", "value": "AWS/EC2", "action": "include"},
    {"type": "name_pattern", "value": "^prod-.*", "action": "include"},
    {"type": "name_pattern", "value": ".*test.*", "action": "exclude"}
  ],
  "feishuWebhooks": [                   // 飞书 Webhook 及路由
    {
      "url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
      "name": "基础设施团队",
      "routingRules": [
        {"field": "namespace", "pattern": "AWS/EC2", "match": "equals"}
      ]
    }
  ],
  "rcaTimeout": 300,                    // RCA 超时（秒）
  "retryPolicy": {"maxRetries": 3, "initialDelay": 5, "backoffMultiplier": 2},
  "groupingWindow": 120,                // 告警聚合窗口（秒）
  "retentionDays": 90                   // 记录保留天数
}
```

> **过滤规则优先级**：exclude 规则优先于 include 规则。告警选择模式优先于过滤规则。

---

## 使用方式
共有以下三个功能：
- Cloudwatch告警自动触发DevopsAgent生成RCA并推送至飞书；
- 在飞书里直接和Devops Agent 对话
- 在飞书里运行改善计划（Improvement Plan）

### 自动告警 RCA

无需操作。任何 CloudWatch 告警触发 ALARM 状态时，系统自动：
1. 解析告警事件
2. 应用过滤规则
3. 聚合同资源告警
4. 调用 DevOps Agent 分析根因
5. 将 RCA 报告以飞书卡片推送到群聊



默认 `alarmSelectionMode = "all"`，即**所有进入 ALARM 状态的告警都会触发 RCA**。如果只想 RCA 一部分告警，改 SSM Parameter `/cloudwatch-alarm-auto-rca/config` 即可，**Lambda 5 分钟内自动加载新配置**，无需 `cdk deploy`。

> 设计原因：筛选规则属于"运行时配置"，会随业务变；CDK 只创建默认空配置，规则放在 SSM 里支持热加载。

#### 三种筛选方式

**1. 白名单模式（最严格）—— 只 RCA 指定名字的告警**

```bash
aws ssm put-parameter --region us-east-1 \
  --name /cloudwatch-alarm-auto-rca/config \
  --overwrite --type String \
  --value '{
    "version":"1.0.0",
    "alarmSelectionMode":"custom",
    "selectedAlarmNames":["EC2-HighCPU-Test","RDS-Conn-Limit"],
    "alarmFilters":[],
    "feishuWebhooks":[{"url":"https://open.feishu.cn/open-apis/bot/v2/hook/<your-token>","name":"默认告警群","routingRules":[]}],
    "rcaTimeout":600,
    "retryPolicy":{"maxRetries":1,"initialDelay":5,"backoffMultiplier":2},
    "groupingWindow":120,
    "retentionDays":90
  }'
```

**2. 按 namespace 筛 —— 只 RCA 某些 AWS 服务的告警**

把 `alarmSelectionMode` 留为 `"all"`，用 `alarmFilters` 表达：

```json
{
  "alarmSelectionMode": "all",
  "alarmFilters": [
    {"type": "namespace", "value": "AWS/EC2", "action": "include"},
    {"type": "namespace", "value": "AWS/RDS", "action": "include"}
  ]
}
```

**3. 按名称正则筛 —— 例如只看生产环境告警**

```json
{
  "alarmSelectionMode": "all",
  "alarmFilters": [
    {"type": "name_pattern", "value": "^prod-",  "action": "include"},
    {"type": "name_pattern", "value": ".*test.*","action": "exclude"}
  ]
}
```

#### 筛选规则速查

`alarmFilters[]` 每条规则有三个字段：`type` / `value` / `action`。

| type | 含义 | value 形态举例 |
|---|---|---|
| `namespace` | 告警的指标 namespace **完全相等** | `"AWS/EC2"` |
| `name_pattern` | 告警名按 **正则** 匹配 | `"^prod-.*"` |

| action | 行为 |
|---|---|
| `include` | 命中此规则 → 通过 |
| `exclude` | 命中此规则 → 拒绝 |

**优先级**：`exclude` 优先于 `include`（命中任何 exclude 立即拒绝，不再检查 include）。`alarmSelectionMode='custom'` 优先于 `alarmFilters`（不在白名单的告警直接拒绝，不进 filter 阶段）。

#### 验证当前生效的配置

```bash
aws ssm get-parameter --region us-east-1 \
  --name /cloudwatch-alarm-auto-rca/config \
  --query 'Parameter.Value' --output text | python3 -m json.tool
```

#### 调试某条告警是否被过滤掉

看 alarm-router Lambda 日志，过滤决策会以结构化 JSON 写日志：

```bash
aws logs tail /aws/lambda/<AlarmRouterFunction-name> \
  --region us-east-1 --since 10m \
  --filter-pattern '{ $.filterReason = * }'
```

或者在 CloudWatch 看自定义指标 `CloudWatchAlarmAutoRCA / AlarmsFiltered`。

### 飞书 Bot 对话

在群聊中 @机器人 + 问题：

```
@DevOps Agent 查看 us-east-1 的 EC2 实例健康状态
@DevOps Agent 最近一周有哪些告警事件？
@DevOps Agent 分析一下 prod-db 的性能瓶颈
@DevOps Agent 生成本周运维健康报告
```

支持多轮对话，Bot 会保持上下文。

#### 在飞书里运行改善计划（Improvement Plan）

机器人在群里能主动跑一次「改善计划」——基于 Agent Space 中已完成的 INVESTIGATION 任务，分析这段时间的运维事件并产出新的改进建议。**触发流程：发关键词唤起菜单卡 → 点「🚀 立即运行改善计划」按钮**。

**第 1 步：唤起菜单卡**

群里 @ 机器人发以下任一关键词（**整条消息就是这个词**，前后空格忽略，大小写无关）：

- `改善计划`
- `改进建议`
- `improvements`
- `improvement`

例如：

```
@DevOps Agent 改善计划
@DevOps Agent improvements
```

机器人会回一张菜单卡，里面有两个按钮：

- 🚀 **立即运行改善计划** — 后台调 `CreateBacklogTask({ taskType: 'EVALUATION' })` 用 Agent Space 里第一个 ACTIVE 的 goal 跑一次 evaluation，轮询完成后把新生成的建议作为文本消息发回当前群。约 30 秒 - 2 分钟。
- 🔍 **查看改进建议** — 直接列出 Agent Space 中已存在的所有改进建议（不创建新任务）。

**第 2 步：点按钮就行**

> ⚠️ 改善计划任务**依赖窗口内有已完成的 INVESTIGATION**——如果近期没人触发过事件调查，会收到「改善计划无法启动，必须先有一个已完成的 INVESTIGATION 任务」的提示。等告警自动触发一次 RCA、或在 chat 里让 Agent 跑一次调查后再点。

**注意事项**

- 关键词必须**整条消息严格匹配**，写「我想看看改善计划」不会触发菜单（会被当成普通问答转给 Agent）
- 真要在长句子里触发，把关键词单独发一句即可





---

## 故障排查 / 调试

### 飞书一直收不到 RCA 卡片

按顺序检查：

```bash
# 1. 看 SSM 配置里 feishuWebhooks 不为空
aws ssm get-parameter --region us-east-1 --name /cloudwatch-alarm-auto-rca/config \
  --query 'Parameter.Value' --output text | jq .feishuWebhooks

# 2. 看 FeishuNotifier 实际发送时飞书的响应（每次发送都会记录）
aws logs tail /aws/lambda/<FeishuNotifierFunction-name> --region us-east-1 \
  --since 30m --filter-pattern '"Feishu webhook response"'

# 3. 手动 curl 一下 webhook，确认机器人本身没被踢出群
curl -s -X POST "<your-webhook-url>" \
  -H 'Content-Type: application/json' \
  -d '{"msg_type":"text","content":{"text":"健康检查"}}'
```

`Feishu webhook response` 日志会显示飞书返回的完整 body（包括 `code` 和 `msg`）。如果 `code=0 msg=success` 但群里没收到，多半是机器人被移出群了。

### 改了 SSM 配置但 Lambda 没立即生效

ConfigManager 缓存 5 分钟。要立刻生效就强制 cold start（修改 Lambda 环境变量）：

```bash
ROUTER_FN=$(aws lambda list-functions --region us-east-1 \
  --query "Functions[?starts_with(FunctionName, 'CloudwatchAlarmAutoRcaSta-AlarmRouter')].FunctionName | [0]" \
  --output text)
ENV_VARS=$(aws lambda get-function-configuration --region us-east-1 \
  --function-name "$ROUTER_FN" --query 'Environment.Variables' --output json \
  | jq --arg n "$(date +%s)" '. + {CONFIG_NONCE:$n}' \
  | jq -r 'to_entries | map("\(.key)=\(.value)") | join(",")')
aws lambda update-function-configuration --region us-east-1 \
  --function-name "$ROUTER_FN" --environment "Variables={$ENV_VARS}"
```

> ⚠️ shell 单行 JSON 容易踩中文引号陷阱。改 SSM 配置时把 JSON 写到文件里，再用 `--value "$(cat config.json)"` 传，避免智能引号被复制进命令。

### 看 Step Functions 走的具体路径

execution 状态是 `SUCCEEDED` 不代表"飞书一定收到"——告警可能在 AlarmRouter 后被 filter 拦截走 `RecordFiltered` 路径，整条链路也是 SUCCEEDED 但飞书不会收到任何东西。

```bash
EXEC_ARN=$(aws stepfunctions list-executions \
  --state-machine-arn arn:aws:states:us-east-1:<account>:stateMachine:AlarmRCAWorkflow... \
  --max-results 1 --region us-east-1 --query 'executions[0].executionArn' --output text)
aws stepfunctions get-execution-history --execution-arn "$EXEC_ARN" --region us-east-1 \
  --query 'events[?type==`PassStateEntered` || type==`TaskStateEntered`].stateEnteredEventDetails.name' \
  --output text
```

- 完整路径：`InvokeAlarmRouter → InvokeAlarmGrouper → InvokeRCAAnalyzer → InvokeFeishuNotifierComplete → RecordSuccess`
- 被 filter 拦截：`InvokeAlarmRouter → RecordFiltered`（秒级完成，飞书不会收到）

---

## 测试脚本

`scripts/stress-tests/` 提供三种**真实压测脚本**，覆盖三个不同 AWS 服务，用真实指标流让告警自然进入 ALARM —— 不是 mock、不是 `set-alarm-state` 手动翻转、不是 `put-metric-data` 推假指标。

| 脚本 | 服务 | 压测方式 | 触发的指标 |
|---|---|---|---|
| `01-ec2-cpu-stress.sh` | EC2 | 通过 SSM 在实例上跑 stress-ng 压满 CPU | `AWS/EC2 CPUUtilization` |
| `02-lambda-errors-stress.sh` | Lambda | 部署一个会抛错的 Lambda，调用 3 次 | `AWS/Lambda Errors` |
| `03-s3-4xx-stress.sh` | S3 | 反复 GET 不存在的 key 产生 NoSuchKey | `AWS/S3 4xxErrors` |

```bash
# EC2（直接跑，前提：账号下有 EC2-HighCPU-Test 告警 + 对应实例）
./scripts/stress-tests/01-ec2-cpu-stress.sh 5     # 压 5 分钟

# Lambda（先 setup 创建测试资源，再 stress，测完 cleanup）
./scripts/stress-tests/02-lambda-errors-stress.sh setup
./scripts/stress-tests/02-lambda-errors-stress.sh stress
./scripts/stress-tests/02-lambda-errors-stress.sh cleanup

# S3（同上，注意 Request Metrics 启用后有 ~15 分钟延迟）
./scripts/stress-tests/03-s3-4xx-stress.sh setup
./scripts/stress-tests/03-s3-4xx-stress.sh stress
./scripts/stress-tests/03-s3-4xx-stress.sh cleanup
```

详细说明：[scripts/stress-tests/README.md](scripts/stress-tests/README.md)

---

## 开发

```bash
npm install          # 安装依赖
npm run build        # 编译 TypeScript
npm test             # 运行全部测试（40 套件 / 390 用例）
npm run test:unit    # 仅单元测试
npm run test:property # 仅属性测试
npm run synth        # 生成 CloudFormation 模板
npm run lint         # 类型检查
```

---

## 清理

```bash
npx cdk destroy
```

---

## 许可证

ISC

---

## 进一步阅读

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 代码内部架构、数据流、关键决策
