import * as cdk from "aws-cdk-lib";

export type PipelineRegionRole = "primary" | "secondary";

export interface PipelineStackProps extends cdk.StackProps {
  approvalEmail: string;
  terraformVersion: string;
  regionRole?: PipelineRegionRole;
  primaryRegion?: string;
  secondaryRegion?: string;
  repositoryName?: string;
  branchName?: string;
  primaryPipelineName?: string;
  secondaryPipelineName?: string;
  activeActiveSecondary?: boolean;
  failoverCheckInterval?: cdk.Duration;
  failoverFailureThreshold?: number;
  failoverOnPipelineFailure?: boolean;
  stateBucketName?: string;
  secondaryStateBucketName?: string;
  terraformLockTableName?: string;
  deploymentControlTableName?: string;
}
