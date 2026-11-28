# The two workers (OCT-321), each with only the signing key it needs (docs/kms-signer.md).
#
# - worker:     every job but organization setup: chain submission and reconciliation, the indexer,
#               webhooks, budget warnings, the sweeps. Signs with the issuer key only.
# - org-worker: organization setup, budget top-ups and earn-rate changes (WORKER_JOBS=org-setup),
#               the only jobs that sign with the program-admin key. It reads the issuer key's public
#               key, never signs with it: setup sends the new program's IssuerCap to that address.
#
# The task role is each one's AWS credential: no access keys anywhere. Neither listens on a port, so
# neither sits behind the load balancer.

# The keys exist already (imported, docs/kms-signer.md), outside Terraform: looked up, never managed.
data "aws_kms_alias" "issuer" {
  name = "alias/octap-testnet-issuer"
}

data "aws_kms_alias" "program_admin" {
  name = "alias/octap-testnet-program-admin"
}

locals {
  workers = {
    worker = {
      environment = [
        { name = "WORKER_JOBS", value = "all" },
        { name = "ORG_PROVISION_WORKER_ENABLED", value = "false" },
      ]
      sign       = [data.aws_kms_alias.issuer.target_key_arn]
      public_key = [data.aws_kms_alias.issuer.target_key_arn]
    }
    org-worker = {
      environment = [
        { name = "WORKER_JOBS", value = "org-setup" },
        { name = "ORG_PROVISION_WORKER_ENABLED", value = "true" },
        { name = "SUI_PROGRAM_ADMIN_KMS_KEY_ID", value = data.aws_kms_alias.program_admin.target_key_arn },
      ]
      sign = [data.aws_kms_alias.program_admin.target_key_arn]
      public_key = [
        data.aws_kms_alias.program_admin.target_key_arn,
        data.aws_kms_alias.issuer.target_key_arn,
      ]
    }
  }
}

resource "aws_iam_role" "worker" {
  for_each           = local.workers
  name               = "${var.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "worker_kms" {
  for_each = local.workers

  statement {
    sid       = "Sign"
    actions   = ["kms:Sign"]
    resources = each.value.sign
  }

  statement {
    sid       = "PublicKey"
    actions   = ["kms:GetPublicKey", "kms:DescribeKey"]
    resources = each.value.public_key
  }
}

resource "aws_iam_role_policy" "worker_kms" {
  for_each = local.workers
  name     = "kms-signing"
  role     = aws_iam_role.worker[each.key].id
  policy   = data.aws_iam_policy_document.worker_kms[each.key].json
}

resource "aws_ecs_task_definition" "worker" {
  for_each                 = local.workers
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.worker[each.key].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = each.key
    image     = "${aws_ecr_repository.core.repository_url}:${var.image_tag}"
    essential = true
    command   = ["node", "api/dist/worker.js"]
    environment = concat([
      { name = "SUI_NETWORK", value = "testnet" },
      { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" },
      # The key ARN carries its region; AWS_REGION is for the SDK's other calls.
      { name = "AWS_REGION", value = var.region },
      { name = "SUI_ISSUER_KMS_KEY_ID", value = data.aws_kms_alias.issuer.target_key_arn },
    ], each.value.environment)
    secrets = [{
      name      = "DATABASE_URL"
      valueFrom = aws_secretsmanager_secret.core["DATABASE_URL"].arn
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.process[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_ecs_service" "worker" {
  for_each        = local.workers
  name            = each.key
  cluster         = aws_ecs_cluster.core.id
  task_definition = aws_ecs_task_definition.worker[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Public subnets with a public address and no NAT, as the api service: the task pulls its image
  # and reaches Sui and KMS directly. The tasks group accepts nothing a worker listens on.
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  # A deploy stops the old task before starting the new one, so two copies of a job never overlap.
  # A worker has no traffic to drain; a minute without one only delays queued work.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  # A version whose task keeps exiting (a bad setting fails at boot) is rolled back.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
