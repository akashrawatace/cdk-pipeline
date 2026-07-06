import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PipelineStack } from '../lib/pipeline-stack';

describe('PipelineStack', () => {
  const app = new cdk.App();
  const stack = new PipelineStack(app, 'TestPipelineStack', {
    approvalEmail: 'test@example.com',
    terraformVersion: '1.9.8',
    env: { account: '123456789012', region: 'ap-southeast-1' },
    primaryRegion: 'ap-southeast-1',
    secondaryRegion: 'ap-south-1',
  });
  const template = Template.fromStack(stack);

  test('creates CodeCommit repository', () => {
    template.hasResourceProperties('AWS::CodeCommit::Repository', {
      RepositoryName: 'infra-repo',
    });
  });

  test('creates S3 bucket for Terraform state', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'tf-state-file-ugi-demo-bucket',
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      ReplicationConfiguration: Match.objectLike({
        Rules: [
          Match.objectLike({
            Status: 'Enabled',
          }),
        ],
      }),
    });
  });

  test('creates DynamoDB global tables for state locking and deployment control', () => {
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 2);
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'tf-lock-ugi-demo-table',
      KeySchema: [{ AttributeName: 'LockID', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      Replicas: [
        Match.objectLike({ Region: 'ap-southeast-1' }),
        Match.objectLike({ Region: 'ap-south-1' }),
      ],
    });
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'tf-deployment-control-ugi-demo-table',
    });
  });

  test('creates SNS topic with email subscription', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      DisplayName: 'Terraform-Plan-Approval',
    });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'test@example.com',
    });
  });

  test('creates IAM roles with proper assume role policies', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'codepipeline.amazonaws.com' },
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'codebuild.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  test('creates both CodeBuild projects', () => {
    template.resourceCountIs('AWS::CodeBuild::Project', 3);
  });

  test('creates CodePipeline with all stages', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'infra-deployment-pipeline',
      Stages: [
        Match.objectLike({ Name: 'Source' }),
        Match.objectLike({ Name: 'Plan' }),
        Match.objectLike({ Name: 'Approval' }),
        Match.objectLike({ Name: 'Apply' }),
      ],
    });
  });

  test('creates a CodeCommit replication trigger in the primary region', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.codecommit'],
        'detail-type': ['CodeCommit Repository State Change'],
        detail: {
          event: ['referenceCreated', 'referenceUpdated'],
          repositoryName: ['infra-repo'],
          referenceName: ['main'],
        },
      },
    });

    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Description:
        'Mirrors infra-repo commits from ap-southeast-1 to ap-south-1',
    });
  });

  test('adds deployment mode and apply mutex checks to apply project', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Description: 'Applies approved Terraform infrastructure changes',
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({
            Name: 'DEPLOYMENT_CONTROL_TABLE_NAME',
            Value: 'tf-deployment-control-ugi-demo-table',
          }),
          Match.objectLike({
            Name: 'EXPECTED_DEPLOYMENT_MODE',
            Value: 'primary',
          }),
        ]),
      }),
    });
  });
});

describe('PipelineStack secondary region', () => {
  const app = new cdk.App();
  const stack = new PipelineStack(app, 'TestSecondaryPipelineStack', {
    approvalEmail: 'test@example.com',
    terraformVersion: '1.9.8',
    env: { account: '123456789012', region: 'ap-south-1' },
    regionRole: 'secondary',
    primaryRegion: 'ap-southeast-1',
    secondaryRegion: 'ap-south-1',
  });
  const template = Template.fromStack(stack);

  test('creates standby secondary pipeline and failover monitor', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'infra-deployment-pipeline-failover',
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'nodejs20.x',
      Environment: {
        Variables: Match.objectLike({
          PRIMARY_REGION: 'ap-southeast-1',
          PRIMARY_PIPELINE_NAME: 'infra-deployment-pipeline',
          SECONDARY_PIPELINE_NAME: 'infra-deployment-pipeline-failover',
          DEPLOYMENT_CONTROL_TABLE_NAME: 'tf-deployment-control-ugi-demo-table',
        }),
      },
    });

    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });
});
