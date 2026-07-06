import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { PipelineRegionRole } from '../types';

export interface StateBackendProps {
  regionRole: PipelineRegionRole;
  primaryRegion: string;
  secondaryRegion: string;
  stateBucketName: string;
  secondaryStateBucketName: string;
  terraformLockTableName: string;
  deploymentControlTableName: string;
}

export class StateBackend extends Construct {
  readonly stateBucket: s3.Bucket;
  readonly terraformLockTableName: string;
  readonly terraformLockTableArn: string;
  readonly deploymentControlTableName: string;
  readonly deploymentControlTableArn: string;

  constructor(scope: Construct, id: string, props: StateBackendProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const {
      regionRole,
      primaryRegion,
      secondaryRegion,
      stateBucketName,
      secondaryStateBucketName,
      terraformLockTableName,
      deploymentControlTableName,
    } = props;

    this.terraformLockTableName = terraformLockTableName;
    this.deploymentControlTableName = deploymentControlTableName;

    const localRegion = regionRole === 'primary' ? primaryRegion : secondaryRegion;
    this.terraformLockTableArn = stack.formatArn({
      service: 'dynamodb',
      region: localRegion,
      resource: 'table',
      resourceName: terraformLockTableName,
    });
    this.deploymentControlTableArn = stack.formatArn({
      service: 'dynamodb',
      region: localRegion,
      resource: 'table',
      resourceName: deploymentControlTableName,
    });

    this.stateBucket = new s3.Bucket(this, 'TerraformStateBucket', {
      bucketName:
        regionRole === 'primary' ? stateBucketName : secondaryStateBucketName,
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

    if (regionRole === 'primary') {
      this.createGlobalTable('TerraformLockGlobalTable', terraformLockTableName, [
        primaryRegion,
        secondaryRegion,
      ]);
      this.createGlobalTable(
        'DeploymentControlGlobalTable',
        deploymentControlTableName,
        [primaryRegion, secondaryRegion],
      );
      this.configureOneWayStateReplication(secondaryRegion, secondaryStateBucketName);
    }
  }

  private createGlobalTable(
    id: string,
    tableName: string,
    regions: string[],
  ): dynamodb.CfnGlobalTable {
    return new dynamodb.CfnGlobalTable(this, id, {
      tableName,
      billingMode: 'PAY_PER_REQUEST',
      attributeDefinitions: [
        {
          attributeName: 'LockID',
          attributeType: 'S',
        },
      ],
      keySchema: [
        {
          attributeName: 'LockID',
          keyType: 'HASH',
        },
      ],
      replicas: regions.map((region) => ({
        region,
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true,
        },
      })),
    });
  }

  private configureOneWayStateReplication(
    secondaryRegion: string,
    secondaryStateBucketName: string,
  ) {
    const stack = cdk.Stack.of(this);
    const destinationBucketArn = stack.formatArn({
      service: 's3',
      region: '',
      account: '',
      resource: secondaryStateBucketName,
    });

    const replicationRole = new iam.Role(this, 'TerraformStateReplicationRole', {
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
      description:
        'Allows S3 to replicate Terraform state from primary to secondary region',
    });

    const replicationPolicy = new iam.Policy(
      this,
      'TerraformStateReplicationPolicy',
      {
        statements: [
          new iam.PolicyStatement({
            actions: ['s3:GetReplicationConfiguration', 's3:ListBucket'],
            resources: [this.stateBucket.bucketArn],
          }),
          new iam.PolicyStatement({
            actions: [
              's3:GetObjectVersionForReplication',
              's3:GetObjectVersionAcl',
              's3:GetObjectVersionTagging',
            ],
            resources: [this.stateBucket.arnForObjects('*')],
          }),
          new iam.PolicyStatement({
            actions: [
              's3:ReplicateObject',
              's3:ReplicateTags',
              's3:ReplicateDelete',
              's3:ObjectOwnerOverrideToBucketOwner',
            ],
            resources: [`${destinationBucketArn}/*`],
          }),
        ],
      },
    );
    replicationRole.attachInlinePolicy(replicationPolicy);

    const cfnBucket = this.stateBucket.node.defaultChild as s3.CfnBucket;
    cfnBucket.replicationConfiguration = {
      role: replicationRole.roleArn,
      rules: [
        {
          id: `ReplicateTerraformStateTo${secondaryRegion}`,
          status: 'Enabled',
          deleteMarkerReplication: {
            status: 'Disabled',
          },
          destination: {
            bucket: destinationBucketArn,
            storageClass: 'STANDARD',
          },
          filter: {
            prefix: '',
          },
        },
      ],
    };
  }
}
