# Code Architecture

Internal architecture document for developers and maintainers. **For deployment / usage instructions, see the repo-root [README.en.md](../README.en.md).**

> 中文版本: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 1. One-line summary

CloudWatch alarm → EventBridge → Step Functions (suspends, waits for callback) → HMAC-signed webhook to DevOps Agent → DevOps Agent runs investigation asynchronously → EventBridge event flows back and resumes SFN → render Feishu card (root cause) → automatically trigger mitigation → mitigation completion event triggers a second card (mitigation plan).

---

## 2. End-to-end sequence

```
[T+0]   CloudWatch Alarm → ALARM state
        ↓ EventBridge (source = aws.cloudwatch)
        Step Functions: AlarmRCAWorkflow starts
        ├─ InvokeAlarmRouter        (alarm-router Lambda: parse + filter)
        ├─ CheckFiltered            (Choice)
        ├─ InvokeAlarmGrouper       (alarm-grouper Lambda: merge same-resource alarms in 2-min window)
        ├─ CheckShouldWait + WaitForGroupWindow
        └─ InvokeRCAAnalyzer        (.waitForTaskToken integration)
                ↓
[T+0+5s]        rca-analyzer Lambda
                    1. Read webhook credentials from Secrets Manager
                    2. POST + HMAC-SHA256 → DevOps Agent webhook
                    3. Write a pending record to DDB (incidentId, taskToken, alarms, ...)
                    4. Lambda returns → SFN stays suspended, waiting for callback

                                  ⋮ DevOps Agent runs the investigation ⋮

[T+5min] EventBridge: aws.aidevops "Investigation Completed"
        → investigation-event-handler Lambda (phase-1 branch)
            1. DDB Scan to find the most recent pending record in the time window
            2. ListJournalRecords(executionId, "investigation_summary_md")
            3. Parse markdown → build root-cause RCAReport (reportPhase = 'investigation')
            4. SendTaskSuccess(taskToken, payload)              ← resume SFN
            5. UpdateBacklogTask(taskStatus = PENDING_START)    ← trigger the mitigation phase
            6. Update DDB: status = investigation_completed, stamp taskId

        SFN resumes
        ├─ CheckRCAStatus           (Choice on rcaReport.status)
        ├─ InvokeFeishuNotifierComplete / Partial
        │       → render the first card (title: 🔍 Root Cause Analysis Complete)
        │       → card body says "⏳ mitigation plan being generated, will arrive as a second card"
        └─ RecordSuccess / RecordFailure / RecordPartial

                                  ⋮ DevOps Agent generates mitigation ⋮

[T+8min] EventBridge: aws.aidevops "Mitigation Completed"
        → investigation-event-handler Lambda (phase-2 branch)
            1. Look up DDB by taskId (exact match)
            2. ListExecutions(taskId), find the execution where agentType = 'mitigation'
            3. ListJournalRecords(mitigationExecutionId, "mitigation_summary_md")
            4. Parse markdown (## Action / ## Reasoning / prose) → mitigation RCAReport
            5. lambda:Invoke(Event) → FeishuNotifier (bypass SFN, the workflow is already finished)
                    → render the second card (title: 🛠️ Mitigation Plan Generated)
            6. Update DDB: status = mitigation_completed
```

---

## 3. Repository layout

```
.
├── bin/
│   ├── app.ts                        ← Main stack entry point; reads config from context/env
│   └── verdaccio-proxy.ts            ← ⚠ Independent stack, unrelated to RCA
│
├── lib/
│   ├── cloudwatch-alarm-auto-rca-stack.ts  ← All AWS resources for the main stack
│   └── verdaccio-proxy-stack.ts            ← ⚠ Independent stack, see above
│
├── src/
│   ├── shared/                       ← Shared across Lambdas
│   │   ├── types.ts                  ← Global type definitions (RCAReport / SystemConfig / ...)
│   │   ├── workflow-definition.ts    ← Step Functions state machine definition
│   │   ├── config-manager.ts         ← SSM config reader with 5-minute cache
│   │   ├── dynamodb-client.ts        ← DDB operation helpers
│   │   └── index.ts                  ← Shared module re-exports
│   │
│   └── lambdas/
│       ├── alarm-router/             ← Parse + filter EventBridge alarm events
│       │   ├── index.ts              (handler)
│       │   ├── parser.ts
│       │   └── filter.ts
│       │
│       ├── alarm-grouper/            ← Aggregate same-resource alarms within 2 minutes
│       │   └── index.ts
│       │
│       ├── rca-analyzer/             ← Trigger the DevOps Agent webhook (waitForTaskToken)
│       │   ├── index.ts              (handler: trigger webhook + write pending)
│       │   ├── agent-client.ts       (HMAC webhook client)
│       │   ├── context-builder.ts    (build the RCAContext)
│       │   ├── pending-store.ts      (write pending record to DDB)
│       │   └── report-generator.ts   ⚠ legacy fallback, see §6
│       │
│       ├── investigation-event-handler/   ← Phase-1 + phase-2 dispatcher
│       │   └── index.ts
│       │
│       ├── feishu-notifier/          ← Render Feishu cards + HTTP POST
│       │   ├── index.ts              (handler)
│       │   ├── card-formatter.ts     (lark_md rendering, dual phase-1/phase-2 templates)
│       │   ├── webhook-router.ts     (route by namespace/tag to different Feishu groups)
│       │   └── sender.ts             (HTTP POST + retries + dead-letter)
│       │
│       └── feishu-bot/               ← ⚠ Independent feature: Feishu chat bot, decoupled from RCA
│
├── scripts/
│   └── stress-tests/                 ← Real stress tests (EC2/Lambda/S3, trigger real alarm chains)
│       ├── 01-ec2-cpu-stress.sh
│       ├── 02-lambda-errors-stress.sh
│       └── 03-s3-4xx-stress.sh
│
├── test/
│   ├── unit/                         ← Jest unit tests (one file per Lambda / utility)
│   ├── property/                     ← fast-check property tests (filtering, routing, TTL, …)
│   └── integration/                  ← Multi-Lambda chains / SFN simulator
│
├── docs/
│   ├── ARCHITECTURE.md               ← Chinese version
│   └── ARCHITECTURE.en.md            ← This file
│
└── README.md / README.en.md          ← Deployment + usage docs
```

---

## 4. Lambda responsibilities in detail

### 4.1 `alarm-router/index.ts`

- **Input**: an EventBridge `CloudWatch Alarm State Change` event
- **Output**: `AlarmRouterOutput` (with `filtered: boolean`)
- Logic:
  - `parser.ts` flattens the nested `detail` into `AlarmRouterOutput`
  - `filter.ts` applies `alarmSelectionMode` + `alarmFilters` from SSM config
  - Emits CloudWatch custom metrics `AlarmsReceived` / `AlarmsFiltered`

### 4.2 `alarm-grouper/index.ts`

- **Input**: `{ alarm: AlarmRouterOutput }`
- **Output**: `AlarmGrouperOutput` (`groupId / alarms / shouldWait / waitUntil`)
- Logic:
  - In `AlarmGroupTable`, search for `resourceArn = X AND status='collecting' AND windowEnd > now`
  - If found, append to that group; otherwise create a new group (2-minute window)
  - On DynamoDB failure, degrade to a single-alarm group (don't block the pipeline)

### 4.3 `rca-analyzer/index.ts` (webhook trigger version)

- **Invoked by SFN with `.waitForTaskToken`**, so SFN auto-injects a `taskToken`
- Flow:
  1. `loadWebhookCredentials()` — read from Secrets Manager, cached per container
  2. `buildRCAContext(alarms)` → `triggerDevOpsAgentInvestigation()`
  3. Success → `writePendingInvestigation()` writes DDB → returns a simple ack
  4. Failure → `SendTaskFailureCommand` so SFN immediately takes the partial branch
- **Key design: the Lambda return value is NOT the SFN step output.** Under `waitForTaskToken`, the actual step output is whatever the later `SendTaskSuccess` carries. The Lambda just needs to "trigger successfully OR fail-fast"; its return body is ignored by SFN.

#### `agent-client.ts` (HMAC webhook client)

- Reads `{ url, secret }` from Secrets Manager, caches per container (no extra fetch per invoke)
- HMAC-SHA256 signing rule: `HMAC(secret, "${timestamp}:${payload}")` → base64
- Required headers: `Content-Type` / `x-amzn-event-signature` / `x-amzn-event-timestamp`
- Retry policy: retry on 5xx + 429, give up immediately on 4xx, mark timeouts separately
- Test hooks: `setHttpTransport()` / `setSecretsManagerClient()` / `resetCredentialCache()`

#### `pending-store.ts`

- Writes `{ incidentId, triggeredAt, taskToken, groupId, alarms }` to `WorkflowExecutionTable`
  - PK = `incidentId` (note: stored under the table's `executionId` attribute name)
  - SK = `triggeredAt` (ISO timestamp)
- TTL = 2 hours (pending records that aren't picked up by phase-1 expire automatically)

### 4.4 `investigation-event-handler/index.ts` (dual-phase dispatcher)

**Both event categories go through the same Lambda; routing happens by `detail-type` prefix.**

#### Phase 1: `Investigation *` events

- **Correlation**: **time-window heuristic** (most recent `status='pending'` record within ±10 minutes)
  > The `incidentId` we sent in the webhook can't be retrieved from the EventBridge event, so we correlate by time window. Accurate enough at low concurrency.
- Pull the journal: `recordType = 'investigation_summary_md'`
- `SendTaskSuccess(taskToken, RCAReport)` to resume SFN
- Then `UpdateBacklogTask(taskStatus='PENDING_START', currentVersion)` ← **this is the API equivalent of the console "Generate mitigation plan" button** (reverse-engineered from CloudTrail).
- Update DDB: `status = 'investigation_completed'`, set `taskId = <event.task_id>`

#### Phase 2: `Mitigation *` events

- **Correlation**: **exact `taskId` match** (phase 1 already wrote `taskId` to DDB)
- ⚠ **Critical pitfall**: in `Mitigation Completed` events, `metadata.execution_id` is the
  **investigation execution** (`agentType=ops1`), **not** the mitigation execution.
  You must first `ListExecutions(taskId)`, filter by `agentType='mitigation'`,
  then pull `mitigation_summary_md` from that execution's journal.
- Use `lambda:Invoke(InvocationType='Event')` to async-invoke FeishuNotifier (bypass SFN, the workflow is finished)

### 4.5 `feishu-notifier/index.ts` + `card-formatter.ts`

#### Card formatter notes

- Feishu's `lark_md` rich-text format **only supports `**bold**` / `_italic_` / links / code blocks**, not ATX headings (`#` / `##`).
- DevOps Agent journals are full of `## Symptoms` / `### EC2 instance` headings — passed through verbatim, they show up as literal `#` characters in the card.
- Solution: `normalizeHeadings()` converts ATX headings to `**bold**`, with a `▸` prefix for `### h3` to preserve hierarchy.
- `sanitizeAgentText()` = `normalizeHeadings()` + `escapeMd()`. All untrusted text from agent journals goes through this.

#### Phase-1 vs phase-2 cards

Driven by the `RCAReport.reportPhase` field (`'investigation' | 'mitigation' | undefined`):

|  | Phase-1 (investigation) | Phase-2 (mitigation) |
|---|---|---|
| `reportPhase` | `'investigation'` | `'mitigation'` |
| Card title | 🔍 Root Cause Analysis Complete | 🛠️ Mitigation Plan Generated |
| Default color | red/orange/green by confidence | green |
| Sections rendered | Alarms / Investigation timeline / Root cause / Mitigation plan (placeholder) | Alarms / Mitigation plan |
| Mitigation section content | "⏳ Mitigation being generated, will arrive as a second card" | Real mitigation content |

`isMitigationOnlyReport()` checks `reportPhase` first; falls back to a heuristic (mitigationPlan present, no rootCauses/keyFindings) only when `reportPhase` is unset.
**Important: do NOT decide card identity by checking whether `mitigationPlan` is empty** — DevOps Agent can return prose ("no operational mitigation needed") in which the regex extracts no steps, but the card still must render as a mitigation card.

#### Prose fallback

When the mitigation card has no structured steps, **fall back to rendering `agentRawText` verbatim** (after `sanitizeAgentText`). This covers the "## Action / ## Reasoning / single paragraph" output shape.

---

## 5. Storage

### `WorkflowExecutionTable`

| Field | Type | Notes |
|---|---|---|
| `executionId` | PK string | Stores the webhook `incidentId` (`cw-alarm-{groupId}-{ms}`) |
| `createdAt` | SK string (ISO) | When the webhook was triggered |
| `status` | string | `pending` / `investigation_completed` / `mitigation_completed` / `mitigation_failed` / `failed` / `timed_out` |
| `taskToken` | string | SFN callback token, used in phase 1 |
| `taskId` | string | Written by phase 1, used by phase 2 for exact lookup |
| `alarms` | list | Full `AlarmRouterOutput[]`; the event handler rebuilds the RCAReport from it |
| `groupId` | string | Forwarded from SFN |
| `stateTransitions` | list | Append-only state-change log |
| `ttl` | number | 2-hour expiration |

### `AlarmGroupTable`

| Field | Type | Notes |
|---|---|---|
| `resourceArn` | PK string | Resource ARN |
| `groupId` | SK string | UUID |
| `windowStart` / `windowEnd` | ISO string | Aggregation window |
| `status` | string | `collecting` / `processing` / `done` |
| `alarms` | list | Alarms in this group |

### `DeadLetterNotificationTable`

Holds Feishu notifications that failed all 3 retries — useful for manual replay.

---

## 6. ⚠ Legacy code: `report-generator.ts`

The functions `generateFullReport / generatePartialReport / generateTimeoutReport / generateRCAReport / AgentResponse`
are **no longer called by rca-analyzer** in the new webhook flow, but they are kept on purpose:

1. `test/unit/rca-report-generator.test.ts`, `test/property/rca-report.test.ts`, and
   `test/integration/workflow.test.ts` still use `generateFullReport` etc. to assert RCAReport shape.
2. They serve as a fallback if the webhook path ever needs to be rolled back.
3. RCAReport field-mapping rules are concentrated here, which makes RCAReport schema changes easier to find.

If the webhook path is confirmed stable in the future, you can delete these functions and the related tests together.

---

## 7. EventBridge rules

| Rule | source | detail-type | target |
|---|---|---|---|
| `CloudWatchAlarmRule` | `aws.cloudwatch` | `CloudWatch Alarm State Change` (only ALARM state) | Step Functions `AlarmRCAWorkflow` |
| `DevOpsAgentInvestigationRule` | `aws.aidevops` | `Investigation Completed/Failed/Timed Out/Cancelled/Skipped` + `Mitigation Completed/Failed/Timed Out/Cancelled` | Lambda `investigation-event-handler` |

---

## 8. Key IAM permissions (per Lambda)

| Lambda | aidevops:* | Other |
|---|---|---|
| RCAAnalyzer | — | `secretsmanager:GetSecretValue/DescribeSecret` (scoped to ARN), `states:SendTaskSuccess/Failure/Heartbeat`, `workflowExecutionTable:Read+Write` |
| InvestigationEventHandler | `ListJournalRecords / GetBacklogTask / UpdateBacklogTask / ListExecutions / GetAgentSpace` | `states:SendTaskSuccess/Failure/Heartbeat`, `workflowExecutionTable:Read+Write`, `lambda:InvokeFunction` (scoped to FeishuNotifier ARN) |
| FeishuNotifier | — | `deadLetterTable:Write` |
| AlarmRouter | — | `workflowExecutionTable:Read+Write` |
| AlarmGrouper | — | `alarmGroupTable:Read+Write` |

Every Lambda has `cloudwatch:PutMetricData` (namespace-scoped) and SSM config-parameter read.

---

## 9. Configuration entry points

### CDK context / env vars (deploy time)

| context key | env var | Purpose |
|---|---|---|
| `agentSpaceId` | `AGENT_SPACE_ID` | Injected into RCAAnalyzer / FeishuNotifier / InvestigationEventHandler / FeishuBot |
| `feishuWebhookUrl` | `FEISHU_WEBHOOK_URL` | Default webhook written into SSM config |
| `feishuAppId` | `FEISHU_APP_ID` | Used by FeishuBot (optional) |
| `feishuAppSecret` | `FEISHU_APP_SECRET` | Used by FeishuBot (optional) |
| `feishuVerificationToken` | `FEISHU_VERIFICATION_TOKEN` | Used by FeishuBot (optional) |
| `devopsAgentWebhookSecretName` | — | Secrets Manager secret name; default `cloudwatch-alarm-auto-rca/devops-agent-webhook` |
| `deployFeishuBot` | — | `false` to skip FeishuBot (default `true`) |

### Secrets Manager (runtime)

`cloudwatch-alarm-auto-rca/devops-agent-webhook` (default name, configurable):

```json
{
  "url": "https://event-ai.us-east-1.api.aws/webhook/generic/<webhook-id>",
  "secret": "<HMAC-secret>"
}
```

Get the credentials from the DevOps Agent console → Capabilities → Webhook → Generate. **To rotate:**

```bash
aws secretsmanager update-secret \
  --region us-east-1 \
  --secret-id cloudwatch-alarm-auto-rca/devops-agent-webhook \
  --secret-string '{"url":"...","secret":"<new-value>"}'
# Lambda containers cache the value; the new secret takes effect on the next cold start.
```

### SSM Parameter (runtime)

`/cloudwatch-alarm-auto-rca/config`. Field definitions: see [README.en.md §Configuration](../README.en.md#configuration). `ConfigManager` refreshes every 5 minutes.

---

## 10. Debugging cheat-sheet

### "Card never arrived" / "card arrived but body is empty"

Walk the chain forward:

```bash
# 1. Did SFN start an execution?
aws stepfunctions list-executions --region us-east-1 \
  --state-machine-arn arn:aws:states:us-east-1:<account>:stateMachine:AlarmRCAWorkflow* \
  --max-items 5

# 2. Did RCAAnalyzer trigger the webhook successfully?
aws logs tail /aws/lambda/<RCAAnalyzerFunction-name> --region us-east-1 --since 10m

# 3. Did the EventBridge event reach InvestigationEventHandler?
aws logs tail /aws/lambda/<InvestigationEventHandler-name> --region us-east-1 --since 30m

# 4. Did FeishuNotifier deliver the card?
aws logs tail /aws/lambda/<FeishuNotifierFunction-name> --region us-east-1 --since 30m
```

### Custom CloudWatch metrics (namespace = `CloudWatchAlarmAutoRCA`)

| Metric | Meaning |
|---|---|
| `AlarmsReceived` / `AlarmsFiltered` | alarm-router throughput |
| `RCAAnalysesInitiated` / `RCAWebhookSucceeded` / `RCAWebhookFailed` | rca-analyzer webhook trigger |
| `InvestigationEventMatched` / `InvestigationEventUnmatched` / `InvestigationEventDeliveryFailed` | phase-1 correlation results |
| `MitigationTriggered` / `MitigationTriggerFailed` | UpdateBacklogTask outcome |
| `MitigationEventMatched` / `MitigationEventUnmatched` / `MitigationCardDispatchFailed` | phase-2 outcome |
| `NotificationsSent` / `NotificationsFailed` | Feishu delivery results |

### Run tests

```bash
npm test                # All (unit + property + integration simulator)
npm run test:unit       # Unit only
npm run test:property   # fast-check property tests only
npm run lint            # tsc --noEmit
```

> **Known lint error**: `lib/verdaccio-proxy-stack.ts` reports `grantTaskDefinitionAccess` does not exist. That's an
> independent stack (private npm registry proxy) unrelated to the RCA pipeline; the symbol was broken by a CDK API
> upgrade. It does not affect the main stack's deployment or runtime — the main stack compiles cleanly within the
> same `tsc` invocation.

---

## 11. Important historical decisions

Recorded so future maintainers don't repeat the same mistakes. **Don't reverse these decisions without new evidence.**

### 11.1 Why webhook + EventBridge instead of CreateChat + SendMessage

The earliest v1 used `aidevops:CreateChat + SendMessage` to stream the root-cause markdown. Problems:

- The chat session's `executionId` does **not** belong to the investigation namespace — it can't be used to deep-link into the DevOps Agent console (`/home/activity/{id}` always 404'd).
- Long streaming responses tend to emit a `responseFailed` event near the tail, which forces complex "preserve partial" logic.
- No way to "auto-trigger mitigation".

The webhook path is the standard event-driven pattern recommended by DevOps Agent's own docs.

### 11.2 SFN `.waitForTaskToken` instead of synchronous waiting

DevOps Agent investigations typically take 5–10 minutes. Lambda's max execution time is 15 minutes — long enough, but:

- Billing is per Lambda runtime; every alarm would burn ~600 seconds of compute.
- Long-lived connections get cut by middleboxes.
- It's not graceful — this is fundamentally an async task.

`.waitForTaskToken` lets the Lambda exit immediately after triggering, keeps SFN suspended waiting for a callback, and **does not consume Lambda billing time** while waiting.

### 11.3 Phase-1 correlates by time window, phase-2 correlates by taskId

EventBridge events don't carry the `incidentId` we sent.

- At phase 1, we don't yet have `taskId` (it's first observable in the event itself), so time-window matching is the only option.
- Phase 1 stamps `taskId` into DDB; phase 2 can do an exact match.

### 11.4 Phase-2 must call ListExecutions, can't use the executionId from the event

In `Mitigation Completed` events, `metadata.execution_id` = investigation execution (ops1),
while `mitigation_summary_md` only exists in the journal of the mitigation execution (`agentType='mitigation'`).
Using the id from the event will never return any content. See §4.4.

### 11.5 `UpdateBacklogTask(PENDING_START)` is the API behind "Generate mitigation plan"

[IAM docs](https://docs.aws.amazon.com/devopsagent/latest/userguide/aws-devops-agent-security-devops-agent-iam-permissions.html), verbatim: `aidevops:UpdateBacklogTask – Allows users to **approve a mitigation plan** or cancel an active investigation or evaluation`.

The exact `taskStatus` value isn't documented; reverse-engineered from CloudTrail it is `'PENDING_START'`. You also need to call `GetBacklogTask` first to fetch the current `version` (optimistic lock). The SDK type doesn't declare a `currentVersion` field, but the wire protocol accepts it.

### 11.6 `lark_md` doesn't support `#` headings

DevOps Agent journals frequently use `##` / `###`. Without normalization, Feishu renders these as literal `#` characters. `normalizeHeadings()` rewrites them to `**bold**`.
