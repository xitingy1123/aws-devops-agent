import {
  RCAReport,
  FeishuCardMessage,
  FeishuCardElement,
  FeishuTextMessage,
  FeishuMessage,
} from '../../shared/types';

/**
 * Notification type for the Feishu card.
 */
export type NotificationType = 'rca_complete' | 'rca_timeout' | 'rca_partial';

/**
 * 判断这条 RCAReport 是不是 phase-2 "纯 mitigation" 报告（来自
 * InvestigationEventHandler 的 buildMitigationReport）。
 *
 * 优先看显式标记 `reportPhase`。没有标记时回落到旧的启发式：
 * "有 mitigationPlan 且没有 rootCauses 且没有 keyFindings"。
 *
 * 注意：DevOps Agent 在"无需操作"等场景下的 mitigation markdown 是一段
 * 散文,parseMitigationPlan 解不出来,所以**不能再依赖 mitigationPlan 数组**
 * 来识别身份；必须靠 reportPhase 显式标记。
 */
export function isMitigationOnlyReport(report: RCAReport): boolean {
  if (report.reportPhase === 'mitigation') return true;
  if (report.reportPhase === 'investigation') return false;
  // 兜底：旧调用方没填 reportPhase
  const hasMitigation = !!report.mitigationPlan && report.mitigationPlan.length > 0;
  const noRootCauses = !report.rootCauses || report.rootCauses.length === 0;
  const noFindings = !report.keyFindings || report.keyFindings.length === 0;
  return hasMitigation && noRootCauses && noFindings;
}

/**
 * 飞书富文本卡片单 div 元素的安全字数上限。
 * 飞书的真实限制大约是 30k 字符 / 元素，留足缓冲避免拒收。
 */
const MAX_DIV_TEXT = 4500;

/**
 * 卡片所有元素文本累加超过该阈值时，回退到分段纯文本消息。
 * 飞书一条文本消息上限约 30k 字符，这里按 8k 留出多段冗余。
 */
const MAX_CARD_TOTAL_TEXT = 18000;

/**
 * 一条 fallback 文本消息的最大字符数（超出则继续分段）。
 */
const MAX_TEXT_MESSAGE = 4000;

// -----------------------------------------------------------------------------
// 配色 / 标题
// -----------------------------------------------------------------------------

function getHeaderTemplate(
  report: RCAReport,
  notificationType: NotificationType
): 'red' | 'orange' | 'green' {
  if (isMitigationOnlyReport(report)) {
    // Mitigation-only card 默认绿色（生成成功）；超时/失败由 notificationType 决定。
    if (notificationType === 'rca_complete') return 'green';
    return 'orange';
  }
  if (notificationType === 'rca_complete') {
    if (report.rootCause.confidence === 'high') return 'red';
    if (report.rootCause.confidence === 'medium') return 'orange';
    return 'green';
  }
  return 'orange';
}

function getCardTitle(
  report: RCAReport,
  notificationType: NotificationType
): string {
  if (isMitigationOnlyReport(report)) {
    if (notificationType === 'rca_complete') return '🛠️ CloudWatch 告警缓解计划已生成';
    if (notificationType === 'rca_timeout') return '⏱️ 缓解计划生成超时';
    return '⚠️ 缓解计划生成部分完成';
  }
  switch (notificationType) {
    case 'rca_complete':
      return '🔍 CloudWatch 告警根因分析完成';
    case 'rca_timeout':
      return '⏱️ CloudWatch 告警根因分析超时';
    case 'rca_partial':
      return '⚠️ CloudWatch 告警根因分析部分完成';
  }
}

// -----------------------------------------------------------------------------
// 链接构造：返回 DevOps Agent 控制台的 investigation 页面（如果可以拿到 executionId）
// -----------------------------------------------------------------------------

function buildReportUrl(): { label: string; url: string } {
  const agentSpaceId = process.env.AGENT_SPACE_ID;
  if (agentSpaceId) {
    // DevOps Agent 控制台里真实有效的入口是 `/dashboard`(Incident Response
    // Dashboard / Incidents 页),用户可以在这个列表里找到本次调查并点进去看
    // 完整 timeline + RCA + mitigation。
    //
    // 历史教训:
    //   - `/home` 会 404
    //   - `/home/activity/{id}` 也会 404,无论 id 是 chat session 还是
    //     EventBridge 事件里的 execution_id —— 控制台没有公开这个路由。
    //
    // 因此即使我们已经在 RCAReport 里携带了准确的 executionId / taskId,
    // 也只能落到 dashboard 列表页,让用户自己点进具体那条调查。
    return {
      label: '在 DevOps Agent 中查看调查列表',
      url: `https://${agentSpaceId}.aidevops.global.app.aws/dashboard`,
    };
  }
  // 完全没配 AGENT_SPACE_ID → 回 CloudWatch Alarms
  const region = process.env.AWS_REGION ?? 'us-east-1';
  return {
    label: '查看 CloudWatch 告警',
    url: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:`,
  };
}

// -----------------------------------------------------------------------------
// 文本块构造工具
// -----------------------------------------------------------------------------

function div(content: string): FeishuCardElement {
  // 飞书 div 元素文本太长会拒收，先截断
  const safe = content.length > MAX_DIV_TEXT
    ? content.substring(0, MAX_DIV_TEXT - 30) + '\n…（内容已截断）'
    : content;
  return {
    tag: 'div',
    text: { tag: 'lark_md', content: safe },
  };
}

function divider(): FeishuCardElement {
  return { tag: 'hr' };
}

function escapeMd(s: string): string {
  // 飞书 lark_md 使用 ** 表示加粗。其它字符（_）通常不解释为 markdown，
  // 所以只对 ** 做转义即可，避免破坏用户文本（如时间戳里的下划线）。
  return s.replace(/\*\*/g, '\\*\\*');
}

/**
 * 飞书 `lark_md` 不支持 `#` 风格的 markdown 标题（只支持 **粗体**、_斜体_、链接、代码块）。
 * DevOps Agent journal 输出经常带 `## Symptom` / `### EC2 实例` 这样的 ATX 标题，
 * 直接传给飞书会被原样显示成字面量。
 *
 * 这个 helper 把 ATX 标题转成视觉接近的粗体行 + 层级 emoji 前缀：
 *   `# Foo`    → `**📌 Foo**`
 *   `## Foo`   → `**🔹 Foo**`
 *   `### Foo`  → `**▸ Foo**`
 *   `#### Foo` → `**· Foo**`
 *   `##### Foo`/`###### Foo` → `**· Foo**`
 *
 * 与 feishu-bot 的 `markdownToLarkMd` 保持视觉一致——这样自动告警链路和
 * chat 路径输出的标题样式相同。
 *
 * 注意：必须在 escapeMd 之前调用（否则 ** 会被先转义掉）。
 */
function normalizeHeadings(s: string): string {
  return s
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!m) return line;
      const depth = m[1].length;
      const text = m[2];
      const prefix =
        depth === 1
          ? '📌 '
          : depth === 2
          ? '🔹 '
          : depth === 3
          ? '▸ '
          : '· ';
      return `**${prefix}${text}**`;
    })
    .join('\n');
}

/**
 * 同时清洗标题 + 转义未授权的 markdown。用于来自 Agent journal 的不可信 markdown。
 */
function sanitizeAgentText(s: string): string {
  return escapeMd(normalizeHeadings(s));
}

// -----------------------------------------------------------------------------
// 各章节渲染
// -----------------------------------------------------------------------------

function alarmsSection(report: RCAReport): string {
  const lines = report.alarmSummary.alarms.map((a) => {
    const value = Number.isFinite(a.currentValue) ? a.currentValue : '?';
    const threshold = Number.isFinite(a.threshold) ? a.threshold : '?';
    return `- **${escapeMd(a.alarmName)}**（${a.namespace}/${a.metricName}） 当前值 ${value} / 阈值 ${threshold}`;
  });
  const resources = report.rootCause.affectedResources.length > 0
    ? report.rootCause.affectedResources.map((r) => `- \`${r}\``).join('\n')
    : '- 未识别';
  return [
    `**📋 告警概要**`,
    lines.join('\n'),
    `首次告警：${report.alarmSummary.firstAlarmTime}`,
    `最近告警：${report.alarmSummary.lastAlarmTime}`,
    ``,
    `**🎯 受影响资源**`,
    resources,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// 控制台 Tab 2: Root cause
// -----------------------------------------------------------------------------

function rootCauseSection(report: RCAReport): string {
  const parts: string[] = ['**🎯 Root cause（根因）**'];

  if (report.rootCauses && report.rootCauses.length > 0) {
    const blocks = report.rootCauses.map((rc, i) => {
      const detail = rc.details ? `\n${sanitizeAgentText(rc.details)}` : '';
      const evidence = rc.evidence ? `\n_证据：_ ${sanitizeAgentText(rc.evidence)}` : '';
      return `**${i + 1}. ${sanitizeAgentText(rc.summary)}**${detail}${evidence}`;
    });
    parts.push(blocks.join('\n\n'));
  } else {
    const detail = report.rootCause.details ? `\n${sanitizeAgentText(report.rootCause.details)}` : '';
    parts.push(`${sanitizeAgentText(report.rootCause.summary)}${detail}`);
  }

  // Category + confidence
  const meta: string[] = [];
  if (report.rootCause.category && report.rootCause.category !== 'unknown') {
    meta.push(`类别：\`${report.rootCause.category}\``);
  }
  meta.push(`置信度：\`${report.rootCause.confidence}\``);
  parts.push(meta.join(' · '));

  return parts.join('\n\n');
}

// -----------------------------------------------------------------------------
// 控制台 Tab 3: Mitigation plan
//
// 现在的流程：
//   - phase 1 卡片（root cause）→ Mitigation plan 还在生成中，这里会渲染一个
//     "等待第二条卡片" 的提示。
//   - phase 2 卡片（mitigation only）→ 这里渲染实际的步骤 + 命令 + 回滚。
//   - 旧调用路径（一次性合成的 RCAReport）→ 这里也能渲染。
// -----------------------------------------------------------------------------

function mitigationPlanSection(report: RCAReport): string {
  const parts: string[] = ['**🛠️ Mitigation plan（缓解计划）**'];

  const hasStructuredPlan = !!report.mitigationPlan && report.mitigationPlan.length > 0;
  const hasFallbackSteps = report.remediation.steps.length > 0;
  const hasFallbackImmediate = !!report.remediation.immediateMitigation &&
    !report.remediation.immediateMitigation.includes('正在生成');
  const isMitigationCard = report.reportPhase === 'mitigation';
  const hasRawMarkdown = !!report.agentRawText && report.agentRawText.trim().length > 0;

  // ---------------------------------------------------------------------------
  // Phase 1 (root-cause card) without any plan content yet → 引导文案
  // ---------------------------------------------------------------------------
  if (!isMitigationCard && !hasStructuredPlan && !hasFallbackSteps && !hasFallbackImmediate) {
    parts.push(
      '_⏳ DevOps Agent 已自动触发缓解计划生成，**完成后会作为第二条飞书卡片单独推送**（约 1-3 分钟）。_'
    );
    parts.push(
      '_如需立即查看，可前往 DevOps Agent 控制台 → Incidents → 当前调查 → Mitigation plan tab。_'
    );
    return parts.join('\n\n');
  }

  // 顶部说明已删除：之前在这里放过一段"以下计划不会自动执行,如需执行请到
  // DevOps Agent 控制台 Mitigation plan tab 点 Run"的提示,但官方文档里
  // 查不到任何关于 "Run" 按钮的描述（仅有 propose / recommend / approve
  // 等措辞,IAM action 也只到 UpdateBacklogTask = "approve a mitigation plan"
  // 即触发 plan 生成,而非执行）,留着会误导用户去寻找一个不存在的按钮。
  // 因此直接省略,不再向用户解释执行模型。

  if (hasStructuredPlan) {
    const blocks = report.mitigationPlan!.map((m, i) => {
      const lines: string[] = [`**${i + 1}. ${sanitizeAgentText(m.step)}**`];
      if (m.command) {
        lines.push(`   命令：\n   \`\`\`\n   ${m.command}\n   \`\`\``);
      }
      if (m.rollback) {
        lines.push(`   _回滚方案：_ ${sanitizeAgentText(m.rollback)}`);
      }
      return lines.join('\n');
    });
    parts.push(blocks.join('\n\n'));
  } else if (hasFallbackSteps) {
    parts.push(
      report.remediation.steps.map((s, i) => `**${i + 1}.** ${sanitizeAgentText(s)}`).join('\n')
    );
  } else if (hasFallbackImmediate) {
    parts.push(sanitizeAgentText(report.remediation.immediateMitigation));
  } else if (isMitigationCard && hasRawMarkdown) {
    // ★ Mitigation 卡片但没有结构化步骤：常见于"无需操作性缓解措施"等散文输出。
    // 把整段 markdown 原样展示——已经被 sanitizeAgentText 转义过 ## / ###。
    parts.push(sanitizeAgentText(report.agentRawText!.trim()));
  } else if (isMitigationCard) {
    parts.push('_DevOps Agent 未输出可解析的缓解计划文本。_');
  }

  // Immediate / long-term 单独补一段（如果有且 mitigationPlan 没覆盖）
  const extras: string[] = [];
  if (
    report.remediation.immediateMitigation &&
    !report.remediation.immediateMitigation.includes('正在生成') &&
    !hasStructuredPlan
  ) {
    extras.push(`**立即缓解：** ${sanitizeAgentText(report.remediation.immediateMitigation)}`);
  }
  if (report.remediation.longTermFix) {
    extras.push(`**长期修复：** ${sanitizeAgentText(report.remediation.longTermFix)}`);
  }
  if (report.remediation.rollbackPlan) {
    extras.push(`**回滚预案：** ${sanitizeAgentText(report.remediation.rollbackPlan)}`);
  }
  if (extras.length > 0) {
    parts.push(extras.join('\n'));
  }

  return parts.join('\n\n');
}

function statusBanner(notificationType: NotificationType): string | null {
  if (notificationType === 'rca_timeout') {
    return '_⏱️ 状态：根因分析超时，以下是已收集的部分信息。_';
  }
  if (notificationType === 'rca_partial') {
    return '_⚠️ 状态：根因分析部分完成，部分数据源不可用。_';
  }
  return null;
}

// -----------------------------------------------------------------------------
// 卡片组装
// -----------------------------------------------------------------------------

function buildElements(
  report: RCAReport,
  notificationType: NotificationType
): { elements: FeishuCardElement[]; totalText: number } {
  // 卡片结构：
  //   - 普通模式（phase 1 或单独路径）：告警概要 → Investigation timeline → Root cause → Mitigation plan
  //   - mitigation-only 模式（phase 2）：告警概要 → Mitigation plan（只展示 mitigation,
  //     避免和 phase-1 卡片重复）
  const sections: Array<string | null> = isMitigationOnlyReport(report)
    ? [
        statusBanner(notificationType),
        alarmsSection(report),
        mitigationPlanSection(report),
      ]
    : [
        statusBanner(notificationType),
        alarmsSection(report),
        rootCauseSection(report),
        mitigationPlanSection(report),
      ];

  const elements: FeishuCardElement[] = [];
  let totalText = 0;
  let isFirst = true;

  for (const section of sections) {
    if (!section) continue;
    if (!isFirst) elements.push(divider());
    elements.push(div(section));
    totalText += section.length;
    isFirst = false;
  }

  // 链接按钮（不计入文本字数限制）
  const link = buildReportUrl();
  elements.push(divider());
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: link.label },
        url: link.url,
      },
    ],
  });

  return { elements, totalText };
}

/**
 * 把 RCAReport 渲染成纯文本消息（用于卡片内容超长时的 fallback）。
 * 返回的字符串可能较长，调用方需自行分段。
 *
 * 段落顺序与卡片一致：告警概要 → Investigation timeline → Root cause → Mitigation plan。
 */
export function formatPlainTextReport(
  report: RCAReport,
  notificationType: NotificationType
): string {
  const lines: string[] = [];
  lines.push(getCardTitle(report, notificationType));
  const banner = statusBanner(notificationType);
  if (banner) lines.push(banner);
  lines.push('');
  lines.push(stripMd(alarmsSection(report)));
  lines.push('');
  lines.push(stripMd(rootCauseSection(report)));
  lines.push('');
  lines.push(stripMd(mitigationPlanSection(report)));
  const link = buildReportUrl();
  lines.push('');
  lines.push(`🔗 ${link.label}: ${link.url}`);
  return lines.join('\n');
}

function stripMd(text: string): string {
  return text.replace(/\\\*\\\*/g, '**').replace(/\*\*/g, '');
}

/**
 * 把长文本切成飞书可发送的多条 text 消息（每条 <= MAX_TEXT_MESSAGE 字符）。
 * 切分时尽量保留段落完整性。
 */
export function splitIntoTextMessages(text: string): FeishuTextMessage[] {
  if (text.length <= MAX_TEXT_MESSAGE) {
    return [{ msg_type: 'text', content: { text } }];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_TEXT_MESSAGE) {
    let cut = remaining.lastIndexOf('\n\n', MAX_TEXT_MESSAGE);
    if (cut < MAX_TEXT_MESSAGE / 2) cut = remaining.lastIndexOf('\n', MAX_TEXT_MESSAGE);
    if (cut < MAX_TEXT_MESSAGE / 2) cut = MAX_TEXT_MESSAGE;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.map((c, i) => ({
    msg_type: 'text' as const,
    content: { text: chunks.length > 1 ? `（${i + 1}/${chunks.length}）\n${c}` : c },
  }));
}

/**
 * Format an RCA report into a Feishu interactive card message.
 *
 * 兼容旧 API：始终返回 FeishuCardMessage（即使内容会被截断）。
 * 推荐改用 formatFeishuMessages，它会在卡片超长时自动 fallback 到多条文本消息。
 */
export function formatFeishuCard(
  report: RCAReport,
  notificationType: NotificationType
): FeishuCardMessage {
  const { elements } = buildElements(report, notificationType);
  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: getCardTitle(report, notificationType) },
        template: getHeaderTemplate(report, notificationType),
      },
      elements,
    },
  };
}

/**
 * 推荐使用的入口：
 * - 当卡片总文本在阈值内 → 返回单条 FeishuCardMessage
 * - 当超出阈值（飞书 30k 字符限制保护） → 返回一条精简卡片（指向完整报告链接）
 *   + 多条纯文本消息，承载完整内容
 */
export function formatFeishuMessages(
  report: RCAReport,
  notificationType: NotificationType
): FeishuMessage[] {
  const { elements, totalText } = buildElements(report, notificationType);

  const card: FeishuCardMessage = {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: getCardTitle(report, notificationType) },
        template: getHeaderTemplate(report, notificationType),
      },
      elements,
    },
  };

  if (totalText <= MAX_CARD_TOTAL_TEXT) {
    return [card];
  }

  // 内容过长：先发送一条精简标题卡片，然后用纯文本消息承载完整内容。
  const link = buildReportUrl();
  const summaryCard: FeishuCardMessage = {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: getCardTitle(report, notificationType) },
        template: getHeaderTemplate(report, notificationType),
      },
      elements: [
        div(`**${escapeMd(report.rootCause.summary)}**\n\n_完整内容因长度限制改为下方文本消息分段发送。_`),
        divider(),
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: link.label },
              url: link.url,
            },
          ],
        },
      ],
    },
  };

  const textMessages = splitIntoTextMessages(formatPlainTextReport(report, notificationType));
  return [summaryCard, ...textMessages];
}
