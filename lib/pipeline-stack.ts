import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { CodeCommitResources } from './constructs/codecommit';
import { FailoverLambda } from './constructs/lambda';
import { Storage } from './constructs/storage';
import { CodeBuildProjects } from './constructs/codebuild';
import { PipelineRegionRole, PipelineStackProps } from './types';

export { PipelineRegionRole, PipelineStackProps };

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const {
      approvalEmail,
      terraformVersion,
      regionRole = 'primary',
      primaryRegion = 'ap-south-1',
      secondaryRegion = 'ap-southeast-1',
      repositoryName = 'infra-repo',
      branchName = 'main',
      primaryPipelineName = 'infra-deployment-pipeline',
      secondaryPipelineName = 'infra-deployment-pipeline-failover',
      activeActiveSecondary = false,
      failoverCheckInterval = cdk.Duration.minutes(5),
      failoverFailureThreshold = 3,
      failoverOnPipelineFailure = true,
      stateBucketName = 'tf-state-file-ugi-demo-bucket',
      secondaryStateBucketName = `${stateBucketName}-${secondaryRegion}`,
      terraformLockTableName = 'tf-lock-ugi-demo-table',
      deploymentControlTableName = 'tf-deployment-control-ugi-demo-table',
    } = props;

    if (regionRole === 'primary' && primaryRegion === secondaryRegion) {
      throw new Error('primaryRegion and secondaryRegion must be different.');
    }

    const pipelineName =
      regionRole === 'primary' ? primaryPipelineName : secondaryPipelineName;

    const repo = new codecommit.Repository(this, 'InfraRepo', {
      repositoryName,
      description:
        regionRole === 'primary'
          ? 'Primary Terraform infrastructure code repository'
          : 'Secondary replicated Terraform infrastructure code repository',
    });

    const backend = new Storage(this, 'StateBackend', {
      regionRole,
      primaryRegion,
      secondaryRegion,
      stateBucketName,
      secondaryStateBucketName,
      terraformLockTableName,
      deploymentControlTableName,
    });

    const approvalTopic = new sns.Topic(this, 'ApprovalTopic', {
      displayName: 'Terraform-Plan-Approval',
    });
    approvalTopic.addSubscription(
      new subscriptions.EmailSubscription(approvalEmail),
    );

    const buildProjects = new CodeBuildProjects(
      this,
      'TerraformBuildProjects',
      {
        terraformVersion,
        regionRole,
        stateBucket: backend.stateBucket,
        terraformLockTableName: backend.terraformLockTableName,
        terraformLockTableArn: backend.terraformLockTableArn,
        deploymentControlTableName: backend.deploymentControlTableName,
        deploymentControlTableArn: backend.deploymentControlTableArn,
      },
    );

    const pipelineRole = this.createPipelineRole(
      repo,
      buildProjects,
      approvalTopic,
    );
    const pipeline = this.createPipeline({
      pipelineRole,
      pipelineName,
      repo,
      branchName,
      regionRole,
      activeActiveSecondary,
      approvalTopic,
      buildProjects,
    });

    if (regionRole === 'primary') {
      const replication = new CodeCommitResources(
        this,
        'CodeCommitReplication',
        {
          repo,
          repositoryName,
          branchName,
          primaryRegion,
          secondaryRegion,
        },
      );

      new cdk.CfnOutput(this, 'SecondaryRepoCloneUrl', {
        value: replication.secondaryRepoCloneUrl,
        description: 'Secondary region CodeCommit repository HTTPS clone URL',
      });
      new cdk.CfnOutput(this, 'ReplicationProjectName', {
        value: replication.replicationProject.projectName,
        description: 'CodeBuild project that mirrors commits to the secondary region',
      });
    }

    if (regionRole === 'secondary' && !activeActiveSecondary) {
      const monitor = new FailoverLambda(this, 'FailoverMonitor', {
        pipeline,
        primaryRegion,
        primaryPipelineName,
        secondaryPipelineName,
        deploymentControlTableName: backend.deploymentControlTableName,
        deploymentControlTableArn: backend.deploymentControlTableArn,
        failoverCheckInterval,
        failoverFailureThreshold,
        failoverOnPipelineFailure,
      });

      new cdk.CfnOutput(this, 'FailoverMonitorName', {
        value: monitor.function.functionName,
        description: 'Lambda function that monitors primary pipeline health',
      });
    }

    new cdk.CfnOutput(this, 'CodeCommitRepoUrl', {
      value: repo.repositoryCloneUrlHttp,
      description: 'CodeCommit repository HTTP clone URL',
    });
    new cdk.CfnOutput(this, 'StateBucketName', {
      value: backend.stateBucket.bucketName,
      description: 'Terraform state S3 bucket name',
    });
    new cdk.CfnOutput(this, 'LockTableName', {
      value: backend.terraformLockTableName,
      description: 'Terraform state lock DynamoDB global table name',
    });
    new cdk.CfnOutput(this, 'DeploymentControlTableName', {
      value: backend.deploymentControlTableName,
      description: 'DynamoDB global table used for apply mode and mutex control',
    });
    new cdk.CfnOutput(this, 'PlanProjectName', {
      value: buildProjects.planProject.projectName,
      description: 'CodeBuild project for terraform plan',
    });
    new cdk.CfnOutput(this, 'ApplyProjectName', {
      value: buildProjects.applyProject.projectName,
      description: 'CodeBuild project for terraform apply',
    });
    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipelineName,
      description: 'CodePipeline name',
    });
    new cdk.CfnOutput(this, 'RegionRole', {
      value: regionRole,
      description: 'Whether this stack is the primary or secondary region deployment',
    });
  }

  private createPipelineRole(
    repo: codecommit.Repository,
    buildProjects: CodeBuildProjects,
    approvalTopic: sns.Topic,
  ): iam.Role {
    const pipelineRole = new iam.Role(this, 'PipelineRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      description: 'Service role for CodePipeline',
    });

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
          buildProjects.planProject.projectArn,
          buildProjects.applyProject.projectArn,
        ],
      }),
    );
    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [
          buildProjects.planRole.roleArn,
          buildProjects.applyRole.roleArn,
        ],
        conditions: {
          StringEqualsIfExists: {
            'iam:PassedToService': 'codebuild.amazonaws.com',
          },
        },
      }),
    );
    approvalTopic.grantPublish(pipelineRole);

    return pipelineRole;
  }

  private createPipeline(props: {
    pipelineRole: iam.Role;
    pipelineName: string;
    repo: codecommit.Repository;
    branchName: string;
    regionRole: PipelineRegionRole;
    activeActiveSecondary: boolean;
    approvalTopic: sns.Topic;
    buildProjects: CodeBuildProjects;
  }): codepipeline.Pipeline {
    const {
      pipelineRole,
      pipelineName,
      repo,
      branchName,
      regionRole,
      activeActiveSecondary,
      approvalTopic,
      buildProjects,
    } = props;
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const planOutput = new codepipeline.Artifact('PlanOutput');

    return new codepipeline.Pipeline(this, 'DeploymentPipeline', {
      role: pipelineRole,
      pipelineName,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.CodeCommitSourceAction({
              actionName: 'Source',
              repository: repo,
              output: sourceOutput,
              branch: branchName,
              trigger:
                regionRole === 'primary' || activeActiveSecondary
                  ? codepipeline_actions.CodeCommitTrigger.EVENTS
                  : codepipeline_actions.CodeCommitTrigger.NONE,
            }),
          ],
        },
        {
          stageName: 'Plan',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'TerraformPlan',
              project: buildProjects.planProject,
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
              project: buildProjects.applyProject,
              input: sourceOutput,
            }),
          ],
        },
      ],
    });
  }
}
