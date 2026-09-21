import * as vm from 'node:vm';
import type { LocationProject } from '../../src/domain/types';
import { AGENT_PLAN_LIMITS } from '../../src/engine/agent/constants';
import { projectFingerprint } from '../../src/engine/agent/planDiff';
import type { ForeSceneAgentCommand, ForeSceneAgentPlan } from '../../src/engine/agent/protocol';

export const AGENT_SCRIPT_LIMITS = {
  maxSourceBytes: 128 * 1024,
  defaultTimeoutMs: 2_000,
  maxTimeoutMs: 5_000,
} as const;

export interface AgentScriptCompileOptions {
  fileName?: string;
  timeoutMs?: number;
}

export interface AgentScriptCompileResult {
  plan: ForeSceneAgentPlan;
  sourceBytes: number;
  commandCount: number;
  timeoutMs: number;
}

interface RawAgentScriptResult {
  description?: string;
  commands: ForeSceneAgentCommand[];
}

function resolveTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? AGENT_SCRIPT_LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Agent script timeout must be a positive finite number.');
  }
  return Math.min(Math.floor(timeoutMs), AGENT_SCRIPT_LIMITS.maxTimeoutMs);
}

function buildProgram(projectJson: string, source: string): string {
  return `(() => {
    "use strict";
    const __commands = [];
    const __counts = { object: 0, shot: 0, landmark: 0 };
    let __description;

    function __deepFreeze(value) {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) __deepFreeze(value[key]);
      }
      return value;
    }

    function __emit(command) {
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        throw new TypeError('ForeScene script commands must be objects.');
      }
      if (__commands.length >= ${AGENT_PLAN_LIMITS.maxCommands}) {
        throw new Error('ForeScene script command limit exceeded (${AGENT_PLAN_LIMITS.maxCommands}). Split the work into multiple scripts.');
      }
      __commands.push(command);
      return command;
    }

    function __nextRef(kind) {
      __counts[kind] += 1;
      return 'script_' + kind + '_' + __counts[kind];
    }

    function __target(value) {
      if (typeof value === 'string') return { id: value };
      if (!value || typeof value !== 'object') {
        throw new TypeError('Expected an entity id, ref, shotNumber, query, or project entity.');
      }
      if (typeof value.ref === 'string') return { ref: value.ref };
      if (typeof value.id === 'string') return { id: value.id };
      if (typeof value.shotNumber === 'string') return { shotNumber: value.shotNumber };
      if (value.query && typeof value.query === 'object') return { query: { ...value.query } };
      throw new TypeError('Target has no id, ref, shotNumber, or query.');
    }

    function __matches(value, query) {
      if (!query || typeof query !== 'object') return true;
      const mode = query.match === 'contains' ? 'contains' : 'exact';
      for (const [key, expected] of Object.entries(query)) {
        if (key === 'match' || expected === undefined) continue;
        const actual = value[key];
        if (key === 'name') {
          const left = String(actual ?? '').toLowerCase();
          const right = String(expected).toLowerCase();
          if (mode === 'contains' ? !left.includes(right) : left !== right) return false;
        } else if (actual !== expected) {
          return false;
        }
      }
      return true;
    }

    const project = __deepFreeze(${projectJson});

    const target = __deepFreeze({
      id: (id) => __deepFreeze({ id: String(id) }),
      ref: (ref) => __deepFreeze({ ref: String(ref) }),
      shotNumber: (shotNumber) => __deepFreeze({ shotNumber: String(shotNumber) }),
      query: (query) => __deepFreeze({ query: { ...query } }),
    });

    const scene = __deepFreeze({
      list: () => project.scene.objects,
      find: (query) => project.scene.objects.find((value) => __matches(value, query)),
      findAll: (query) => project.scene.objects.filter((value) => __matches(value, query)),
      require(query) {
        const value = this.find(query);
        if (!value) throw new Error('No scene object matched ' + JSON.stringify(query));
        return value;
      },
      create(type, options = {}) {
        const { ref, ...object } = options;
        const createdRef = typeof ref === 'string' ? ref : __nextRef('object');
        __emit({ op: 'object.create', ref: createdRef, object: { ...object, type } });
        return __deepFreeze({ ref: createdRef });
      },
      update(object, updates) {
        __emit({ op: 'object.update', object: __target(object), updates });
      },
      delete(object) {
        __emit({ op: 'object.delete', object: __target(object) });
      },
      duplicate(object, options = {}) {
        const createdRef = typeof options.ref === 'string' ? options.ref : __nextRef('object');
        __emit({ op: 'object.duplicate', object: __target(object), ref: createdRef });
        if (options.updates && typeof options.updates === 'object') {
          __emit({ op: 'object.update', object: { ref: createdRef }, updates: options.updates });
        }
        return __deepFreeze({ ref: createdRef });
      },
    });

    const shots = __deepFreeze({
      list: () => project.shots,
      find: (query) => project.shots.find((value) => __matches(value, query)),
      findAll: (query) => project.shots.filter((value) => __matches(value, query)),
      require(query) {
        const value = this.find(query);
        if (!value) throw new Error('No shot matched ' + JSON.stringify(query));
        return value;
      },
      create(options = {}) {
        const { ref, ...shot } = options;
        const createdRef = typeof ref === 'string' ? ref : __nextRef('shot');
        __emit({ op: 'shot.create', ref: createdRef, shot });
        return __deepFreeze({ ref: createdRef });
      },
      rename(shot, name) {
        __emit({ op: 'shot.rename', shot: __target(shot), name });
      },
      describe(shot, description) {
        __emit({ op: 'shot.updateDescription', shot: __target(shot), description });
      },
      camera(shot, camera) {
        __emit({ op: 'shot.updateCamera', shot: __target(shot), camera });
      },
      frameSubjects(shot, subjects, composition) {
        __emit({
          op: 'shot.frameSubjects',
          shot: __target(shot),
          subjects: subjects.map(__target),
          ...(composition ? { composition } : {}),
        });
      },
      stage(shot, object, options = {}) {
        __emit({ op: 'shot.stageObject', shot: __target(shot), object: __target(object), ...options });
      },
      clearStaging(shot, object) {
        __emit({
          op: 'shot.clearStaging',
          shot: __target(shot),
          ...(object ? { object: __target(object) } : {}),
        });
      },
      delete(shot) {
        __emit({ op: 'shot.delete', shot: __target(shot) });
      },
    });

    const landmarks = __deepFreeze({
      list: () => project.landmarks,
      find: (query) => project.landmarks.find((value) => __matches(value, query)),
      findAll: (query) => project.landmarks.filter((value) => __matches(value, query)),
      require(query) {
        const value = this.find(query);
        if (!value) throw new Error('No landmark matched ' + JSON.stringify(query));
        return value;
      },
      create(options = {}) {
        const { ref, ...landmark } = options;
        const createdRef = typeof ref === 'string' ? ref : __nextRef('landmark');
        __emit({ op: 'landmark.create', ref: createdRef, landmark });
        return __deepFreeze({ ref: createdRef });
      },
      update(landmark, updates) {
        __emit({ op: 'landmark.update', landmark: __target(landmark), updates });
      },
      link(landmark, object) {
        __emit({
          op: 'landmark.linkObject',
          landmark: __target(landmark),
          object: object === null ? null : __target(object),
        });
      },
      delete(landmark) {
        __emit({ op: 'landmark.delete', landmark: __target(landmark) });
      },
    });

    const workspace = __deepFreeze({
      open(value) {
        __emit({ op: 'workspace.open', workspace: value });
      },
    });

    const plan = __deepFreeze({
      description(value) {
        __description = String(value);
      },
      command(command) {
        return __emit(command);
      },
    });

    ${source}

    return JSON.stringify({
      ...(__description ? { description: __description } : {}),
      commands: __commands,
    });
  })()`;
}

function parseResult(serialized: unknown): RawAgentScriptResult {
  if (typeof serialized !== 'string') {
    throw new Error('ForeScene agent script did not produce a serialized plan.');
  }
  const parsed = JSON.parse(serialized) as Partial<RawAgentScriptResult>;
  if (!Array.isArray(parsed.commands)) {
    throw new Error('ForeScene agent script did not produce a command array.');
  }
  if (parsed.commands.length > AGENT_PLAN_LIMITS.maxCommands) {
    throw new Error(`ForeScene agent script produced ${parsed.commands.length} commands; maximum is ${AGENT_PLAN_LIMITS.maxCommands}.`);
  }
  if (parsed.description !== undefined && typeof parsed.description !== 'string') {
    throw new Error('ForeScene agent script description must be a string.');
  }
  return parsed as RawAgentScriptResult;
}

export function compileAgentScript(
  source: string,
  project: LocationProject,
  options: AgentScriptCompileOptions = {},
): AgentScriptCompileResult {
  if (typeof source !== 'string') throw new TypeError('Agent script source must be a string.');
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes > AGENT_SCRIPT_LIMITS.maxSourceBytes) {
    throw new Error(`Agent script is ${sourceBytes} bytes; maximum is ${AGENT_SCRIPT_LIMITS.maxSourceBytes}.`);
  }
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const projectJson = JSON.stringify(project);
  if (!projectJson) throw new Error('Could not serialize the current ForeScene project for scripting.');

  const context = vm.createContext(Object.create(null), {
    name: 'ForeScene Agent Script',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });

  let raw: unknown;
  try {
    raw = new vm.Script(buildProgram(projectJson, source), {
      filename: options.fileName ?? 'forescene-agent-script.js',
    }).runInContext(context, { timeout: timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ForeScene agent script failed: ${message}`);
  }

  const result = parseResult(raw);
  const plan: ForeSceneAgentPlan = {
    version: 1,
    ...(result.description ? { description: result.description } : {}),
    expectedFingerprint: projectFingerprint(project),
    commands: result.commands,
  };
  return { plan, sourceBytes, commandCount: result.commands.length, timeoutMs };
}
