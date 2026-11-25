output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.core.repository_url
}

output "ecs_cluster" {
  value = aws_ecs_cluster.core.name
}

output "tasks_security_group_id" {
  value = aws_security_group.tasks.id
}

output "postgres_endpoint" {
  value = aws_db_instance.postgres.endpoint
}

output "redis_url" {
  description = "REDIS_URL for the tasks: TLS, no password (only the tasks' security group connects)."
  value       = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
}

output "secret_names" {
  value = sort([for s in aws_secretsmanager_secret.core : s.name])
}
