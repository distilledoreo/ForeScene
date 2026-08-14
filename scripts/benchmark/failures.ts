import type { BenchmarkFailure, BenchmarkFailureClass } from './types';

export const APPLICATION_DEFECT_CODE = 'application_defect' as const;

const INFRA_OPERATION_HINTS = [
  /timed? ?out/i,
  /singletonlock|profile is in use|processsingleton/i,
  /orphaned chromium|browser closed/i,
  /no forescene dev server/i,
  /econnrefused|enotfound/i,
];

const APPLICATION_DEFECT_HINTS = [
  /application_defect/i,
  /persist(?:ence)?(?:\/export)?(?:\/rehydrat(?:e|ion))?(?:\/package)? mismatch/i,
  /rehydrat/i,
  /backup identity|package identity|embedded project\.json/i,
  /explicit null|linkedPanoId/i,
  /model binary is missing|missing binary model/i,
];

export function classifyCliFailure(input: {
  operation?: string;
  message: string;
  exitCode?: number;
  code?: string;
}): BenchmarkFailure {
  const message = input.message;
  if (INFRA_OPERATION_HINTS.some((pattern) => pattern.test(message))) {
    return {
      class: 'INFRASTRUCTURE_FAILURE',
      operation: input.operation,
      message,
    };
  }
  if (
    input.code === APPLICATION_DEFECT_CODE
    || APPLICATION_DEFECT_HINTS.some((pattern) => pattern.test(message))
  ) {
    return {
      class: 'INFRASTRUCTURE_FAILURE',
      code: APPLICATION_DEFECT_CODE,
      operation: input.operation,
      message,
    };
  }
  if (input.exitCode === 2) {
    return {
      class: 'HARNESS_FAILURE',
      operation: input.operation,
      message,
    };
  }
  return {
    class: 'MODEL_FAILURE',
    operation: input.operation,
    message,
  };
}

export function infrastructureFailure(operation: string, message: string): BenchmarkFailure {
  return { class: 'INFRASTRUCTURE_FAILURE', operation, message };
}

export function applicationDefect(operation: string, message: string): BenchmarkFailure {
  return {
    class: 'INFRASTRUCTURE_FAILURE',
    code: APPLICATION_DEFECT_CODE,
    operation,
    message,
  };
}

export function environmentFailure(message: string): BenchmarkFailure {
  return { class: 'ENVIRONMENT_FAILURE', message };
}

export function harnessFailure(message: string): BenchmarkFailure {
  return { class: 'HARNESS_FAILURE', message };
}

export function modelFailure(message: string, operation?: string): BenchmarkFailure {
  return { class: 'MODEL_FAILURE', operation, message };
}

export function isStopTheRun(failure: BenchmarkFailure): boolean {
  const stop: BenchmarkFailureClass[] = ['INFRASTRUCTURE_FAILURE', 'HARNESS_FAILURE', 'ENVIRONMENT_FAILURE'];
  return stop.includes(failure.class);
}
