#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

new PipelineStack(app, 'PipelineStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-southeast-1',
  },
  approvalEmail: 'akash.rawat@acelucid.com',
  terraformVersion: '1.9.8',
  description: 'Bootstrapping and supporting infrastructure for Terraform-based landing zone deployment',
});

app.synth();
