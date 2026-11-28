# The ECS cluster and the one-off migration task (OCT-319). The api service (api.tf, OCT-320)
# and the workers (workers.tf, OCT-321) run here; the mcp service joins in OCT-307.

resource "aws_ecs_cluster" "core" {
  name = var.name
}

# The role ECS itself uses to start a task: pull the image, write logs, read the task's secrets.
# What a running process may do (KMS signing) is a separate task role, per worker (workers.tf).
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in aws_secretsmanager_secret.core : s.arn]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "read-core-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

# Applies the migrations: `scripts/migrate.mjs` (OCT-317) creates the Supabase roles on an empty
# database, runs drizzle's migrations, and is a no-op when there is nothing new. Run it with
# `aws ecs run-task` (infra/README.md); OCT-322 runs it on every deploy.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.task_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${aws_ecr_repository.core.repository_url}:${var.image_tag}"
    essential = true
    command   = ["node", "scripts/migrate.mjs"]
    secrets = [{
      name      = "DATABASE_URL"
      valueFrom = aws_secretsmanager_secret.core["DATABASE_URL"].arn
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.process["migrate"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}
