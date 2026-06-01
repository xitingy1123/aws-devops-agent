/**
 * Integration test: Step Functions workflow end-to-end execution with mock Lambdas.
 *
 * Synthesizes the workflow defined by `buildWorkflowDefinition`, then runs a
 * lightweight Amazon States Language (ASL) interpreter that supports the
 * subset of features actually used by the workflow:
 *
 *   - Task (LambdaInvoke):       calls into an in-memory Lambda registry
 *   - Choice:                    BooleanEquals + StringEquals + Default
 *   - Wait:                      noop (we don't actually wait in tests)
 *   - Pass:                      Result + ResultPath, Parameters with $ refs
 *
 * For each path scenario we register fake Lambda implementations and assert
 * the final state and the sequence of states executed.
 *
 * Validates: Requirements 2.1, 2.2 (Step Functions workflow orchestration)
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import {
  buildWorkflowDefinition,
  WorkflowLambdas,
} from '../../src/shared/workflow-definition';

// -----------------------------------------------------------------------------
// Synth and definition extraction (same approach as workflow-definition.test.ts)
// -----------------------------------------------------------------------------

interface SynthResult {
  definition: any;
  lambdaArnByLogicalId: Record<string, string>;
  lambdaLogicalIdByRole: Record<keyof WorkflowLambdas, string>;
}

function synthDefinition(): SynthResult {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'WorkflowIntegrationStack');

  const makeFn = (id: string) =>
    new lambda.Function(stack, id, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });

  const lambdas: WorkflowLambdas = {
    alarmRouter: makeFn('AlarmRouterFn'),
    alarmGrouper: makeFn('AlarmGrouperFn'),
    rcaAnalyzer: makeFn('RcaAnalyzerFn'),
    feishuNotifier: makeFn('FeishuNotifierFn'),
  };

  buildWorkflowDefinition(stack, lambdas);

  const template = Template.fromStack(stack);
  const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
  const sm = stateMachines[Object.keys(stateMachines)[0]];
  const parts = sm.Properties.DefinitionString['Fn::Join'][1] as Array<string | object>;

  const arnByLogical: Record<string, string> = {};
  const joined = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const obj = part as Record<string, any>;
      if ('Fn::GetAtt' in obj) {
        const [logicalId, attr] = obj['Fn::GetAtt'];
        const arn = `arn:aws:lambda:us-east-1:123456789012:function:${logicalId}`;
        arnByLogical[logicalId] = arn;
        return arn;
      }
      if ('Ref' in obj) return `<<REF:${obj.Ref}>>`;
      return JSON.stringify(obj);
    })
    .join('');

  const lambdaLogicalIdByRole: Record<keyof WorkflowLambdas, string> = {
    alarmRouter: (
      stack.resolve((lambdas.alarmRouter as lambda.Function).functionArn) as any
    )['Fn::GetAtt'][0],
    alarmGrouper: (
      stack.resolve((lambdas.alarmGrouper as lambda.Function).functionArn) as any
    )['Fn::GetAtt'][0],
    rcaAnalyzer: (
      stack.resolve((lambdas.rcaAnalyzer as lambda.Function).functionArn) as any
    )['Fn::GetAtt'][0],
    feishuNotifier: (
      stack.resolve((lambdas.feishuNotifier as lambda.Function).functionArn) as any
    )['Fn::GetAtt'][0],
  };

  return { definition: JSON.parse(joined), lambdaArnByLogicalId: arnByLogical, lambdaLogicalIdByRole };
}

// -----------------------------------------------------------------------------
// Minimal ASL interpreter
// -----------------------------------------------------------------------------

type LambdaMock = (input: any) => any | Promise<any>;
type LambdaRegistry = Record<string, LambdaMock>;

interface ExecutionTrace {
  states: string[];
  finalOutput: any;
}

/**
 * Resolve a JSONPath expression like `$.foo.bar` against the given input.
 * Only supports the simple `$.path.to.value` form used by the workflow.
 */
function resolveJsonPath(input: any, path: string): any {
  if (path === '$') return input;
  // Context-object reference: $$.Task.Token (and similar $$.* paths). The
  // CDK-generated workflow uses this on the waitForTaskToken step to inject
  // the SFN-generated task token. Simulator returns a deterministic stub.
  if (path === '$$.Task.Token') return 'simulated-task-token';
  if (path.startsWith('$$.')) return `simulated-context-${path.slice(3)}`;
  if (!path.startsWith('$.')) {
    throw new Error(`Unsupported JsonPath: ${path}`);
  }
  const parts = path.slice(2).split('.');
  let cur = input;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Resolve a Parameters block: keys ending in `.$` reference JSONPath into the
 * current state input; other keys are passed through verbatim. Nested objects
 * are recursed.
 */
function resolveParameters(parameters: any, input: any): any {
  if (parameters == null) return input;
  if (Array.isArray(parameters)) {
    return parameters.map((v) => resolveParameters(v, input));
  }
  if (typeof parameters !== 'object') return parameters;

  const out: any = {};
  for (const key of Object.keys(parameters)) {
    if (key.endsWith('.$')) {
      const realKey = key.slice(0, -2);
      out[realKey] = resolveJsonPath(input, parameters[key]);
    } else {
      out[key] = resolveParameters(parameters[key], input);
    }
  }
  return out;
}

/**
 * Place `value` at the given JSONPath in `input` and return the merged result.
 * Only `$` (replace) and `$.field` (set top-level field) are supported.
 */
function applyResultPath(input: any, value: any, resultPath: string | undefined): any {
  if (resultPath === undefined || resultPath === '$') return value;
  if (!resultPath.startsWith('$.')) {
    throw new Error(`Unsupported ResultPath: ${resultPath}`);
  }
  const key = resultPath.slice(2);
  if (key.includes('.')) {
    throw new Error(`Nested ResultPath not supported: ${resultPath}`);
  }
  return { ...input, [key]: value };
}

async function executeWorkflow(
  definition: any,
  initialInput: any,
  lambdas: LambdaRegistry
): Promise<ExecutionTrace> {
  const trace: string[] = [];
  let current: string = definition.StartAt;
  let stateInput: any = initialInput;
  const visited = new Set<string>();

  // Safety bound — workflow has < 20 states; cap iterations.
  for (let i = 0; i < 50; i++) {
    if (!current) break;
    trace.push(current);
    visited.add(current);
    const state = definition.States[current];
    if (!state) throw new Error(`Unknown state: ${current}`);

    switch (state.Type) {
      case 'Task': {
        // Resolve Lambda ARN from Parameters.FunctionName
        const fnArn: string = state.Parameters.FunctionName;
        const mock = lambdas[fnArn];
        if (!mock) {
          throw new Error(
            `No mock registered for Lambda ARN: ${fnArn}. ` +
              `Registered: ${Object.keys(lambdas).join(', ')}`
          );
        }
        // Build Lambda payload
        let payload: any;
        if (state.Parameters.Payload !== undefined) {
          payload = resolveParameters(state.Parameters.Payload, stateInput);
        } else if (state.Parameters['Payload.$']) {
          payload = resolveJsonPath(stateInput, state.Parameters['Payload.$']);
        } else {
          payload = stateInput;
        }
        const lambdaResult = await mock(payload);

        // waitForTaskToken integration: the step output IS whatever the
        // (simulated) external SendTaskSuccess delivers, NOT { Payload }.
        // Treat the mock's return value as that SendTaskSuccess payload directly.
        const isWaitForTaskToken =
          typeof state.Resource === 'string' && state.Resource.includes('waitForTaskToken');
        let afterOutput: any;
        if (isWaitForTaskToken) {
          afterOutput = state.OutputPath
            ? resolveJsonPath(lambdaResult, state.OutputPath)
            : lambdaResult;
        } else {
          // Wrap in { Payload } the way LambdaInvoke does, then OutputPath strips it.
          const wrapped = { Payload: lambdaResult };
          afterOutput = state.OutputPath
            ? resolveJsonPath(wrapped, state.OutputPath)
            : wrapped;
        }
        stateInput = afterOutput;

        if (state.End === true) return { states: trace, finalOutput: stateInput };
        current = state.Next;
        break;
      }
      case 'Choice': {
        let nextState: string | undefined = state.Default;
        for (const choice of state.Choices) {
          const variableValue = resolveJsonPath(stateInput, choice.Variable);
          if (
            'BooleanEquals' in choice &&
            variableValue === choice.BooleanEquals
          ) {
            nextState = choice.Next;
            break;
          }
          if (
            'StringEquals' in choice &&
            variableValue === choice.StringEquals
          ) {
            nextState = choice.Next;
            break;
          }
        }
        if (!nextState) throw new Error(`Choice ${current} did not match`);
        current = nextState;
        break;
      }
      case 'Wait': {
        // Don't actually wait — just advance.
        current = state.Next;
        break;
      }
      case 'Pass': {
        let value: any = stateInput;
        if (state.Result !== undefined) {
          value = state.Result;
        } else if (state.Parameters !== undefined) {
          value = resolveParameters(state.Parameters, stateInput);
        }
        stateInput = applyResultPath(stateInput, value, state.ResultPath);
        if (state.End === true) return { states: trace, finalOutput: stateInput };
        current = state.Next;
        break;
      }
      default:
        throw new Error(`Unsupported state type: ${state.Type} for state ${current}`);
    }
  }

  throw new Error(`Workflow exceeded iteration bound. Trace: ${trace.join(' -> ')}`);
}

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

function makeAlarm(): any {
  return {
    alarmId: 'arn:aws:cloudwatch:us-east-1:123:alarm:HighCPU',
    alarmName: 'HighCPU',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-abc123' },
    threshold: 80,
    currentValue: 95,
    stateChangeTimestamp: '2024-01-15T10:00:00Z',
    previousState: 'OK',
    accountId: '123',
    region: 'us-east-1',
    resource: { accountId: '123', region: 'us-east-1', service: 'ec2', resourceId: 'i-abc123' },
    filtered: false,
  };
}

function makeRcaReport(status: 'completed' | 'partial' | 'timeout' = 'completed'): any {
  return {
    reportId: 'report-1',
    groupId: 'group-1',
    generatedAt: '2024-01-15T10:05:00Z',
    status,
    alarmSummary: {
      alarmCount: 1,
      alarms: [],
      firstAlarmTime: '2024-01-15T10:00:00Z',
      lastAlarmTime: '2024-01-15T10:00:00Z',
    },
    investigation: { timeline: [], dataSourcesConsulted: [], hypothesesExplored: [] },
    rootCause: {
      summary: 'High CPU',
      category: 'system_change',
      details: 'CPU spike',
      confidence: 'high',
      affectedResources: [],
    },
    remediation: { immediateMitigation: 'Restart', longTermFix: 'Optimize', steps: [] },
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('Integration: Step Functions workflow end-to-end (Requirements 2.1, 2.2)', () => {
  let synth: SynthResult;
  let arn: Record<keyof WorkflowLambdas, string>;

  beforeAll(() => {
    synth = synthDefinition();
    arn = {
      alarmRouter: synth.lambdaArnByLogicalId[synth.lambdaLogicalIdByRole.alarmRouter],
      alarmGrouper: synth.lambdaArnByLogicalId[synth.lambdaLogicalIdByRole.alarmGrouper],
      rcaAnalyzer: synth.lambdaArnByLogicalId[synth.lambdaLogicalIdByRole.rcaAnalyzer],
      feishuNotifier: synth.lambdaArnByLogicalId[synth.lambdaLogicalIdByRole.feishuNotifier],
    };
  });

  it('completes the happy path: alarm → grouper (no wait) → rca completed → notify success', async () => {
    const alarm = makeAlarm();
    const lambdas: LambdaRegistry = {
      [arn.alarmRouter]: () => alarm,
      [arn.alarmGrouper]: () => ({
        groupId: 'group-1',
        alarms: [alarm],
        isNewGroup: true,
        shouldWait: false,
      }),
      [arn.rcaAnalyzer]: () => ({
        rcaReport: makeRcaReport('completed'),
        status: 'completed',
        duration: 1234,
      }),
      [arn.feishuNotifier]: () => ({
        success: true,
        sentTo: ['https://example.com/hook'],
        failedTo: [],
        retryCount: 0,
      }),
    };

    const trace = await executeWorkflow(synth.definition, { event: 'cloudwatch' }, lambdas);

    expect(trace.states).toEqual([
      'InvokeAlarmRouter',
      'CheckFiltered',
      'InvokeAlarmGrouper',
      'CheckShouldWait',
      'InvokeRCAAnalyzer',
      'CheckRCAStatus',
      'InvokeFeishuNotifierComplete',
      'CheckNotificationResult',
      'RecordSuccess',
    ]);
    expect(trace.finalOutput.workflowResult.outcome).toBe('success');
  });

  it('takes the filtered path: alarm.filtered=true → RecordFiltered (terminal)', async () => {
    const lambdas: LambdaRegistry = {
      [arn.alarmRouter]: () => ({ ...makeAlarm(), filtered: true, filterReason: 'no_include_rule_matched' }),
      [arn.alarmGrouper]: () => {
        throw new Error('alarmGrouper should not be called on filtered path');
      },
      [arn.rcaAnalyzer]: () => {
        throw new Error('rcaAnalyzer should not be called on filtered path');
      },
      [arn.feishuNotifier]: () => {
        throw new Error('feishuNotifier should not be called on filtered path');
      },
    };

    const trace = await executeWorkflow(synth.definition, { event: 'cloudwatch' }, lambdas);

    expect(trace.states).toEqual(['InvokeAlarmRouter', 'CheckFiltered', 'RecordFiltered']);
    expect(trace.finalOutput.workflowResult.outcome).toBe('filtered');
  });

  it('takes the grouping wait path: shouldWait=true → PrepareWaitSeconds → WaitForGroupWindow → RCA', async () => {
    const alarm = makeAlarm();
    const lambdas: LambdaRegistry = {
      [arn.alarmRouter]: () => alarm,
      [arn.alarmGrouper]: () => ({
        groupId: 'group-2',
        alarms: [alarm, alarm],
        isNewGroup: false,
        shouldWait: true,
        waitUntil: '2024-01-15T10:02:00Z',
      }),
      [arn.rcaAnalyzer]: () => ({
        rcaReport: makeRcaReport('completed'),
        status: 'completed',
        duration: 100,
      }),
      [arn.feishuNotifier]: () => ({
        success: true,
        sentTo: ['hook'],
        failedTo: [],
        retryCount: 0,
      }),
    };

    const trace = await executeWorkflow(synth.definition, { event: 'cloudwatch' }, lambdas);

    expect(trace.states).toEqual([
      'InvokeAlarmRouter',
      'CheckFiltered',
      'InvokeAlarmGrouper',
      'CheckShouldWait',
      'PrepareWaitSeconds',
      'WaitForGroupWindow',
      'InvokeRCAAnalyzer',
      'CheckRCAStatus',
      'InvokeFeishuNotifierComplete',
      'CheckNotificationResult',
      'RecordSuccess',
    ]);
    expect(trace.finalOutput.workflowResult.outcome).toBe('success');
  });

  it('takes the partial path when RCA status is not "completed"', async () => {
    const alarm = makeAlarm();
    const lambdas: LambdaRegistry = {
      [arn.alarmRouter]: () => alarm,
      [arn.alarmGrouper]: () => ({
        groupId: 'group-3',
        alarms: [alarm],
        isNewGroup: true,
        shouldWait: false,
      }),
      [arn.rcaAnalyzer]: () => ({
        rcaReport: makeRcaReport('partial'),
        status: 'partial',
        duration: 50,
      }),
      [arn.feishuNotifier]: (input: any) => {
        // The partial branch must invoke the notifier with rca_partial.
        expect(input.notificationType).toBe('rca_partial');
        return { success: true, sentTo: ['hook'], failedTo: [], retryCount: 0 };
      },
    };

    const trace = await executeWorkflow(synth.definition, { event: 'cloudwatch' }, lambdas);

    expect(trace.states).toEqual([
      'InvokeAlarmRouter',
      'CheckFiltered',
      'InvokeAlarmGrouper',
      'CheckShouldWait',
      'InvokeRCAAnalyzer',
      'CheckRCAStatus',
      'InvokeFeishuNotifierPartial',
      'RecordPartial',
    ]);
    expect(trace.finalOutput.workflowResult.outcome).toBe('partial');
  });

  it('records failure when notification ultimately fails (success=false)', async () => {
    const alarm = makeAlarm();
    const lambdas: LambdaRegistry = {
      [arn.alarmRouter]: () => alarm,
      [arn.alarmGrouper]: () => ({
        groupId: 'group-4',
        alarms: [alarm],
        isNewGroup: true,
        shouldWait: false,
      }),
      [arn.rcaAnalyzer]: () => ({
        rcaReport: makeRcaReport('completed'),
        status: 'completed',
        duration: 100,
      }),
      [arn.feishuNotifier]: () => ({
        success: false,
        sentTo: [],
        failedTo: ['hook'],
        retryCount: 3,
      }),
    };

    const trace = await executeWorkflow(synth.definition, { event: 'cloudwatch' }, lambdas);

    expect(trace.states).toContain('InvokeFeishuNotifierComplete');
    expect(trace.states[trace.states.length - 1]).toBe('RecordFailure');
    expect(trace.finalOutput.workflowResult.outcome).toBe('failure');
  });

  it('passes alarm output verbatim from AlarmRouter into AlarmGrouper as { alarm }', async () => {
    const alarm = makeAlarm();
    let observedGrouperInput: any = null;
    const lambdas: LambdaRegistry = {
      [arn.alarmRouter]: () => alarm,
      [arn.alarmGrouper]: (input: any) => {
        observedGrouperInput = input;
        return { groupId: 'g', alarms: [alarm], isNewGroup: true, shouldWait: false };
      },
      [arn.rcaAnalyzer]: () => ({ rcaReport: makeRcaReport(), status: 'completed', duration: 1 }),
      [arn.feishuNotifier]: () => ({ success: true, sentTo: ['h'], failedTo: [], retryCount: 0 }),
    };

    await executeWorkflow(synth.definition, {}, lambdas);

    // The grouper must receive { alarm: <router output> } per the workflow definition.
    expect(observedGrouperInput).toEqual({ alarm });
  });

  it('passes groupId and alarms verbatim to RCAAnalyzer', async () => {
    const alarm = makeAlarm();
    let observedRcaInput: any = null;
    const lambdas: LambdaRegistry = {
      [arn.alarmRouter]: () => alarm,
      [arn.alarmGrouper]: () => ({
        groupId: 'group-rca-input',
        alarms: [alarm, alarm],
        isNewGroup: true,
        shouldWait: false,
      }),
      [arn.rcaAnalyzer]: (input: any) => {
        observedRcaInput = input;
        return { rcaReport: makeRcaReport(), status: 'completed', duration: 1 };
      },
      [arn.feishuNotifier]: () => ({ success: true, sentTo: ['h'], failedTo: [], retryCount: 0 }),
    };

    await executeWorkflow(synth.definition, {}, lambdas);

    expect(observedRcaInput).toEqual({
      groupId: 'group-rca-input',
      alarms: [alarm, alarm],
      taskToken: 'simulated-task-token', // injected by SFN waitForTaskToken
    });
  });
});
