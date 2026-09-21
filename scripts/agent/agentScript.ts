import vm from 'node:vm';
import type { LocationProject } from '../../src/domain/types';
import { AGENT_PLAN_LIMITS } from '../../src/engine/agent/constants';
import { projectFingerprint } from '../../src/engine/agent/planDiff';
import type { AgentEntityTarget, ForeSceneAgentCommand, ForeSceneAgentPlan } from '../../src/engine/agent/protocol';

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

type ScriptTarget = AgentEntityTarget | string | { id?: string; ref?: string; shotNumber?: string; query?: Record<string, unknown> };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function normalizeTarget(value: ScriptTarget): AgentEntityTarget {
  if (typeof value === 'string') return { id: value };
  if (!value || typeof value !== 'object') throw new TypeError('Expected an entity id, ref, shotNumber, query, or project entity.');
  if (typeof value.ref === 'string') return { ref: value.ref };
  if (typeof value.id === 'string') return { id: value.id };
  if (typeof value.shotNumber === 'string') return { shotNumber: value.shotNumber };
  if (value.query && typeof value.query === 'object') return { query: { ...value.query } as AgentEntityTarget & any } as AgentEntityTarget;
  throw new TypeError('Target has no id, ref, shotNumber, or query.');
}

function matches(value: Record<string, unknown>, query: Record<string, unknown>): boolean {
  const mode = query.match === 'contains' ? 'contains' : 'exact';
  for (const [key, expected] of Object.entries(query)) {
    if (key === 'match' || expected === undefined) continue;
    const actual = value[key];
    if (key === 'name') {
      const left = String(actual ?? '').toLowerCase();
      const right = String(expected).toLowerCase();
      if (mode === 'contains' ? !left.includes(right) : left !== right) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
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
  const requestedTimeout = options.timeoutMs ?? AGENT_SCRIPT_LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new Error('Agent script timeout must be a positive finite number.');
  const timeoutMs = Math.min(Math.floor(requestedTimeout), AGENT_SCRIPT_LIMITS.maxTimeoutMs);

  const commands: ForeSceneAgentCommand[] = [];
  let description: string | undefined;
  const counters = { object: 0, shot: 0, landmark: 0 };
  const snapshot = deepFreeze(structuredClone(project));

  const emit = (command: ForeSceneAgentCommand) => {
    if (commands.length >= AGENT_PLAN_LIMITS.maxCommands) {
      throw new Error(`ForeScene script command limit exceeded (${AGENT_PLAN_LIMITS.maxCommands}). Split the work into multiple scripts.`);
    }
    commands.push(structuredClone(command));
    return command;
  };
  const nextRef = (kind: keyof typeof counters) => {
    counters[kind] += 1;
    return `script_${kind}_${counters[kind]}`;
  };

  const target = deepFreeze({
    id: (id: string) => deepFreeze({ id: String(id) }),
    ref: (ref: string) => deepFreeze({ ref: String(ref) }),
    shotNumber: (shotNumber: string) => deepFreeze({ shotNumber: String(shotNumber) }),
    query: (query: Record<string, unknown>) => deepFreeze({ query: { ...query } }),
  });

  const scene = deepFreeze({
    list: () => snapshot.scene.objects,
    find: (query: Record<string, unknown>) => snapshot.scene.objects.find((value) => matches(value as unknown as Record<string, unknown>, query)),
    findAll: (query: Record<string, unknown>) => snapshot.scene.objects.filter((value) => matches(value as unknown as Record<string, unknown>, query)),
    require(query: Record<string, unknown>) {
      const found = this.find(query);
      if (!found) throw new Error(`No scene object matched ${JSON.stringify(query)}`);
      return found;
    },
    create(type: string, options: Record<string, unknown> = {}) {
      const { ref, ...object } = options;
      const createdRef = typeof ref === 'string' ? ref : nextRef('object');
      emit({ op: 'object.create', ref: createdRef, object: { ...object, type } as any });
      return deepFreeze({ ref: createdRef });
    },
    update(object: ScriptTarget, updates: Record<string, unknown>) {
      emit({ op: 'object.update', object: normalizeTarget(object), updates });
    },
    delete(object: ScriptTarget) {
      emit({ op: 'object.delete', object: normalizeTarget(object) });
    },
    duplicate(object: ScriptTarget, options: Record<string, unknown> = {}) {
      const createdRef = typeof options.ref === 'string' ? options.ref : nextRef('object');
      emit({ op: 'object.duplicate', object: normalizeTarget(object), ref: createdRef });
      if (options.updates && typeof options.updates === 'object') {
        emit({ op: 'object.update', object: { ref: createdRef }, updates: options.updates as Record<string, unknown> });
      }
      return deepFreeze({ ref: createdRef });
    },
  });

  const shots = deepFreeze({
    list: () => snapshot.shots,
    find: (query: Record<string, unknown>) => snapshot.shots.find((value) => matches(value as unknown as Record<string, unknown>, query)),
    findAll: (query: Record<string, unknown>) => snapshot.shots.filter((value) => matches(value as unknown as Record<string, unknown>, query)),
    require(query: Record<string, unknown>) {
      const found = this.find(query);
      if (!found) throw new Error(`No shot matched ${JSON.stringify(query)}`);
      return found;
    },
    create(options: Record<string, unknown> = {}) {
      const { ref, ...shot } = options;
      const createdRef = typeof ref === 'string' ? ref : nextRef('shot');
      emit({ op: 'shot.create', ref: createdRef, shot: shot as any });
      return deepFreeze({ ref: createdRef });
    },
    rename(shot: ScriptTarget, name: string) {
      emit({ op: 'shot.rename', shot: normalizeTarget(shot), name });
    },
    describe(shot: ScriptTarget, text: string) {
      emit({ op: 'shot.updateDescription', shot: normalizeTarget(shot), description: text });
    },
    camera(shot: ScriptTarget, camera: Record<string, unknown>) {
      emit({ op: 'shot.updateCamera', shot: normalizeTarget(shot), camera: camera as any });
    },
    frameSubjects(shot: ScriptTarget, subjects: ScriptTarget[], composition?: string) {
      emit({ op: 'shot.frameSubjects', shot: normalizeTarget(shot), subjects: subjects.map(normalizeTarget), ...(composition ? { composition } : {}) });
    },
    stage(shot: ScriptTarget, object: ScriptTarget, options: Record<string, unknown> = {}) {
      emit({ op: 'shot.stageObject', shot: normalizeTarget(shot), object: normalizeTarget(object), ...options } as any);
    },
    clearStaging(shot: ScriptTarget, object?: ScriptTarget) {
      emit({ op: 'shot.clearStaging', shot: normalizeTarget(shot), ...(object ? { object: normalizeTarget(object) } : {}) });
    },
    delete(shot: ScriptTarget) {
      emit({ op: 'shot.delete', shot: normalizeTarget(shot) });
    },
  });

  const landmarks = deepFreeze({
    list: () => snapshot.landmarks,
    find: (query: Record<string, unknown>) => snapshot.landmarks.find((value) => matches(value as unknown as Record<string, unknown>, query)),
    create(options: Record<string, unknown> = {}) {
      const { ref, ...landmark } = options;
      const createdRef = typeof ref === 'string' ? ref : nextRef('landmark');
      emit({ op: 'landmark.create', ref: createdRef, landmark: landmark as any });
      return deepFreeze({ ref: createdRef });
    },
    update(landmark: ScriptTarget, updates: Record<string, unknown>) {
      emit({ op: 'landmark.update', landmark: normalizeTarget(landmark), updates: updates as any });
    },
    link(landmark: ScriptTarget, object: ScriptTarget | null) {
      emit({ op: 'landmark.linkObject', landmark: normalizeTarget(landmark), object: object === null ? null : normalizeTarget(object) });
    },
    delete(landmark: ScriptTarget) {
      emit({ op: 'landmark.delete', landmark: normalizeTarget(landmark) });
    },
  });

  const plan = deepFreeze({
    description(value: unknown) {
      description = String(value);
    },
    command(command: ForeSceneAgentCommand) {
      return emit(command);
    },
  });

  const workspace = deepFreeze({
    open(value: 'build' | 'reference' | 'shots' | 'export') {
      emit({ op: 'workspace.open', workspace: value });
    },
  });

  const context = vm.createContext(
    {
      project: snapshot,
      target,
      scene,
      shots,
      landmarks,
      workspace,
      plan,
      console: deepFreeze({ log: () => undefined, warn: () => undefined, error: () => undefined }),
    },
    {
      name: 'ForeScene Agent Script',
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    },
  );

  try {
    new vm.Script(`"use strict";\n${source}`, {
      filename: options.fileName ?? 'forescene-agent-script.js',
      displayErrors: true,
    }).runInContext(context, { timeout: timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ForeScene agent script failed: ${message}`);
  }

  const compiledPlan: ForeSceneAgentPlan = {
    version: 1,
    ...(description ? { description } : {}),
    expectedFingerprint: projectFingerprint(project),
    commands,
  };
  return { plan: compiledPlan, sourceBytes, commandCount: commands.length, timeoutMs };
}
