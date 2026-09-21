import { compileAgentScript } from '../../scripts/agent/agentScript.ts';
import type { LocationProject } from '../../src/domain/types.ts';
import type { AgentObjectQuery } from '../../src/engine/agent/protocol.ts';
import { prepareAgentPlan } from '../../src/engine/agent/planCompiler.ts';
import {
  AGENT_SPATIAL_AUTHORING_REFERENCE,
  inspectSceneSpatially,
  validateSpatialAuthoring,
} from '../../src/engine/agent/spatialAuthoring.ts';
import {
  authenticateRemoteAgentRequest,
  noStoreJson,
  RemoteAgentRelayError,
  runRemoteBrowserCommand,
  unauthorizedResponse,
} from '../lib/remoteAgentStore.ts';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOL_DEFINITIONS = [
  {
    name: 'agent_reference',
    description: 'Read the ForeScene coordinate system, primitive placement semantics, spatial workflow, and architecture scripting reference. Call this before substantial scene construction.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'project_inspect',
    description: 'Inspect the project currently open in the connected ForeScene browser tab.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'scene_query',
    description: 'List ForeScene scene objects using structured filters.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string' },
        stagingRole: { type: 'string', enum: ['set', 'prop', 'person'] },
        match: { type: 'string', enum: ['exact', 'contains'] },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'scene_inspect',
    description: 'Inspect matching objects with transforms, dimensions, world-space bounds, supports, semantic cutter/host relationships, and explained versus unexplained intersections.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string' },
        stagingRole: { type: 'string', enum: ['set', 'prop', 'person'] },
        match: { type: 'string', enum: ['exact', 'contains'] },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'scene_validate',
    description: 'Run spatial/architectural preflight. Includes automatic doorway-host resolution, portal threshold support, bounded stair-clearance checks, duplicate supports, story/axis errors, and substantial unexplained intersections.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'object', description: 'Optional Agent Plan to validate hypothetically without applying it.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'scene_capture',
    description: 'Render an authoring inspection image from an isometric or orthographic build view. Use after substantial construction and after fixes.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['isometric', 'top', 'front', 'back', 'left', 'right'] },
        width: { type: 'number', minimum: 128, maximum: 1280 },
        height: { type: 'number', minimum: 128, maximum: 1024 },
        levelId: { type: 'string' },
        padding: { type: 'number', minimum: 1.02, maximum: 3 },
        plan: { type: 'object', description: 'Optional Agent Plan to render hypothetically without applying it.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'project_script',
    description: 'Compile a stateful ForeScene agent script against the live project and return the normal validated preview. This never applies the plan. Doorways placed through one compatible wall automatically cut it; stairs automatically cut the nearest eligible floor/slab layer in their bounded upper clearance. For substantial construction, call agent_reference, then scene_validate and scene_capture before applying.',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', minLength: 1 } },
      required: ['script'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_apply',
    description: 'Apply a previously previewed ForeScene Agent Plan. Requires a browser session connected with editing enabled. For substantial spatial builds, validate and visually inspect the preview/design before finalizing.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'object' },
        expectedRevisionId: { type: 'string' },
        allowSpatialErrors: { type: 'boolean', description: 'Explicitly allow new spatial preflight errors for intentionally unusual geometry.' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
  },
  {
    name: 'shot_render',
    description: 'Render a shot in the connected ForeScene browser. Returns render metadata and artifact handles; large inline image data is omitted from the relay response.',
    inputSchema: {
      type: 'object',
      properties: {
        shotId: { type: 'string' },
        appearance: { type: 'string', enum: ['clay', 'projected', 'depth'] },
        timeSeconds: { type: 'number' },
        peopleVariant: { type: 'string' },
      },
      required: ['shotId'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_verify',
    description: 'Run project health inspection and visual preflight in the connected ForeScene browser.',
    inputSchema: {
      type: 'object',
      properties: {
        shotIds: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
] as const;

function rpcResponse(id: JsonRpcId, result: unknown, status = 200): Response {
  return noStoreJson({ jsonrpc: '2.0', id, result }, { status });
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown, status = 200): Response {
  return noStoreJson({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }, { status });
}

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function toolError(code: string, message: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { ok: false, error: { code, message } },
  };
}

async function callTool(
  token: string,
  accessMode: 'read-only' | 'read-write',
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'agent_reference':
      return AGENT_SPATIAL_AUTHORING_REFERENCE;

    case 'project_inspect':
      return runRemoteBrowserCommand(token, 'project.inspect', {}, { timeoutMs: 20_000 });

    case 'scene_query':
      return runRemoteBrowserCommand(token, 'scene.query', { query: args }, { timeoutMs: 20_000 });

    case 'scene_inspect': {
      const project = await runRemoteBrowserCommand(
        token,
        'project.document',
        {},
        { timeoutMs: 18_000 },
      ) as LocationProject;
      return inspectSceneSpatially(project, args as AgentObjectQuery);
    }

    case 'scene_validate': {
      const project = await runRemoteBrowserCommand(
        token,
        'project.document',
        {},
        { timeoutMs: 18_000 },
      ) as LocationProject;
      if (args.plan && typeof args.plan === 'object' && !Array.isArray(args.plan)) {
        const prepared = prepareAgentPlan(args.plan, {
          project,
          workspace: 'build',
          selectedObjectIds: [],
          selectedShotId: project.shots[0]?.id,
          gridSnap: false,
        });
        if (!prepared.ok) {
          return {
            ok: false,
            planValid: false,
            diagnostics: prepared.diagnostics,
            warnings: prepared.warnings,
          };
        }
        return {
          ...validateSpatialAuthoring(prepared.prepared.nextProject),
          planValid: true,
          planSummary: prepared.prepared.summary,
        };
      }
      return validateSpatialAuthoring(project);
    }

    case 'scene_capture':
      return runRemoteBrowserCommand(token, 'scene.capture', args, { timeoutMs: 35_000 });

    case 'project_script': {
      const script = typeof args.script === 'string' ? args.script : '';
      if (!script.trim()) throw new RemoteAgentRelayError('invalid_argument', 'script is required.');
      const project = await runRemoteBrowserCommand(
        token,
        'project.document',
        {},
        { timeoutMs: 18_000 },
      ) as LocationProject;
      const compiled = compileAgentScript(script, project, { fileName: 'remote-mcp-script.js' });
      const preview = await runRemoteBrowserCommand(
        token,
        'project.preview_plan',
        { plan: compiled.plan },
        { timeoutMs: 22_000 },
      );
      const prepared = prepareAgentPlan(compiled.plan, {
        project,
        workspace: 'build',
        selectedObjectIds: [],
        selectedShotId: project.shots[0]?.id,
        gridSnap: false,
      });
      const spatialValidation = prepared.ok
        ? validateSpatialAuthoring(prepared.prepared.nextProject)
        : undefined;
      return {
        ok: Boolean((preview as { ok?: boolean } | undefined)?.ok) && prepared.ok,
        readyToApply: Boolean((preview as { ok?: boolean } | undefined)?.ok)
          && prepared.ok
          && Boolean(spatialValidation?.ok),
        compiled: {
          sourceBytes: compiled.sourceBytes,
          commandCount: compiled.commandCount,
          expandedCommandCount: compiled.expandedCommandCount,
          timeoutMs: compiled.timeoutMs,
        },
        plan: compiled.plan,
        preview,
        spatialValidation,
        ...(prepared.ok ? {} : { localPreparationDiagnostics: prepared.diagnostics }),
      };
    }

    case 'project_apply': {
      if (accessMode !== 'read-write') {
        throw new RemoteAgentRelayError('write_access_required', 'Reconnect ForeScene with editing enabled before applying a plan.');
      }
      if (!args.plan || typeof args.plan !== 'object' || Array.isArray(args.plan)) {
        throw new RemoteAgentRelayError('invalid_argument', 'plan must be an Agent Plan object.');
      }

      const project = await runRemoteBrowserCommand(
        token,
        'project.document',
        {},
        { timeoutMs: 18_000 },
      ) as LocationProject;
      const prepared = prepareAgentPlan(args.plan, {
        project,
        workspace: 'build',
        selectedObjectIds: [],
        selectedShotId: project.shots[0]?.id,
        gridSnap: false,
      });
      if (!prepared.ok) {
        return {
          ok: false,
          blocked: true,
          error: { code: 'invalid_plan', message: 'Plan failed local preparation before apply.' },
          diagnostics: prepared.diagnostics,
          warnings: prepared.warnings,
        };
      }
      const baselineSpatial = validateSpatialAuthoring(project);
      const proposedSpatial = validateSpatialAuthoring(prepared.prepared.nextProject);
      const baselineErrorKeys = new Set(
        baselineSpatial.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.code + ':' + [...issue.objectIds].sort().join(',')),
      );
      const newSpatialErrors = proposedSpatial.issues.filter((issue) => (
        issue.severity === 'error'
        && !baselineErrorKeys.has(issue.code + ':' + [...issue.objectIds].sort().join(','))
      ));
      if (newSpatialErrors.length > 0 && args.allowSpatialErrors !== true) {
        return {
          ok: false,
          blocked: true,
          error: {
            code: 'spatial_validation_failed',
            message: 'Apply blocked because the plan introduces new spatial-authoring errors. Fix them or explicitly set allowSpatialErrors=true.',
          },
          newSpatialErrors,
          spatialValidation: proposedSpatial,
        };
      }

      return runRemoteBrowserCommand(
        token,
        'project.apply_plan',
        {
          plan: args.plan,
          ...(typeof args.expectedRevisionId === 'string'
            ? { expectedRevisionId: args.expectedRevisionId }
            : {}),
        },
        { timeoutMs: 45_000, requiresWrite: true },
      );
    }

    case 'shot_render':
      return runRemoteBrowserCommand(token, 'shot.render', args, { timeoutMs: 45_000 });

    case 'project_verify': {
      const browserVerification = await runRemoteBrowserCommand(
        token,
        'project.verify',
        args,
        { timeoutMs: 45_000 },
      );
      const project = await runRemoteBrowserCommand(
        token,
        'project.document',
        {},
        { timeoutMs: 18_000 },
      ) as LocationProject;
      const spatialAuthoring = validateSpatialAuthoring(project);
      return {
        ...(browserVerification && typeof browserVerification === 'object'
          ? browserVerification as Record<string, unknown>
          : { browserVerification }),
        spatialAuthoring,
        ok: Boolean((browserVerification as { ok?: boolean } | undefined)?.ok) && spatialAuthoring.ok,
      };
    }

    default:
      throw new RemoteAgentRelayError('unknown_tool', `Unknown ForeScene tool "${name}".`);
  }
}

export default async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'POST', 'cache-control': 'no-store' },
    });
  }

  const auth = await authenticateRemoteAgentRequest(req);
  if (!auth) return unauthorizedResponse();

  const message = await req.json().catch(() => undefined) as JsonRpcRequest | undefined;
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC request.', undefined, 400);
  }

  const id = message.id ?? null;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
  }

  if (message.method === 'initialize') {
    return rpcResponse(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'ForeScene Remote',
        version: '0.1.0',
        description: 'Controls the ForeScene project in the paired browser tab.',
      },
      instructions: 'Use project_script for procedural scene work. It previews only; call project_apply separately to commit changes.',
    });
  }

  if (message.method === 'ping') return rpcResponse(id, {});

  if (message.method === 'tools/list') {
    return rpcResponse(id, { tools: TOOL_DEFINITIONS });
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments;
    if (typeof name !== 'string') return rpcError(id, -32602, 'tools/call requires params.name.');
    const toolArgs = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    try {
      const result = await callTool(auth.token, auth.session.accessMode, name, toolArgs);
      if (
        name === 'scene_capture'
        && result
        && typeof result === 'object'
        && typeof (result as { dataUrl?: unknown }).dataUrl === 'string'
      ) {
        const capture = result as { dataUrl: string; mimeType?: string; [key: string]: unknown };
        const match = capture.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          const { dataUrl: _dataUrl, ...structured } = capture;
          return rpcResponse(id, {
            content: [
              { type: 'text', text: JSON.stringify(structured, null, 2) },
              { type: 'image', data: match[2], mimeType: match[1] },
            ],
            structuredContent: structured,
          });
        }
      }
      return rpcResponse(id, toolResult(result));
    } catch (error) {
      if (error instanceof RemoteAgentRelayError) {
        return rpcResponse(id, toolError(error.code, error.message));
      }
      const messageText = error instanceof Error ? error.message : 'ForeScene remote tool failed.';
      return rpcResponse(id, toolError('remote_tool_failed', messageText));
    }
  }

  // Returning method-not-found on the 2026 discovery probe intentionally lets
  // auto-negotiating clients fall back to the fully supported 2025-11-25
  // stateless Streamable HTTP behavior.
  return rpcError(id, -32601, `Method "${message.method}" is not supported by this endpoint.`);
};

export const config = {
  path: '/mcp',
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
