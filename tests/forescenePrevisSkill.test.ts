import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PREVIS_CAMERA_ANGLES,
  PREVIS_CAMERA_TEMPLATES,
  PREVIS_LENS_CLASSES,
  PREVIS_LOCATION_SLOTS,
  PREVIS_LOCATION_TEMPLATES,
  PREVIS_RELATIVE_RELATIONS,
  type PrevisCameraAngle,
  type PrevisCameraTemplate,
  type PrevisLensClass,
  type PrevisLocationSlot,
  type PrevisLocationTemplate,
  type PrevisRelativeRelation,
} from '../src/engine/previs/manifest';
import { parsePrevisProductionManifest } from '../src/engine/previs/manifestValidation';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(repoRoot, 'skills', 'forescene-previs');
const skillPath = path.join(skillRoot, 'SKILL.md');
const productionManifestPath = path.join(skillRoot, 'references', 'production-manifest.md');
const shotTemplatesPath = path.join(skillRoot, 'references', 'shot-templates.md');
const existingProjectRefinementPath = path.join(skillRoot, 'references', 'existing-project-refinement.md');
const deliverablesPath = path.join(skillRoot, 'references', 'deliverables.md');
const batchReviewPath = path.join(skillRoot, 'references', 'batch-review.md');
const visualAcceptancePath = path.join(skillRoot, 'references', 'visual-acceptance.md');
const nonhumanoidModelsPath = path.join(skillRoot, 'references', 'nonhumanoid-models.md');
const errorRecoveryPath = path.join(skillRoot, 'references', 'error-recovery.md');
const importedCharactersPath = path.join(skillRoot, 'references', 'imported-characters.md');
const importedCharacterWorkflowPath = path.join(skillRoot, 'examples', 'imported-character-workflow.md');
const aiControlFullPlanPath = path.join(skillRoot, 'examples', 'ai-control-full-export-plan.json');

const skill = readFileSync(skillPath, 'utf8');
const productionManifest = readFileSync(productionManifestPath, 'utf8');
const shotTemplates = readFileSync(shotTemplatesPath, 'utf8');
const existingProjectRefinement = readFileSync(existingProjectRefinementPath, 'utf8');
const deliverables = readFileSync(deliverablesPath, 'utf8');
const batchReview = readFileSync(batchReviewPath, 'utf8');
const visualAcceptance = readFileSync(visualAcceptancePath, 'utf8');
const nonhumanoidModels = readFileSync(nonhumanoidModelsPath, 'utf8');
const errorRecovery = readFileSync(errorRecoveryPath, 'utf8');
const importedCharacters = readFileSync(importedCharactersPath, 'utf8');
const importedCharacterWorkflow = readFileSync(importedCharacterWorkflowPath, 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('ForeScene previs skill contract', () => {
  it('documents the current still, motion, and imported-character workflow', () => {
    for (const phrase of [
      'agent:frame',
      'agent:video',
      'agent:open',
      'agent:save',
      'agent:capabilities',
      'FORESCENE_BENCHMARK_BRIEF',
      'writeAuthorized',
      'resetAuthorized',
      'repairBudget',
      'Do not kill Chromium',
      'if a capability is `true`',
      'agent:analyze-character',
      'agent:import-character',
      'renderControlVideo',
      'durationSeconds',
      'keyframes',
      'type: "imported_character"',
      'preserve-existing',
      'source',
      'cast.<id>',
      'imported-characters.md',
      'motion-authoring.md',
      'MP4 exists',
      '--update-manifest',
      'Do not invent coordinates before compilation',
      't = duration / 2',
    ]) {
      expect(skill, `missing skill contract phrase: ${phrase}`).toContain(phrase);
    }
    expect(skill).not.toContain('equivalent browser API');
  });

  it('defaults an existing project to non-destructive refinement and captures preservation evidence', () => {
    for (const phrase of [
      'Existing-project refinement',
      'Hard rule:',
      'contains any shots or panoramas',
      '`--reset-project` and `resetProject` are prohibited',
      'project-preservation.json',
      'project-preservation-final.json',
      'Record every original shot ID',
      'panorama ID',
      'retained environment-object ID',
      'camera/timeline entry',
    ]) {
      expect(`${skill}\n${existingProjectRefinement}`, `missing preservation rule: ${phrase}`).toContain(phrase);
    }
    expect(existingProjectRefinement).toContain('"resetAuthorized": false');
  });

  it('documents gated visual batch review that stops after an empty or failed shot', () => {
    for (const phrase of [
      '3–5 shots',
      'A failed shot blocks the next batch.',
      'visual.required-content',
      'reviewedArtifacts',
      'criteria exactly once',
      'Empty rooms',
      'When visual evidence conflicts with `validation.json`, trust the visual evidence and mark the shot failed.',
      'open or sample the MP4',
    ]) {
      expect(`${batchReview}\n${visualAcceptance}`, `missing visual batch gate: ${phrase}`).toContain(phrase);
    }
  });

  it('defines the AI-control export plan and blocks required projected omissions', () => {
    const plan = JSON.parse(readFileSync(aiControlFullPlanPath, 'utf8')) as {
      version?: number;
      commands?: Array<{ op?: string; patch?: Record<string, unknown> }>;
    };
    expect(plan.version).toBe(1);
    const patch = plan.commands?.[0];
    expect(patch?.op).toBe('export.sceneDefaults.patch');
    expect(patch?.patch).toMatchObject({
      peopleExportMode: 'both',
      includeViewport: true,
      includeProjectedViewport: true,
      includeProjectedCameraMoveReferenceFrames: true,
      includeProjectedCameraMoveVideo: true,
      includeCameraMoveVideo: true,
      includeCameraMoveReferenceFrames: true,
      characterPass: {
        enabled: true,
        includeStill: true,
        includeMotion: true,
        motionFormat: 'both',
        backgroundColor: '#00FF00',
        includeAttachedProps: true,
      },
      depth: {
        enabled: true,
        includeViewportStill: true,
        includeReferenceFrames: true,
        includeCameraMoveVideo: true,
        rangeMode: 'auto',
        invert: false,
      },
    });
    expect(deliverables).toContain('agent:plan-exports');
    expect(deliverables).toContain('`missing-projector` is a blocking failure');
  });

  it('requires real proxy replacement work and evidence-based completion summaries', () => {
    for (const phrase of [
      'Copy every proxy shot override to the real model.',
      'Copy timeline/keyframe transforms and visibility where applicable.',
      'zero `commandsApplied` or zero `affectedShots` is a failure',
      'associated visual review record passed',
      'productionComplete": false',
    ]) {
      expect(`${nonhumanoidModels}\n${errorRecovery}`, `missing integrity requirement: ${phrase}`).toContain(phrase);
    }
  });

  it('uses neutral examples in its reusable operating materials', () => {
    const reusableMaterials = [
      skill,
      productionManifest,
      existingProjectRefinement,
      batchReview,
      nonhumanoidModels,
      errorRecovery,
      importedCharacters,
      importedCharacterWorkflow,
    ].join('\n');
    for (const productionSpecificPhrase of [
      'Joseph',
      "What I'm Fighting For",
      'Hand Monster',
      'Spider proxy',
    ]) {
      expect(reusableMaterials).not.toContain(productionSpecificPhrase);
    }
    expect(skill).not.toContain('music-video.json');
  });

  it('keeps every linked local reference and example present', () => {
    const links = [...skill.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.startsWith('http://') || link.startsWith('https://')).toBe(false);
      expect(existsSync(path.resolve(skillRoot, link)), `missing linked skill file: ${link}`).toBe(true);
    }
  });

  it('matches documented manifest enum values to the source schema', () => {
    const typedGroups: Array<{ name: string; values: readonly string[] }> = [
      { name: 'location templates', values: PREVIS_LOCATION_TEMPLATES satisfies readonly PrevisLocationTemplate[] },
      { name: 'camera templates', values: PREVIS_CAMERA_TEMPLATES satisfies readonly PrevisCameraTemplate[] },
      { name: 'camera angles', values: PREVIS_CAMERA_ANGLES satisfies readonly PrevisCameraAngle[] },
      { name: 'lens classes', values: PREVIS_LENS_CLASSES satisfies readonly PrevisLensClass[] },
      { name: 'location slots', values: PREVIS_LOCATION_SLOTS satisfies readonly PrevisLocationSlot[] },
      { name: 'relative relations', values: PREVIS_RELATIVE_RELATIONS satisfies readonly PrevisRelativeRelation[] },
    ];
    const documentation = `${productionManifest}\n${shotTemplates}`;
    for (const group of typedGroups) {
      for (const value of group.values) {
        expect(documentation, `missing ${group.name} enum value: ${value}`).toContain(`\`${value}\``);
      }
    }
  });

  it('keeps every cited agent command aligned with package.json', () => {
    const citedCommands = [...skill.matchAll(/npm run (agent:[a-z-]+)/g)].map((match) => match[1]!);
    expect(citedCommands.length).toBeGreaterThan(0);
    for (const command of new Set(citedCommands)) {
      expect(packageJson.scripts?.[command], `missing package script: ${command}`).toBeTruthy();
    }
  });

  it('keeps reusable primitives independent from the optional refinement runner', () => {
    const primitiveCommands = [
      'agent:import-model',
      'agent:replace-proxy',
      'agent:render-passes',
      'agent:plan-exports',
      'agent:verify-package',
    ];
    for (const command of primitiveCommands) {
      expect(skill, `primitive command missing from skill: ${command}`).toContain(`npm run ${command}`);
      expect(packageJson.scripts?.[command], `primitive command missing from package.json: ${command}`).toBeTruthy();
    }
    expect(skill).toContain('individual Agent API operations and CLI commands are ForeScene\'s reusable, first-class primitives');
    expect(skill).toContain('`agent:refine` is an optional advanced runner');
    expect(skill).toContain('not required for ordinary ForeScene operation, simple asset replacement, normal shot corrections, rendering, or export');
    expect(skill).toContain('The skill owns production interpretation, visual judgment, repair strategy, and the decision to continue or stop.');
    expect(skill).toContain('ForeScene and the Agent API provide the operations, validation, preservation mechanisms, and export capabilities');

    const workflowStart = skill.indexOf('## Existing-project refinement workflow');
    const workflowEnd = skill.indexOf('## Export profiles and package planning');
    expect(workflowStart).toBeGreaterThanOrEqual(0);
    expect(workflowEnd).toBeGreaterThan(workflowStart);
    const ordinaryWorkflow = skill.slice(workflowStart, workflowEnd);
    expect(ordinaryWorkflow).not.toContain('agent:refine');
  });

  it('provides a real motion example and documents imported cast binding', () => {
    const examplePath = path.join(skillRoot, 'examples', 'dialogue-motion.json');
    const example = JSON.parse(readFileSync(examplePath, 'utf8')) as {
      cast?: Array<{ type?: string }>;
      shots?: Array<{ motion?: { durationSeconds?: number; keyframes?: Array<{ timeSeconds?: number }> } }>;
    };
    const parsed = parsePrevisProductionManifest(example);
    expect(parsed.errors, parsed.errors.map((error) => error.message).join('\n')).toEqual([]);
    expect(example.shots?.some((shot) => shot.motion?.keyframes && shot.motion.keyframes.length >= 2)).toBe(true);
    expect(example.cast?.every((character) => character.type === 'human_dummy')).toBe(true);
    expect(importedCharacterWorkflow).toContain('agent:previs');
    expect(importedCharacterWorkflow).toContain('imported_character');
    expect(importedCharacterWorkflow).toContain('preserve-existing');
  });
});
