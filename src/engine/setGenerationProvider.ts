import type { BlueprintDiagnostic } from '../domain/setBlueprint';
import {
  buildSetBlueprintRepairPrompt,
  buildSetBlueprintSystemPrompt,
  buildSetBlueprintUserPrompt,
} from './setBlueprintPrompt';
import { parseSetBlueprint } from './setBlueprintValidation';
import type { SetBlueprint, SetBlueprintParseResult } from '../domain/setBlueprint';

export type SetGenerationDetailLevel = 'simple' | 'standard' | 'detailed';

export interface SetGenerationRequest {
  description: string;
  approximateWidthMeters?: number;
  approximateDepthMeters?: number;
  detailLevel?: SetGenerationDetailLevel;
  constraints?: string;
  /** Abort signal for HTTP / local providers. */
  signal?: AbortSignal;
}

/**
 * Provider boundary: the UI must not know about Gemini, OpenAI, Anthropic, or any specific model.
 * Implementations return untrusted JSON that must always pass through parseSetBlueprint.
 */
export interface SetGenerationProvider {
  readonly id: string;
  readonly label: string;
  generateSet(request: SetGenerationRequest): Promise<unknown>;
}

export interface GenerateValidatedSetOptions {
  provider: SetGenerationProvider;
  request: SetGenerationRequest;
  /** When true (default), retry once with validation errors if the first parse fails. */
  repairOnce?: boolean;
}

export interface GenerateValidatedSetResult {
  blueprint?: SetBlueprint;
  parse: SetBlueprintParseResult;
  /** Raw provider payloads (original, then repair attempt if any). */
  rawOutputs: unknown[];
  repaired: boolean;
}

/** Manual provider: does not call a model. The UI pastes JSON separately. */
export class ManualSetGenerationProvider implements SetGenerationProvider {
  readonly id = 'manual';
  readonly label = 'Paste blueprint JSON';

  async generateSet(_request: SetGenerationRequest): Promise<unknown> {
    throw new Error(
      'Manual provider does not generate sets. Copy the system prompt into an external model, then paste the JSON result.',
    );
  }

  getSystemPrompt(): string {
    return buildSetBlueprintSystemPrompt();
  }

  getUserPrompt(request: SetGenerationRequest): string {
    return buildSetBlueprintUserPrompt(request);
  }
}

export interface HttpSetGenerationProviderOptions {
  /** Absolute or same-origin URL. Credentials stay server-side. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

function readViteSetGenerationEndpoint(): string | undefined {
  try {
    const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
    const value = meta.env?.VITE_SET_GENERATION_ENDPOINT;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HTTP provider: POSTs the generation request to a configurable endpoint.
 * The endpoint must return a SetBlueprint JSON body (or `{ blueprint: … }`), never a native LocationProject.
 */
export class HttpSetGenerationProvider implements SetGenerationProvider {
  readonly id = 'http';
  readonly label = 'HTTP generate-set endpoint';

  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpSetGenerationProviderOptions = {}) {
    this.endpoint = options.endpoint
      ?? readViteSetGenerationEndpoint()
      ?? '/api/generate-set';
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  async generateSet(request: SetGenerationRequest): Promise<unknown> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        systemPrompt: buildSetBlueprintSystemPrompt(),
        userPrompt: buildSetBlueprintUserPrompt(request),
        request: {
          description: request.description,
          approximateWidthMeters: request.approximateWidthMeters,
          approximateDepthMeters: request.approximateDepthMeters,
          detailLevel: request.detailLevel,
          constraints: request.constraints,
        },
      }),
      signal: request.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Set generation endpoint returned ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`,
      );
    }
    const payload = await response.json() as unknown;
    return unwrapBlueprintPayload(payload);
  }

  async repairSet(params: {
    originalOutput: string;
    errors: BlueprintDiagnostic[];
    signal?: AbortSignal;
  }): Promise<unknown> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        systemPrompt: buildSetBlueprintSystemPrompt(),
        userPrompt: buildSetBlueprintRepairPrompt({
          originalOutput: params.originalOutput,
          errorMessages: params.errors.map((error) => formatDiagnostic(error)),
        }),
        repair: true,
      }),
      signal: params.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Set generation repair endpoint returned ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`,
      );
    }
    const payload = await response.json() as unknown;
    return unwrapBlueprintPayload(payload);
  }
}

/**
 * Run a provider, validate the result, and optionally retry once with a repair prompt.
 * Preserves original output; never loops indefinitely.
 */
export async function generateValidatedSet(
  options: GenerateValidatedSetOptions,
): Promise<GenerateValidatedSetResult> {
  const rawOutputs: unknown[] = [];
  const first = await options.provider.generateSet(options.request);
  rawOutputs.push(first);
  let parse = parseSetBlueprint(first);
  if (parse.blueprint || options.repairOnce === false) {
    return { blueprint: parse.blueprint, parse, rawOutputs, repaired: false };
  }

  const provider = options.provider;
  if (!('repairSet' in provider) || typeof (provider as HttpSetGenerationProvider).repairSet !== 'function') {
    return { blueprint: undefined, parse, rawOutputs, repaired: false };
  }

  const originalOutput = typeof first === 'string' ? first : JSON.stringify(first, null, 2);
  const repairedRaw = await (provider as HttpSetGenerationProvider).repairSet({
    originalOutput,
    errors: parse.errors,
    signal: options.request.signal,
  });
  rawOutputs.push(repairedRaw);
  parse = parseSetBlueprint(repairedRaw);
  return {
    blueprint: parse.blueprint,
    parse,
    rawOutputs,
    repaired: true,
  };
}

export function unwrapBlueprintPayload(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if ('blueprint' in record) return record.blueprint;
  }
  return payload;
}

export function formatDiagnostic(diagnostic: BlueprintDiagnostic): string {
  const where = diagnostic.path ? ` (${diagnostic.path})` : diagnostic.key ? ` (key=${diagnostic.key})` : '';
  return `${diagnostic.code}${where}: ${diagnostic.message}`;
}

/** Resolve the active provider from environment without teaching the UI about vendors. */
export function resolveSetGenerationProvider(
  options: HttpSetGenerationProviderOptions = {},
): SetGenerationProvider {
  const endpoint = options.endpoint ?? readViteSetGenerationEndpoint();
  if (typeof endpoint === 'string' && endpoint.trim()) {
    return new HttpSetGenerationProvider({ ...options, endpoint: endpoint.trim() });
  }
  return new ManualSetGenerationProvider();
}
