
# 真实压测脚本（多服务）

不用 mock，不用 `set-alarm-state`，不用 `put-metric-data`。
**完全是真实负载产生真实指标，让告警自然进入 ALARM 状态。**

## 三个服务

| 脚本 | 服务 | 压测方式 | 触发的 namespace 指标 |
|---|---|---|---|
| `01-ec2-cpu-stress.sh` | EC2 | 通过 SSM 在 EC2 上跑 stress-ng 压满 CPU | `AWS/EC2` `CPUUtilization` |
| `02-lambda-errors-stress.sh` | Lambda | 部署一个会抛错的 Lambda，调用 3 次 | `AWS/Lambda` `Errors` |
| `03-s3-4xx-stress.sh` | S3 | 反复 GET 不存在的 key 产生真实 NoSuchKey 4xx（3 次） | `AWS/S3` `4xxErrors` |

每个脚本都会：

1. **真实压测**资源
2. CloudWatch 在 60 秒后聚合到这条指标
3. 指标超阈值 → 告警**真实进入 ALARM**
4. EventBridge 真实抓到 state change 事件
5. Step Functions **真实启动一次 execution**（如果 filter 不拦截就走完整 RCA）
6. 飞书群**真实收到 RCA 卡片**

## 配合 filter 测试

跑这些压测脚本之前，可以先去 SSM 改 `/cloudwatch-alarm-auto-rca/config`：

- 想测 namespace exclude `AWS/Lambda`：先改配置，再跑 `02-lambda-errors-stress.sh stress`
- 想测告警通过：保持默认配置，跑任意一个

观察方式：

```bash
# 看 Step Functions 是被拦截还是走完整 RCA
aws stepfunctions list-executions \
  --state-machine-arn $(aws stepfunctions list-state-machines \
    --query "stateMachines[?contains(name, 'AlarmRCAWorkflow')].stateMachineArn | [0]" --output text) \
  --max-results 3 --region us-east-1
```

## 用法

### 01 EC2 CPU
```bash
chmod +x 01-ec2-cpu-stress.sh
INSTANCE_ID=i-xxxxxxxxxxxxxxxxx ./01-ec2-cpu-stress.sh           # 默认 5 分钟
INSTANCE_ID=i-xxxxxxxxxxxxxxxxx ./01-ec2-cpu-stress.sh 10        # 10 分钟
```
- 前提：账号下需要有一个名为 `EC2-HighCPU-Test` 的 CloudWatch 告警，绑定到 `INSTANCE_ID` 指定的 EC2 实例
- 通过 SSM 远程跑 stress-ng，不用本地 SSH

### 02 Lambda Errors
```bash
chmod +x 02-lambda-errors-stress.sh
./02-lambda-errors-stress.sh setup     # 第一次：创建测试 Lambda + 告警
./02-lambda-errors-stress.sh stress    # 触发：发 3 次调用全抛错
./02-lambda-errors-stress.sh cleanup   # 测完：删除资源
```
- 自动建：IAM Role、Lambda function、CloudWatch Alarm（threshold=1）
- 完整链路 ~2 分钟（Lambda 调用秒级，1 分钟告警 period 后进 ALARM）

### 03 S3 4xx
```bash
chmod +x 03-s3-4xx-stress.sh
./03-s3-4xx-stress.sh setup     # 第一次：创建 bucket + 启用 Request Metrics + 告警
# 等 ~15 分钟让 Request Metrics 开始上报
./03-s3-4xx-stress.sh stress    # 触发：发 3 次 GET 不存在的 key
./03-s3-4xx-stress.sh cleanup   # 测完：删除资源
```
- ⚠ 注意：S3 Request Metrics 启用后**有 ~15 分钟上报延迟**，第一次跑 stress 可能要等
- 告警 threshold=1，只要 1 个 4xx 就触发

## 全跑一遍验证三种 filter

```bash
# 场景 A：filter 只放行 AWS/EC2 → EC2 告警走完整 RCA，Lambda/S3 被拦截
./01-ec2-cpu-stress.sh 3 &      # 后台跑
./02-lambda-errors-stress.sh stress
./03-s3-4xx-stress.sh stress
# 看 Step Functions：3 个 execution，2 个走 RecordFiltered，1 个走 RecordSuccess

# 场景 B：filter 排除 AWS/Lambda → EC2/S3 通过，Lambda 拦截
# 改 SSM 配置，重复上面步骤
```

## 安全清理

每个脚本都有 `cleanup` 子命令，能把资源全删干净：

```bash
./02-lambda-errors-stress.sh cleanup
./03-s3-4xx-stress.sh cleanup
```

EC2 的压测会在指定时长后自动停止（stress-ng 自带 `--timeout`），不留持续负载。
