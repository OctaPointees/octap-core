# The image from the root Dockerfile (OCT-317). Tags are commit SHAs and never move, so a running
# service always matches a commit.
resource "aws_ecr_repository" "core" {
  name                 = "octap-core"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "core" {
  repository = aws_ecr_repository.core.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images (enough to roll back)"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

# One log group per process, so each can be tailed on its own.
resource "aws_cloudwatch_log_group" "process" {
  for_each          = toset(["api", "worker", "org-worker", "mcp", "migrate"])
  name              = "/octap/staging/${each.key}"
  retention_in_days = var.log_retention_days
}
