import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CodeCommitReplicationProps {
  repo: codecommit.Repository;
  repositoryName: string;
  branchName: string;
  primaryRegion: string;
  secondaryRegion: string;
}

export class CodeCommitReplication extends Construct {
  readonly replicationProject: codebuild.Project;
  readonly secondaryRepoCloneUrl: string;

  constructor(scope: Construct, id: string, props: CodeCommitReplicationProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const {
      repo,
      repositoryName,
      branchName,
      primaryRegion,
      secondaryRegion,
    } = props;
    const secondaryRepoArn = stack.formatArn({
      service: 'codecommit',
      region: secondaryRegion,
      resource: repositoryName,
    });
    this.secondaryRepoCloneUrl = `https://git-codecommit.${secondaryRegion}.${stack.urlSuffix}/v1/repos/${repositoryName}`;

    this.replicationProject = new codebuild.Project(
      this,
      'CodeCommitReplicationProject',
      {
        description: `Mirrors ${repositoryName} commits from ${primaryRegion} to ${secondaryRegion}`,
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: codebuild.ComputeType.SMALL,
        },
        environmentVariables: {
          PRIMARY_REPO_URL: { value: repo.repositoryCloneUrlHttp },
          SECONDARY_REPO_URL: { value: this.secondaryRepoCloneUrl },
          BRANCH_NAME: { value: branchName },
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            pre_build: {
              commands: [
                'git config --global credential.helper "!aws codecommit credential-helper $@"',
                'git config --global credential.UseHttpPath true',
              ],
            },
            build: {
              commands: [
                'rm -rf /tmp/infra-repo.git',
                'git clone --mirror "$PRIMARY_REPO_URL" /tmp/infra-repo.git',
                'cd /tmp/infra-repo.git',
                'git remote set-url --push origin "$SECONDARY_REPO_URL"',
                'git push --mirror origin',
              ],
            },
          },
        }),
      },
    );

    this.replicationProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'codecommit:GitPull',
          'codecommit:GetRepository',
          'codecommit:GetBranch',
        ],
        resources: [repo.repositoryArn],
      }),
    );
    this.replicationProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'codecommit:GitPush',
          'codecommit:GetRepository',
          'codecommit:GetBranch',
          'codecommit:CreateBranch',
        ],
        resources: [secondaryRepoArn],
      }),
    );

    new events.Rule(this, 'ReplicateOnCodeCommitChange', {
      description: `Replicates ${repositoryName}/${branchName} to ${secondaryRegion} after commits`,
      eventPattern: {
        source: ['aws.codecommit'],
        detailType: ['CodeCommit Repository State Change'],
        resources: [repo.repositoryArn],
        detail: {
          event: ['referenceCreated', 'referenceUpdated'],
          repositoryName: [repositoryName],
          referenceName: [branchName],
        },
      },
      targets: [new events_targets.CodeBuildProject(this.replicationProject)],
    });
  }
}
