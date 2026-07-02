# AWS CDK Deployment Pipeline Architecture

## Overview

This project implements an Infrastructure as Code (IaC) deployment pipeline using **AWS CDK** and **Terraform**. The CDK stack bootstraps the supporting infrastructure (pipeline, state storage, IAM), and the pipeline orchestrates Terraform to deploy the landing zone.

```
┌─────────────────────────────────────────────────────────┐
│                   1. CDK Deploy                         │
│   (aws-cdk-lib) triggers the whole process              │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────────────────┐
│           2. Supporting Infrastructure (CDK Stack)     │
│                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │CodeCommit│  │ S3 Bucket│  │ DynamoDB Lock Table  │  │
│  │(infra    │  │(Terraform│  │ (state locking)      │  │
│  │  code)   │  │  state)  │  │                      │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
│                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ IAM Roles│  │ CodeBuild│  │ CodeBuild            │  │
│  │ (scoped) │  │ (Plan)   │  │ (Apply)              │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
└─────────────────────┬──────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│          3. CodePipeline Orchestration                  │
│                                                         │
│   Source ──► Plan ──► Approval ──► Apply                │
│   (CodeCommit)  (tf plan)  (Manual)  (tf apply)         │
│                                                         │
│   Stages:                                               │
│   - Source: Pulls infra code from CodeCommit            │
│   - Plan:   CodeBuild runs `terraform plan`             │
│   - Approval: Manual gate (SNS email notification)      │
│   - Apply:  CodeBuild runs `terraform apply`            │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│          4. Landing Zone (Terraform)                    │
│                                                         │
│   AWS Org OUs + Accounts                                │
│   TGW VPCs + Fortigate                                  │
│   LogArchive                                            │
└─────────────────────────────────────────────────────────┘
```

---

## Getting Started

### 1. Clone & Install

```bash
cd infra-pipeline
npm install
```

### 2. Bootstrap CDK (

```bash
npx cdk bootstrap 
```

### 3. Deploy the Pipeline

```bash
npm run deploy
```

### 4. Pipeline Execution

1. **Source** — automatically triggers on push to `main`
2. **Plan** — runs `terraform plan`, preview saved as artifact
3. **Approval** — email sent to `akash.rawat@acelucid.com`; review and approve via the AWS Console
4. **Apply** — runs `terraform apply -auto-approve` to deploy the landing zone

---

## Component Details

### CodeCommit Repository (`infra-repo`)
Stores all Terraform infrastructure code. Pushes to the `main` branch trigger the pipeline.

### S3 Bucket (Terraform State)
- Versioning enabled for state history and rollback
- Server-side encryption (SSE-S3)
- Public access blocked
- SSL enforcement

### DynamoDB Table (State Locking)
- Partition key: `LockID` (String)
- Pay-per-request billing
- Point-in-time recovery enabled
- Prevents concurrent Terraform operations

### IAM Roles
| Role | Purpose | Permissions |
|---|---|---|
| **PipelineRole** | CodePipeline service role | CodeCommit read, CodeBuild trigger, SNS publish, IAM PassRole |
| **CodeBuildPlanRole** | Terraform plan CodeBuild | ReadOnly access + state S3/DynamoDB read |
| **CodeBuildApplyRole** | Terraform apply CodeBuild | Full landing zone permissions + state S3/DynamoDB full |

### SNS Topic
Sends email notifications for manual approval requests when a new plan is ready for review.

### CodeBuild Plan
- Linux (Standard 7.0, medium)
- Installs Terraform 1.9.8
- Runs `terraform init && terraform plan`
- Outputs plan to artifact for reference

### CodeBuild Apply
- Linux (Standard 7.0, medium)
- Installs Terraform 1.9.8
- Runs `terraform init && terraform apply -auto-approve`
- Outputs apply log to artifact

### CodePipeline
- **Source** — CodeCommit (main branch)
- **Plan** — CodeBuild action
- **Approval** — Manual approval with SNS notification
- **Apply** — CodeBuild action

---

## CDK Stack Outputs

After deployment, the stack exports:

| Output | Description |
|---|---|
| `CodeCommitRepoUrl` | HTTPS URL to clone the repo |
| `StateBucketName` | S3 bucket for Terraform state |
| `LockTableName` | DynamoDB table for state locking |
| `PlanProjectName` | CodeBuild plan project name |
| `ApplyProjectName` | CodeBuild apply project name |
| `PipelineName` | CodePipeline name |


## Security & Static Analysis (Checkov)

This repository integrates **Checkov** to scan both the CDK and Terraform codebases for security and compliance issues.

### 1. Local CDK Scanning
To check the CDK-generated CloudFormation templates before deploying:
1. Ensure Checkov is installed locally (e.g., via `pip install checkov` or using Docker).
2. Run:
   ```bash
   npm run checkov
   ```
This synthesizes the templates and runs Checkov against the output `cdk.out/` folder using configurations in `.checkov.yaml`.

### 2. CI/CD Pipeline Scanning
Checkov is integrated as an automated security gate in the CodePipeline **Plan** stage. During the CodeBuild execution:
1. Checkov is installed automatically in the build container.
2. It scans the source files (`checkov -d . --framework terraform`).
3. If security vulnerabilities are found, the build fails, preventing the pipeline from advancing to the manual approval or apply stages.

---

## Useful Commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript |
| `npm run test` | Run CDK assertion tests |
| `npm run synth` | Synthesize CloudFormation template |
| `npm run diff` | Show diff against deployed stack |
| `npm run deploy` | Deploy the pipeline stack |
| `npm run checkov` | Synthesize CDK and run local Checkov scan |

---

## Security

- S3 bucket blocks all public access
- DynamoDB table uses IAM-based access control
- IAM roles follow least-privilege principle
- Approval stage requires human review before infrastructure changes
- Secrets (if any) should use AWS Secrets Manager

---

*Generated on: 2026-07-02*
