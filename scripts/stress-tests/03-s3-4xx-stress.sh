#!/bin/bash
#
# 真实压测 3：S3 4xx Errors
#
# 创建一个测试 S3 bucket（开启请求度量）+ 配套告警，
# 反复 GET 不存在的 key 产生真实 4xxErrors 指标，触发告警。
#
# 用法：
#   ./03-s3-4xx-stress.sh setup     # 创建 bucket + 启用 request metrics + 创建告警
#   ./03-s3-4xx-stress.sh stress    # 反复访问不存在的 key
#   ./03-s3-4xx-stress.sh cleanup   # 删除测试资源
#

set -e

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET_NAME="test-filter-s3-4xx-${ACCOUNT}"
ALARM_NAME="Test-Filter-S3-4xx-Stress"
METRIC_FILTER_ID="EntireBucket"
REQUESTS="${REQUESTS:-3}"

G="\033[0;32m"; Y="\033[1;33m"; R="\033[0;31m"; N="\033[0m"

setup() {
  echo -e "${G}▶ 创建 S3 测试资源${N}"

  # 1. 创建 bucket
  if ! aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
    echo -e "${Y}创建 bucket：$BUCKET_NAME${N}"
    if [ "$REGION" = "us-east-1" ]; then
      aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" >/dev/null
    else
      aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" \
        --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    fi
  fi

  # 2. 开启请求度量（这是产生 4xxErrors 指标的前提）
  echo -e "${Y}启用 S3 Request Metrics（覆盖整个 bucket）${N}"
  aws s3api put-bucket-metrics-configuration --region "$REGION" \
    --bucket "$BUCKET_NAME" --id "$METRIC_FILTER_ID" \
    --metrics-configuration "Id=$METRIC_FILTER_ID"

  # 3. 创建告警
  echo -e "${Y}创建 CloudWatch 告警${N}"
  aws cloudwatch put-metric-alarm --region "$REGION" \
    --alarm-name "$ALARM_NAME" \
    --alarm-description "S3 4xx errors stress test (real metrics)" \
    --metric-name "4xxErrors" --namespace "AWS/S3" \
    --statistic "Sum" --period 60 --evaluation-periods 1 \
    --threshold 1 --comparison-operator "GreaterThanOrEqualToThreshold" \
    --dimensions "Name=BucketName,Value=$BUCKET_NAME" \
                 "Name=FilterId,Value=$METRIC_FILTER_ID" \
    --treat-missing-data "notBreaching"

  echo -e "${G}✅ 资源已就绪${N}"
  echo "  Bucket: $BUCKET_NAME"
  echo "  Alarm:  $ALARM_NAME (4xxErrors >= 1 in 1min)"
  echo
  echo -e "${Y}⚠ 重要：S3 Request Metrics 启用后通常需要 ~15 分钟开始上报指标${N}"
  echo "  立刻 stress 也能产生真实 4xx，但告警可能晚一些进 ALARM"
  echo
  echo "下一步：./03-s3-4xx-stress.sh stress"
}

stress() {
  echo -e "${G}▶ S3 4xx 真实压测${N}"
  echo "  对 $BUCKET_NAME 发起 $REQUESTS 次 GET 不存在的 key（产生 NoSuchKey 4xx）"
  echo

  # 顺序 GET 不存在的 keys（次数少，不需要并发）
  for i in $(seq 1 "$REQUESTS"); do
    aws s3api get-object --region "$REGION" \
      --bucket "$BUCKET_NAME" --key "nonexistent-key-$i-$RANDOM" \
      /dev/null >/dev/null 2>&1 || true
    echo "  发起第 $i 次请求"
  done
  echo -e "${G}✓ 全部 $REQUESTS 次请求已发起（每次都返回 4xx）${N}"

  # 监控告警状态
  echo
  echo -e "${Y}▶ 等待告警进入 ALARM（每 60s 检查，最多 20 分钟）${N}"
  echo "  注意：S3 Request Metrics 上报有 ~15 分钟延迟"
  elapsed=0
  while [ $elapsed -lt 1200 ]; do
    sleep 60
    elapsed=$((elapsed + 60))
    state=$(aws cloudwatch describe-alarms --region "$REGION" \
      --alarm-names "$ALARM_NAME" \
      --query 'MetricAlarms[0].StateValue' --output text)
    errors=$(aws cloudwatch get-metric-statistics --region "$REGION" \
      --namespace "AWS/S3" --metric-name 4xxErrors \
      --dimensions "Name=BucketName,Value=$BUCKET_NAME" \
                   "Name=FilterId,Value=$METRIC_FILTER_ID" \
      --start-time "$(date -u -v-20M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%S)" \
      --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
      --period 60 --statistics Sum \
      --query 'Datapoints[-1].Sum' --output text 2>/dev/null)
    echo "  [+${elapsed}s] 4xxErrors(1min) = ${errors:-N/A}, Alarm = $state"
    if [ "$state" = "ALARM" ]; then
      echo -e "${G}✅ 告警进入 ALARM 状态！${N}"
      echo "  Step Functions 应该已经被 EventBridge 触发"
      break
    fi
  done

  if [ "$state" != "ALARM" ]; then
    echo -e "${Y}⚠ 20 分钟内告警未进 ALARM。${N}"
    echo "  最可能：S3 Request Metrics 还没开始上报。再等几分钟重新跑 stress。"
  fi
}

cleanup() {
  echo -e "${Y}▶ 清理测试资源${N}"
  aws cloudwatch delete-alarms --region "$REGION" --alarm-names "$ALARM_NAME" 2>/dev/null || true
  echo "  ✓ 删除告警 $ALARM_NAME"
  aws s3api delete-bucket-metrics-configuration --region "$REGION" \
    --bucket "$BUCKET_NAME" --id "$METRIC_FILTER_ID" 2>/dev/null || true
  echo "  ✓ 删除 Request Metrics"
  aws s3 rm "s3://$BUCKET_NAME" --recursive 2>/dev/null || true
  aws s3api delete-bucket --bucket "$BUCKET_NAME" 2>/dev/null || true
  echo "  ✓ 删除 Bucket $BUCKET_NAME"
  echo -e "${G}✅ 清理完成${N}"
}

case "${1:-}" in
  setup)   setup ;;
  stress)  stress ;;
  cleanup) cleanup ;;
  *)
    echo "用法："
    echo "  $0 setup     # 创建测试 bucket + Request Metrics + 告警"
    echo "  $0 stress    # 真实压测：反复访问不存在的 key 产生 4xx"
    echo "  $0 cleanup   # 删除所有测试资源"
    ;;
esac
