import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { PipelineRegionRole } from '../types';

export interface TerraformBuildProjectsProps {
  terraformVersion: string;
  regionRole: PipelineRegionRole;
  stateBucket: s3.Bucket;
  terraformLockTableName: string;
  terraformLockTableArn: string;
  deploymentControlTableName: string;
  deploymentControlTableArn: string;
}

export class TerraformBuildProjects extends Construct {
  readonly planProject: codebuild.PipelineProject;
  readonly applyProject: codebuild.PipelineProject;
  readonly planRole: iam.Role;
  readonly applyRole: iam.Role;

  constructor(scope: Construct, id: string, props: TerraformBuildProjectsProps) {
    super(scope, id);

    const {
      terraformVersion,
      regionRole,
      stateBucket,
      terraformLockTableName,
      terraformLockTableArn,
      deploymentControlTableName,
      deploymentControlTableArn,
    } = props;
    const expectedDeploymentMode =
      regionRole === 'primary' ? 'primary' : 'failover';

    this.planRole = new iam.Role(this, 'CodeBuildPlanRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'Role for Terraform plan CodeBuild project',
    });
    this.planRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
    );

    this.applyRole = new iam.Role(this, 'CodeBuildApplyRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'Role for Terraform apply CodeBuild project',
    });

    this.grantStateAccess(
      stateBucket,
      terraformLockTableArn,
      deploymentControlTableArn,
    );

    const installTerraformCommands = [
      `curl -sLO "https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_linux_amd64.zip"`,
      'unzip -q -o terraform_*.zip -d /usr/local/bin/',
      'rm -f terraform_*.zip',
      'terraform --version',
    ];

    this.planProject = new codebuild.PipelineProject(this, 'TerraformPlanProject', {
      role: this.planRole,
      description: 'Validates and previews Terraform infrastructure changes',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
      },
      environmentVariables: {
        TF_STATE_BUCKET_NAME: { value: stateBucket.bucketName },
        TF_LOCK_TABLE_NAME: { value: terraformLockTableName },
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
              'terraform init -no-color -backend-config="bucket=$TF_STATE_BUCKET_NAME" -backend-config="dynamodb_table=$TF_LOCK_TABLE_NAME" -backend-config="region=$AWS_REGION"',
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

    this.applyProject = new codebuild.PipelineProject(
      this,
      'TerraformApplyProject',
      {
        role: this.applyRole,
        description: 'Applies approved Terraform infrastructure changes',
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: codebuild.ComputeType.MEDIUM,
        },
        environmentVariables: {
          DEPLOYMENT_CONTROL_TABLE_NAME: { value: deploymentControlTableName },
          EXPECTED_DEPLOYMENT_MODE: { value: expectedDeploymentMode },
          TF_STATE_BUCKET_NAME: { value: stateBucket.bucketName },
          TF_LOCK_TABLE_NAME: { value: terraformLockTableName },
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            install: {
              'runtime-versions': { python: '3.11' },
              commands: installTerraformCommands,
            },
            pre_build: {
              commands: this.applySafetyCommands(),
            },
            build: {
              commands: [
                'terraform init -no-color -backend-config="bucket=$TF_STATE_BUCKET_NAME" -backend-config="dynamodb_table=$TF_LOCK_TABLE_NAME" -backend-config="region=$AWS_REGION"',
                'terraform apply -auto-approve -no-color 2>&1 | tee /tmp/apply-output.txt',
              ],
            },
          },
          artifacts: {
            files: ['/tmp/apply-output.txt'],
            'discard-paths': 'yes',
          },
        }),
      },
    );
  }

  private grantStateAccess(
    stateBucket: s3.Bucket,
    terraformLockTableArn: string,
    deploymentControlTableArn: string,
  ) {
    this.planRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [stateBucket.bucketArn, stateBucket.arnForObjects('*')],
      }),
    );
    this.planRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:DescribeTable',
        ],
        resources: [terraformLockTableArn],
      }),
    );

    this.applyRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:ListBucket',
          's3:DeleteObject',
        ],
        resources: [stateBucket.bucketArn, stateBucket.arnForObjects('*')],
      }),
    );
    this.applyRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:DescribeTable',
        ],
        resources: [terraformLockTableArn],
      }),
    );
    this.applyRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
          'dynamodb:UpdateItem',
          'dynamodb:DescribeTable',
        ],
        resources: [deploymentControlTableArn],
      }),
    );

    this.applyRole.addToPolicy(
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
  }

  private applySafetyCommands(): string[] {
    return [
      'echo "Checking deployment mode before Terraform apply..."',
      'DEPLOYMENT_MODE=$(aws dynamodb get-item --table-name "$DEPLOYMENT_CONTROL_TABLE_NAME" --key \'{"LockID":{"S":"deployment-mode"}}\' --query "Item.Mode.S" --output text)',
      'if [ "$DEPLOYMENT_MODE" = "None" ]; then DEPLOYMENT_MODE=primary; fi',
      'if [ "$DEPLOYMENT_MODE" != "$EXPECTED_DEPLOYMENT_MODE" ]; then echo "Deployment mode is $DEPLOYMENT_MODE; expected $EXPECTED_DEPLOYMENT_MODE. Refusing to apply."; exit 1; fi',
      'export APPLY_LOCK_OWNER="${AWS_REGION}:${CODEBUILD_BUILD_ID}"',
      'printf \'{"LockID":{"S":"terraform-apply-lock"},"Owner":{"S":"%s"},"Region":{"S":"%s"},"BuildId":{"S":"%s"},"AcquiredAt":{"S":"%s"}}\' "$APPLY_LOCK_OWNER" "$AWS_REGION" "$CODEBUILD_BUILD_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/apply-lock.json',
      'aws dynamodb put-item --table-name "$DEPLOYMENT_CONTROL_TABLE_NAME" --item file:///tmp/apply-lock.json --condition-expression "attribute_not_exists(LockID)"',
      'printf \'{":owner":{"S":"%s"}}\' "$APPLY_LOCK_OWNER" > /tmp/apply-lock-owner.json',
      'cleanup() { aws dynamodb delete-item --table-name "$DEPLOYMENT_CONTROL_TABLE_NAME" --key \'{"LockID":{"S":"terraform-apply-lock"}}\' --condition-expression "Owner = :owner" --expression-attribute-values file:///tmp/apply-lock-owner.json || true; }',
      'trap cleanup EXIT',
    ];
  }
}
