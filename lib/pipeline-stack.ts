import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import { Construct } from 'constructs';

export interface PipelineStackProps extends cdk.StackProps {
  approvalEmail: string;
  terraformVersion: string;
}

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { approvalEmail, terraformVersion } = props;

    // ──────────────────────────────────────
    // 1. CodeCommit Repository
    // ──────────────────────────────────────
    const repo = new codecommit.Repository(this, 'InfraRepo', {
      repositoryName: 'infra-repo',
      description: 'Terraform infrastructure code repository',
    });

    // ──────────────────────────────────────
    // 2. S3 Bucket for Terraform State
    // ──────────────────────────────────────
    const stateBucket = new s3.Bucket(this, 'TerraformStateBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    // ──────────────────────────────────────
    // 3. DynamoDB Table for State Locking
    // ──────────────────────────────────────
    const lockTable = new dynamodb.Table(this, 'TerraformLockTable', {
      partitionKey: { name: 'LockID', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // ──────────────────────────────────────
    // 4. SNS Topic for Approval
    // ──────────────────────────────────────
    const approvalTopic = new sns.Topic(this, 'ApprovalTopic', {
      displayName: 'Terraform-Plan-Approval',
    });
    approvalTopic.addSubscription(
      new subscriptions.EmailSubscription(approvalEmail),
    );

    // ──────────────────────────────────────
    // 5. IAM Roles
    // ──────────────────────────────────────

    // Pipeline service role — CodePipeline orchestrates the stages
    const pipelineRole = new iam.Role(this, 'PipelineRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      description: 'Service role for CodePipeline',
    });

    // Plan role — read-only for planning + state access
    const planRole = new iam.Role(this, 'CodeBuildPlanRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'Role for Terraform plan CodeBuild project',
    });
    planRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
    );

    // Apply role — full landing‑zone permissions + state access
    const applyRole = new iam.Role(this, 'CodeBuildApplyRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'Role for Terraform apply CodeBuild project',
    });

    // ─── State bucket + lock table access for both roles ───
    const stateBucketPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [stateBucket.bucketArn, stateBucket.arnForObjects('*')],
    });
    planRole.addToPolicy(stateBucketPolicy);

    const stateBucketFullPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
      resources: [stateBucket.bucketArn, stateBucket.arnForObjects('*')],
    });
    applyRole.addToPolicy(stateBucketFullPolicy);

    const lockTableReadPolicy = new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:Scan',
        'dynamodb:DescribeTable',
      ],
      resources: [lockTable.tableArn],
    });
    planRole.addToPolicy(lockTableReadPolicy);

    const lockTableFullPolicy = new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan',
        'dynamodb:DescribeTable',
      ],
      resources: [lockTable.tableArn],
    });
    applyRole.addToPolicy(lockTableFullPolicy);

    // ─── Apply role gets landing‑zone permissions ───
    applyRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'organizations:*',
          'ec2:*',
          'logs:*',
          'cloudtrail:*',
          'config:*',
          's3:*',
          'iam:*',
          'kms:*',
          'ssm:*',
          'servicequotas:*',
          'ram:*',
          'resource-groups:*',
          'tag:*',
        ],
        resources: ['*'],
      }),
    );

    // ──────────────────────────────────────
    // 6. CodeBuild Projects
    // ──────────────────────────────────────

    const installTerraformCommands = [
      `curl -sLO "https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_linux_amd64.zip"`,
      'unzip -q -o terraform_*.zip -d /usr/local/bin/',
      'rm -f terraform_*.zip',
      'terraform --version',
    ];

    const planProject = new codebuild.PipelineProject(this, 'TerraformPlanProject', {
      role: planRole,
      description: 'Validates and previews Terraform infrastructure changes',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { python: '3.11' },
            commands: [
              ...installTerraformCommands,
              'pip3 install --upgrade pip',
              'pip3 install checkov',
            ],
          },
          build: {
            commands: [
              'echo "Running Checkov static code analysis on Terraform code..."',
              'checkov -d . --framework terraform',
              'terraform init -no-color',
              'terraform plan -no-color 2>&1 | tee /tmp/plan-output.txt',
            ],
          },
        },
        artifacts: {
          files: ['/tmp/plan-output.txt'],
          'discard-paths': 'yes',
        },
      }),
    });

    const applyProject = new codebuild.PipelineProject(this, 'TerraformApplyProject', {
      role: applyRole,
      description: 'Applies approved Terraform infrastructure changes',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { python: '3.11' },
            commands: installTerraformCommands,
          },
          build: {
            commands: [
              'terraform init -no-color',
              'terraform apply -auto-approve -no-color 2>&1 | tee /tmp/apply-output.txt',
            ],
          },
        },
        artifacts: {
          files: ['/tmp/apply-output.txt'],
          'discard-paths': 'yes',
        },
      }),
    });

    // ──────────────────────────────────────
    // 7. CodePipeline Permissions
    // ──────────────────────────────────────

    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'codecommit:GetBranch',
          'codecommit:GetCommit',
          'codecommit:GetRepository',
          'codecommit:UploadArchive',
          'codecommit:GetUploadArchiveStatus',
          'codecommit:CancelUploadArchive',
        ],
        resources: [repo.repositoryArn],
      }),
    );

    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'codebuild:StartBuild',
          'codebuild:BatchGetBuilds',
          'codebuild:StopBuild',
        ],
        resources: [
          planProject.projectArn,
          applyProject.projectArn,
        ],
      }),
    );

    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [planRole.roleArn, applyRole.roleArn],
        conditions: {
          StringEqualsIfExists: {
            'iam:PassedToService': 'codebuild.amazonaws.com',
          },
        },
      }),
    );

    approvalTopic.grantPublish(pipelineRole);

    // ──────────────────────────────────────
    // 8. CodePipeline
    // ──────────────────────────────────────

    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const planOutput = new codepipeline.Artifact('PlanOutput');

    new codepipeline.Pipeline(this, 'DeploymentPipeline', {
      role: pipelineRole,
      pipelineName: 'infra-deployment-pipeline',
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.CodeCommitSourceAction({
              actionName: 'Source',
              repository: repo,
              output: sourceOutput,
              branch: 'main',
            }),
          ],
        },
        {
          stageName: 'Plan',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'TerraformPlan',
              project: planProject,
              input: sourceOutput,
              outputs: [planOutput],
            }),
          ],
        },
        {
          stageName: 'Approval',
          actions: [
            new codepipeline_actions.ManualApprovalAction({
              actionName: 'ApproveChanges',
              notificationTopic: approvalTopic,
              additionalInformation:
                'A Terraform plan has been generated. Review the plan output and approve or reject.',
            }),
          ],
        },
        {
          stageName: 'Apply',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'TerraformApply',
              project: applyProject,
              input: sourceOutput,
            }),
          ],
        },
      ],
    });

    // ──────────────────────────────────────
    // Outputs
    // ──────────────────────────────────────
    new cdk.CfnOutput(this, 'CodeCommitRepoUrl', {
      value: repo.repositoryCloneUrlHttp,
      description: 'CodeCommit repository HTTP clone URL',
    });
    new cdk.CfnOutput(this, 'StateBucketName', {
      value: stateBucket.bucketName,
      description: 'Terraform state S3 bucket name',
    });
    new cdk.CfnOutput(this, 'LockTableName', {
      value: lockTable.tableName,
      description: 'Terraform state lock DynamoDB table name',
    });
    new cdk.CfnOutput(this, 'PlanProjectName', {
      value: planProject.projectName,
      description: 'CodeBuild project for terraform plan',
    });
    new cdk.CfnOutput(this, 'ApplyProjectName', {
      value: applyProject.projectName,
      description: 'CodeBuild project for terraform apply',
    });
    new cdk.CfnOutput(this, 'PipelineName', {
      value: 'infra-deployment-pipeline',
      description: 'CodePipeline name',
    });
  }
}
