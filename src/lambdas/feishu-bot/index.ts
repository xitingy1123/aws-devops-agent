/**
 * 飞书 Bot 对话助手 — Lambda + API Gateway 实现
 *
 * 支持两种交互方式：
 * 1. 文本消息：用户 @机器人 提问，调用 DevOps Agent SendMessage
 * 2. 交互卡片：用户点击按钮（如"查看巡检建议"）触发 ListRecommendations
 */

import {
  DevOpsAgentClient,
  CreateChatCommand,
  SendMessageCommand,
  ListRecommendationsCommand,
  CreateBacklogTaskCommand,
  GetBacklogTaskCommand,
  ListExecutionsCommand,
  ListJournalRecordsCommand,
} from '@aws-sdk/client-devops-agent';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface FeishuEvent {
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
  };
  event?: {
    sender?: { sender_id?: { open_id?: string; user_id?: string } };
    message?: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      content: string;
      mentions?: Array<{ key: string; id: { open_id?: string } }>;
    };
  };
  challenge?: string;
  token?: string;
  type?: string;
  // 卡片回调（card.action.trigger）字段
  action?: {
    value?: any;
    tag?: string;
  };
  open_message_id?: string;
  open_chat_id?: string;
}

interface APIGatewayEvent {
  body: string | null;
  headers: Record<string, string>;
  httpMethod: string;
  isBase64Encoded: boolean;
}

interface APIGatewayResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------
// 环境变量
// ---------------------------------------------------------------------------

const FEISHU_APP_ID = (process.env.FEISHU_APP_ID ?? '').trim();
const FEISHU_APP_SECRET = (process.env.FEISHU_APP_SECRET ?? '').trim();
// trim 是关键：CDK 部署时 -c agentSpaceId="..." 偶尔会把粘贴时混入的前/后导
// 空格一并塞进环境变量，DevOps Agent 服务端会把带空格的 ID 当作"找不到的资源"
// 直接 403 AccessDenied，错误信息只说 "An internal error occurred"，定位很费劲。
const AGENT_SPACE_ID = (process.env.AGENT_SPACE_ID ?? '').trim();
const AWS_REGION_NAME = process.env.AWS_REGION ?? 'us-east-1';

// ---------------------------------------------------------------------------
// 客户端实例
// ---------------------------------------------------------------------------

const devopsClient = new DevOpsAgentClient({ region: AWS_REGION_NAME });
const lambdaClient = new LambdaClient({ region: AWS_REGION_NAME });
const ddbDocClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: AWS_REGION_NAME })
);
const sessions: Map<string, string> = new Map();
const processedEvents: Set<string> = new Set();
const MAX_PROCESSED_EVENTS = 1000;

// ---------------------------------------------------------------------------
// Chat → Investigation 映射表（DynamoDB）
//
// 用户在 chat 里说"调查一下…"，DevOps Agent 自己会调 CreateBacklogTask
// 创建一个 INVESTIGATION 任务。这个任务我们 backend 看不到 taskId，所以
// 调查完成后 EventBridge 事件会"无主"，结果回不到群里。
//
// 解决：在 SendMessage 调用前后用 ListBacklogTasks 做差量发现，把新
// 出现的 INVESTIGATION 任务和当前 chatId 关联起来写入此表。
// EventBridge handler 收到 'Investigation Completed' 时 fallback 查这张表。
// ---------------------------------------------------------------------------

interface ChatInvestigationMapping {
  taskId: string;
  chatId: string;
  createdAt: string;
  description?: string;
  source: 'feishu_chat';
  ttl: number; // Unix seconds
}

function getMappingTableName(): string | undefined {
  return process.env.CHAT_INVESTIGATION_MAPPING_TABLE_NAME;
}

async function putChatInvestigationMapping(
  taskId: string,
  chatId: string,
  description?: string
): Promise<void> {
  const tableName = getMappingTableName();
  if (!tableName) {
    console.warn('CHAT_INVESTIGATION_MAPPING_TABLE_NAME not set; skip mapping write');
    return;
  }
  const item: ChatInvestigationMapping = {
    taskId,
    chatId,
    createdAt: new Date().toISOString(),
    description,
    source: 'feishu_chat',
    // 24 小时 TTL — 调查应该在分钟级完成，过期记录无意义
    ttl: Math.floor(Date.now() / 1000) + 86400,
  };
  try {
    await ddbDocClient.send(new PutCommand({ TableName: tableName, Item: item }));
    console.log(`Mapped chat→investigation: taskId=${taskId} chatId=${chatId}`);
  } catch (err: any) {
    console.error('Failed to write chat→investigation mapping:', err);
  }
}

/**
 * 从 DevOps Agent 的 chat 响应文本里抽取所有 INVESTIGATION taskId。
 *
 * Agent 在 chat 模式下创建调查时会**主动**在响应文本里嵌入这种标记。
 * 实际看到的格式（参考真实截图）：
 *
 *   [[investigation:0556a555-ca43-4a3a-8975-35b21a1f966d:High CPU spikes on EC2 instance i-...]]
 *
 * 注意：
 *   - 是**双方括号** [[...]] 而不是单方括号
 *   - UUID 之后还跟着 ":<title>" 后缀
 *
 * 最稳的做法：忽略外层括号 / 标题后缀，直接匹配 `investigation:<uuid>`。
 * 标准 v4 UUID 是 36 字符（8-4-4-4-12），按这个严格匹配就不会误中其它内容。
 *
 * 一条响应里可能多次引用同一个 taskId，返回去重列表。
 *
 * Exported for unit testing.
 */
export function extractInvestigationTaskIds(text: string): string[] {
  if (!text) return [];
  // 匹配 investigation:<uuid> —— 标准 36-char UUID (hex + 短横线)
  const pattern = /investigation:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function isDuplicate(eventId: string): boolean {
  if (processedEvents.has(eventId)) return true;
  processedEvents.add(eventId);
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    const first = processedEvents.values().next().value;
    if (first) processedEvents.delete(first);
  }
  return false;
}

/**
 * 跨 Lambda 实例的事件去重（DDB 原子声明）。
 *
 * 内存里的 isDuplicate 不跨实例：飞书 3s 没收到 200 就重试，冷启动时第一个
 * 请求还在跑，重试就被路由到**另一个新冷启动的实例**——两个实例的内存 Set
 * 各管各的，都没见过这个 eventId，于是都派发 async job → 用户看到双份消息。
 *
 * 这个函数用 PutItem + ConditionExpression 拿到分布式锁：第一个实例写成功
 * 返回 false；后续重试 ConditionalCheckFailedException → 视为重复返回 true。
 *
 * TTL 10 分钟 —— 飞书重试窗口 1h，但同一 event 不会真的间隔 > 10min。
 *
 * 失败时（DDB 不可达 / 表名未配置）回退到内存去重，避免完全把 bot 卡死。
 */
async function isDuplicateRemote(eventId: string): Promise<boolean> {
  const tableName = process.env.FEISHU_EVENT_DEDUP_TABLE_NAME;
  if (!tableName) {
    console.warn('FEISHU_EVENT_DEDUP_TABLE_NAME not set; falling back to in-memory dedup');
    return isDuplicate(eventId);
  }
  const ttl = Math.floor(Date.now() / 1000) + 600; // 10 分钟
  try {
    await ddbDocClient.send(
      new PutCommand({
        TableName: tableName,
        Item: { eventId, claimedAt: new Date().toISOString(), ttl },
        ConditionExpression: 'attribute_not_exists(eventId)',
      })
    );
    // 拿到锁，同时也写一下内存缓存（同一实例后续直接命中无需打 DDB）
    processedEvents.add(eventId);
    return false;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      // 已被其它实例（或同实例之前的请求）认领过 → 重复
      return true;
    }
    // 其它错误（IAM、网络、限流等）：保守起见**视为不重复**继续处理。
    // 宁可双发也不能因为 dedup 表故障让所有事件被丢弃。
    console.error('isDuplicateRemote failed, treating as not-duplicate:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 飞书 API
// ---------------------------------------------------------------------------

let cachedToken: { value: string; expireAt: number } | null = null;

async function getTenantAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expireAt > Date.now() + 60000) {
    return cachedToken.value;
  }
  const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await response.json() as any;
  if (data.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${data.msg}`);
  }
  cachedToken = { value: data.tenant_access_token, expireAt: Date.now() + (data.expire ?? 7200) * 1000 };
  return cachedToken.value;
}

async function replyMessage(messageId: string, msgType: string, content: any): Promise<void> {
  const token = await getTenantAccessToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ content: JSON.stringify(content), msg_type: msgType }),
  });
  const data = await response.json() as any;
  if (data.code !== 0) console.error('Failed to reply:', data);
}

async function sendCardToChat(chatId: string, card: any): Promise<void> {
  const token = await getTenantAccessToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      content: JSON.stringify(card),
      msg_type: 'interactive',
    }),
  });
  const data = await response.json() as any;
  if (data.code !== 0) {
    // 改成抛异常 — 之前只 console.error 不 throw 导致上层 try/catch 永远捕获不到，
    // 用户会看到"卡片已发送"的 toast 但实际卡片没出来。
    console.error('Failed to send card:', data);
    throw new Error(
      `Failed to send card: code=${data.code} msg=${data.msg ?? 'unknown'}`
    );
  }
  console.log(`Card sent to chat ${chatId}, message_id=${data.data?.message_id}`);
}

// ---------------------------------------------------------------------------
// 卡片构建
// ---------------------------------------------------------------------------

/**
 * 构建欢迎/菜单卡片：用户输入"改善计划"或"改进建议"或"improvements"时显示
 */
function buildMenuCard(): any {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🛠 DevOps Agent 运维助手' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '👋 你可以通过以下功能快速使用 DevOps Agent：',
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '**📋 改进建议（Improvements）**',
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🚀 立即运行改善计划' },
            type: 'primary',
            value: { action: 'run_evaluation' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔍 查看改进建议' },
            type: 'default',
            value: { action: 'list_recommendations' },
          },
        ],
      },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: '🚀 立即运行改善计划：触发 DevOps Agent 在后台分析最近事件并生成新的改进建议（约 30 秒 - 2 分钟）' },
        ],
      },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: '🔍 查看改进建议：列出 Agent Space 中已存在的所有运维改进建议' },
        ],
      },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: '💬 直接 @机器人 + 你的问题（含「调查」类描述时 Agent 会自动发起 INVESTIGATION 任务，结果会自动推回群里）。' },
        ],
      },
    ],
  };
}

/**
 * 构建"巡检中"加载卡片
 */
function buildLoadingCard(): any {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔄 正在拉取改进建议...' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: '正在从 DevOps Agent 拉取最新改进建议，请稍候...' },
      },
    ],
  };
}

/**
 * 构建"事件调查仪表板"卡片 — 复刻 DevOps Agent 控制台的 Investigation Dashboard。
 *
 * 使用 **Card JSON Schema 2.0** 结构（Lark client >= 7.20 全支持，2024 年初发布）。
 * 之前 1.0 结构的 `tag: 'form'` 容器和 `input_type: 'multiline_text'` 都不存在，
 * 导致整个表单元素被静默丢弃 —— 用户截图里看到只剩头尾两段文字就是这个原因。
 *
 * 2.0 结构关键点：
 *   - 顶层用 `schema: '2.0'` 显式声明
 *   - `body.elements` 而不是 `elements`
 *   - `Form` 容器（首字母大写的 element_id 不影响渲染，但 tag 必须是 'form'）
 *   - `Input` 组件支持 `placeholder / default_value / required / max_length`
 *   - 多行：`Input` 不直接支持 multiline，所以这里用了 `Textarea`
 *   - 按钮的提交动作走 `behaviors: [{ type: 'callback' }]` + `form_action_type: 'submit'`
 *
 * 包含：
 *   - 多行 textarea（必填，让用户自由描述调查目标）
 *   - 三个快速模板按钮（Latest alarm / High CPU usage / Error rate spike）—
 *     点击后整张卡片更新为预填好描述的版本
 *   - Start investigation 提交按钮（form_action_type=submit）
 *
 * 表单提交后飞书会把所有 input/textarea 的值放在 form_value 里随
 * card.action.trigger 回传，我们再读取 description 字段调
 * CreateBacklogTask({taskType:'INVESTIGATION'})。
 *
 * @param defaultDescription 预填充的描述，由"快速模板"按钮触发时使用
 */
function buildInvestigationFormCard(defaultDescription: string = ''): any {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '🔬 Incident Response Dashboard' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '**Start an investigation**\n\n描述你想发起的调查任务，请尽量包含调查目标、关注的资源/指标范围或其它相关上下文信息。',
        },
        {
          tag: 'form',
          name: 'investigation_form',
          elements: [
            {
              tag: 'input',
              name: 'description',
              placeholder: {
                tag: 'plain_text',
                content:
                  '例如：us-east-1 EC2 实例 i-xxxxx 最近 30 分钟 CPU 持续高于 90%，请排查根因…',
              },
              default_value: defaultDescription,
              required: true,
              max_length: 1000,
              // 多行输入 —— 飞书 schema 2.0 支持的官方写法
              input_type: 'multiline_text',
              rows: 5,
            },
            {
              tag: 'markdown',
              content:
                '<font color="grey">快速模板（点击替换上方输入框内容）：</font>',
            },
            {
              tag: 'action',
              actions: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: 'Latest alarm' },
                  type: 'default',
                  behaviors: [
                    {
                      type: 'callback',
                      value: { action: 'fill_template', template: 'latest_alarm' },
                    },
                  ],
                },
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: 'High CPU usage' },
                  type: 'default',
                  behaviors: [
                    {
                      type: 'callback',
                      value: { action: 'fill_template', template: 'high_cpu' },
                    },
                  ],
                },
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: 'Error rate spike' },
                  type: 'default',
                  behaviors: [
                    {
                      type: 'callback',
                      value: { action: 'fill_template', template: 'error_spike' },
                    },
                  ],
                },
              ],
            },
            { tag: 'hr' },
            {
              tag: 'action',
              actions: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: 'Start investigation' },
                  type: 'primary',
                  form_action_type: 'submit',
                  behaviors: [
                    {
                      type: 'callback',
                      value: { action: 'submit_investigation' },
                    },
                  ],
                },
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '取消' },
                  type: 'default',
                  // form_action_type=reset 是飞书内置的纯客户端动作（清空表
                  // 单），不允许带 behaviors —— 服务端会报
                  // "form reset action not support behaviors"（错误码 230099）。
                  form_action_type: 'reset',
                },
              ],
            },
          ],
        },
        {
          tag: 'markdown',
          content:
            '<font color="grey">提交后会创建一次 INVESTIGATION 任务，结果（根因总结）将自动发送到本群（约 3 - 8 分钟）。</font>',
        },
      ],
    },
  };
}

/**
 * 调查模板：把英文模板按钮映射到具体的描述 prompt。
 * 这里写得稍微具体一点，DevOps Agent 拿到的描述越具体，结论质量越高。
 */
const INVESTIGATION_TEMPLATES: Record<string, string> = {
  latest_alarm:
    '调查最近一次进入 ALARM 状态的 CloudWatch 告警，关联资源在告警时间窗口前后 10 分钟内的指标、日志、CloudTrail 事件、最近部署/变更记录，给出根因分析与修复建议。',
  high_cpu:
    '我们的某个工作负载（EC2 / ECS / RDS / Lambda 等）出现 CPU 持续偏高（>= 80%）。请定位负载所在资源，对比历史基线，分析最可能的根因（流量突增、慢查询、热点 key、内存压力导致的 swap、GC 风暴等），并给出短期缓解和长期治理建议。',
  error_spike:
    '应用层出现错误率/异常突增（5xx / Lambda Errors / 队列 DLQ / 自定义业务错误指标）。请关联近期部署、配置变更、依赖服务的健康度，从应用日志、X-Ray trace、上下游服务指标三个维度联合排查，给出最可能的根因与修复方案。',
};

/**
 * 把字符串按最大字节长度切分成多段（按行/段落优先切分）
 */
function chunkText(text: string, maxBytes: number = 12000): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line;
    if (encoder.encode(candidate).length <= maxBytes) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // 单行就超了，硬截断
      if (encoder.encode(line).length > maxBytes) {
        let remaining = line;
        while (remaining) {
          let take = remaining;
          while (encoder.encode(take).length > maxBytes) {
            take = take.substring(0, Math.floor(take.length * 0.9));
          }
          chunks.push(take);
          remaining = remaining.substring(take.length);
        }
        current = '';
      } else {
        current = line;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * 发送多段文本消息到群聊（首条带标题）
 */
async function sendTextChunksToChat(chatId: string, header: string, body: string): Promise<void> {
  const fullText = header + '\n\n' + body;
  const chunks = chunkText(fullText, 12000);

  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : '';
    await sendTextToChat(chatId, prefix + chunks[i]);
  }
}

// ---------------------------------------------------------------------------
// Markdown → lark_md 渲染
//
// 飞书的 lark_md 支持 **加粗**、`代码`、链接、列表、`---` 分隔线，但 **不支持
// markdown 标题语法 `# / ## / ###`**。Agent 输出的 mitigation summary 用了大量
// 标题，直接发送会出现一堆原样 `#` `**` 字符。这里做一次转换：
//   - `# title`   → `**📌 title**` + 空行
//   - `## title`  → `**🔹 title**` + 空行
//   - `### title` → `**▸ title**` + 空行
//   - `#### title`→ `**· title**` + 空行
// 其它语法（**bold**、代码块 ``` 包裹的代码、列表 - / *）保持原样，lark_md
// 会正确渲染。
// ---------------------------------------------------------------------------

/**
 * 把通用 markdown 转成飞书 lark_md 友好的形式。
 *
 * 现在只需要处理 ATX 标题（`# / ## / ### / ####`），因为这是 lark_md 唯一不
 * 支持的常见 markdown 语法。其它语法（粗体、行内代码、围栏代码块、列表、
 * 链接、表格）lark_md 都能正确渲染。
 *
 * Exported for unit testing.
 */
export function markdownToLarkMd(input: string): string {
  if (!input) return '';
  return input
    .split('\n')
    .map((line) => {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (!m) return line;
      const depth = m[1].length;
      const content = m[2].trim();
      const prefix =
        depth === 1
          ? '📌 '
          : depth === 2
          ? '🔹 '
          : depth === 3
          ? '▸ '
          : '· ';
      return `**${prefix}${content}**`;
    })
    .join('\n');
}

/**
 * 把 lark_md 文本切分成若干 ≤maxBytes 的段，按行边界优先切分，避免切坏
 * 围栏代码块（``` 配对）。代码块如果超长就硬切（不常见）。
 */
function chunkLarkMd(text: string, maxBytes: number = 25000): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return [text];
  const chunks: string[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  let currentSize = 0;
  let inCodeBlock = false;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join('\n'));
    current = [];
    currentSize = 0;
  };
  for (const line of lines) {
    if (line.trim().startsWith('```')) inCodeBlock = !inCodeBlock;
    const lineSize = encoder.encode(line).length + 1;
    if (currentSize + lineSize > maxBytes && !inCodeBlock && current.length > 0) {
      flush();
    }
    current.push(line);
    currentSize += lineSize;
  }
  flush();
  return chunks;
}

/**
 * 用 interactive card 发送 markdown 内容到群聊（带标题）。
 *
 * 比纯 text 消息漂亮得多 —— 标题加粗、代码块带浅灰底、列表正确缩进。
 *
 * 长内容会按 ~25KB 切分成多张卡片连续发送。
 */
async function sendMarkdownCardToChat(
  chatId: string,
  title: string,
  template: 'blue' | 'green' | 'orange' | 'red' | 'purple',
  bodyMarkdown: string,
  options?: { headerMeta?: string; footer?: string }
): Promise<void> {
  const rendered = markdownToLarkMd(bodyMarkdown);
  const chunks = chunkLarkMd(rendered, 25000);

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const titleSuffix = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '';

    const elements: any[] = [];

    if (isFirst && options?.headerMeta) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: options.headerMeta },
      });
      elements.push({ tag: 'hr' });
    }

    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: chunks[i] },
    });

    if (isLast && options?.footer) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: options.footer }],
      });
    }

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title + titleSuffix },
        template,
      },
      elements,
    };

    await sendCardToChat(chatId, card);
  }
}

async function sendTextToChat(chatId: string, text: string): Promise<void> {
  const token = await getTenantAccessToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      content: JSON.stringify({ text }),
      msg_type: 'text',
    }),
  });
  const data = await response.json() as any;
  if (data.code !== 0) {
    console.error('Failed to send text message:', data);
    throw new Error(`Failed to send text: ${data.msg}`);
  }
}

/**
 * 把 recommendations 列表格式化为纯文本（不限单条长度）
 */
function formatRecommendationsAsText(recommendations: any[]): string {
  if (recommendations.length === 0) {
    return '当前没有待处理的改进建议。';
  }

  const high = recommendations.filter(r => r.priority === 'HIGH');
  const medium = recommendations.filter(r => r.priority === 'MEDIUM');
  const low = recommendations.filter(r => r.priority === 'LOW');

  const lines: string[] = [];
  lines.push(`🔍 共发现 ${recommendations.length} 条改进建议`);
  lines.push(`🔴 高：${high.length}    🟡 中：${medium.length}    🟢 低：${low.length}`);
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  recommendations.forEach((rec, idx) => {
    const priorityEmoji = rec.priority === 'HIGH' ? '🔴' : rec.priority === 'MEDIUM' ? '🟡' : '🟢';
    const statusEmoji = rec.status === 'PROPOSED' ? '🆕' : rec.status === 'ACCEPTED' ? '✅' : '📋';

    let summaryText = rec.content?.summary ?? '';
    let parsed: any = null;
    try {
      parsed = JSON.parse(summaryText);
    } catch {
      // 不是 JSON
    }

    lines.push(`【${idx + 1}】 ${priorityEmoji} ${statusEmoji} ${rec.title ?? '未命名建议'}`);

    if (parsed) {
      if (parsed.overview) {
        lines.push('');
        lines.push(`📝 概述：${parsed.overview}`);
      }
      if (parsed.background) {
        lines.push('');
        lines.push(`📌 背景：${parsed.background}`);
      }
      if (parsed.description) {
        lines.push('');
        lines.push(`📋 详情：${parsed.description}`);
      }
      if (parsed.category) {
        lines.push('');
        lines.push(`🏷️ 分类：${parsed.category}`);
      }
    } else if (summaryText) {
      lines.push('');
      lines.push(summaryText);
    }

    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
  });

  return lines.join('\n');
}
function buildRecommendationsCard(
  recommendations: any[],
  taskInfo?: { taskId: string; status: string }
): any {
  // 任务状态标题
  const statusLabel = taskInfo
    ? (taskInfo.status === 'COMPLETED' ? '✅ 改善计划任务已完成' :
       taskInfo.status === 'FAILED' ? '❌ 改善计划任务失败' :
       taskInfo.status === 'TIMED_OUT' ? '⏱️ 改善计划任务超时' :
       taskInfo.status === 'CANCELED' ? '🚫 改善计划任务已取消' :
       '⏳ 改善计划任务仍在进行中')
    : '📋 改进建议';

  if (recommendations.length === 0) {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: statusLabel },
        template: taskInfo?.status === 'COMPLETED' ? 'green' : 'orange',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: taskInfo
              ? `任务 ID: \`${taskInfo.taskId}\`\n\n本次改善计划暂未发现新的改进建议。`
              : '当前没有待处理的改进建议。',
          },
        },
        ...(taskInfo && taskInfo.status !== 'COMPLETED' ? [{
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: '提示：任务可能还在后台执行，稍后可以再次点击改善计划查看更新结果。' },
          ],
        }] : []),
      ],
    };
  }

  const high = recommendations.filter(r => r.priority === 'HIGH');
  const medium = recommendations.filter(r => r.priority === 'MEDIUM');
  const low = recommendations.filter(r => r.priority === 'LOW');

  const headerLines: string[] = [];
  if (taskInfo) {
    headerLines.push(`任务 ID: \`${taskInfo.taskId}\``);
  }
  headerLines.push(`🔍 共发现 **${recommendations.length}** 条改进建议`);
  headerLines.push(`🔴 高：${high.length}　🟡 中：${medium.length}　🟢 低：${low.length}`);

  const elements: any[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: headerLines.join('\n') },
    },
    { tag: 'hr' },
  ];

  const top10 = recommendations.slice(0, 10);
  for (const rec of top10) {
    const priorityEmoji = rec.priority === 'HIGH' ? '🔴' : rec.priority === 'MEDIUM' ? '🟡' : '🟢';
    const statusEmoji = rec.status === 'PROPOSED' ? '🆕' : rec.status === 'ACCEPTED' ? '✅' : '📋';

    // summary 通常是 JSON 字符串，解析后提取 overview/description
    let summaryText = rec.content?.summary ?? '（无摘要）';
    try {
      const parsed = JSON.parse(summaryText);
      // 优先按以下字段顺序取真正的描述
      summaryText = parsed.overview
                  ?? parsed.description
                  ?? parsed.background
                  ?? parsed.summary
                  ?? summaryText;
    } catch {
      // 不是 JSON，直接用原字符串
    }

    // 截断到 300 字符避免卡片过长
    if (summaryText.length > 300) {
      summaryText = summaryText.substring(0, 300) + '...';
    }

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `${priorityEmoji} ${statusEmoji} **${rec.title ?? '未命名建议'}**\n${summaryText}`,
      },
    });
  }

  if (recommendations.length > 10) {
    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: `仅显示前 10 条，共 ${recommendations.length} 条建议` },
      ],
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '🔄 刷新' },
        type: 'default',
        value: { action: 'list_recommendations' },
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: statusLabel },
      template: high.length > 0 ? 'red' : medium.length > 0 ? 'orange' : 'green',
    },
    elements,
  };
}

/**
 * 构建错误卡片
 */
function buildErrorCard(error: string): any {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '❌ 操作失败' },
      template: 'red',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: error } },
    ],
  };
}

/**
 * 构建普通对话回复卡片。
 *
 * 没有 header / 没有 template，看起来就是一条带格式的普通消息——这是飞书
 * 让 markdown 渲染（lark_md）的最低形态。要换成纯 text 消息会丢失所有
 * 格式（# / ** / 代码块都按字面字符显示），post 消息又不支持代码块，所以
 * "无装饰 interactive 卡片" 就是干净 + 有 markdown 渲染 的最佳折衷。
 *
 * content 会先过 markdownToLarkMd —— 把 lark_md 不支持的 ATX 标题
 * (# / ## / ###) 转成加粗带前缀的形式。
 */
function buildChatReplyCard(content: string): any {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: markdownToLarkMd(content) } },
    ],
  };
}

// ---------------------------------------------------------------------------
// DevOps Agent 调用
// ---------------------------------------------------------------------------

async function listRecommendations(taskId?: string): Promise<any[]> {
  const allRecommendations: any[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await devopsClient.send(new ListRecommendationsCommand({
      agentSpaceId: AGENT_SPACE_ID,
      taskId,
      limit: 50,
      nextToken,
    }));
    if (resp.recommendations) {
      allRecommendations.push(...resp.recommendations);
    }
    nextToken = resp.nextToken;
  } while (nextToken && allRecommendations.length < 100);
  return allRecommendations;
}

/**
 * 发起一次新的 EVALUATION（巡检）任务，并轮询直到完成或超时
 *
 * EVALUATION 任务要求 description 是一个 JSON 字符串，包含 goal_id 字段。
 * 默认使用 Agent Space 里第一个 ACTIVE 的 goal。
 */
async function triggerEvaluation(): Promise<{ taskId: string; status: string; recommendations: any[] }> {
  // 1. 列出 goals，找到第一个 ACTIVE 的 goal
  const { ListGoalsCommand } = await import('@aws-sdk/client-devops-agent') as any;
  const goalsResp: any = await devopsClient.send(new ListGoalsCommand({
    agentSpaceId: AGENT_SPACE_ID,
  }));

  const activeGoal = (goalsResp.goals ?? []).find((g: any) => g.status === 'ACTIVE');
  if (!activeGoal?.goalId) {
    throw new Error('Agent Space 中未找到 ACTIVE 状态的 goal，无法发起改善计划');
  }

  console.log(`Using goal: ${activeGoal.goalId} - ${activeGoal.title}`);

  // 2. 发起 EVALUATION 任务
  const createResp = await devopsClient.send(new CreateBacklogTaskCommand({
    agentSpaceId: AGENT_SPACE_ID,
    taskType: 'EVALUATION',
    title: `飞书 Bot 触发的改善计划任务 ${new Date().toISOString()}`,
    description: JSON.stringify({ goal_id: activeGoal.goalId }),
    priority: 'MEDIUM',
    clientToken: `feishu-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }));

  const taskId = createResp.task?.taskId;
  if (!taskId) {
    throw new Error('未能创建 EVALUATION 任务');
  }

  console.log(`Created EVALUATION task: ${taskId}, initial status: ${createResp.task?.status}`);

  // 3. 轮询任务状态
  const POLL_INTERVAL_MS = 5000;
  const MAX_WAIT_MS = 150000;
  const startTime = Date.now();
  let currentStatus = createResp.task?.status ?? 'PENDING_TRIAGE';

  while (Date.now() - startTime < MAX_WAIT_MS) {
    if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELED'].includes(currentStatus)) {
      break;
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const getResp = await devopsClient.send(new GetBacklogTaskCommand({
      agentSpaceId: AGENT_SPACE_ID,
      taskId,
    }));

    currentStatus = getResp.task?.status ?? currentStatus;
    console.log(`Task ${taskId} status: ${currentStatus} (elapsed: ${Date.now() - startTime}ms)`);
  }

  // 4. 拉取该任务生成的 recommendations
  const recommendations = await listRecommendations(taskId);

  return { taskId, status: currentStatus, recommendations };
}

/**
 * 发起一次新的 INVESTIGATION（事件调查）任务，并轮询直到完成或超时。
 *
 * INVESTIGATION 任务的 description 是自由文本，DevOps Agent 会基于它自动调用
 * CloudWatch Metrics / Logs / CloudTrail / Application Signals 等数据源做根因分析。
 *
 * 完成后通过 ListExecutions/ListJournalRecords 拉 'investigation_summary_md' 拿总结。
 */
async function triggerInvestigation(
  description: string
): Promise<{ taskId: string; status: string; summaryMd: string }> {
  const createResp = await devopsClient.send(
    new CreateBacklogTaskCommand({
      agentSpaceId: AGENT_SPACE_ID,
      taskType: 'INVESTIGATION',
      title: `飞书 Bot 触发的事件调查 ${new Date().toISOString().slice(0, 19)}`,
      description,
      priority: 'HIGH',
      clientToken: `feishu-bot-inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
  );

  const taskId = createResp.task?.taskId;
  if (!taskId) {
    throw new Error('未能创建 INVESTIGATION 任务');
  }

  console.log(`Created INVESTIGATION task: ${taskId}, initial status: ${createResp.task?.status}`);

  // 轮询任务状态。INVESTIGATION 通常 3-8 分钟，留 9 分钟兜底。
  const POLL_INTERVAL_MS = 10000;
  const MAX_WAIT_MS = 9 * 60 * 1000;
  const startTime = Date.now();
  let currentStatus = createResp.task?.status ?? 'PENDING_TRIAGE';

  while (Date.now() - startTime < MAX_WAIT_MS) {
    if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELED'].includes(currentStatus)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const getResp = await devopsClient.send(
      new GetBacklogTaskCommand({ agentSpaceId: AGENT_SPACE_ID, taskId })
    );
    currentStatus = getResp.task?.status ?? currentStatus;
    console.log(`Investigation ${taskId} status: ${currentStatus} (elapsed: ${Date.now() - startTime}ms)`);
  }

  // 拉调查总结：先 ListExecutions 找 INVESTIGATION 类型的 execution，再 ListJournalRecords。
  let summaryMd = '';
  try {
    const execResp: any = await devopsClient.send(
      new ListExecutionsCommand({
        agentSpaceId: AGENT_SPACE_ID,
        taskId,
      })
    );
    const investigationExec = (execResp.executions ?? []).find(
      (e: any) => e.agentType === 'investigation' || e.agentType === 'INVESTIGATION'
    ) ?? (execResp.executions ?? [])[0];

    if (investigationExec?.executionId) {
      const journalResp: any = await devopsClient.send(
        new ListJournalRecordsCommand({
          agentSpaceId: AGENT_SPACE_ID,
          executionId: investigationExec.executionId,
        })
      );
      const summaryRecord = (journalResp.records ?? []).find(
        (r: any) => r.recordType === 'investigation_summary_md' || r.recordType === 'INVESTIGATION_SUMMARY_MD'
      );
      if (summaryRecord?.content) {
        summaryMd =
          typeof summaryRecord.content === 'string'
            ? summaryRecord.content
            : (summaryRecord.content.text ?? JSON.stringify(summaryRecord.content));
      }
    }
  } catch (err: any) {
    console.warn(`Failed to fetch investigation summary for ${taskId}:`, err.message);
  }

  return { taskId, status: currentStatus, summaryMd };
}

async function askDevOpsAgent(chatId: string, query: string): Promise<string> {
  // 关键：如果这条消息看起来像在请求一次调查（"investigate xxx" / "调查 xxx"），
  // 强制开启新 session。不复用旧的 executionId。
  //
  // 实测旧 chat session 累积上下文后，"Investigate my latest CloudWatch alarm"
  // 这种触发 Agent 内部创建 INVESTIGATION 任务的请求会让 SendMessage 流
  // 卡死 5 分钟（Lambda 超时）。改用一次一新的 session 避开这个 server 端问题。
  const looksLikeInvestigationRequest = /\b(investigate|investigation)\b/i.test(query) ||
    /调查/.test(query) || /根因/.test(query);
  if (looksLikeInvestigationRequest && sessions.has(chatId)) {
    console.log(`[askDevOpsAgent] Investigation-like query detected; resetting chat session for ${chatId}`);
    sessions.delete(chatId);
  }

  let executionId = sessions.get(chatId);
  if (!executionId) {
    try {
      console.log(`[askDevOpsAgent] Calling CreateChat with agentSpaceId=${AGENT_SPACE_ID} chatId=${chatId}`);
      const createResp = await devopsClient.send(new CreateChatCommand({
        agentSpaceId: AGENT_SPACE_ID,
      }));
      executionId = createResp.executionId;
      console.log(`[askDevOpsAgent] CreateChat ok, executionId=${executionId}`);
      if (executionId) sessions.set(chatId, executionId);
      else return '❌ 创建 DevOps Agent 会话失败';
    } catch (err: any) {
      // 把完整 SDK 错误结构打到日志（name / fault / metadata / requestId 等）
      // —— 服务端返回的 "An internal error occurred" 在 message 里看不出原因，
      //    但 $metadata 里通常会带 httpStatusCode 和 requestId 帮助定位。
      console.error('[askDevOpsAgent] CreateChat failed:', JSON.stringify({
        name: err?.name,
        message: err?.message,
        fault: err?.$fault,
        httpStatus: err?.$metadata?.httpStatusCode,
        requestId: err?.$metadata?.requestId,
        agentSpaceId: AGENT_SPACE_ID,
        region: AWS_REGION_NAME,
      }));
      console.error('[askDevOpsAgent] Full error:', err);
      return `❌ 创建 DevOps Agent 会话失败：${err.message}`;
    }
  }

  // SendMessage 是 SSE 流式 API：偶尔会出现 server 端不发任何 event 也不
  // 关流的情况（实测一次复现 5 分钟 Lambda 跑满超时）。这里加 AbortController
  // 双重保险：
  //   1. abortAllMs：从开始到结束的总硬上限（避免无限等）
  //   2. abortIdleMs：两个 event 之间没有进展时也提前中断（避免 server 卡住时干等）
  //
  // 实际跑出来发现 Agent 处理复杂调查会持续调几十次 CloudWatch / Logs API,
  // 累计 5+ 分钟很正常。所以总上限拉到 8 分钟,只要 server 还持续在推 event
  // （reset idle timer）就一直收。Lambda 自身 timeout 是 600s,留 2 分钟兜底。
  const abortController = new AbortController();
  // Lambda 自身 timeout 是 600s（在 CDK 里设的）。我们设 580s 总上限，留
  // 20s 给后续处理（写映射、回卡片）+ Lambda runtime overhead。
  // 实际跑出来 Agent 处理复杂调查会持续调几十次 CloudWatch / Logs API,
  // 累计 5-9 分钟很正常。只要 server 还在持续推 event 就不应该中断它。
  // ABORT_IDLE_MS 较宽松：Agent 单步工具调用偶尔慢（大批量 logs API
  // GetLogEvents 可能 30-60s）。
  const ABORT_ALL_MS = 580_000; // 9 分 40 秒硬上限（Lambda 600s - 20s 余量）
  const ABORT_IDLE_MS = 180_000; // 3 分钟没新 event 视为 server 端卡死
  const allTimer = setTimeout(() => {
    console.warn(`[askDevOpsAgent] Aborting stream after ${ABORT_ALL_MS}ms (overall timeout)`);
    abortController.abort();
  }, ABORT_ALL_MS);
  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.warn(`[askDevOpsAgent] Aborting stream after ${ABORT_IDLE_MS}ms idle (no events)`);
      abortController.abort();
    }, ABORT_IDLE_MS);
  };
  resetIdleTimer();

  let aborted = false;
  try {
    const resp = await devopsClient.send(
      new SendMessageCommand({
        agentSpaceId: AGENT_SPACE_ID,
        executionId,
        content: query,
      }),
      { abortSignal: abortController.signal as any }
    );

    const blocks: Map<number, string[]> = new Map();
    const blockStops: Map<number, string> = new Map();

    if (resp.events) {
      try {
        // @ts-ignore - events is async iterable
        for await (const event of resp.events) {
          resetIdleTimer(); // 每收到一个 event 就重置 idle 计时器
          if (event.contentBlockDelta) {
            const idx = event.contentBlockDelta.index ?? 0;
            const text = event.contentBlockDelta.delta?.textDelta?.text;
            if (text) {
              if (!blocks.has(idx)) blocks.set(idx, []);
              blocks.get(idx)!.push(text);
            }
          } else if (event.contentBlockStop) {
            const idx = event.contentBlockStop.index ?? 0;
            const text = event.contentBlockStop.text;
            if (text) blockStops.set(idx, text);
          } else if (event.responseFailed) {
            return `❌ DevOps Agent 错误：${event.responseFailed.errorMessage ?? 'unknown'}`;
          }
        }
      } catch (streamErr: any) {
        // AbortError 是我们自己中断的；其他错误抛出去
        if (streamErr?.name === 'AbortError' || abortController.signal.aborted) {
          aborted = true;
          console.warn('[askDevOpsAgent] Stream aborted by timeout');
        } else {
          throw streamErr;
        }
      }
    }

    // 拼成完整文本，用正则把 [[investigation:<uuid>]] 标记里的 taskId 全抓出来。
    //
    // 这个标记是 DevOps Agent 在 chat 模式下创建调查任务时**主动嵌入**到
    // 响应文本里的。直接从流里拿 taskId 比用 ListBacklogTasks 差量发现要
    // 可靠得多——后者有时序竞态，前者一次必中。
    const fullText = [
      ...Array.from(blockStops.values()),
      ...Array.from(blocks.values()).map((arr) => arr.join('')),
    ].join('\n');

    const taskIds = extractInvestigationTaskIds(fullText);
    if (taskIds.length > 0) {
      console.log(
        `[chat→inv] Extracted ${taskIds.length} taskId(s) from chat response: [${taskIds.join(',')}] chatId=${chatId}`
      );
      try {
        await Promise.all(
          taskIds.map((tid) =>
            putChatInvestigationMapping(tid, chatId, query.slice(0, 500))
          )
        );
        console.log(`[chat→inv] Persisted ${taskIds.length} mapping(s) for chatId=${chatId}`);
      } catch (err: any) {
        console.error('[chat→inv] Failed to persist mappings:', err);
      }
    } else if (!aborted) {
      console.log(`[chat→inv] No [investigation:<id>] markers found this turn; nothing to map`);
    }

    if (blockStops.size > 0) {
      const sortedKeys = Array.from(blockStops.keys()).sort((a, b) => a - b);
      // 去重：Agent 偶尔会在一次响应里输出两个内容相同（或几乎相同）的 block,
      // 用户看到就是同一段话被显示两遍。如果**相邻** block 文本完全相同就只
      // 保留一个；非相邻或不同的 block 保持原样（多步工具调用之间偶有过渡
      // 文字差异，不能误删）。
      const blocksDedup: string[] = [];
      let prev: string | null = null;
      for (const k of sortedKeys) {
        const text = (blockStops.get(k) ?? '').trim();
        if (text && text !== prev) {
          blocksDedup.push(text);
          prev = text;
        }
      }
      const result = blocksDedup.join('\n\n');
      if (result.trim()) {
        return aborted ? result + '\n\n⚠️ （响应被超时中断，可能不完整）' : result;
      }
    }

    if (blocks.size > 0) {
      const sortedKeys = Array.from(blocks.keys()).sort((a, b) => a - b);
      // 同样的相邻去重逻辑（fallback 路径）
      const blocksDedup: string[] = [];
      let prev: string | null = null;
      for (const k of sortedKeys) {
        const text = (blocks.get(k) ?? []).join('').trim();
        if (text && text !== prev) {
          blocksDedup.push(text);
          prev = text;
        }
      }
      const result = blocksDedup.join('\n\n');
      if (result.trim()) {
        return aborted ? result + '\n\n⚠️ （响应被超时中断，可能不完整）' : result;
      }
    }

    if (aborted) {
      // 整个流完全没拿到内容就被中断了 → 重置该 chat 的 session（很可能是
      // 上下文累积导致 Agent 服务端处理卡死）
      sessions.delete(chatId);
      return '⏱️ DevOps Agent 响应超时（无任何输出）。已重置会话上下文，请重新提问。\n\n💡 如果你刚发的是调查请求，可以去 DevOps Agent 控制台直接查看任务状态。';
    }

    return '（DevOps Agent 未返回内容）';
  } catch (err: any) {
    sessions.delete(chatId);
    return `❌ 调用失败：${err.message}`;
  } finally {
    clearTimeout(allTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

function extractText(event: FeishuEvent): string | null {
  const message = event.event?.message;
  if (!message) return null;
  try {
    const content = JSON.parse(message.content);
    let text = content.text ?? '';
    const mentions = message.mentions ?? [];
    for (const mention of mentions) {
      text = text.replace(mention.key, '').trim();
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 判断用户消息是否触发巡检/菜单卡片。
 *
 * 同 isInvestigationTrigger：只对"整条消息就是命令"匹配，避免命中
 * 长句子里恰好包含 "improvements" 等词的情况。
 */
function isMenuTrigger(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const COMMAND_KEYWORDS = [
    '改善计划',
    '改进建议',
    'improvements',
    'improvement',
  ];
  return COMMAND_KEYWORDS.some((keyword) => lower === keyword);
}

/**
 * 判断用户消息是否要直接打开"事件调查"表单卡片。
 *
 * 只在**整条消息就是命令关键词**时才打开表单（比如用户单独发"调查"）。
 * 如果消息里已经带了具体描述（"Investigate my latest CloudWatch alarm..."），
 * 直接转给 Agent 更合理 —— Agent 会自主创建 INVESTIGATION 任务，taskId 通过
 * 响应里的 [investigation:<uuid>] 标记被我们捕获，结果照常推回群里。
 *
 * 严格相等匹配，避免命中长句子里恰好包含 "investigate" 这种关键词的情况。
 */
function isInvestigationTrigger(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const COMMAND_KEYWORDS = [
    '调查',
    '发起调查',
    '事件调查',
    '手动调查',
    'investigate',
    'investigation',
    'start investigation',
    'rca',
    '根因',
    '根因分析',
  ];
  return COMMAND_KEYWORDS.some((keyword) => lower === keyword);
}

// ---------------------------------------------------------------------------
// 处理卡片交互回调（card.action.trigger）
// ---------------------------------------------------------------------------

async function handleCardAction(body: any): Promise<APIGatewayResponse> {
  const headers = { 'Content-Type': 'application/json' };

  const action = body.event?.action?.value ?? body.action?.value;
  const openChatId = body.event?.context?.open_chat_id ?? body.open_chat_id;

  console.log(`Card action received: ${JSON.stringify(action)}, chatId: ${openChatId}`);

  if (!openChatId) {
    console.warn('No open_chat_id found in card action callback');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (action?.action === 'list_recommendations') {
    if (functionName) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({
            __asyncJob: 'list_recommendations',
            chatId: openChatId,
          })),
        }));
      } catch (err: any) {
        console.error('Failed to dispatch list_recommendations job:', err);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            toast: { type: 'error', content: `❌ 启动失败：${err.message}` },
          }),
        };
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        toast: { type: 'info', content: '🔍 正在拉取最新改进建议...' },
      }),
    };
  }

  if (action?.action === 'run_evaluation') {
    if (functionName) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({
            __asyncJob: 'run_evaluation',
            chatId: openChatId,
          })),
        }));
      } catch (err: any) {
        console.error('Failed to dispatch run_evaluation job:', err);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            toast: { type: 'error', content: `❌ 启动失败：${err.message}` },
          }),
        };
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        toast: {
          type: 'info',
          content: '🚀 已发起改善计划任务，结果将在完成后发送到群里（约 30 秒 - 2 分钟）',
        },
      }),
    };
  }

  // -------------------------------------------------------------------------
  // 事件调查（INVESTIGATION）相关 action
  // -------------------------------------------------------------------------

  // 用户点了菜单里的「🔬 发起调查」→ 把表单卡作为**新消息**发到群里。
  //
  // 注意不能用 card update（之前用 `card: { type: 'raw', data: ... }`）—
  // 菜单卡是 schema 1.0，调查表单卡是 schema 2.0，飞书不允许跨 schema
  // 卡片替换，会报 toast 200673（"出错了，请稍后重试"）。直接发新消息能
  // 绕开这个限制。
  //
  // 关键：发卡片要异步（fire-and-forget Lambda 自调用）—— 直接同步等飞书
  // API 返回会消耗几百 ms，加上冷启动经常踩 3s 回调超时线，导致飞书重试。
  if (action?.action === 'open_investigation_form') {
    if (functionName && openChatId) {
      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'Event',
            Payload: Buffer.from(
              JSON.stringify({
                __asyncJob: 'send_investigation_form',
                chatId: openChatId,
              })
            ),
          })
        );
      } catch (err: any) {
        console.error('Failed to dispatch send_investigation_form job:', err);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            toast: { type: 'error', content: `❌ 启动失败：${err.message}` },
          }),
        };
      }
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        toast: { type: 'info', content: '调查表单准备中，将发送到群里...' },
      }),
    };
  }

  // 快速模板按钮：把模板文本预填回输入框（通过卡片整体替换实现）
  if (action?.action === 'fill_template') {
    const templateKey = action.template ?? '';
    const prefill = INVESTIGATION_TEMPLATES[templateKey] ?? '';
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        toast: { type: 'info', content: '已填入模板，可继续编辑后提交' },
        card: {
          type: 'raw',
          data: buildInvestigationFormCard(prefill),
        },
      }),
    };
  }

  // 用户提交了调查表单：拿 description，派发后台 job
  if (action?.action === 'submit_investigation') {
    // 飞书表单提交时把所有 input 的值放在 form_value 里
    const formValue = body.event?.action?.form_value ?? body.action?.form_value ?? {};
    const description: string = (formValue.description ?? '').toString().trim();

    if (!description) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          toast: { type: 'error', content: '❌ 请先填写调查描述再提交' },
        }),
      };
    }

    if (functionName) {
      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'Event',
            Payload: Buffer.from(
              JSON.stringify({
                __asyncJob: 'run_investigation',
                chatId: openChatId,
                description,
              })
            ),
          })
        );
      } catch (err: any) {
        console.error('Failed to dispatch run_investigation job:', err);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            toast: { type: 'error', content: `❌ 启动失败：${err.message}` },
          }),
        };
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        toast: {
          type: 'info',
          content: '🔬 已发起事件调查，调查总结将在完成后发送到群里（约 3 - 8 分钟）',
        },
      }),
    };
  }

  // 表单 reset
  if (action?.action === 'reset_investigation') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        toast: { type: 'info', content: '已清空' },
        card: {
          type: 'raw',
          data: buildInvestigationFormCard(''),
        },
      }),
    };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
}

/**
 * 后台拉取并展示 Agent Space 中所有的 Recommendations
 * 使用纯文本消息分段发送，避免卡片单元素长度限制
 */
async function listRecommendationsInBackground(chatId: string): Promise<void> {
  try {
    const recommendations = await listRecommendations();
    console.log(`Fetched ${recommendations.length} recommendations`);

    if (recommendations.length === 0) {
      await sendTextToChat(chatId, '📋 当前 Agent Space 中没有改进建议。');
      return;
    }

    const high = recommendations.filter(r => r.priority === 'HIGH').length;
    const medium = recommendations.filter(r => r.priority === 'MEDIUM').length;
    const low = recommendations.filter(r => r.priority === 'LOW').length;

    const header = `📋 改进建议清单\n` +
                   `🔍 共 ${recommendations.length} 条 | 🔴 高:${high}  🟡 中:${medium}  🟢 低:${low}`;
    const body = formatRecommendationsAsText(recommendations);

    await sendTextChunksToChat(chatId, header, body);
  } catch (err: any) {
    console.error('List recommendations failed:', err);
    try {
      await sendTextToChat(chatId, `❌ 查询改进建议失败：${err.message}`);
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
}

/**
 * 后台发起 EVALUATION 巡检任务，轮询直到完成，发送结果
 * EVALUATION 任务依赖目标时间窗口内有已完成的 INVESTIGATION，否则返回友好错误
 */
async function runEvaluationInBackground(chatId: string): Promise<void> {
  try {
    await sendTextToChat(chatId, '🚀 正在发起改善计划任务，请稍候...');

    const { taskId, status, recommendations } = await triggerEvaluation();
    console.log(`Evaluation completed: taskId=${taskId}, status=${status}, ${recommendations.length} recommendations`);

    if (recommendations.length === 0) {
      const statusLabel = status === 'COMPLETED' ? '✅ 改善计划任务已完成' :
                          status === 'FAILED' ? '❌ 改善计划任务失败' :
                          status === 'TIMED_OUT' ? '⏱️ 改善计划任务超时' :
                          '⏳ 改善计划任务仍在进行中';
      await sendTextToChat(chatId, `${statusLabel}\n任务 ID：${taskId}\n\n本次改善计划未生成新的改进建议。可以稍后通过「查看改进建议」按钮查询全部建议。`);
      return;
    }

    const high = recommendations.filter(r => r.priority === 'HIGH').length;
    const medium = recommendations.filter(r => r.priority === 'MEDIUM').length;
    const low = recommendations.filter(r => r.priority === 'LOW').length;

    const header = `✅ 改善计划任务完成\n` +
                   `任务 ID：${taskId}\n` +
                   `🔍 本次新增 ${recommendations.length} 条建议 | 🔴 高:${high}  🟡 中:${medium}  🟢 低:${low}`;
    const body = formatRecommendationsAsText(recommendations);

    await sendTextChunksToChat(chatId, header, body);
  } catch (err: any) {
    console.error('Evaluation failed:', err);

    // 友好的错误提示
    let userMessage = `❌ 改善计划失败：${err.message}`;
    const msg = String(err.message ?? '');
    if (msg.includes('investigation task') || msg.includes('investigation summary')) {
      userMessage = `❌ 改善计划无法启动\n\n原因：必须先有一个已完成的 INVESTIGATION 任务（带调查总结）才能发起改善计划。\n\n💡 解决办法：\n• 等待 CloudWatch 告警自动触发 RCA 调查\n• 或在 DevOps Agent 控制台手动触发一次事件调查\n• 完成调查后再点击「立即运行改善计划」`;
    } else if (msg.includes('未找到 ACTIVE 状态的 goal')) {
      userMessage = `❌ 改善计划无法启动\n\n原因：当前 Agent Space 中没有 ACTIVE 状态的 goal。\n\n💡 请在 DevOps Agent 控制台先创建一个 goal。`;
    }

    try {
      await sendTextToChat(chatId, userMessage);
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
}

/**
 * 后台发送调查表单卡到群里（async job）。
 *
 * 抽出来异步派发的原因：飞书卡片回调要求 3s 内返回 200，否则会重试。
 * 同步等飞书 send_message API 响应（含 token 取/缓存 + 网络往返）经常踩到
 * 这条线，触发重试 → 群里出现两张表单卡。改用 Lambda 自调用 fire-and-forget
 * 后，主回调 < 100ms 返回，飞书不会重试。
 */
async function sendInvestigationFormInBackground(chatId: string): Promise<void> {
  try {
    await sendCardToChat(chatId, buildInvestigationFormCard(''));
    console.log(`[send_investigation_form] form card sent to chat ${chatId}`);
  } catch (err: any) {
    console.error('[send_investigation_form] failed:', err);
    try {
      await sendTextToChat(
        chatId,
        `❌ 打开调查表单失败：${err.message}\n\n💡 你也可以直接在群里 @机器人 描述要调查的内容，比如:\n  @机器人 调查最近 30 分钟 EC2 i-xxxx CPU 飙高的根因`
      );
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
}

/**
 * 后台发起 INVESTIGATION 任务，轮询直到完成，把根因总结发到群里。
 *
 * 与 Evaluation 不同，Investigation 不需要预先有 goal，description 自由文本即可。
 * 完成后我们从 journal 里拉 'investigation_summary_md'（与 RCA 自动链路一致）。
 */
async function runInvestigationInBackground(chatId: string, description: string): Promise<void> {
  try {
    await sendTextToChat(
      chatId,
      `🔬 正在发起事件调查任务，请稍候...\n\n📝 调查描述：\n${description}`
    );

    const { taskId, status, summaryMd } = await triggerInvestigation(description);
    console.log(
      `Investigation completed: taskId=${taskId}, status=${status}, summaryLen=${summaryMd.length}`
    );

    const statusLabel =
      status === 'COMPLETED'
        ? '✅ 调查任务已完成'
        : status === 'FAILED'
        ? '❌ 调查任务失败'
        : status === 'TIMED_OUT'
        ? '⏱️ 调查任务超时'
        : status === 'CANCELED'
        ? '🚫 调查任务已取消'
        : '⏳ 调查任务仍在进行中';

    if (!summaryMd) {
      await sendTextToChat(
        chatId,
        `${statusLabel}\n任务 ID：${taskId}\n\n` +
          (status === 'COMPLETED'
            ? '本次调查已完成，但未拉到调查总结（journal 中没有 investigation_summary_md 记录）。可以到 DevOps Agent 控制台查看详细结果。'
            : '调查暂未生成总结，可稍后到 DevOps Agent 控制台查看。')
      );
      return;
    }

    const header = `${statusLabel}\n任务 ID：${taskId}`;
    const cardTemplate: 'green' | 'orange' | 'red' | 'blue' =
      status === 'FAILED' || status === 'CANCELED'
        ? 'red'
        : status === 'TIMED_OUT'
        ? 'orange'
        : 'green';
    await sendMarkdownCardToChat(chatId, statusLabel, cardTemplate, summaryMd, {
      headerMeta: `任务 ID：\`${taskId}\``,
    });
  } catch (err: any) {
    console.error('Investigation failed:', err);
    let userMessage = `❌ 调查失败：${err.message}`;
    const msg = String(err.message ?? '');
    if (msg.includes('AccessDenied') || msg.includes('not authorized')) {
      userMessage = `❌ 调查无法启动\n\n原因：Lambda 缺少 aidevops:CreateBacklogTask / ListExecutions / ListJournalRecords 权限。请检查 IAM 策略。`;
    }
    try {
      await sendTextToChat(chatId, userMessage);
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
}

/**
 * 把一次"已经完成"的调查或缓解计划结果推送到 chat。
 *
 * 由 investigation-event-handler 在 EventBridge `Investigation Completed` /
 * `Mitigation Completed` 事件命中 chat 映射表时异步调用 —— bot 自己拉
 * journal 里对应 phase 的 markdown 然后发到指定群。
 *
 * 这条路径专为 chat-initiated investigation 而设：
 *   - 用户在飞书 chat 里说"调查一下 xxx"
 *   - DevOps Agent 自主创建 INVESTIGATION 任务（taskId 我们已经在
 *     askDevOpsAgent 阶段嗅探并写入映射表）
 *   - 几分钟后调查完成 → 推第一条根因卡片
 *   - handler 同时调 UpdateBacklogTask(PENDING_START) 触发 mitigation
 *   - 几分钟后 mitigation 完成 → 再推第二条缓解计划卡片
 *
 * @param args.phase  'investigation'（默认）或 'mitigation'，决定拉哪种 journal
 *                    record（investigation_summary_md / mitigation_summary_md）
 *                    以及找哪种 execution（agentType=ops1 / agentType=mitigation）
 */
async function pushChatInvestigationResultInBackground(args: {
  chatId: string;
  taskId: string;
  executionId?: string;
  status?: string;
  description?: string;
  phase?: 'investigation' | 'mitigation';
}): Promise<void> {
  const {
    chatId,
    taskId,
    executionId: hintedExecutionId,
    status,
    description,
    phase = 'investigation',
  } = args;

  // phase-specific 配置
  const recordType =
    phase === 'mitigation' ? 'mitigation_summary_md' : 'investigation_summary_md';
  const executionTypePredicate = (agentType: string): boolean => {
    const t = agentType.toLowerCase();
    if (phase === 'mitigation') return t.includes('mitigation');
    // investigation 阶段对应 ops1 execution（DevOps Agent 内部命名）
    return t === 'investigation' || t === 'ops1';
  };

  try {
    // 1. 找对应阶段的 execution（mitigation 阶段事件里的 executionId 是 ops1
    //    的，不能直接复用，必须 ListExecutions 找 mitigation execution）
    let executionId = phase === 'mitigation' ? undefined : hintedExecutionId;
    if (!executionId) {
      try {
        const execResp: any = await devopsClient.send(
          new ListExecutionsCommand({
            agentSpaceId: AGENT_SPACE_ID,
            taskId,
          })
        );
        const executions = execResp.executions ?? [];
        const matched =
          executions.find((e: any) => executionTypePredicate(e.agentType ?? '')) ??
          (phase === 'investigation' ? executions[0] : undefined);
        executionId = matched?.executionId;
      } catch (err: any) {
        console.warn(`ListExecutions failed for task ${taskId}:`, err.message);
      }
    }

    // 2. 拉 journal markdown
    let summaryMd = '';
    if (executionId) {
      try {
        const journalResp: any = await devopsClient.send(
          new ListJournalRecordsCommand({
            agentSpaceId: AGENT_SPACE_ID,
            executionId,
            recordType: recordType as any,
            limit: 50,
          })
        );
        const parts: string[] = [];
        for (const r of journalResp.records ?? []) {
          const c = r.content;
          if (typeof c === 'string') parts.push(c);
          else if (c && typeof c === 'object') {
            if (typeof c.text === 'string') parts.push(c.text);
            else if (typeof c.markdown === 'string') parts.push(c.markdown);
            else if (typeof c.body === 'string') parts.push(c.body);
          }
        }
        summaryMd = parts.join('\n\n');
      } catch (err: any) {
        console.warn(`ListJournalRecords failed for execution ${executionId}:`, err.message);
      }
    }

    // 3. 推回 chat — 不同 phase 不同标题
    let statusLabel: string;
    if (phase === 'mitigation') {
      statusLabel =
        status === 'COMPLETED' || !status
          ? '🛠️ 缓解计划已生成（接续上一条根因分析）'
          : status === 'FAILED'
          ? '❌ 缓解计划生成失败'
          : status === 'TIMED_OUT'
          ? '⏱️ 缓解计划生成超时'
          : status === 'CANCELED'
          ? '🚫 缓解计划已取消'
          : `ℹ️ 缓解计划状态：${status}`;
    } else {
      statusLabel =
        status === 'COMPLETED' || !status
          ? '✅ 调查任务已完成（来自你刚才在 chat 里发起的调查）'
          : status === 'FAILED'
          ? '❌ 调查任务失败'
          : status === 'TIMED_OUT'
          ? '⏱️ 调查任务超时'
          : status === 'CANCELED'
          ? '🚫 调查任务已取消'
          : `ℹ️ 调查任务状态：${status}`;
    }

    const descLine = description ? `\n📝 你的请求：${description.slice(0, 200)}` : '';
    const noContentMsg =
      phase === 'mitigation'
        ? '（缓解计划暂未生成，可到 DevOps Agent 控制台查看详细结果）'
        : '（调查总结暂未生成，可到 DevOps Agent 控制台查看详细结果）\n💡 后续会自动触发 mitigation plan 生成，请等待第二条卡片。';

    if (!summaryMd) {
      await sendTextToChat(
        chatId,
        `${statusLabel}\n任务 ID：${taskId}${descLine}\n\n${noContentMsg}`
      );
      return;
    }

    // 用 interactive card + lark_md 渲染，避免出现一堆原样的 # 和 ** 字符。
    // 卡片头标题用 statusLabel，meta 区域显示 任务 ID + 你的请求；正文是
    // markdown 转换后的 lark_md；末尾在 investigation phase 加 footer 提示
    // mitigation 即将到来。
    const headerMeta = `任务 ID：\`${taskId}\`${descLine}`;
    const cardTemplate: 'green' | 'orange' | 'red' | 'blue' =
      status === 'FAILED' || status === 'CANCELED'
        ? 'red'
        : status === 'TIMED_OUT'
        ? 'orange'
        : phase === 'mitigation'
        ? 'blue'
        : 'green';
    const footer =
      phase === 'investigation'
        ? '⏳ 缓解计划正在生成中，几分钟后会单独推送一张缓解计划卡片'
        : undefined;

    await sendMarkdownCardToChat(chatId, statusLabel, cardTemplate, summaryMd, {
      headerMeta,
      footer,
    });
  } catch (err: any) {
    console.error('pushChatInvestigationResultInBackground failed:', err);
    try {
      await sendTextToChat(
        chatId,
        `❌ ${phase === 'mitigation' ? '缓解计划' : '调查结果'}推送失败：${err.message}（任务 ID：${taskId}）`
      );
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
}

export const handler = async (event: any): Promise<APIGatewayResponse | { ok: boolean }> => {
  const headers = { 'Content-Type': 'application/json' };

  // 1. 异步任务调用（来自 Lambda 自调用，不通过 API Gateway）
  if (event && typeof event === 'object' && event.__asyncJob) {
    console.log(`Async job received: ${event.__asyncJob} for chat ${event.chatId}`);
    if (event.__asyncJob === 'list_recommendations' && event.chatId) {
      await listRecommendationsInBackground(event.chatId);
    } else if (event.__asyncJob === 'run_evaluation' && event.chatId) {
      await runEvaluationInBackground(event.chatId);
    } else if (event.__asyncJob === 'send_investigation_form' && event.chatId) {
      await sendInvestigationFormInBackground(event.chatId);
    } else if (event.__asyncJob === 'run_investigation' && event.chatId && event.description) {
      await runInvestigationInBackground(event.chatId, event.description);
    } else if (event.__asyncJob === 'push_chat_investigation_result' && event.chatId && event.taskId) {
      await pushChatInvestigationResultInBackground({
        chatId: event.chatId,
        taskId: event.taskId,
        executionId: event.executionId,
        status: event.status,
        description: event.description,
        phase: event.phase,
      });
    } else if (event.__asyncJob === 'process_message' && event.chatId && event.messageId && event.text) {
      await processMessageInBackground(event.chatId, event.messageId, event.text);
    }
    return { ok: true };
  }

  // 2. 来自 API Gateway 的请求
  let body: any;
  let rawBody: string;
  try {
    rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString()
      : event.body ?? '{}';
    console.log(`Raw request body: ${rawBody.substring(0, 2000)}`);
    body = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // URL 验证（飞书事件订阅和卡片回调都用 challenge）
  if (body.type === 'url_verification' || body.challenge) {
    console.log('URL verification request received');
    return { statusCode: 200, headers, body: JSON.stringify({ challenge: body.challenge }) };
  }

  console.log(`Request type detection - body.type: ${body.type}, body.action: ${body.action ? 'present' : 'absent'}, body.header?.event_type: ${body.header?.event_type}`);

  // 卡片交互回调（飞书新版用 event_type=card.action.trigger）
  if (body.type === 'card.action.trigger'
      || body.header?.event_type === 'card.action.trigger'
      || body.action) {
    // 同样过滤过期的卡片点击事件，避免一小时前的点击被飞书重试导致重复触发改善计划
    const cardCreateTime = body.header?.create_time;
    if (cardCreateTime) {
      const t = Number(cardCreateTime);
      if (Number.isFinite(t) && t > 0 && Date.now() - t > 5 * 60 * 1000) {
        console.warn(`Stale card action dropped: ageMs=${Date.now() - t} createTime=${cardCreateTime}`);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }
    }
    // 去重：飞书 3s 没收到 200 就重试，冷启动时我们经常踩线 → 同一次点击被
    // 派发成两个 async job，用户会看到双份"正在发起..."和双份结果。
    //
    // 用 DDB 原子声明（跨 Lambda 实例可靠）。同一次点击在两种回调格式（v1
    // legacy 和 v2 新版）下 event_id 不同，但**点击 token** 相同（飞书用它
    // 标识"一次用户操作"）。优先用 token 去重，fallback 到 event_id。
    //
    // 注意：用户截图里看到飞书订阅了 `card.action.trigger`（新版）和
    // `card.action.trigger_v1`（旧版）两个回调，会让每次点击触发两次回调。
    // 推荐去飞书后台只保留新版；这里的 token 去重是兜底。
    const cardToken = body.event?.token ?? body.token;
    const cardEventId = body.header?.event_id;
    const dedupKey = cardToken
      ? `card-token:${cardToken}`
      : cardEventId
      ? `card-event:${cardEventId}`
      : undefined;
    if (dedupKey && (await isDuplicateRemote(dedupKey))) {
      console.log(`Duplicate card action ${dedupKey}, skipping`);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    console.log('Card action callback received');
    return handleCardAction(body);
  }

  // 事件去重（DDB 原子声明，跨 Lambda 实例可靠）
  const eventId = body.header?.event_id;
  if (eventId && (await isDuplicateRemote(eventId))) {
    console.log(`Duplicate event ${eventId}, skipping`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // 关键修复：丢弃过期的事件回调。
  // 飞书 IM 事件回调如果 3 秒内没收到 200，会持续重试 1 小时，导致几十分钟前
  // 甚至几小时前的旧消息被反复"回复"。我们用 header.create_time 过滤掉
  // 超过 5 分钟的事件 —— 即使 Lambda 重启丢失内存去重，也不会再处理旧事件。
  const createTimeStr = body.header?.create_time;
  if (createTimeStr) {
    const createTimeMs = Number(createTimeStr);
    if (Number.isFinite(createTimeMs) && createTimeMs > 0) {
      const ageMs = Date.now() - createTimeMs;
      const MAX_EVENT_AGE_MS = 5 * 60 * 1000; // 5 分钟
      if (ageMs > MAX_EVENT_AGE_MS) {
        console.warn(`Stale event dropped: eventId=${eventId} ageMs=${ageMs} createTime=${createTimeStr}`);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }
    }
  }

  // 只处理消息接收事件
  if (body.header?.event_type !== 'im.message.receive_v1') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const text = extractText(body);
  if (!text) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const chatId = body.event?.message?.chat_id ?? 'unknown';
  const messageId = body.event?.message?.message_id ?? '';

  console.log(`Received message from chat ${chatId}: ${text.substring(0, 100)}`);

  // 关键修复：必须在 3 秒内响应飞书，否则飞书会重试发送同一事件。
  // 调用 DevOps Agent 通常 5-30 秒，无法在主 handler 里同步完成。
  // 解决方案：把消息处理派发给异步 Lambda 调用，主 handler 立即返回 200。
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (functionName && messageId) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          __asyncJob: 'process_message',
          chatId,
          messageId,
          text,
        })),
      }));
      console.log(`Message processing dispatched async for messageId ${messageId}`);
    } catch (err: any) {
      console.error('Failed to dispatch async message processing:', err);
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};

/**
 * 后台处理用户发来的消息（菜单关键词或与 DevOps Agent 对话）
 */
async function processMessageInBackground(
  chatId: string,
  messageId: string,
  text: string
): Promise<void> {
  try {
    if (isInvestigationTrigger(text)) {
      await replyMessage(messageId, 'interactive', buildInvestigationFormCard(''));
    } else if (isMenuTrigger(text)) {
      await replyMessage(messageId, 'interactive', buildMenuCard());
    } else {
      const answer = await askDevOpsAgent(chatId, text);
      await replyMessage(messageId, 'interactive', buildChatReplyCard(answer));
    }
  } catch (err: any) {
    console.error('Failed to process message in background:', err);
    try {
      await replyMessage(messageId, 'text', { text: `❌ 处理失败：${err.message}` });
    } catch (replyErr) {
      console.error('Failed to send error reply:', replyErr);
    }
  }
}
