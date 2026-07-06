#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const primaryRegion = process.env.CDK_DEFAULT_REGION || 'ap-southeast-1';
const secondaryRegion =
  app.node.tryGetContext('secondaryRegion') ||
  process.env.SECONDARY_REGION ||
  'ap-south-1';

const commonProps = {
  approvalEmail: 'akash.rawat@acelucid.com',
  terraformVersion: '1.9.8',
  primaryRegion,
  secondaryRegion,
  description:
    'Bootstrapping and supporting infrastructure for Terraform-based landing zone deployment',
};

new PipelineStack(app, 'PipelineStackPrimary', {
  env: {
    account,
    region: primaryRegion,
  },
  ...commonProps,
  regionRole: 'primary',
});

new PipelineStack(app, 'PipelineStackSecondary', {
  env: {
    account,
    region: secondaryRegion,
  },
  ...commonProps,
  regionRole: 'secondary',
});

app.synth();
