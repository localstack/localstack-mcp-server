terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  s3_use_path_style = true
}

variable "name_prefix" {
  description = "Prefix used for test resources"
  type        = string
  default     = "mcpjam-eval"
}

resource "aws_s3_bucket" "eval_bucket" {
  bucket        = "${var.name_prefix}-bucket"
  force_destroy = true
}

resource "aws_sqs_queue" "eval_queue" {
  name = "${var.name_prefix}-queue"
}

output "bucket_name" {
  value = aws_s3_bucket.eval_bucket.bucket
}

output "queue_name" {
  value = aws_sqs_queue.eval_queue.name
}
