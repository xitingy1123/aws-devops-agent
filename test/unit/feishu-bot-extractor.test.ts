/**
 * Unit tests for the chat→investigation taskId extractor.
 *
 * The extractor is the linchpin of Plan B: it pulls the taskId out of the
 * `[[investigation:<uuid>:<title>]]` markers that DevOps Agent embeds in its
 * chat response text whenever it autonomously creates an INVESTIGATION task.
 *
 * If this regex fails, every chat-initiated investigation is orphaned (the
 * EventBridge "Investigation Completed" event won't have a chat mapping to
 * push back to). So we want generous coverage here — including the real
 * formats observed in production.
 */
import { extractInvestigationTaskIds } from '../../src/lambdas/feishu-bot/index';

describe('extractInvestigationTaskIds', () => {
  it('returns empty array for empty / null / undefined input', () => {
    expect(extractInvestigationTaskIds('')).toEqual([]);
    // @ts-expect-error — exercise runtime null guard
    expect(extractInvestigationTaskIds(null)).toEqual([]);
    // @ts-expect-error — exercise runtime undefined guard
    expect(extractInvestigationTaskIds(undefined)).toEqual([]);
  });

  it('returns empty array when no markers are present', () => {
    const text = 'Hello world, no investigation here.';
    expect(extractInvestigationTaskIds(text)).toEqual([]);
  });

  it('extracts taskId from the real production marker format (double brackets + title suffix)', () => {
    // This is the actual format DevOps Agent emits in chat (verified from a real screenshot):
    //   "[[investigation:<uuid>:<title>]]"
    const text =
      `I've created the investigation: [[investigation:0556a555-ca43-4a3a-8975-35b21a1f966d:` +
      `High CPU spikes on EC2 instance i-1234567890abcdef0]]`;
    expect(extractInvestigationTaskIds(text)).toEqual([
      '0556a555-ca43-4a3a-8975-35b21a1f966d',
    ]);
  });

  it('extracts taskId from the older single-bracket format', () => {
    // Some older responses used single brackets without title suffix.
    const text =
      `The investigation [investigation:1668217a-a4a3-4883-baa0-f0c275c4f35f] ` +
      `will analyze the underlying metrics and logs.`;
    expect(extractInvestigationTaskIds(text)).toEqual([
      '1668217a-a4a3-4883-baa0-f0c275c4f35f',
    ]);
  });

  it('extracts taskId from a bare marker without any brackets', () => {
    // Defensive: even if Agent emits the marker without surrounding punctuation,
    // we should still catch it.
    const text =
      `tracking via investigation:0556a555-ca43-4a3a-8975-35b21a1f966d for now`;
    expect(extractInvestigationTaskIds(text)).toEqual([
      '0556a555-ca43-4a3a-8975-35b21a1f966d',
    ]);
  });

  it('deduplicates when Agent references the same task multiple times', () => {
    // Agents often quote their own taskId in multiple paragraphs.
    const tid = '1668217a-a4a3-4883-baa0-f0c275c4f35f';
    const text =
      `Kicking off [[investigation:${tid}:my title]]. ` +
      `Once [investigation:${tid}] is done, you'll see the report.`;
    expect(extractInvestigationTaskIds(text)).toEqual([tid]);
  });

  it('extracts multiple distinct taskIds in order of first occurrence', () => {
    const text =
      `First [[investigation:11111111-2222-3333-4444-555555555555:Alpha]] then ` +
      `[[investigation:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:Beta]] simultaneously.`;
    expect(extractInvestigationTaskIds(text)).toEqual([
      '11111111-2222-3333-4444-555555555555',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ]);
  });

  it('rejects malformed UUIDs (wrong segment lengths)', () => {
    expect(extractInvestigationTaskIds('[investigation:abc]')).toEqual([]);
    expect(extractInvestigationTaskIds('[investigation:1234-5678]')).toEqual([]);
    // 8-4-4-4-11 (last segment one char short)
    expect(
      extractInvestigationTaskIds(
        '[[investigation:11111111-2222-3333-4444-55555555555:nope]]'
      )
    ).toEqual([]);
  });

  it('does not match other prefixes like evaluation:<uuid>', () => {
    const text =
      'See [[evaluation:0556a555-ca43-4a3a-8975-35b21a1f966d:something]]';
    expect(extractInvestigationTaskIds(text)).toEqual([]);
  });

  it('extracts from realistic multi-paragraph chat response (mirrors user screenshot)', () => {
    const text = `
I've created the investigation: [[investigation:0556a555-ca43-4a3a-8975-35b21a1f966d:High CPU spikes on EC2 instance i-1234567890abcdef0]]

The investigation will analyze:
- Metrics — CPU utilization patterns and any correlating resource metrics
- Logs — System logs and application logs from the instance
- Activity — CloudTrail events around the spike times
- Timing — Whether the ~2-hour intervals indicate scheduled jobs

You can track progress in the UI.
`;
    expect(extractInvestigationTaskIds(text)).toEqual([
      '0556a555-ca43-4a3a-8975-35b21a1f966d',
    ]);
  });
});
