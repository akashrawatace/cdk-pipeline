import {
  CodePipelineClient,
  ListPipelineExecutionsCommand,
  StartPipelineExecutionCommand,
} from '@aws-sdk/client-codepipeline';
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';

const primary = new CodePipelineClient({
  region: mustGetEnv('PRIMARY_REGION'),
});
const secondary = new CodePipelineClient({});
const ssm = new SSMClient({});

const primaryPipelineName = mustGetEnv('PRIMARY_PIPELINE_NAME');
const secondaryPipelineName = mustGetEnv('SECONDARY_PIPELINE_NAME');
const failureCountParameter = mustGetEnv('FAILURE_COUNT_PARAMETER');
const lastFailoverParameter = mustGetEnv('LAST_FAILOVER_PARAMETER');
const failureThreshold = Number.parseInt(mustGetEnv('FAILURE_THRESHOLD'), 10);
const failoverOnPipelineFailure =
  mustGetEnv('FAILOVER_ON_PIPELINE_FAILURE').toLowerCase() === 'true';

const terminalFailureStatuses = new Set([
  'Failed',
  'Cancelled',
  'Stopped',
  'Stopping',
]);
const runningStatuses = new Set(['InProgress', 'Stopping']);

interface FailoverResponse {
  failoverStarted: boolean;
  reason?: string;
  message?: string;
  pipelineExecutionId?: string;
  primaryStatus?: string;
  consecutiveFailures?: number;
  errorType?: string;
}

export const handler = async (): Promise<FailoverResponse> => {
  try {
    const executions = await primary.send(
      new ListPipelineExecutionsCommand({
        pipelineName: primaryPipelineName,
        maxResults: 1,
      }),
    );
    const latestExecution = executions.pipelineExecutionSummaries?.[0];
    const latestStatus = latestExecution?.status ?? 'NoExecutions';
    const latestExecutionId =
      latestExecution?.pipelineExecutionId ?? 'NoExecutions';

    await setParameter(failureCountParameter, '0');

    if (latestStatus === 'Succeeded') {
      await setParameter(lastFailoverParameter, '');
    }

    if (
      failoverOnPipelineFailure &&
      terminalFailureStatuses.has(latestStatus)
    ) {
      return startSecondary(
        `primary pipeline status is ${latestStatus}`,
        `failed:${latestExecutionId}`,
      );
    }

    return {
      failoverStarted: false,
      primaryStatus: latestStatus,
    };
  } catch (error) {
    const failures =
      Number.parseInt(await getParameter(failureCountParameter, '0'), 10) + 1;
    await setParameter(failureCountParameter, failures.toString());

    if (failures >= failureThreshold) {
      return startSecondary(
        `primary pipeline health check failed ${failures} consecutive times: ${getErrorName(error)}`,
        'unreachable',
      );
    }

    return {
      failoverStarted: false,
      consecutiveFailures: failures,
      errorType: getErrorName(error),
    };
  }
};

async function startSecondary(
  reason: string,
  failoverKey: string,
): Promise<FailoverResponse> {
  if ((await getParameter(lastFailoverParameter, '')) === failoverKey) {
    return {
      failoverStarted: false,
      reason,
      message: 'failover already handled',
    };
  }

  if (await secondaryIsRunning()) {
    return {
      failoverStarted: false,
      reason,
      message: 'secondary already running',
    };
  }

  const response = await secondary.send(
    new StartPipelineExecutionCommand({
      name: secondaryPipelineName,
    }),
  );
  await setParameter(lastFailoverParameter, failoverKey);

  return {
    failoverStarted: true,
    reason,
    pipelineExecutionId: response.pipelineExecutionId,
  };
}

async function secondaryIsRunning(): Promise<boolean> {
  const executions = await secondary.send(
    new ListPipelineExecutionsCommand({
      pipelineName: secondaryPipelineName,
      maxResults: 1,
    }),
  );
  const latestStatus = executions.pipelineExecutionSummaries?.[0]?.status;

  return latestStatus !== undefined && runningStatuses.has(latestStatus);
}

async function getParameter(name: string, defaultValue: string): Promise<string> {
  try {
    const response = await ssm.send(new GetParameterCommand({ Name: name }));
    return response.Parameter?.Value ?? defaultValue;
  } catch (error) {
    if (error instanceof ParameterNotFound) {
      return defaultValue;
    }

    throw error;
  }
}

async function setParameter(name: string, value: string): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: 'String',
      Overwrite: true,
    }),
  );
}

function mustGetEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
