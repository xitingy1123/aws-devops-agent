# CloudWatch Alarm Auto RCA

Automated root cause analysis for CloudWatch alarms, powered by AWS DevOps Agent. When a CloudWatch alarm fires, the system automatically invokes DevOps Agent to investigate the root cause, generates a structured RCA report, and pushes it to your team via Feishu (Lark) webhook. A Feishu chat-bot assistant is also included so you can talk to DevOps Agent directly inside Feishu.

> 中文版本: [README.md](README.md)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Automated Alarm Pipeline                         │
│                                                                     │
│  CloudWatch Alarm ──→ EventBridge ──→ Step Functions ──→ Lambda     │
│       (ALARM)         (rule match)    (orchestration)   (handlers)  │
│                                                                     │
│  Lambda chain:                                                       │
│  AlarmRouter → AlarmGrouper → RCAAnalyzer → FeishuNotifier          │
│  (parse+filter) (aggregate)   (call Agent)  (push card)              │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│              Feishu Chat-Bot Assistant (Lambda + API Gateway)       │
│                                                                     │
│  user @bot ──→ Feishu cloud ──→ POST API Gateway ──→ Lambda ──→ DevOps Agent
│                                          ↓                          │
│                          Feishu interactive card ←── Agent reply    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Features

- **Automatic alarm capture** — EventBridge rule catches every CloudWatch alarm state change
- **Smart filtering** — `all` / `custom` selection mode, plus namespace / name pattern rules
- **Alarm aggregation** — Multiple alarms on the same resource within 2 minutes are merged into one investigation
- **Automated RCA** — Calls AWS DevOps Agent and produces a structured report
- **Feishu notification** — Delivers RCA results as interactive cards, with multi-webhook routing
- **Feishu chat-bot** — `@`-mention the bot in Feishu to talk to DevOps Agent
- **One-click deploy** — Everything defined in CDK, `cdk deploy` is enough
- **Hot-reload config** — Configuration in SSM Parameter Store, refreshed every 5 minutes

---

## Prerequisites

- Node.js >= 20
- AWS CLI configured (`aws configure`)
- AWS CDK CLI (`npm install -g aws-cdk`)

---

## One-Click Deploy

### Step 1 — Configure Feishu (pre-deploy preparation)

Set up Feishu first to collect the credentials you'll need.

> **Two different Feishu bots — please don't confuse them.** They are independent and unrelated:
>
> | | Custom bot (Webhook) | Custom enterprise app bot |
> |---|---|---|
> | **Purpose** | Push alerts (system → Feishu, one-way) | Conversational chat (user ↔ system, two-way) |
> | **Where to create** | Inside a Feishu group's settings | On the [Feishu Open Platform](https://open.feishu.cn/app) |
> | **How it works** | The system POSTs HTTP messages into the group | Users `@`-mention the bot, bot calls Agent and replies |
> | **Credentials** | A single webhook URL | App ID + App Secret + Verification Token |
> | **Required?** | ✅ Required (otherwise no alert delivery) | ❌ Optional (skip if you don't need chat) |
>
> In short: a "custom bot" is just an inbound URL with no chat ability. A "custom enterprise app" is a full app — once you add the bot capability, the app itself becomes a bot that can receive and reply to messages.

#### A. Alarm push (custom bot webhook)

1. Open the Feishu **group chat** that should receive alerts
2. Group settings (top-right `···`) → **Group bots** → **Add bot** → choose **"Custom bot"**
3. Give it a name (e.g. "Alarm Notifier"), click "Add"
4. **Copy the webhook URL right away** → save it as `feishuWebhookUrl`

> ⚠️ The webhook URL is shown only once at creation. Don't close that dialog before copying.

#### B. Conversational interaction (custom enterprise app, optional)

If you want to `@`-mention the bot inside Feishu and chat with DevOps Agent:

1. Sign in to [Feishu Open Platform](https://open.feishu.cn/app) → **Create custom enterprise app**
2. Fill in a name (e.g. `DevOps Agent Assistant`)
3. **Add app capability** → click "Add" on the "Bot" capability
4. **Permissions** → enable the following:

| Scope | Description |
|-------|-------------|
| `im:message` | Read and send single-chat / group messages |
| `im:message:send_as_bot` | Send messages as the app |
| `im:message.group_at_msg:readonly` | Receive `@`-mentions in groups |
| `im:message.p2p_msg:readonly` | Receive direct-chat messages |
| `im:chat:readonly` | Read group metadata |
| `im:resource` | Fetch attached resources (images / files) |

5. **Credentials & Basic Info** → record **App ID** and **App Secret**
6. **Events & Callbacks** → **Encryption strategy** → record the **Verification Token**
7. Choose "Send events to a request URL" for event subscriptions, leave the URL **empty for now** (you'll fill it in after deploy)
8. **Events & Callbacks** → **Event Configuration** → "Add event" → pick **"Receive Message v2.0"** (`im.message.receive_v1`) → save.

### Step 2 — Collect AWS DevOps Agent info

#### Get the Agent Space ID

From the DevOps Agent console URL:

```
https://4XXXXXXXXXXXXXXXXXXXXc.aidevops.global.app.aws/home
        └── Agent Space ID ──┘
```

Or via CLI:

```bash
aws devops-agent list-agent-spaces --region us-east-1 --query 'agentSpaces[].{ID:agentSpaceId,Name:name}' --output table
```

#### Get the DevOps Agent webhook URL + HMAC secret

In the Agent Space console → Capabilities → Webhook → **Generate webhook**.

> ⚠️ Both the webhook URL and the HMAC secret are shown **only once** at creation. Copy them immediately.

Store them in AWS Secrets Manager (default secret name: `cloudwatch-alarm-auto-rca/devops-agent-webhook`):

```bash
aws secretsmanager create-secret \
  --region us-east-1 \
  --name cloudwatch-alarm-auto-rca/devops-agent-webhook \
  --secret-string '{"url":"https://event-ai.us-east-1.api.aws/webhook/generic/<webhook-id>","secret":"<HMAC-secret>"}'
```

### Step 3 — Clone the repo and install dependencies

```bash
git clone https://github.com/xitingy1123/aws-devops-agent.git
cd aws-devops-agent
npm install
```

### Step 4 — CDK Bootstrap (first deploy only)

```bash
npx cdk bootstrap aws://<account-id>/us-east-1
```

> Skip if the account/region was bootstrapped before.

### Step 5 — Deploy

All Feishu configuration is passed in via CDK context. **No need to run `aws ssm put-parameter` separately.**

```bash
# Full deploy (alarm push + chat bot)
npx cdk deploy \
  -c agentSpaceId="<your-agent-space-id>" \
  -c feishuWebhookUrl="https://open.feishu.cn/open-apis/bot/v2/hook/<your-token>" \
  -c feishuAppId="cli_a5xxxxxxxx" \
  -c feishuAppSecret="<your App Secret>" \
  -c feishuVerificationToken="<your Verification Token>"

# Alarm push only (no chat bot)
npx cdk deploy \
  -c agentSpaceId="<your-agent-space-id>" \
  -c feishuWebhookUrl="https://open.feishu.cn/open-apis/bot/v2/hook/<your-token>" \
  -c deployFeishuBot=false
```

### Step 6 — Set the Feishu callback URL (chat bot only)

After deploy, the CDK stack outputs:

```
FeishuBotWebhookUrl = https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/webhook
```

Back on the Feishu Open Platform → **Events & Callbacks**. Configure both the **Event Configuration** and **Callback Configuration** tabs (same URL for both):

**A. Event Configuration** (receives messages from users)

1. Subscription mode → Edit → "Send events to a request URL" → paste the URL above
2. Feishu sends a verification request automatically (the Lambda answers the challenge)
3. Add event `im.message.receive_v1`

**B. Callback Configuration** (receives card button clicks)

1. Subscription mode → Edit → "Send callbacks to a request URL" → paste the **same** URL
2. Add callback `card.action.trigger`

> ⚠️ **Callback Configuration is required** — "Run improvement", "Start investigation", "Show recommendations" and every other card button is dispatched through this event. Without it, button clicks do nothing.

**C. Publish**

4. Version management → create version → submit for review → publish
5. In your group: group settings → group bots → add the app you just created

### Step 7 — Verify

```bash
# Verify alarm push
aws cloudwatch set-alarm-state \
  --alarm-name "<any-existing-alarm>" \
  --state-value ALARM \
  --state-reason "Testing RCA pipeline" \
  --region us-east-1

# Verify chat bot: @-mention your bot in the Feishu group
```

---

## Resources Created by CDK

| Resource | Type | Purpose |
|----------|------|---------|
| WorkflowExecutionTable | DynamoDB | Workflow execution records |
| AlarmGroupTable | DynamoDB | Alarm aggregation groups |
| DeadLetterNotificationTable | DynamoDB | Failed-notification dead-letter |
| AlarmRouterFunction | Lambda | Parse + filter alarms |
| AlarmGrouperFunction | Lambda | Aggregate alarms |
| RCAAnalyzerFunction | Lambda | Trigger DevOps Agent |
| FeishuNotifierFunction | Lambda | Render and deliver Feishu cards |
| FeishuBotFunction | Lambda | Feishu chat bot (optional) |
| FeishuBotApi | API Gateway | Feishu event callback endpoint (optional) |
| InvestigationEventHandlerFunction | Lambda | Resume SFN on `aws.aidevops` events; trigger / render mitigation card |
| AlarmRCAWorkflow | Step Functions | Workflow orchestration (waitForTaskToken) |
| CloudWatchAlarmRule | EventBridge | Capture CloudWatch alarm events |
| DevOpsAgentInvestigationRule | EventBridge | Capture `aws.aidevops` Investigation* / Mitigation* events |
| SystemConfig | SSM Parameter | System config |
| WorkflowFailureAlarm | CloudWatch Alarm | Self-monitoring |
| NotificationFailureAlarm | CloudWatch Alarm | Notification failure monitoring |

---

## Configuration

### SSM config parameter

Path: `/cloudwatch-alarm-auto-rca/config`

```json
{
  "version": "1.0.0",
  "alarmSelectionMode": "all",          // "all" or "custom"
  "selectedAlarmNames": [],             // whitelist used by "custom" mode
  "alarmFilters": [                     // filter rules
    {"type": "namespace", "value": "AWS/EC2", "action": "include"},
    {"type": "name_pattern", "value": "^prod-.*", "action": "include"},
    {"type": "name_pattern", "value": ".*test.*", "action": "exclude"}
  ],
  "feishuWebhooks": [                   // Feishu webhooks + routing
    {
      "url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
      "name": "Infra Team",
      "routingRules": [
        {"field": "namespace", "pattern": "AWS/EC2", "match": "equals"}
      ]
    }
  ],
  "rcaTimeout": 300,                    // RCA timeout in seconds
  "retryPolicy": {"maxRetries": 3, "initialDelay": 5, "backoffMultiplier": 2},
  "groupingWindow": 120,                // alarm aggregation window in seconds
  "retentionDays": 90                   // record retention
}
```

> **Filter precedence**: `exclude` rules win over `include` rules. The selection mode is checked before the filter rules.

---

## Usage

### Automated alarm RCA

Nothing to do. Whenever any CloudWatch alarm transitions to `ALARM`, the system automatically:

1. Parses the alarm event
2. Applies filtering rules
3. Aggregates same-resource alarms within the window
4. Calls DevOps Agent to investigate the root cause
5. Pushes the RCA report as a Feishu interactive card

### Choose which alarms trigger RCA (no redeploy required)

The default is `alarmSelectionMode = "all"`, meaning **every alarm transitioning to `ALARM` will trigger RCA**. To narrow it down, edit the SSM Parameter `/cloudwatch-alarm-auto-rca/config` — **Lambdas pick up the new config within 5 minutes, no `cdk deploy` needed**.

> Why this lives in SSM, not CDK: filter rules are *runtime configuration* — they change as your business does. CDK only creates an empty default; the rules sit in SSM so they can be hot-reloaded.

#### Three ways to filter

**1. Whitelist mode (strictest) — only RCA the alarms you name**

```bash
aws ssm put-parameter --region us-east-1 \
  --name /cloudwatch-alarm-auto-rca/config \
  --overwrite --type String \
  --value '{
    "version":"1.0.0",
    "alarmSelectionMode":"custom",
    "selectedAlarmNames":["EC2-HighCPU-Test","RDS-Conn-Limit"],
    "alarmFilters":[],
    "feishuWebhooks":[{"url":"https://open.feishu.cn/open-apis/bot/v2/hook/<your-token>","name":"Default Alarm Group","routingRules":[]}],
    "rcaTimeout":600,
    "retryPolicy":{"maxRetries":1,"initialDelay":5,"backoffMultiplier":2},
    "groupingWindow":120,
    "retentionDays":90
  }'
```

**2. Filter by namespace — only RCA alarms from certain AWS services**

Keep `alarmSelectionMode` as `"all"` and express the filter via `alarmFilters`:

```json
{
  "alarmSelectionMode": "all",
  "alarmFilters": [
    {"type": "namespace", "value": "AWS/EC2", "action": "include"},
    {"type": "namespace", "value": "AWS/RDS", "action": "include"}
  ]
}
```

**3. Filter by alarm-name regex — e.g. production-only**

```json
{
  "alarmSelectionMode": "all",
  "alarmFilters": [
    {"type": "name_pattern", "value": "^prod-",  "action": "include"},
    {"type": "name_pattern", "value": ".*test.*","action": "exclude"}
  ]
}
```

#### Filter rule reference

Each rule in `alarmFilters[]` has three fields: `type` / `value` / `action`.

| type | Meaning | Example value |
|---|---|---|
| `namespace` | Exact match on alarm metric namespace | `"AWS/EC2"` |
| `name_pattern` | **Regex** match on alarm name | `"^prod-.*"` |

| action | Behavior |
|---|---|
| `include` | Match → pass |
| `exclude` | Match → reject |

**Precedence**: `exclude` beats `include` (any exclude hit rejects immediately, includes are not consulted). `alarmSelectionMode='custom'` beats `alarmFilters` (alarms not on the whitelist are rejected before filters run).

#### Inspect the live config

```bash
aws ssm get-parameter --region us-east-1 \
  --name /cloudwatch-alarm-auto-rca/config \
  --query 'Parameter.Value' --output text | python3 -m json.tool
```

#### Debug "why was this alarm filtered out?"

Check the alarm-router Lambda logs — filter decisions are written as structured JSON:

```bash
aws logs tail /aws/lambda/<AlarmRouterFunction-name> \
  --region us-east-1 --since 10m \
  --filter-pattern '{ $.filterReason = * }'
```

Or look at the CloudWatch custom metric `CloudWatchAlarmAutoRCA / AlarmsFiltered`.

### Feishu chat bot

`@`-mention the bot inside a group with your question:

```
@DevOps Agent show the health of EC2 instances in us-east-1
@DevOps Agent which alarms fired in the past week?
@DevOps Agent analyze the performance bottleneck of prod-db
@DevOps Agent generate this week's ops health report
```

Multi-turn conversation is supported — the bot keeps context.

---

## Development

```bash
npm install            # Install deps
npm run build          # Compile TypeScript
npm test               # Run all tests (40 suites / 390 cases)
npm run test:unit      # Unit tests only
npm run test:property  # Property tests only
npm run synth          # Synth CloudFormation template
npm run lint           # Type check
```

---

## Cleanup

```bash
npx cdk destroy
```

---

## License

ISC

---

## Further Reading

- **[docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md)** — internal architecture, data flow, key design decisions
