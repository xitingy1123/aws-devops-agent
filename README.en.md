# CloudWatch Alarm Auto RCA

Automated root cause analysis for CloudWatch alarms, powered by AWS DevOps Agent. When a CloudWatch alarm fires, the system automatically invokes DevOps Agent to investigate the root cause, generates a structured RCA report, and pushes it to your team via Feishu (Lark) webhook. Once the investigation finishes, the system automatically triggers Mitigation Plan generation and pushes a separate mitigation card to Feishu — the entire Investigation → Mitigation flow needs zero manual clicks. A Feishu chat-bot assistant is also included so you can talk to DevOps Agent directly inside Feishu, including running and viewing improvement plans.

> 中文版本: [README.md](README.md)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                Automated Alarm Pipeline (Phase 1 + Phase 2)                 │
│                                                                             │
│  CloudWatch Alarm ──→ EventBridge ──→ Step Functions ──→ Lambda             │
│       (ALARM)         (rule match)    (orchestration)   (handlers)          │
│                                                                             │
│  Lambda chain (Phase 1 — Investigation):                                    │
│  AlarmRouter → AlarmGrouper → RCAAnalyzer → [DevOps Agent] → FeishuNotifier │
│  (parse+filter) (aggregate)   (call Agent)                   (① root-cause card)
│                                                                             │
│  Lambda chain (Phase 2 — Mitigation, auto-triggered):                       │
│  EventBridge `Investigation Completed`                                      │
│        ↓                                                                    │
│  InvestigationEventHandler ──[UpdateBacklogTask: PENDING_START]──→ Agent    │
│        ↓                                                                    │
│  EventBridge `Mitigation Completed`                                         │
│        ↓                                                                    │
│  InvestigationEventHandler ──→ FeishuNotifier (② mitigation card)           │
└─────────────────────────────────────────────────────────────────────────────┘

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
- **Automated root cause (Investigation)** — Calls AWS DevOps Agent and produces a structured report
- **Automated mitigation (Mitigation)** — When Investigation completes, the system automatically calls `UpdateBacklogTask(taskStatus='PENDING_START')` (equivalent to clicking the console "Generate mitigation plan" button) and delivers a second Feishu card with the mitigation steps once it's ready — no manual action needed
- **Feishu notification** — Each alarm pipeline ultimately delivers **2 cards** to the group (① root cause + investigation timeline, ② mitigation plan), with multi-webhook routing
- **Feishu chat-bot** — `@`-mention the bot in Feishu to talk to DevOps Agent; chat-initiated investigations follow the same auto-mitigation flow and the second card lands back in the original chat
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
| ChatInvestigationMappingTable | DynamoDB | Maps Feishu chat → DevOps Agent taskId for chat-initiated investigations |
| AlarmRouterFunction | Lambda | Parse + filter alarms |
| AlarmGrouperFunction | Lambda | Aggregate alarms |
| RCAAnalyzerFunction | Lambda | Trigger DevOps Agent Investigation |
| InvestigationEventHandlerFunction | Lambda | Handles `aws.aidevops` Investigation*/Mitigation* events: resumes SFN, **auto-triggers Mitigation generation**, dispatches phase-2 card |
| FeishuNotifierFunction | Lambda | Renders and delivers Feishu cards (both phase-1 and phase-2) |
| FeishuBotFunction | Lambda | Feishu chat bot (optional) |
| FeishuBotApi | API Gateway | Feishu event callback endpoint (optional) |
| AlarmRCAWorkflow | Step Functions | Workflow orchestration (carries phase 1 only; phase 2 is driven directly by EventBridge) |
| CloudWatchAlarmRule | EventBridge | Capture CloudWatch alarm events |
| DevOpsAgentInvestigationRule | EventBridge | Capture `aws.aidevops` Investigation*/Mitigation* terminal events |
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

The project ships three capabilities:

- CloudWatch alarms automatically trigger DevOps Agent to produce an RCA and push it to Feishu (with auto-generated Mitigation Plan)
- Chat with DevOps Agent directly in Feishu
- Run the Improvement Plan inside Feishu

### Automated alarm RCA (two phases: Investigation + Mitigation)

Zero manual steps. The moment any CloudWatch alarm enters `ALARM`, the system runs the full two-phase pipeline automatically:

**Phase 1 — Investigation (root cause analysis)**

1. EventBridge captures the ALARM state change
2. AlarmRouter parses + filters
3. AlarmGrouper aggregates same-resource alarms (2-minute window)
4. RCAAnalyzer calls DevOps Agent to start the Investigation
5. The Agent emits an `Investigation Completed` event when done
6. **Card ① delivered**: root cause + investigation timeline

**Phase 2 — Mitigation (auto-triggered, no manual click)**

7. After receiving `Investigation Completed`, InvestigationEventHandler automatically calls `UpdateBacklogTask(taskStatus='PENDING_START')` — equivalent to clicking "Generate mitigation plan" in the console
8. The Agent emits `Mitigation Completed` when done
9. InvestigationEventHandler async-invokes FeishuNotifier
10. **Card ② delivered**: mitigation steps + commands

> Each alarm ultimately delivers **2 cards** to the Feishu group, typically 1–3 minutes apart (depends on Agent's mitigation generation time). If Investigation ends in any non-Completed terminal state (Failed/TimedOut/Cancelled/Skipped), Phase 2 is skipped and only **1 card** is sent.
>
> Chat-initiated investigations (`@`-mention the bot in Feishu) follow the exact same auto-mitigation flow; the second card lands back in the original chat.

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

#### Run the Improvement Plan in Feishu

The bot can run a fresh "improvement plan" right from a group — based on the INVESTIGATION tasks completed inside the Agent Space, it analyzes recent ops events and produces new improvement recommendations. **Trigger flow: send a keyword to summon the menu card → click "🚀 Run improvement plan"**.

**Step 1 — Summon the menu card**

`@`-mention the bot with any of the following keywords (the **whole message** must be the keyword, leading/trailing spaces ignored, case-insensitive):

- `改善计划`
- `改进建议`
- `improvements`
- `improvement`

For example:

```
@DevOps Agent improvements
@DevOps Agent 改善计划
```

The bot replies with a card containing two buttons:

- 🚀 **Run improvement plan** — calls `CreateBacklogTask({ taskType: 'EVALUATION' })` against the first ACTIVE goal in your Agent Space, polls until completion, and posts the new recommendations back to the group as a text message. Roughly 30 s – 2 min.
- 🔍 **Show recommendations** — lists every existing improvement recommendation already stored in the Agent Space (no new task created).

**Step 2 — Just click**

> ⚠️ Improvement Plan tasks **require at least one completed INVESTIGATION in the recent window**. If no incident investigation has been triggered recently, you'll see "Improvement plan cannot start — there must be a completed INVESTIGATION task first". Wait for an alarm to drive an automatic RCA, or ask the Agent to investigate something in chat, then try again.

**Notes**

- The keyword must match the **whole message strictly**. Embedding it in a longer sentence ("I want to see the improvement plan") will not summon the menu — it falls through to the regular Q&A path. To trigger it inside a longer conversation, just send the keyword as its own message.

---

## Troubleshooting / Debugging

### Feishu group never receives the RCA card

Check in order:

```bash
# 1. Make sure feishuWebhooks is non-empty in SSM config
aws ssm get-parameter --region us-east-1 --name /cloudwatch-alarm-auto-rca/config \
  --query 'Parameter.Value' --output text | jq .feishuWebhooks

# 2. Look at the Feishu API response captured by FeishuNotifier (logged on every send)
aws logs tail /aws/lambda/<FeishuNotifierFunction-name> --region us-east-1 \
  --since 30m --filter-pattern '"Feishu webhook response"'

# 3. Manually curl the webhook to confirm the bot itself is still in the group
curl -s -X POST "<your-webhook-url>" \
  -H 'Content-Type: application/json' \
  -d '{"msg_type":"text","content":{"text":"healthcheck"}}'
```

The `Feishu webhook response` log line includes the full body Feishu returned (including `code` and `msg`). If you see `code=0 msg=success` but the group received nothing, the most likely cause is the bot was kicked from the group.

### Got the first card (root cause) but the second card (Mitigation) never arrived

Phase 2 is automatically triggered by InvestigationEventHandler after it receives `Investigation Completed`, by calling `UpdateBacklogTask`. If the second card never shows up, walk through this:

```bash
# 1. Find the InvestigationEventHandler Lambda function name
HANDLER_FN=$(aws lambda list-functions --region us-east-1 \
  --query "Functions[?contains(FunctionName, 'InvestigationEventHandler')].FunctionName | [0]" \
  --output text)
echo "$HANDLER_FN"

# 2. Did mitigation generation get triggered?
aws logs tail /aws/lambda/"$HANDLER_FN" --region us-east-1 --since 30m \
  --filter-pattern '"Mitigation generation triggered"'

# 3. If trigger failed, look at the error (common: missing IAM perm, expired taskId)
aws logs tail /aws/lambda/"$HANDLER_FN" --region us-east-1 --since 30m \
  --filter-pattern '"triggerMitigationGeneration failed"'

# 4. Did EventBridge ever emit a Mitigation Completed event?
aws logs tail /aws/lambda/"$HANDLER_FN" --region us-east-1 --since 30m \
  --filter-pattern '"Mitigation"'

# 5. Look at the custom metrics MitigationTriggered / MitigationTriggerFailed
aws cloudwatch get-metric-statistics --region us-east-1 \
  --namespace CloudWatchAlarmAutoRCA \
  --metric-name MitigationTriggered \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 --statistics Sum
```

Common causes:

| Symptom | Cause | Fix |
|---|---|---|
| No `Mitigation generation triggered` log line | Investigation finished in a non-`Completed` terminal state (Failed/TimedOut/Cancelled). Phase 2 is intentionally skipped. | Expected behavior |
| `triggerMitigationGeneration failed` with `AccessDenied` | Lambda is missing `aiops:UpdateBacklogTask` | Re-run `cdk deploy` |
| Trigger succeeded but card never arrives (>10 min) | Mitigation is still running on the Agent side, or it failed without emitting the terminal event | Find the task in the DevOps Agent console and check its status |

### Changed SSM config but Lambdas still see the old values

ConfigManager caches for 5 minutes. To force a cold start (and an immediate refresh), bump a Lambda env var:

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

> ⚠️ Single-line JSON in shell easily picks up smart quotes. When updating SSM config, write the JSON to a file and pass it with `--value "$(cat config.json)"` — that avoids smart quotes from your editor leaking into the command.

### Trace which Step Functions path was taken

A `SUCCEEDED` execution doesn't necessarily mean "Feishu received the card" — the alarm may have been filtered out at AlarmRouter and routed through `RecordFiltered`, which also yields SUCCEEDED but never sends a card.

```bash
EXEC_ARN=$(aws stepfunctions list-executions \
  --state-machine-arn arn:aws:states:us-east-1:<account>:stateMachine:AlarmRCAWorkflow... \
  --max-results 1 --region us-east-1 --query 'executions[0].executionArn' --output text)
aws stepfunctions get-execution-history --execution-arn "$EXEC_ARN" --region us-east-1 \
  --query 'events[?type==`PassStateEntered` || type==`TaskStateEntered`].stateEnteredEventDetails.name' \
  --output text
```

- Full happy path: `InvokeAlarmRouter → InvokeAlarmGrouper → InvokeRCAAnalyzer → InvokeFeishuNotifierComplete → RecordSuccess`
- Filtered out: `InvokeAlarmRouter → RecordFiltered` (finishes in seconds, no card sent)

---

## Stress test scripts

`scripts/stress-tests/` ships three **real stress test scripts** covering three different AWS services. They use real workloads to produce real metrics so the alarms naturally enter `ALARM` — no mocks, no `set-alarm-state` flips, no fake `put-metric-data`.

| Script | Service | How it stresses | Metric |
|---|---|---|---|
| `01-ec2-cpu-stress.sh` | EC2 | Runs `stress-ng` over SSM to peg CPU | `AWS/EC2 CPUUtilization` |
| `02-lambda-errors-stress.sh` | Lambda | Deploys a Lambda that throws, invokes it 3 times | `AWS/Lambda Errors` |
| `03-s3-4xx-stress.sh` | S3 | Repeatedly GETs nonexistent keys (NoSuchKey 4xx) | `AWS/S3 4xxErrors` |

```bash
# EC2 (run directly; assumes alarm "EC2-HighCPU-Test" + a target instance exist)
./scripts/stress-tests/01-ec2-cpu-stress.sh 5     # stress for 5 minutes

# Lambda (setup → stress → cleanup)
./scripts/stress-tests/02-lambda-errors-stress.sh setup
./scripts/stress-tests/02-lambda-errors-stress.sh stress
./scripts/stress-tests/02-lambda-errors-stress.sh cleanup

# S3 (same pattern; note Request Metrics has ~15min reporting lag after enable)
./scripts/stress-tests/03-s3-4xx-stress.sh setup
./scripts/stress-tests/03-s3-4xx-stress.sh stress
./scripts/stress-tests/03-s3-4xx-stress.sh cleanup
```

Details: [scripts/stress-tests/README.md](scripts/stress-tests/README.md)

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
