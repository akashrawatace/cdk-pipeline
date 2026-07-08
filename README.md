# AWS CDK Deployment Pipeline Architecture

## Overview

This project implements an Infrastructure as Code (IaC) deployment pipeline using **AWS CDK** and **Terraform**. The CDK app bootstraps the supporting infrastructure (pipeline, state storage, IAM) in a primary and secondary AWS region, and the pipeline orchestrates Terraform to deploy the landing zone.

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
│          4. Cross-Region Resilience                     │
│                                                         │
│   Primary commit ──► EventBridge ──► CodeBuild mirror   │
│                         │                               │
│                         ▼                               │
│                  Secondary CodeCommit                   │
│                                                         │
│   Secondary watchdog checks primary pipeline health     │
│   and starts the standby pipeline during failover.      │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│          5. Landing Zone (Terraform)                    │
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

### 3. Deploy the Pipelines

```bash
npm run deploy -- --all
```

The CDK app creates:

- `PipelineStackPrimary` in `CDK_DEFAULT_REGION` or `ap-south-1`
- `PipelineStackSecondary` in `SECONDARY_REGION`, the `secondaryRegion` CDK context value, or `ap-southeast-1`
- A primary state bucket named `tf-state-file-ugi-demo-bucket` by default
- A secondary state bucket named `tf-state-file-ugi-demo-bucket-<secondary-region>` by default
- DynamoDB Global Tables named `tf-lock-ugi-demo-table` and `tf-deployment-control-ugi-demo-table`

Example:

```bash
set SECONDARY_REGION=ap-southeast-1
npm run deploy -- --all
```

### 4. Pipeline Execution

1. **Source** — primary pipeline automatically triggers on push to `main`
2. **Plan** — runs `terraform plan`, preview saved as artifact
3. **Approval** — email sent to `akash.rawat@acelucid.com`; review and approve via the AWS Console
4. **Apply** — runs `terraform apply -auto-approve` to deploy the landing zone

The secondary pipeline is created as a standby pipeline. It does not start directly from replicated commits unless `activeActiveSecondary` is enabled in CDK.

---

## Component Details

### CodeCommit Repository (`infra-repo`)

Stores all Terraform infrastructure code. Pushes to the `main` branch trigger the primary pipeline.

Because CodeCommit is region-scoped and has no native replication, the primary stack also creates a CodeBuild mirror project. An EventBridge rule listens for `referenceCreated` and `referenceUpdated` events on `main`, then starts the mirror project. The mirror project uses the AWS CodeCommit Git credential helper to:

```bash
git clone --mirror "$PRIMARY_REPO_URL" /tmp/infra-repo.git
git push --mirror "$SECONDARY_REPO_URL"
```

This copies branches, tags, and commit history to the secondary region repository.

### S3 Bucket (Terraform State)

- Versioning enabled for state history and rollback
- Server-side encryption (SSE-S3)
- Public access blocked
- SSL enforcement
- One-way Cross-Region Replication from the primary state bucket to the secondary state bucket

S3 bucket names are globally unique. The primary bucket keeps the configured name `tf-state-file-ugi-demo-bucket`; the secondary bucket uses `tf-state-file-ugi-demo-bucket-<secondary-region>` unless `secondaryStateBucketName` is provided through CDK context.

### DynamoDB Global Tables

- Partition key: `LockID` (String)
- Pay-per-request billing
- Point-in-time recovery enabled
- `tf-lock-ugi-demo-table` is the Terraform backend lock table, replicated to both regions
- `tf-deployment-control-ugi-demo-table` stores deployment mode and the global apply mutex

### IAM Roles

| Role                   | Purpose                   | Permissions                                                   |
| ---------------------- | ------------------------- | ------------------------------------------------------------- |
| **PipelineRole**       | CodePipeline service role | CodeCommit read, CodeBuild trigger, SNS publish, IAM PassRole |
| **CodeBuildPlanRole**  | Terraform plan CodeBuild  | ReadOnly access + state S3/DynamoDB read                      |
| **CodeBuildApplyRole** | Terraform apply CodeBuild | Full landing zone permissions + state S3/DynamoDB full        |

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
- Runs `terraform init` with region-specific backend config
- Checks deployment mode before apply
- Acquires a global DynamoDB mutex before `terraform apply`
- Releases the mutex when the build exits
- Outputs apply log to artifact

### CodePipeline

- **Source** — CodeCommit (main branch)
- **Plan** — CodeBuild action
- **Approval** — Manual approval with SNS notification
- **Apply** — CodeBuild action

### Cross-Region Failover

The secondary stack creates a scheduled Node.js Lambda watchdog. Every 5 minutes by default it calls `ListPipelineExecutions` for the primary pipeline in the primary region.

Failover starts the secondary pipeline when either condition is true:

- The latest primary pipeline execution is in a terminal failure state (`Failed`, `Cancelled`, `Stopped`, or `Stopping`)
- The watchdog cannot reach the primary pipeline for `failoverFailureThreshold` consecutive checks, defaulting to 3

The failure counter is stored in Systems Manager Parameter Store in the secondary region. This avoids depending on the primary region to publish an outage event.

Before starting the secondary pipeline, the watchdog writes this item to `tf-deployment-control-ugi-demo-table`:

```json
{
  "LockID": "deployment-mode",
  "Mode": "failover"
}
```

That fences the primary apply project. Primary can only apply when deployment mode is missing or set to `primary`; secondary can only apply when deployment mode is `failover`.

Lambda source code lives under `lambda/`. The failover watchdog is implemented in TypeScript at `lambda/failover-monitor/index.ts` and bundled by CDK with `NodejsFunction`, so future functions can use the same folder pattern.

### Active-Standby vs Active-Active

The default implementation is active-standby:

- Primary commits trigger primary builds and deploys
- Primary commits are mirrored to the secondary repository
- Secondary commits do not automatically start the secondary pipeline
- The secondary watchdog starts the secondary pipeline during failover

An active-active variant is simpler operationally: set `activeActiveSecondary: true` on the secondary stack so replicated commits also trigger the secondary pipeline. This gives faster regional independence, but both regions can attempt Terraform operations for the same change. Only use that mode if your Terraform state locking and deployment targets are designed for concurrent or duplicate executions.

### Terraform State Failover Safety

Normal mode:

```text
Primary pipeline applies
Primary S3 state bucket -> replicated to secondary S3 state bucket
Deployment mode: primary or missing
```

Failover mode:

```text
Secondary watchdog sets deployment-mode=failover
Secondary pipeline applies against the secondary state bucket
Primary apply is blocked by the deployment-mode gate
```

Every apply build also tries to create this item before running Terraform:

```json
{
  "LockID": "terraform-apply-lock",
  "Owner": "<region>:<codebuild-build-id>"
}
```

The write uses a DynamoDB conditional expression, so only one pipeline can own the apply lock at a time. The lock intentionally has no automatic expiry; if a build dies without cleanup, an operator should verify no apply is still running before manually deleting the stale lock.

Failback is intentionally manual:

- Stop or disable secondary applies
- Copy/promote the known-good secondary state object back to the primary state bucket
- Run a primary-region `terraform plan` against the promoted state
- Set `deployment-mode=primary` in the deployment control table
- Re-enable primary apply

---

## CDK Stack Outputs

After deployment, the stack exports:

| Output                       | Description                                               |
| ---------------------------- | --------------------------------------------------------- |
| `CodeCommitRepoUrl`          | HTTPS URL to clone the repo                               |
| `StateBucketName`            | S3 bucket for Terraform state                             |
| `LockTableName`              | DynamoDB Global Table for Terraform state locking         |
| `DeploymentControlTableName` | DynamoDB Global Table for deployment mode and apply mutex |
| `PlanProjectName`            | CodeBuild plan project name                               |
| `ApplyProjectName`           | CodeBuild apply project name                              |
| `PipelineName`               | CodePipeline name                                         |
| `RegionRole`                 | `primary` or `secondary`                                  |
| `SecondaryRepoCloneUrl`      | Secondary CodeCommit HTTPS URL, primary stack only        |
| `ReplicationProjectName`     | CodeBuild mirror project, primary stack only              |
| `FailoverMonitorName`        | Lambda watchdog, secondary stack only                     |

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

| Command           | Purpose                                   |
| ----------------- | ----------------------------------------- |
| `npm run build`   | Compile TypeScript                        |
| `npm run test`    | Run CDK assertion tests                   |
| `npm run synth`   | Synthesize CloudFormation template        |
| `npm run diff`    | Show diff against deployed stack          |
| `npm run deploy`  | Deploy the pipeline stack                 |
| `npm run checkov` | Synthesize CDK and run local Checkov scan |

---

## Security

- S3 bucket blocks all public access
- DynamoDB table uses IAM-based access control
- IAM roles follow least-privilege principle
- Approval stage requires human review before infrastructure changes
- Secrets (if any) should use AWS Secrets Manager

---
