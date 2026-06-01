#!/bin/bash
#
# 真实压测 2：Lambda Errors
#
# 部署一个会抛异常的 Lambda 函数 + 配套 CloudWatch 告警，
# 然后并发调用它产生真实 Errors 指标，触发告警。
#
# 用法：
#   ./02-lambda-errors-stress.sh setup     # 创建测试 Lambda + 告警
#   ./02-lambda-errors-stress.sh stress    # 触发错误
#   ./02-lambda-errors-stress.sh cleanup   # 删除测试资源
#

set -e

REGION="${AWS_REGION:-us-east-1}"
FUNCTION_NAME="test-filter-lambda-errors"
ALARM_NAME="Test-Filter-Lambda-Errors-Stress"
ROLE_NAME="test-filter-lambda-errors-role"
INVOCATIONS="${INVOCATIONS:-3}"

G="\033[0;32m"; Y="\033[1;33m"; R="\033[0;31m"; N="\033[0m"

setup() {
  echo -e "${G}▶ 创建测试 Lambda + 告警${N}"
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

  # 1. 建 IAM Role
  if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    echo -e "${Y}创建 IAM Role...${N}"
    aws iam create-role --role-name "$ROLE_NAME" \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Effect": "Allow",
          "Principal": {"Service": "lambda.amazonaws.com"},
          "Action": "sts:AssumeRole"
        }]
      }' >/dev/null
    aws iam attach-role-policy --role-name "$ROLE_NAME" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    echo -e "${Y}等待 Role 生效（10s）...${N}"
    sleep 10
  fi

  # 2. 创建会抛错的 Lambda
  if ! aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
    echo -e "${Y}创建 Lambda 函数...${N}"
    tmp=$(mktemp -d)
    cat > "$tmp/index.js" <<'EOF'
exports.handler = async () => {
  throw new Error('intentional test error for filter testing');
};
EOF
    (cd "$tmp" && zip -q function.zip index.js)
    aws lambda create-function --region "$REGION" \
      --function-name "$FUNCTION_NAME" \
      --runtime nodejs20.x \
      --role "arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}" \
      --handler index.handler \
      --zip-file "fileb://$tmp/function.zip" \
      --timeout 5 >/dev/null
    rm -rf "$tmp"
  fi

  # 3. 创建告警
  echo -e "${Y}创建 CloudWatch 告警...${N}"
  aws cloudwatch put-metric-alarm --region "$REGION" \
    --alarm-name "$ALARM_NAME" \
    --alarm-description "Lambda errors stress test (real metrics)" \
    --metric-name "Errors" --namespace "AWS/Lambda" \
    --statistic "Sum" --period 60 --evaluation-periods 1 \
    --threshold 1 --comparison-operator "GreaterThanOrEqualToThreshold" \
    --dimensions "Name=FunctionName,Value=$FUNCTION_NAME" \
    --treat-missing-data "notBreaching"

  echo -e "${G}✅ 资源已就绪${N}"
  echo "  Lambda: $FUNCTION_NAME"
  echo "  Alarm:  $ALARM_NAME (Errors >= 1 in 1min)"
  echo
  echo "下一步：./02-lambda-errors-stress.sh stress"
}

stress() {
  echo -e "${G}▶ Lambda Errors 真实压测${N}"
  echo "  调用 $FUNCTION_NAME 共 $INVOCATIONS 次（每次都抛错）"
  echo

  # 顺序调用 Lambda（次数少，不需要并发）
  for i in $(seq 1 "$INVOCATIONS"); do
    aws lambda invoke --region "$REGION" \
      --function-name "$FUNCTION_NAME" \
      --invocation-type "Event" \
      --payload '{}' /dev/null >/dev/null 2>&1
    echo "  发起第 $i 次调用"
  done
  echo -e "${G}✓ 全部 $INVOCATIONS 次调用已发起${N}"

  # 监控告警状态
  echo
  echo -e "${Y}▶ 等待告警进入 ALARM（每 30s 检查，最多 5 分钟）${N}"
  elapsed=0
  while [ $elapsed -lt 300 ]; do
    sleep 30
    elapsed=$((elapsed + 30))
    state=$(aws cloudwatch describe-alarms --region "$REGION" \
      --alarm-names "$ALARM_NAME" \
      --query 'MetricAlarms[0].StateValue' --output text)
    errors=$(aws cloudwatch get-metric-statistics --region "$REGION" \
      --namespace "AWS/Lambda" --metric-name Errors \
      --dimensions "Name=FunctionName,Value=$FUNCTION_NAME" \
      --start-time "$(date -u -v-3M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '3 minutes ago' +%Y-%m-%dT%H:%M:%S)" \
      --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
      --period 60 --statistics Sum \
      --query 'Datapoints[-1].Sum' --output text 2>/dev/null)
    echo "  [+${elapsed}s] Errors(1min) = ${errors:-N/A}, Alarm = $state"
    if [ "$state" = "ALARM" ]; then
      echo -e "${G}✅ 告警进入 ALARM 状态！${N}"
      echo "  Step Functions 应该已经被 EventBridge 触发"
      break
    fi
  done

  if [ "$state" != "ALARM" ]; then
    echo -e "${Y}⚠ 5 分钟内告警未进 ALARM。${N}"
    echo "  可能原因：调用太快指标聚合还未到，再等等或重新跑 stress 命令。"
  fi
}

cleanup() {
  echo -e "${Y}▶ 清理测试资源${N}"
  aws cloudwatch delete-alarms --region "$REGION" --alarm-names "$ALARM_NAME" 2>/dev/null || true
  echo "  ✓ 删除告警 $ALARM_NAME"
  aws lambda delete-function --region "$REGION" --function-name "$FUNCTION_NAME" 2>/dev/null || true
  echo "  ✓ 删除 Lambda $FUNCTION_NAME"
  aws iam detach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true
  aws iam delete-role --role-name "$ROLE_NAME" 2>/dev/null || true
  echo "  ✓ 删除 IAM Role $ROLE_NAME"
  echo -e "${G}✅ 清理完成${N}"
}

case "${1:-}" in
  setup)   setup ;;
  stress)  stress ;;
  cleanup) cleanup ;;
  *)
    echo "用法："
    echo "  $0 setup     # 创建测试 Lambda + 告警"
    echo "  $0 stress    # 真实压测：调用 Lambda 让它疯狂抛错"
    echo "  $0 cleanup   # 删除所有测试资源"
    ;;
esac
