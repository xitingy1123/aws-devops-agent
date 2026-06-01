#!/bin/bash
#
# 真实压测 1：EC2 CPU
#
# 在 EC2 实例上跑 stress-ng，让 CPUUtilization 飙到 ~95%。
# 触发已存在的 CloudWatch 告警 EC2-HighCPU-Test（threshold=80, period=60s）。
#
# 用法：
#   ./01-ec2-cpu-stress.sh                         # 默认 5 分钟
#   ./01-ec2-cpu-stress.sh 10                      # 10 分钟
#   INSTANCE_ID=i-xxx ./01-ec2-cpu-stress.sh       # 换实例
#

set -e

REGION="${AWS_REGION:-us-east-1}"
INSTANCE_ID="${INSTANCE_ID:-i-xxxxxxxxxxxxxxxxx}"
ALARM_NAME="${ALARM_NAME:-EC2-HighCPU-Test}"
DURATION_MIN="${1:-5}"
DURATION_SEC=$((DURATION_MIN * 60))

G="\033[0;32m"; Y="\033[1;33m"; R="\033[0;31m"; N="\033[0m"

echo -e "${G}▶ EC2 CPU 真实压测${N}"
echo "  Instance:  $INSTANCE_ID"
echo "  Region:    $REGION"
echo "  Duration:  $DURATION_MIN 分钟"
echo "  Alarm:     $ALARM_NAME"
echo

# 1. 检查 SSM agent 在线
ping_status=$(aws ssm describe-instance-information --region "$REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
if [ "$ping_status" != "Online" ]; then
  echo -e "${R}❌ EC2 实例 SSM 不在线（PingStatus=$ping_status）${N}"
  echo "  确认：1) Instance 的 IAM Role 包含 AmazonSSMManagedInstanceCore"
  echo "       2) Instance 已开机"
  exit 1
fi
echo -e "${G}✓ SSM agent 在线${N}"

# 2. 通过 SSM 远程跑 stress-ng
echo -e "${Y}▶ 通过 SSM 在 EC2 上启动 stress-ng（${DURATION_SEC}s）...${N}"
cmd_id=$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "EC2 CPU stress test ($(date -u +%H:%M:%SZ))" \
  --parameters "commands=[
    \"sudo dnf install -y stress-ng 2>/dev/null || sudo yum install -y stress-ng 2>/dev/null || true\",
    \"cd /tmp && nohup stress-ng --cpu 0 --cpu-load 95 --timeout ${DURATION_SEC}s > /tmp/stress.log 2>&1 &\",
    \"echo started PID \\\$!\"
  ]" \
  --query 'Command.CommandId' --output text)
echo "  Command ID: $cmd_id"

# 等待 SSM 命令真正下发到 instance
echo -e "${Y}等待 SSM 命令在实例上执行...${N}"
sleep 5
status=$(aws ssm get-command-invocation --region "$REGION" \
  --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
  --query 'Status' --output text 2>/dev/null || echo "Pending")
while [ "$status" = "Pending" ] || [ "$status" = "InProgress" ]; do
  sleep 3
  status=$(aws ssm get-command-invocation --region "$REGION" \
    --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
    --query 'Status' --output text 2>/dev/null || echo "Pending")
done

if [ "$status" != "Success" ]; then
  echo -e "${R}❌ SSM 命令失败（status=$status）${N}"
  aws ssm get-command-invocation --region "$REGION" \
    --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
    --query 'StandardErrorContent' --output text
  exit 1
fi
echo -e "${G}✓ stress-ng 已在实例上启动${N}"

# 3. 监控告警状态
echo
echo -e "${Y}▶ 监控告警状态（每 30s 检查一次，最多等待 ${DURATION_SEC}s）${N}"
elapsed=0
while [ $elapsed -lt $DURATION_SEC ]; do
  sleep 30
  elapsed=$((elapsed + 30))
  state=$(aws cloudwatch describe-alarms --region "$REGION" \
    --alarm-names "$ALARM_NAME" \
    --query 'MetricAlarms[0].StateValue' --output text)
  metric=$(aws cloudwatch get-metric-statistics --region "$REGION" \
    --namespace "AWS/EC2" --metric-name CPUUtilization \
    --dimensions "Name=InstanceId,Value=$INSTANCE_ID" \
    --start-time "$(date -u -v-2M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 60 --statistics Maximum \
    --query 'Datapoints[-1].Maximum' --output text 2>/dev/null)
  echo "  [+${elapsed}s] CPU(max 1min) = ${metric:-N/A}%, Alarm = $state"
  if [ "$state" = "ALARM" ]; then
    echo -e "${G}✅ 告警进入 ALARM 状态！${N}"
    echo "  Step Functions 应该已经被 EventBridge 触发"
    echo "  查看：aws stepfunctions list-executions \\"
    echo "         --state-machine-arn arn:aws:states:$REGION:$(aws sts get-caller-identity --query Account --output text):stateMachine:AlarmRCAWorkflow51578815-kniZlNFSlqZF \\"
    echo "         --max-results 3 --region $REGION"
    break
  fi
done

if [ "$state" != "ALARM" ]; then
  echo -e "${Y}⚠ 测试时间到，告警仍未进 ALARM。可能需要更长时间。${N}"
fi

echo
echo -e "${G}压测继续在 EC2 上运行（共 $DURATION_MIN 分钟）${N}"
echo "  停止压测：aws ssm send-command --region $REGION --instance-ids $INSTANCE_ID \\"
echo "           --document-name AWS-RunShellScript \\"
echo "           --parameters 'commands=[\"pkill stress-ng\"]'"
