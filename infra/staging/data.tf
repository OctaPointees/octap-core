# Postgres and Redis (OCT-319). Both sit in the private subnets with no public address, and only
# the ECS tasks' security group can reach them.

# Every Core task (api, worker, mcp, migrate) runs with this group. It opens nothing inbound by
# itself; the load balancer's rule for the API is added in OCT-320.
resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "Core ECS tasks"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-tasks" }
}

# Tasks run in the public subnets with a public IP and no NAT, so they reach ECR, Secrets
# Manager, KMS, CloudWatch, Sui and the model APIs directly.
resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- Postgres ---------------------------------------------------------------------------------

resource "aws_security_group" "postgres" {
  name        = "${var.name}-postgres"
  description = "RDS Postgres: only Core tasks"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-postgres" }
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_tasks" {
  security_group_id            = aws_security_group.postgres.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# A new value on every run; RDS and the secret only take it when db_password_version changes.
ephemeral "random_password" "postgres" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "postgres" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "postgres" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = "17"
  instance_class = "db.t4g.micro"
  db_name        = "octap"
  username       = "octap_admin"

  # Write-only: sent to RDS, never stored in state. Bump db_password_version to set a new one.
  password_wo         = ephemeral.random_password.postgres.result
  password_wo_version = var.db_password_version

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.postgres.name
  vpc_security_group_ids = [aws_security_group.postgres.id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period    = 7
  copy_tags_to_snapshot      = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-final"
  auto_minor_version_upgrade = true
  apply_immediately          = false
}

# The API and the worker read DATABASE_URL from this secret. Also write-only: the URL carries the
# password, so it is never in state. RDS refuses connections without TLS, hence sslmode=require.
resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id                = aws_secretsmanager_secret.core["DATABASE_URL"].id
  secret_string_wo         = "postgresql://${aws_db_instance.postgres.username}:${ephemeral.random_password.postgres.result}@${aws_db_instance.postgres.endpoint}/${aws_db_instance.postgres.db_name}?sslmode=require"
  secret_string_wo_version = var.db_password_version
}

# --- Redis ------------------------------------------------------------------------------------

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "ElastiCache Redis: only Core tasks"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-redis" }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_tasks" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

# One node. TLS in transit (REDIS_URL is `rediss://`); no AUTH token, since one would be stored in
# Terraform state. Only the tasks' security group can connect.
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = var.name
  description          = "Core rate limits, sessions and one-time codes"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  automatic_failover_enabled = false
  apply_immediately          = false
}
