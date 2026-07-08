#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { PipelineStack } from "../lib/pipeline-stack";

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const primaryRegion = process.env.CDK_DEFAULT_REGION || "ap-south-1";
const secondaryRegion =
  app.node.tryGetContext("secondaryRegion") ||
  process.env.SECONDARY_REGION ||
  "ap-southeast-1";
const stateBucketName =
  app.node.tryGetContext("stateBucketName") || "tf-state-file-ugi-demo-bucket";
const secondaryStateBucketName =
  app.node.tryGetContext("secondaryStateBucketName") ||
  `${stateBucketName}-${secondaryRegion}`;
const terraformLockTableName =
  app.node.tryGetContext("terraformLockTableName") || "tf-lock-ugi-demo-table";
const deploymentControlTableName =
  app.node.tryGetContext("deploymentControlTableName") ||
  "tf-deployment-control-ugi-demo-table";

const commonProps = {
  approvalEmail: "akash.rawat@acelucid.com",
  terraformVersion: "1.9.8",
  primaryRegion,
  secondaryRegion,
  stateBucketName,
  secondaryStateBucketName,
  terraformLockTableName,
  deploymentControlTableName,
  description:
    "Bootstrapping and supporting infrastructure for Terraform-based landing zone deployment",
};

const primaryStack = new PipelineStack(app, "PipelineStackPrimary", {
  env: {
    account,
    region: primaryRegion,
  },
  ...commonProps,
  regionRole: "primary",
});

const secondaryStack = new PipelineStack(app, "PipelineStackSecondary", {
  env: {
    account,
    region: secondaryRegion,
  },
  ...commonProps,
  regionRole: "secondary",
});

primaryStack.addDependency(secondaryStack);

app.synth();
