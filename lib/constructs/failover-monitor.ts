import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface FailoverMonitorProps {
  pipeline: codepipeline.Pipeline;
  primaryRegion: string;
  primaryPipelineName: string;
  secondaryPipelineName: string;
  deploymentControlTableName: string;
  deploymentControlTableArn: string;
  failoverCheckInterval: cdk.Duration;
  failoverFailureThreshold: number;
  failoverOnPipelineFailure: boolean;
}

export class FailoverMonitor extends Construct {
  readonly function: lambda_nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: FailoverMonitorProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const {
      pipeline,
      primaryRegion,
      primaryPipelineName,
      secondaryPipelineName,
      deploymentControlTableName,
      deploymentControlTableArn,
      failoverCheckInterval,
      failoverFailureThreshold,
      failoverOnPipelineFailure,
    } = props;

    const failureCountParameterName =
      `/infra-pipeline/${secondaryPipelineName}/consecutive-primary-failures`;
    const lastFailoverParameterName =
      `/infra-pipeline/${secondaryPipelineName}/last-failover-key`;
    const primaryPipelineArn = stack.formatArn({
      service: 'codepipeline',
      region: primaryRegion,
      resource: primaryPipelineName,
    });
    const failoverParameterPrefixArn = stack.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: `infra-pipeline/${secondaryPipelineName}/*`,
    });

    this.function = new lambda_nodejs.NodejsFunction(
      this,
      'PrimaryPipelineFailoverMonitor',
      {
        entry: path.join(
          process.cwd(),
          'lambda',
          'failover-monitor',
          'index.ts',
        ),
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(60),
        environment: {
          PRIMARY_REGION: primaryRegion,
          PRIMARY_PIPELINE_NAME: primaryPipelineName,
          SECONDARY_PIPELINE_NAME: secondaryPipelineName,
          FAILURE_COUNT_PARAMETER: failureCountParameterName,
          LAST_FAILOVER_PARAMETER: lastFailoverParameterName,
          FAILURE_THRESHOLD: failoverFailureThreshold.toString(),
          FAILOVER_ON_PIPELINE_FAILURE: failoverOnPipelineFailure
            ? 'true'
            : 'false',
          DEPLOYMENT_CONTROL_TABLE_NAME: deploymentControlTableName,
        },
        bundling: {
          minify: true,
          sourceMap: true,
        },
      },
    );

    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'codepipeline:GetPipelineState',
          'codepipeline:ListPipelineExecutions',
        ],
        resources: [primaryPipelineArn],
      }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'codepipeline:GetPipelineState',
          'codepipeline:ListPipelineExecutions',
          'codepipeline:StartPipelineExecution',
        ],
        resources: [pipeline.pipelineArn],
      }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [failoverParameterPrefixArn],
      }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [deploymentControlTableArn],
      }),
    );

    new events.Rule(this, 'PrimaryPipelineFailoverSchedule', {
      description: `Checks ${primaryPipelineName} in ${primaryRegion} and starts secondary pipeline on failover`,
      schedule: events.Schedule.rate(failoverCheckInterval),
      targets: [new events_targets.LambdaFunction(this.function)],
    });
  }
}
