# The public API (OCT-320): an application load balancer at https://api.octap.biz in front of the
# `api` ECS service. DNS stays in Cloudflare, DNS only (not proxied): Cloudflare's proxy cuts a
# response at 100 seconds, which would end the console's event stream and the assistant's answers.

locals {
  api_domain = "api.${var.domain}"
  api_port   = 3000
}

data "cloudflare_zone" "main" {
  filter = {
    name = var.domain
  }
}

# --- Certificate ------------------------------------------------------------------------------

resource "aws_acm_certificate" "api" {
  domain_name       = local.api_domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_dns_record" "api_certificate_validation" {
  for_each = {
    for o in aws_acm_certificate.api.domain_validation_options : o.domain_name => o
  }
  zone_id = data.cloudflare_zone.main.id
  name    = trimsuffix(each.value.resource_record_name, ".")
  type    = each.value.resource_record_type
  content = trimsuffix(each.value.resource_record_value, ".")
  ttl     = 60
  proxied = false
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for r in aws_acm_certificate.api.domain_validation_options : r.resource_record_name]
  depends_on              = [cloudflare_dns_record.api_certificate_validation]
}

# --- Load balancer ----------------------------------------------------------------------------

resource "aws_security_group" "load_balancer" {
  name        = "${var.name}-load-balancer"
  description = "Public load balancer: HTTP and HTTPS from anywhere, out to the Core tasks only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-load-balancer" }
}

resource "aws_vpc_security_group_ingress_rule" "load_balancer_http" {
  security_group_id = aws_security_group.load_balancer.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "load_balancer_https" {
  security_group_id = aws_security_group.load_balancer.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "load_balancer_to_api" {
  security_group_id            = aws_security_group.load_balancer.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = local.api_port
  to_port                      = local.api_port
}

# The only inbound rule the tasks have: the API port, from the load balancer.
resource "aws_vpc_security_group_ingress_rule" "tasks_from_load_balancer" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.load_balancer.id
  ip_protocol                  = "tcp"
  from_port                    = local.api_port
  to_port                      = local.api_port
}

resource "aws_lb" "public" {
  name               = var.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.load_balancer.id]
  subnets            = aws_subnet.public[*].id
  # The console's event stream sends a heartbeat every 20 s; the assistant can be quiet longer
  # while a model thinks. 5 minutes keeps both open.
  idle_timeout               = 300
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = local.api_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  # Long enough for an in-flight request to finish on a deploy, short enough not to stall it.
  deregistration_delay = 30

  # /health checks Postgres and Redis too: 503 when either is down, 200 when only Sui is.
  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api.certificate_arn
  # api.octap.biz today; OCT-307 adds a host rule for mcp.octap.biz.
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "cloudflare_dns_record" "api" {
  zone_id = data.cloudflare_zone.main.id
  name    = local.api_domain
  type    = "CNAME"
  content = aws_lb.public.dns_name
  ttl     = 300
  proxied = false
}

# --- The api service --------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
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
    name      = "api"
    image     = "${aws_ecr_repository.core.repository_url}:${var.image_tag}"
    essential = true
    # The image's default command: node api/dist/main.js.
    portMappings = [{ containerPort = local.api_port, protocol = "tcp" }]
    environment = [
      { name = "API_HOST", value = "0.0.0.0" },
      { name = "API_PORT", value = tostring(local.api_port) },
      # One hop: the load balancer. Rate limits then see the client's address, not its.
      { name = "TRUSTED_PROXY_HOPS", value = "1" },
      { name = "SUI_NETWORK", value = "testnet" },
      { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" },
      { name = "CONSOLE_GOOGLE_CLIENT_ID", value = var.console_google_client_id },
    ]
    # A task can't start while a secret it names has no value, so only the ones already set are
    # named here: DATABASE_URL always, the others once filled in (var.api_feature_secrets).
    secrets = [
      for name in concat(["DATABASE_URL"], var.api_feature_secrets) : {
        name      = name
        valueFrom = aws_secretsmanager_secret.core[name].arn
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.process["api"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.core.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  # Boot (Nest, the first Postgres and Redis connections) before the first health check counts.
  health_check_grace_period_seconds = 60

  # Public subnets with a public address and no NAT: the task pulls its image and reaches Sui,
  # Enoki and Google directly. Inbound, the tasks group accepts the load balancer only.
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.api_port
  }

  # A new version that never turns healthy is rolled back to the last one that did.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}
