import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PipelineStack } from '../lib/pipeline-stack';

describe('PipelineStack', () => {
  const app = new cdk.App();
  const stack = new PipelineStack(app, 'TestPipelineStack', {
    approvalEmail: 'test@example.com',
    terraformVersion: '1.9.8',
    env: { account: '123456789012', region: 'ap-southeast-1' },
  });
  const template = Template.fromStack(stack);

  test('creates CodeCommit repository', () => {
    template.hasResourceProperties('AWS::CodeCommit::Repository', {
      RepositoryName: 'infra-repo',
    });
  });

  test('creates S3 bucket for Terraform state', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('creates DynamoDB table for state locking', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'LockID', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
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
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
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
});
