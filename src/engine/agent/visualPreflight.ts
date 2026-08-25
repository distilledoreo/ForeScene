/**
 * Deterministic visual preflight for agent/benchmark quality gates.
 * Wraps shot diagnostics plus camera-direction and motion-continuity checks.
 * Uses shot-effective state and samples camera keyframes / motion times.
 */

import type { LocationProject, SceneObject, Shot, Vec3 } from '../../domain/types';
import { cameraForward } from '../sync';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  type AgentDiagnostic,
} from './diagnostics';
import type {
  AgentValidationGateStatus,
  AgentVisualPreflightCheck,
  AgentVisualPreflightResult,
  AgentVisualPreflightSample,
  AgentVisualPreflightSubjectPolicy,
} from './protocol';
import { inspectAgentShotDiagnostics } from './shotDiagnostics';
import { getShotEffectiveState } from './spatialShotState';
import {
  getProductionConfiguration,
  resolveProductionBindingObjectIds,
} from '../previs/productionConfiguration';
import { inspectShotActionContinuity } from './actionContinuity';

const MIN_VISIBLE_FRACTION = 0.08;
const MIN_COVERAGE = 0.01;
const MAX_COVERAGE = 0.92;
const MAX_GROUND_CLEARANCE = 0.18;
const MIN_CAMERA_ALIGNMENT = 0.15;
const MIN_SUBJECT_MOTION = 0.15;
const MIN_CAMERA_MOTION = 0.05;
const MAX_SAMPLE_TIMES = 8;

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function length(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function normalize(value: Vec3): Vec3 {
  const mag = length(value);
  if (mag < 1e-8) return [0, 0, -1];
  return [value[0] / mag, value[1] / mag, value[2] / mag];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function statusFromFailed(failed: boolean, warning: boolean): AgentVisualPreflightCheck['status'] {
  if (failed) return 'failed';
  if (warning) return 'warning';
  return 'passed';
}

function worstStatus(
  current: AgentVisualPreflightCheck['status'] | undefined,
  next: AgentVisualPreflightCheck['status'],
): AgentVisualPreflightCheck['status'] {
  const rank = { passed: 0, warning: 1, failed: 2 };
  if (!current) return next;
  return rank[next] > rank[current] ? next : current;
}

function isCandidateSubject(object: SceneObject): boolean {
  if (object.type === 'human_dummy') return true;
  if (object.poseableCharacter || object.humanPose) return true;
  if (object.type === 'imported_model' && object.category === 'helper') return true;
  return false;
}

function isEnvironmentPrimitive(object: SceneObject): boolean {
  return object.type === 'floor' || object.type === 'wall' || object.type === 'sun_marker';
}

export function listVisibleRenderableObjectIds(objects: SceneObject[]): string[] {
  return objects
    .filter((object) => object.visible !== false && !isEnvironmentPrimitive(object))
    .map((object) => object.id);
}

export function listVisualPreflightCandidateSubjectIds(
  objects: SceneObject[],
  requestedSubjectIds?: string[],
): string[] {
  const ids = new Set<string>();
  for (const object of objects) {
    if (isCandidateSubject(object)) ids.add(object.id);
  }
  for (const id of requestedSubjectIds ?? []) ids.add(id);
  return [...ids];
}

function metadataFlag(shot: Shot, key: string): boolean {
  return shot.metadata?.[key] === true;
}

/**
 * Set-dressing policy for visual preflight:
 *
 * - Explicit environment-only (`environmentOnly` input, shot metadata, or
 *   `shotKind === "environment"`) is the only N/A path. Visible content is
 *   the set itself and is never scored as unresolved.
 * - Ordinary shots expect subjects. Visible non-environment objects that are
 *   not identified or scored are unresolved set dressing.
 * - No identified subjects + unresolved visible content → fail.
 * - Identified/scored subjects + additional unresolved visible content → fail
 *   the ordinary visual gate. A non-blocking warning requires the explicit
 *   persisted opt-in `allowUnresolvedSetDressing`.
 * - Empty set with no visible content and no explicit environment-only → warn
 *   (not a fully passed gate).
 * - Requested subjects keep existing missing/fail behavior; requesting an
 *   object identifies it so it is scored instead of treated as set dressing.
 */
export function resolveVisualPreflightSubjectPolicy(input: {
  shot: Shot;
  objects: SceneObject[];
  requestedSubjectIds?: string[];
  environmentOnly?: boolean;
  allowUnresolvedSetDressing?: boolean;
  /** Object ids actually scored as subjects. When omitted, candidates are treated as identified. */
  scoredSubjectIds?: string[];
  /** Persisted production-location objects are explicit environment, not unresolved dressing. */
  environmentObjectIds?: string[];
}): {
  environmentOnly: boolean;
  allowUnresolvedSetDressing: boolean;
  subjectPolicy: AgentVisualPreflightSubjectPolicy;
  candidateSubjectIds: string[];
  unresolvedVisibleObjectIds: string[];
} {
  const candidateSubjectIds = listVisualPreflightCandidateSubjectIds(
    input.objects,
    input.requestedSubjectIds,
  );
  const explicit = input.environmentOnly === true
    || metadataFlag(input.shot, 'environmentOnly')
    || input.shot.metadata?.shotKind === 'environment';
  const allowUnresolvedSetDressing = !explicit && (
    input.allowUnresolvedSetDressing === true
    || metadataFlag(input.shot, 'allowUnresolvedSetDressing')
  );
  const identified = new Set(
    input.scoredSubjectIds !== undefined ? input.scoredSubjectIds : candidateSubjectIds,
  );
  const environmentIds = new Set(input.environmentObjectIds ?? []);
  const unresolvedVisibleObjectIds = explicit
    ? []
    : listVisibleRenderableObjectIds(input.objects).filter((id) => !identified.has(id) && !environmentIds.has(id));
  return {
    environmentOnly: explicit,
    allowUnresolvedSetDressing,
    subjectPolicy: explicit
      ? 'environment_only'
      : allowUnresolvedSetDressing
        ? 'set_dressing_allowed'
        : 'subjects_expected',
    candidateSubjectIds,
    unresolvedVisibleObjectIds,
  };
}

export function collectVisualPreflightSampleTimes(
  shot: Shot,
  requestedTimeSeconds?: number,
  actionSampleTimes: readonly number[] = [],
): number[] {
  if (requestedTimeSeconds !== undefined) return [requestedTimeSeconds];
  const keyframes = [...shot.cameraKeyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (keyframes.length === 0) {
    return [...new Set([0, ...actionSampleTimes])].sort((a, b) => a - b);
  }

  const times = new Set<number>();
  const start = keyframes[0]!.timeSeconds;
  const end = keyframes[keyframes.length - 1]!.timeSeconds;
  times.add(start);
  times.add(end);
  if (keyframes.length >= 3) {
    times.add(keyframes[Math.floor(keyframes.length / 2)]!.timeSeconds);
  } else if (end > start) {
    times.add((start + end) / 2);
  }
  // Authored action samples are semantic contract checkpoints. Always inspect
  // them even when they do not coincide with a camera keyframe; MAX_SAMPLE_TIMES
  // only limits extra camera samples, never production action guarantees.
  for (const timeSeconds of actionSampleTimes) times.add(timeSeconds);
  for (const keyframe of keyframes) {
    if (times.size >= MAX_SAMPLE_TIMES) break;
    times.add(keyframe.timeSeconds);
  }
  return [...times].sort((a, b) => a - b);
}

function evaluateVisualPreflightAtTime(input: {
  project: LocationProject;
  shot: Shot;
  timeSeconds?: number;
  subjectIds?: string[];
  environmentOnly?: boolean;
  allowUnresolvedSetDressing?: boolean;
}): {
  checks: AgentVisualPreflightCheck[];
  subjects: ReturnType<typeof inspectAgentShotDiagnostics>['subjects'];
  diagnostics: AgentDiagnostic[];
  missingSubjectIds: string[];
  requestedSubjectIds?: string[];
  sampledTimeSeconds?: number;
  environmentOnly: boolean;
  allowUnresolvedSetDressing: boolean;
  subjectPolicy: AgentVisualPreflightSubjectPolicy;
  candidateSubjectIds: string[];
  unresolvedVisibleObjectIds: string[];
} {
  const { project, shot } = input;
  const effective = getShotEffectiveState(project, shot.id, input.timeSeconds);
  const effectiveShot = effective?.shot ?? shot;
  const effectiveObjects = effective?.objects ?? project.scene.objects;

  const diagnosticsResult = inspectAgentShotDiagnostics({
    project,
    shot,
    timeSeconds: input.timeSeconds,
    subjectIds: input.subjectIds,
  });
  const subjects = diagnosticsResult.subjects;
  const checks: AgentVisualPreflightCheck[] = [];

  const requestedSubjectIds = input.subjectIds?.length ? [...input.subjectIds] : undefined;
  const presentIds = new Set(subjects.map((subject) => subject.objectId));
  const missingSubjectIds = (requestedSubjectIds ?? []).filter((id) => !presentIds.has(id));
  const missingRequested = missingSubjectIds.length > 0;
  const configuration = getProductionConfiguration(project);
  const productionContract = configuration.shotContracts[shot.id];
  const productionLocations = Object.values(configuration.locations);
  const environmentObjectIds = productionLocations.length > 0
    ? productionLocations.flatMap((location) => [
        ...location.objectIds,
        ...location.objectGroupIds.flatMap((groupId) => (
          project.scene.objectGroups?.[groupId]?.objectIds ?? []
        )),
      ])
    : [];
  const scoredSubjectIds = [...new Set([
    ...subjects.flatMap((subject) => (
      project.scene.objectGroups?.[subject.objectId]?.objectIds ?? [subject.objectId]
    )),
    ...(productionContract?.presence?.expectedVisibleObjectIds ?? []),
    ...(productionContract?.presence?.expectedVisibleGroupIds.flatMap((groupId) => (
      project.scene.objectGroups?.[groupId]?.objectIds ?? []
    )) ?? []),
  ])];
  const policy = resolveVisualPreflightSubjectPolicy({
    shot: effectiveShot,
    objects: effectiveObjects,
    requestedSubjectIds,
    environmentOnly: input.environmentOnly,
    allowUnresolvedSetDressing: input.allowUnresolvedSetDressing,
    scoredSubjectIds,
    environmentObjectIds,
  });
  const intentionalCropObjectIds = new Set(
    (productionContract?.composition?.subjects ?? []).flatMap((constraint) => {
      if (constraint.completeAssemblyInFrame !== false) return [];
      const binding = configuration.bindings[constraint.entityId];
      return binding ? resolveProductionBindingObjectIds(project, binding) : [];
    }),
  );
  const intentionalForegroundObjectIds = new Set(
    (productionContract?.composition?.occlusionIntent ?? []).flatMap((intent) => {
      const binding = configuration.bindings[intent.foregroundEntityId];
      return binding ? resolveProductionBindingObjectIds(project, binding) : [];
    }),
  );
  const hasRequiredCropLandmarks = (subject: typeof subjects[number]): boolean => {
    const landmarks = subject.humanLandmarks;
    return Boolean(
      landmarks?.headTop?.inFrame
      && (landmarks.shoulders?.inFrame || landmarks.chest?.inFrame),
    );
  };
  const unresolvedVisible = !policy.environmentOnly
    && policy.unresolvedVisibleObjectIds.length > 0
    && subjects.length === 0
    && !missingRequested;
  const unresolvedSetDressing = !policy.environmentOnly
    && policy.unresolvedVisibleObjectIds.length > 0
    && subjects.length > 0;
  const unresolvedSetDressingFailed = unresolvedSetDressing && !policy.allowUnresolvedSetDressing;
  const unresolvedSetDressingWarning = unresolvedSetDressing && policy.allowUnresolvedSetDressing;
  const emptySetWithoutIntent = !policy.environmentOnly
    && policy.candidateSubjectIds.length === 0
    && policy.unresolvedVisibleObjectIds.length === 0
    && subjects.length === 0
    && !missingRequested;
  const accidentalEmpty = !policy.environmentOnly
    && subjects.length === 0
    && !missingRequested
    && policy.candidateSubjectIds.length > 0;

  const hidden = subjects.filter((subject) => (
    subject.behindCamera
    || (subject.visibleFraction < MIN_VISIBLE_FRACTION
      && !(intentionalCropObjectIds.has(subject.objectId) && hasRequiredCropLandmarks(subject))
      && !(intentionalForegroundObjectIds.has(subject.objectId)
        && subject.visibleFraction >= 0.02
        && subject.screenCoverage >= 0.03))
  ));
  const visibilityFailed = missingRequested
    || accidentalEmpty
    || unresolvedVisible
    || unresolvedSetDressingFailed
    || (hidden.length > 0 && subjects.length > 0);
  checks.push({
    id: 'subject_visibility',
    status: statusFromFailed(visibilityFailed, emptySetWithoutIntent || unresolvedSetDressingWarning),
    message: policy.environmentOnly
      ? 'Environment-only shot has no subjects to score.'
      : missingRequested
        ? `${missingSubjectIds.length} requested subject(s) are missing from the shot-effective scene.`
        : unresolvedVisible
          ? `Visible renderable content is present but subject inference found no candidates. Mark the shot environment-only or identify subjects.`
          : accidentalEmpty
            ? `No subjects were inferred for a shot that still has ${policy.candidateSubjectIds.length} candidate subject(s).`
            : emptySetWithoutIntent
              ? 'No subjects were inferred. Environment-only scoring requires explicit intent.'
              : unresolvedSetDressingFailed
                ? `Visible renderable content is present but not identified as a subject. Request those objects, hide them, mark the shot environment-only, or set allowUnresolvedSetDressing.`
                : unresolvedSetDressingWarning
                  ? `Visible set-dressing content is present but not identified as a subject. Opt-in allowUnresolvedSetDressing keeps this non-blocking.`
                  : hidden.length === 0
                    ? 'Requested subjects are visible in frame.'
                    : `${hidden.length} subject(s) are behind the camera or nearly invisible.`,
    measured: {
      subjectCount: subjects.length,
      hiddenCount: hidden.length,
      missingSubjectCount: missingSubjectIds.length,
      candidateSubjectCount: policy.candidateSubjectIds.length,
      unresolvedVisibleCount: policy.unresolvedVisibleObjectIds.length,
      environmentOnly: policy.environmentOnly ? 1 : 0,
      minVisibleFraction: subjects.reduce((min, subject) => Math.min(min, subject.visibleFraction), 1),
    },
  });

  // Landmark-crop templates are validated by the head/upper-body crop gate;
  // their full-body AABB coverage is intentionally outside generic bands.
  const coverageSubjects = subjects.filter((subject) => !intentionalCropObjectIds.has(subject.objectId));
  const coverageValues = coverageSubjects.map((subject) => subject.screenCoverage);
  const minCoverage = coverageValues.length > 0 ? Math.min(...coverageValues) : 0;
  const maxCoverage = coverageValues.length > 0 ? Math.max(...coverageValues) : 0;
  const coverageFailed = accidentalEmpty
    || unresolvedVisible
    || (coverageSubjects.length > 0 && (minCoverage < MIN_COVERAGE || maxCoverage > MAX_COVERAGE));
  checks.push({
    id: 'framing_coverage',
    status: statusFromFailed(coverageFailed, !policy.environmentOnly && minCoverage > 0 && minCoverage < 0.03),
    message: policy.environmentOnly
      ? 'Environment-only shot has no subject coverage to score.'
      : accidentalEmpty || unresolvedVisible
        ? 'Subject framing cannot pass when no subjects were inferred for an ordinary shot.'
        : coverageFailed
          ? 'Subject framing is too tight or too loose.'
          : 'Subject framing coverage is within the preflight band.',
    measured: { minCoverage, maxCoverage, environmentOnly: policy.environmentOnly ? 1 : 0 },
  });

  const floating = subjects.filter((subject) => subject.groundClearanceMeters > MAX_GROUND_CLEARANCE);
  const buried = subjects.filter((subject) => subject.groundClearanceMeters < -0.25);
  checks.push({
    id: 'ground_contact',
    status: statusFromFailed(!policy.environmentOnly && floating.length + buried.length > 0, false),
    message: policy.environmentOnly
      ? 'Environment-only shot has no subject ground-contact to score.'
      : floating.length + buried.length === 0
        ? 'Subjects are near the identified floor.'
        : `${floating.length + buried.length} subject(s) float above or sink through the floor.`,
    measured: {
      maxClearance: subjects.reduce((max, subject) => Math.max(max, subject.groundClearanceMeters), 0),
      minClearance: subjects.reduce((min, subject) => Math.min(min, subject.groundClearanceMeters), 0),
      environmentOnly: policy.environmentOnly ? 1 : 0,
    },
  });

  const camera = effectiveShot.camera;
  const centroid: Vec3 = subjects.length > 0
    ? subjects.reduce((sum, subject, _index, list) => {
        const position = effectiveObjects.find((object) => object.id === subject.objectId)?.transform.position
          ?? camera.target;
        return [
          sum[0] + position[0] / list.length,
          sum[1] + position[1] / list.length,
          sum[2] + position[2] / list.length,
        ];
      }, [0, 0, 0] as Vec3)
    : camera.target;
  const towardSubjects = normalize(subtract(centroid, camera.position));
  const forward = normalize(cameraForward(camera));
  const alignment = dot(forward, towardSubjects);
  checks.push({
    id: 'camera_direction',
    status: statusFromFailed(!policy.environmentOnly && subjects.length > 0 && alignment < MIN_CAMERA_ALIGNMENT, !policy.environmentOnly && alignment < 0.35),
    message: policy.environmentOnly
      ? 'Environment-only camera look-at is recorded without a subject target.'
      : alignment >= MIN_CAMERA_ALIGNMENT
        ? 'Camera faces the requested subjects.'
        : 'Camera is not facing the requested subjects.',
    measured: { alignment, environmentOnly: policy.environmentOnly ? 1 : 0 },
  });

  const cropped = subjects.filter((subject) => {
    if (!subject.clipped) return false;
    if (!intentionalCropObjectIds.has(subject.objectId)) return true;
    if (intentionalForegroundObjectIds.has(subject.objectId)) {
      return subject.visibleFraction < 0.02 || subject.screenCoverage < 0.03;
    }
    // Medium and close compositions may intentionally crop the lower body,
    // but they still fail closed if the head or upper torso leaves frame.
    return !hasRequiredCropLandmarks(subject);
  });
  checks.push({
    id: 'cropping',
    status: statusFromFailed(
      !policy.environmentOnly && cropped.length > 0 && cropped.length === subjects.length && subjects.length > 0,
      !policy.environmentOnly && cropped.length > 0,
    ),
    message: policy.environmentOnly
      ? 'Environment-only shot has no subject cropping to score.'
      : cropped.length === 0
        ? 'Subjects are not clipped by the frame.'
        : `${cropped.length} subject(s) are cropped by the frame edge.`,
    measured: { croppedCount: cropped.length, environmentOnly: policy.environmentOnly ? 1 : 0 },
  });

  const maxSubjectMotion = diagnosticsResult.subjectDisplacements.reduce(
    (max, item) => Math.max(max, item.displacementMeters),
    0,
  );
  const cameraMotion = diagnosticsResult.cameraDisplacementMeters;
  const motionFailed = shot.cameraKeyframes.length >= 2
    && maxSubjectMotion >= MIN_SUBJECT_MOTION
    && cameraMotion < MIN_CAMERA_MOTION
    && alignment < 0.2;
  checks.push({
    id: 'motion_continuity',
    status: statusFromFailed(motionFailed, shot.cameraKeyframes.length >= 2 && maxSubjectMotion < 0.02 && cameraMotion < 0.02),
    message: motionFailed
      ? 'Subjects move but the camera does not follow them.'
      : 'Motion continuity is consistent with the shot timeline.',
    measured: {
      cameraDisplacementMeters: cameraMotion,
      maxSubjectDisplacementMeters: maxSubjectMotion,
      keyframeCount: shot.cameraKeyframes.length,
    },
  });

  const actionContinuity = inspectShotActionContinuity({
    project,
    shot,
    timeSeconds: diagnosticsResult.sampledTimeSeconds ?? input.timeSeconds ?? 0,
  });
  if (actionContinuity) {
    const hasAuthoredSample = actionContinuity.expectedCount > 0;
    checks.push({
      id: 'action_continuity',
      status: hasAuthoredSample
        ? statusFromFailed(!actionContinuity.ok, false)
        : 'warning',
      message: actionContinuity.ok && hasAuthoredSample
        ? 'Persisted action intent matches the shot-effective timeline state.'
        : !hasAuthoredSample
          ? 'Persisted action intent has no sample at this preflight time.'
        : actionContinuity.reviewRequiredCount > 0
          ? 'Persisted action intent includes an unapproved approximate pose substitution.'
          : 'Shot-effective pose, visibility, or trajectory diverges from persisted action intent.',
      measured: {
        expectedCount: actionContinuity.expectedCount,
        matchedCount: actionContinuity.matchedCount,
        missingBindingCount: actionContinuity.missingBindingCount,
        poseMismatchCount: actionContinuity.poseMismatchCount,
        trajectoryMismatchCount: actionContinuity.trajectoryMismatchCount,
        visibilityMismatchCount: actionContinuity.visibilityMismatchCount,
        reviewRequiredCount: actionContinuity.reviewRequiredCount,
      },
    });
  }

  return {
    checks,
    subjects,
    diagnostics: diagnosticsResult.diagnostics,
    missingSubjectIds,
    requestedSubjectIds,
    sampledTimeSeconds: diagnosticsResult.sampledTimeSeconds ?? input.timeSeconds,
    environmentOnly: policy.environmentOnly,
    allowUnresolvedSetDressing: policy.allowUnresolvedSetDressing,
    subjectPolicy: policy.subjectPolicy,
    candidateSubjectIds: policy.candidateSubjectIds,
    unresolvedVisibleObjectIds: policy.unresolvedVisibleObjectIds,
  };
}

function scoreFromChecks(checks: AgentVisualPreflightCheck[]): number {
  const failed = checks.filter((check) => check.status === 'failed').length;
  const warned = checks.filter((check) => check.status === 'warning').length;
  return Math.max(0, 100 - failed * 20 - warned * 8);
}

function visualGateStatusFromChecks(
  checks: AgentVisualPreflightCheck[],
  missingSubjectCount: number,
): Exclude<AgentValidationGateStatus, 'skipped'> {
  if (missingSubjectCount > 0 || checks.some((check) => check.status === 'failed')) return 'failed';
  if (checks.some((check) => check.status === 'warning')) return 'warning';
  return 'passed';
}

export function inspectShotVisualPreflight(input: {
  project: LocationProject;
  shotId: string;
  timeSeconds?: number;
  subjectIds?: string[];
  environmentOnly?: boolean;
  allowUnresolvedSetDressing?: boolean;
}): AgentVisualPreflightResult {
  const shot = input.project.shots.find((candidate) => candidate.id === input.shotId);
  if (!shot) {
    return {
      ok: false,
      gateStatus: 'failed',
      shotId: input.shotId,
      score: 0,
      checks: [],
      subjects: [],
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${input.shotId}".`)],
    };
  }

  const configuration = getProductionConfiguration(input.project);
  const actionSampleTimes = (configuration.shotContracts[shot.id]?.actions ?? [])
    .flatMap((action) => action.samples.map((sample) => sample.timeSeconds));
  const sampleTimes = collectVisualPreflightSampleTimes(
    shot,
    input.timeSeconds,
    actionSampleTimes,
  );
  const samples: AgentVisualPreflightSample[] = [];
  const aggregatedById = new Map<AgentVisualPreflightCheck['id'], AgentVisualPreflightCheck>();
  const allSubjects: AgentVisualPreflightResult['subjects'] = [];
  const allDiagnostics: AgentDiagnostic[] = [];
  const missingSubjectIds = new Set<string>();

  for (const timeSeconds of sampleTimes) {
    const sampleInputTime = shot.cameraKeyframes.length > 0 || input.timeSeconds !== undefined
      ? timeSeconds
      : input.timeSeconds;
    const evaluated = evaluateVisualPreflightAtTime({
      project: input.project,
      shot,
      timeSeconds: sampleInputTime,
      subjectIds: input.subjectIds,
      environmentOnly: input.environmentOnly,
      allowUnresolvedSetDressing: input.allowUnresolvedSetDressing,
    });
    const score = scoreFromChecks(evaluated.checks);
    const failedChecks = evaluated.checks.filter((check) => check.status === 'failed');
    samples.push({
      timeSeconds: evaluated.sampledTimeSeconds ?? timeSeconds,
      ok: failedChecks.length === 0,
      score,
      checks: evaluated.checks,
      failedCheckIds: failedChecks.map((check) => check.id),
      diagnostics: [
        ...evaluated.diagnostics,
        ...failedChecks.map((check) => agentError(check.id, `${check.message} (t=${(evaluated.sampledTimeSeconds ?? timeSeconds).toFixed(3)}s)`)),
      ],
    });
    for (const id of evaluated.missingSubjectIds) missingSubjectIds.add(id);
    for (const subject of evaluated.subjects) {
      if (!allSubjects.some((existing) => existing.objectId === subject.objectId)) {
        allSubjects.push(subject);
      }
    }
    allDiagnostics.push(...evaluated.diagnostics);
    for (const check of evaluated.checks) {
      const existing = aggregatedById.get(check.id);
      const status = worstStatus(existing?.status, check.status);
      aggregatedById.set(check.id, {
        ...check,
        status,
        message: status === 'failed' && existing?.status === 'failed'
          ? existing.message
          : status === check.status ? check.message : existing?.message ?? check.message,
      });
    }
  }

  const checks = [...aggregatedById.values()];
  const sampleScore = samples.length > 0
    ? Math.round(samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length)
    : scoreFromChecks(checks);
  const score = Math.max(0, sampleScore - missingSubjectIds.size * 20);
  const extraDiagnostics: AgentDiagnostic[] = checks
    .filter((check) => check.status !== 'passed')
    .map((check) => (
      check.status === 'failed'
        ? agentError(check.id, check.message)
        : { code: check.id, message: check.message, severity: 'warning' as const }
    ));
  for (const sample of samples) {
    if (!sample.ok) {
      extraDiagnostics.push(agentError(
        'visual_preflight_sample_failed',
        `Visual preflight failed at t=${sample.timeSeconds.toFixed(3)}s: ${sample.failedCheckIds.join(', ') || 'unspecified'}.`,
      ));
    }
  }

  const productionContract = configuration.shotContracts[shot.id];
  const productionLocations = Object.values(configuration.locations);
  const policy = resolveVisualPreflightSubjectPolicy({
    shot,
    objects: getShotEffectiveState(input.project, shot.id, input.timeSeconds)?.objects
      ?? input.project.scene.objects,
    requestedSubjectIds: input.subjectIds,
    environmentOnly: input.environmentOnly,
    allowUnresolvedSetDressing: input.allowUnresolvedSetDressing,
    scoredSubjectIds: [...new Set([
      ...allSubjects.flatMap((subject) => (
        input.project.scene.objectGroups?.[subject.objectId]?.objectIds ?? [subject.objectId]
      )),
      ...(productionContract?.presence?.expectedVisibleObjectIds ?? []),
      ...(productionContract?.presence?.expectedVisibleGroupIds.flatMap((groupId) => (
        input.project.scene.objectGroups?.[groupId]?.objectIds ?? []
      )) ?? []),
    ])],
    environmentObjectIds: productionLocations.length > 0
      ? productionLocations.flatMap((location) => [
          ...location.objectIds,
          ...location.objectGroupIds.flatMap((groupId) => (
            input.project.scene.objectGroups?.[groupId]?.objectIds ?? []
          )),
        ])
      : [],
  });
  const gateStatus = visualGateStatusFromChecks(checks, missingSubjectIds.size);

  return {
    ok: gateStatus === 'passed',
    gateStatus,
    shotId: shot.id,
    sampledTimeSeconds: samples[0]?.timeSeconds,
    sampleTimesSeconds: samples.map((sample) => sample.timeSeconds),
    samples,
    score,
    checks,
    subjects: allSubjects,
    requestedSubjectIds: input.subjectIds,
    missingSubjectIds: [...missingSubjectIds],
    environmentOnly: policy.environmentOnly,
    subjectPolicy: policy.subjectPolicy,
    candidateSubjectIds: policy.candidateSubjectIds,
    unresolvedVisibleObjectIds: policy.unresolvedVisibleObjectIds,
    ...(policy.allowUnresolvedSetDressing ? { allowUnresolvedSetDressing: true } : {}),
    diagnostics: [...allDiagnostics, ...extraDiagnostics],
  };
}
