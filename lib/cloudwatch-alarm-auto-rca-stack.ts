import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';
import { buildWorkflowDefinition, WorkflowLambdas } from '../src/shared/workflow-definition';

/**
 * Stack 配置参数
 */
export interface CloudwatchAlarmAutoRcaStackProps extends cdk.StackProps {
  /**
   * 飞书自定义机器人 Webhook URL（告警通知推送用）
   * 在群聊中添加自定义机器人后获取
   */
  feishuWebhookUrl?: string;

  /**
   * 飞书应用 App ID（Bot 对话用，从飞书开放平台获取）
   * 如果不提供，飞书 Bot 对话助手将不会部署
   */
  feishuAppId?: string;

  /**
   * 飞书应用 App Secret（从飞书开放平台获取）
   */
  feishuAppSecret?: string;

  /**
   * AWS DevOps Agent Space ID
   */
  agentSpaceId?: string;

  /**
   * 飞书应用 Verification Token（事件回调验证用）
   * 在飞书开放平台 → 事件与回调 → 加密策略 中获取
   */
  feishuVerificationToken?: string;

  /**
   * Secrets Manager secret name (or ARN) that holds the DevOps Agent webhook
   * credentials in JSON form: { "url": "...", "secret": "..." }.
   *
   * 默认 'cloudwatch-alarm-auto-rca/devops-agent-webhook'。
   */
  devopsAgentWebhookSecretName?: string;

  /**
   * 是否部署飞书 Bot 对话助手（ECS Fargate）
   * @default true（当 feishuAppId 和 feishuAppSecret 都提供时）
   */
  deployFeishuBot?: boolean;
}

export class CloudwatchAlarmAutoRcaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: CloudwatchAlarmAutoRcaStackProps) {
    super(scope, id, props);

    // =========================================================================
    // DynamoDB Tables (Task 12.1)
    // =========================================================================

    // WorkflowExecution table - tracks RCA workflow state
    const workflowExecutionTable = new dynamodb.Table(this, 'WorkflowExecutionTable', {
      partitionKey: { name: 'executionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // AlarmGroup table - stores alarm grouping data
    const alarmGroupTable = new dynamodb.Table(this, 'AlarmGroupTable', {
      partitionKey: { name: 'resourceArn', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'groupId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Dead letter notification table - stores unsent notifications
    const deadLetterTable = new dynamodb.Table(this, 'DeadLetterNotificationTable', {
      partitionKey: { name: 'notificationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Chat investigation mapping table — links a DevOps Agent INVESTIGATION
    // task back to the originating Feishu chat so we can push the result
    // when the EventBridge "Investigation Completed" event arrives.
    //
    // Used for the chat-initiated path (user @bot asks the agent to
    // investigate, agent autonomously calls CreateBacklogTask). The task is
    // not part of the SFN-driven RCA flow, so without this mapping the result
    // would silently complete and never reach the user.
    const chatInvestigationMappingTable = new dynamodb.Table(
      this,
      'ChatInvestigationMappingTable',
      {
        partitionKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: 'ttl',
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // Feishu event dedup table — distributed dedup for incoming Feishu events.
    //
    // Why DDB and not in-memory: Feishu retries the callback if it doesn't
    // get a 200 within 3s. On a Lambda cold start the first request is still
    // running when the retry arrives — the retry is routed to a *different*
    // Lambda instance, whose in-memory dedup Set knows nothing about the
    // first instance's processed events. Both instances dispatch async jobs
    // → user sees double messages, and DevOps Agent rejects the duplicate
    // EVALUATION task with "already in progress".
    //
    // PutItem with ConditionExpression='attribute_not_exists(eventId)' gives
    // us a true atomic single-claim primitive. TTL 10 minutes — Feishu retry
    // window is 1h but no real event should ever recur > 10min apart.
    const feishuEventDedupTable = new dynamodb.Table(
      this,
      'FeishuEventDedupTable',
      {
        partitionKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: 'ttl',
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // =========================================================================
    // SSM Parameter Store (Task 12.5)
    // =========================================================================

    const configParameter = new ssm.StringParameter(this, 'SystemConfig', {
      parameterName: '/cloudwatch-alarm-auto-rca/config',
      description: 'CloudWatch Alarm Auto RCA system configuration',
      stringValue: JSON.stringify({
        version: '1.0.0',
        alarmSelectionMode: 'all',
        selectedAlarmNames: [],
        alarmFilters: [],
        feishuWebhooks: props?.feishuWebhookUrl
          ? [{ url: props.feishuWebhookUrl, name: '默认告警群', routingRules: [] }]
          : [],
        rcaTimeout: 600,
        retryPolicy: {
          maxRetries: 1,
          initialDelay: 5,
          backoffMultiplier: 2,
        },
        groupingWindow: 120,
        enabledNamespaces: ['AWS/EC2', 'AWS/RDS', 'AWS/Lambda', 'AWS/ECS'],
        retentionDays: 90,
      }),
    });

    // =========================================================================
    // Lambda Functions (Task 12.2)
    // =========================================================================

    // Shared Lambda environment variables
    const sharedEnv: Record<string, string> = {
      WORKFLOW_EXECUTION_TABLE_NAME: workflowExecutionTable.tableName,
      ALARM_GROUP_TABLE_NAME: alarmGroupTable.tableName,
      DEAD_LETTER_TABLE_NAME: deadLetterTable.tableName,
      CHAT_INVESTIGATION_MAPPING_TABLE_NAME: chatInvestigationMappingTable.tableName,
      SSM_CONFIG_PATH: '/cloudwatch-alarm-auto-rca/config',
    };

    // AlarmRouter Lambda
    const alarmRouterFn = new nodejs.NodejsFunction(this, 'AlarmRouterFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'src', 'lambdas', 'alarm-router', 'index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: sharedEnv,
      bundling: { minify: true, sourceMap: false, target: 'node20', externalModules: [] },
      description: 'Parses CloudWatch alarm events, applies selection mode and filter rules',
    });

    // AlarmGrouper Lambda
    const alarmGrouperFn = new nodejs.NodejsFunction(this, 'AlarmGrouperFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'src', 'lambdas', 'alarm-grouper', 'index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: sharedEnv,
      bundling: { minify: true, sourceMap: false, target: 'node20', externalModules: [] },
      description: 'Groups alarms by resource and time window',
    });

    // RCAAnalyzer Lambda
    const rcaAnalyzerFn = new nodejs.NodejsFunction(this, 'RCAAnalyzerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'src', 'lambdas', 'rca-analyzer', 'index.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      environment: {
        ...sharedEnv,
        AGENT_SPACE_ID: props?.agentSpaceId ?? '',
        DEVOPS_AGENT_WEBHOOK_SECRET_ID:
          props?.devopsAgentWebhookSecretName ?? 'cloudwatch-alarm-auto-rca/devops-agent-webhook',
      },
      bundling: { minify: true, sourceMap: false, target: 'node20', externalModules: [] },
      description: 'Triggers AWS DevOps Agent investigation via webhook (waitForTaskToken)',
    });

    // FeishuNotifier Lambda
    const feishuNotifierFn = new nodejs.NodejsFunction(this, 'FeishuNotifierFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'src', 'lambdas', 'feishu-notifier', 'index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      environment: {
        ...sharedEnv,
        AGENT_SPACE_ID: props?.agentSpaceId ?? '',
      },
      bundling: { minify: true, sourceMap: false, target: 'node20', externalModules: [] },
      description: 'Formats RCA reports and sends Feishu notifications',
    });

    // InvestigationEventHandler Lambda — 接 EventBridge `aws.aidevops` 事件,
    // 反查 pending taskToken,SendTaskSuccess 唤醒 SFN。
    const investigationEventHandlerFn = new nodejs.NodejsFunction(
      this,
      'InvestigationEventHandlerFunction',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(
          __dirname,
          '..',
          'src',
          'lambdas',
          'investigation-event-handler',
          'index.ts'
        ),
        handler: 'handler',
        memorySize: 512,
        // Bumped from 60s to 120s: chat-initiated investigation fallback does
        // an exponential backoff (up to ~60s) waiting for the bot's mapping
        // write to land in DDB.
        timeout: cdk.Duration.seconds(120),
        environment: {
          ...sharedEnv,
          AGENT_SPACE_ID: props?.agentSpaceId ?? '',
          // Phase-2 mitigation card is dispatched by directly async-invoking
          // FeishuNotifier (SFN already finished after phase 1). Pass the
          // function name through so the handler can target it.
          FEISHU_NOTIFIER_FN_NAME: feishuNotifierFn.functionName,
        },
        bundling: { minify: true, sourceMap: false, target: 'node20', externalModules: [] },
        description:
          'Handles aws.aidevops Investigation* and Mitigation* events: wakes up SFN, triggers mitigation generation, dispatches phase-2 card',
      }
    );

    // =========================================================================
    // IAM Permissions
    // =========================================================================

    // SSM read access for all Lambdas
    configParameter.grantRead(alarmRouterFn);
    configParameter.grantRead(alarmGrouperFn);
    configParameter.grantRead(rcaAnalyzerFn);
    configParameter.grantRead(feishuNotifierFn);
    configParameter.grantRead(investigationEventHandlerFn);

    // DynamoDB permissions
    alarmGroupTable.grantReadWriteData(alarmGrouperFn);
    workflowExecutionTable.grantReadWriteData(alarmRouterFn);
    workflowExecutionTable.grantReadWriteData(rcaAnalyzerFn); // 写 pending 记录
    workflowExecutionTable.grantReadWriteData(investigationEventHandlerFn); // Scan + Update
    deadLetterTable.grantWriteData(feishuNotifierFn);
    // Chat → Investigation 映射表：feishu-bot 写入；investigation-event-handler 读取
    chatInvestigationMappingTable.grantReadData(investigationEventHandlerFn);

    // CloudWatch metrics permission for all Lambdas
    const metricsPolicy = new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': 'CloudWatchAlarmAutoRCA',
        },
      },
    });
    alarmRouterFn.addToRolePolicy(metricsPolicy);
    alarmGrouperFn.addToRolePolicy(metricsPolicy);
    rcaAnalyzerFn.addToRolePolicy(metricsPolicy);
    feishuNotifierFn.addToRolePolicy(metricsPolicy);
    investigationEventHandlerFn.addToRolePolicy(metricsPolicy);

    // Resource Groups Tagging API — FeishuNotifier reads a resource's tags to
    // route the alarm to the correct Feishu group (tag-based routing, e.g.
    // project=abc). tag:GetResources does not support resource-level scoping.
    feishuNotifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['tag:GetResources'],
        resources: ['*'],
      })
    );

    // DevOps Agent webhook secret — RCAAnalyzer 读取（HMAC 签名用）
    const webhookSecretName =
      props?.devopsAgentWebhookSecretName ?? 'cloudwatch-alarm-auto-rca/devops-agent-webhook';
    const webhookSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'DevOpsAgentWebhookSecret',
      webhookSecretName
    );
    webhookSecret.grantRead(rcaAnalyzerFn);

    // DevOps Agent journal + backlog API access for InvestigationEventHandler.
    //   - ListJournalRecords: pull markdown summary content from the journal
    //   - GetBacklogTask / UpdateBacklogTask: read task version & advance the
    //     task into the mitigation phase (mirrors the console "Generate
    //     mitigation plan" button — see CloudTrail of UpdateBacklogTask with
    //     taskStatus=PENDING_START + currentVersion).
    investigationEventHandlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'aidevops:ListJournalRecords',
          'aidevops:GetBacklogTask',
          'aidevops:UpdateBacklogTask',
          'aidevops:ListExecutions',
          'aidevops:GetAgentSpace',
        ],
        resources: ['*'],
      })
    );

    // Async-invoke FeishuNotifier directly for the phase-2 mitigation card
    // (SFN already finished after phase 1, so we bypass it).
    feishuNotifierFn.grantInvoke(investigationEventHandlerFn);

    // Step Functions SendTaskSuccess/Failure — both rca-analyzer (failure path)
    // and investigation-event-handler (success/failure path) need it.
    const sfnCallbackPolicy = new iam.PolicyStatement({
      actions: ['states:SendTaskSuccess', 'states:SendTaskFailure', 'states:SendTaskHeartbeat'],
      resources: ['*'], // task tokens are issued at runtime; ARN scoping is impractical
    });
    rcaAnalyzerFn.addToRolePolicy(sfnCallbackPolicy);
    investigationEventHandlerFn.addToRolePolicy(sfnCallbackPolicy);

    // =========================================================================
    // Step Functions Workflow (Task 12.4)
    // =========================================================================

    const workflowLambdas: WorkflowLambdas = {
      alarmRouter: alarmRouterFn,
      alarmGrouper: alarmGrouperFn,
      rcaAnalyzer: rcaAnalyzerFn,
      feishuNotifier: feishuNotifierFn,
    };

    const stateMachine = buildWorkflowDefinition(this, workflowLambdas);

    // Grant Step Functions permissions to invoke Lambdas
    alarmRouterFn.grantInvoke(stateMachine);
    alarmGrouperFn.grantInvoke(stateMachine);
    rcaAnalyzerFn.grantInvoke(stateMachine);
    feishuNotifierFn.grantInvoke(stateMachine);

    // Grant Step Functions permission to write to DynamoDB
    workflowExecutionTable.grantReadWriteData(stateMachine);

    // =========================================================================
    // EventBridge Rule (Task 12.3)
    // =========================================================================

    // Rule to capture CloudWatch Alarm State Change events (ALARM state only)
    const alarmRule = new events.Rule(this, 'CloudWatchAlarmRule', {
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        detail: {
          state: {
            value: ['ALARM'],
          },
        },
      },
      description: 'Captures CloudWatch alarm state changes to ALARM state and triggers RCA workflow',
    });

    // Target: Step Functions state machine
    alarmRule.addTarget(new targets.SfnStateMachine(stateMachine));

    // Rule to capture aws.aidevops investigation + mitigation lifecycle events.
    // Both go to the same handler — it dispatches by detail-type prefix.
    const investigationRule = new events.Rule(this, 'DevOpsAgentInvestigationRule', {
      eventPattern: {
        source: ['aws.aidevops'],
        detailType: [
          'Investigation Completed',
          'Investigation Failed',
          'Investigation Timed Out',
          'Investigation Cancelled',
          'Investigation Skipped',
          'Mitigation Completed',
          'Mitigation Failed',
          'Mitigation Timed Out',
          'Mitigation Cancelled',
        ],
      },
      description:
        'Captures terminal DevOps Agent investigation/mitigation events. Phase 1 wakes up SFN waitForTaskToken; phase 2 dispatches a follow-up Feishu card.',
    });
    investigationRule.addTarget(new targets.LambdaFunction(investigationEventHandlerFn));

    // =========================================================================
    // CloudWatch Alarms & Dashboard (Task 12.6)
    // =========================================================================

    const metricNamespace = 'CloudWatchAlarmAutoRCA';

    // Alarm: Workflow failure rate
    new cloudwatch.Alarm(this, 'WorkflowFailureAlarm', {
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'RCAAnalysesFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'RCA analysis failures exceed threshold',
    });

    // Alarm: Notification failure rate
    new cloudwatch.Alarm(this, 'NotificationFailureAlarm', {
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'NotificationsFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'Feishu notification failures exceed threshold',
    });

    // =========================================================================
    // Feishu Bot 对话助手 (Lambda + API Gateway)
    // =========================================================================

    const shouldDeployBot = props?.deployFeishuBot !== false
      && !!props?.feishuAppId
      && !!props?.feishuAppSecret
      && !!props?.agentSpaceId;

    if (shouldDeployBot) {
      // Feishu Bot Lambda - uses NodejsFunction for automatic TypeScript bundling with esbuild
      const feishuBotFn = new nodejs.NodejsFunction(this, 'FeishuBotFunction', {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(__dirname, '..', 'src', 'lambdas', 'feishu-bot', 'index.ts'),
        handler: 'handler',
        memorySize: 512,
        // 600s 是 Lambda 上限。手动 INVESTIGATION 任务在后台 Lambda 里轮询
        // 最多 9 分钟，留 1 分钟兜底。
        timeout: cdk.Duration.seconds(600),
        environment: {
          FEISHU_APP_ID: props!.feishuAppId!,
          FEISHU_APP_SECRET: props!.feishuAppSecret!,
          FEISHU_VERIFICATION_TOKEN: props!.feishuVerificationToken ?? '',
          AGENT_SPACE_ID: props!.agentSpaceId!,
          // 用于 chat-initiated investigation 的 chatId↔taskId 映射表
          CHAT_INVESTIGATION_MAPPING_TABLE_NAME:
            chatInvestigationMappingTable.tableName,
          // 用于飞书 event 去重（防止冷启动时重试派发双份 job）
          FEISHU_EVENT_DEDUP_TABLE_NAME: feishuEventDedupTable.tableName,
        },
        bundling: {
          minify: true,
          sourceMap: false,
          target: 'node20',
          externalModules: [],
        },
        description: 'Feishu Bot - receives messages via HTTP callback, calls DevOps Agent',
      });

      // 把 chat→investigation 映射表读写权限给 bot
      chatInvestigationMappingTable.grantReadWriteData(feishuBotFn);
      // 飞书 event 去重表也给 bot 读写
      feishuEventDedupTable.grantReadWriteData(feishuBotFn);

      // 让 investigation-event-handler 在找不到 SFN pending 记录时，能反向调
      // bot 把结果推回原 chat。Lambda 函数名通过环境变量传递。
      investigationEventHandlerFn.addEnvironment(
        'FEISHU_BOT_FN_NAME',
        feishuBotFn.functionName
      );
      feishuBotFn.grantInvoke(investigationEventHandlerFn);

      // Grant DevOps Agent permissions
      feishuBotFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'aidevops:CreateChat',
            'aidevops:SendMessage',
            'aidevops:GetAgentSpace',
            'aidevops:ListAgentSpaces',
            'aidevops:ListChats',
            'aidevops:ListRecommendations',
            'aidevops:GetRecommendation',
            'aidevops:CreateBacklogTask',
            'aidevops:GetBacklogTask',
            'aidevops:ListBacklogTasks',
            'aidevops:ListGoals',
            // 手动 INVESTIGATION：完成后从 journal 拉调查总结
            'aidevops:ListExecutions',
            'aidevops:ListJournalRecords',
            'aidevops:GetExecution',
          ],
          resources: ['*'],
        })
      );

      // Grant Lambda permission to invoke itself (for async background tasks)
      // Use the function's own ARN via Cfn token to avoid circular dependency
      feishuBotFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [
            `arn:aws:lambda:${this.region}:${this.account}:function:*FeishuBot*`,
          ],
        })
      );

      // API Gateway
      const api = new apigateway.RestApi(this, 'FeishuBotApi', {
        restApiName: 'FeishuBotWebhook',
        description: 'Receives Feishu event callbacks for DevOps Agent Bot',
      });

      const feishuBotIntegration = new apigateway.LambdaIntegration(feishuBotFn);
      api.root.addResource('webhook').addMethod('POST', feishuBotIntegration);

      new cdk.CfnOutput(this, 'FeishuBotWebhookUrl', {
        value: `${api.url}webhook`,
        description: 'Feishu Bot Webhook URL - paste this into Feishu Open Platform event callback URL',
      });
    }

    // =========================================================================
    // Outputs
    // =========================================================================

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'Step Functions State Machine ARN',
    });

    new cdk.CfnOutput(this, 'WorkflowExecutionTableName', {
      value: workflowExecutionTable.tableName,
      description: 'DynamoDB Workflow Execution Table',
    });

    new cdk.CfnOutput(this, 'AlarmGroupTableName', {
      value: alarmGroupTable.tableName,
      description: 'DynamoDB Alarm Group Table',
    });
  }
}
