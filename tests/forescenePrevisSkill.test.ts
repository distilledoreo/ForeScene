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
const skillRoot = path.join(repoRoot, '.grok', 'skills', 'forescene-previs');
const skillPath = path.join(skillRoot, 'SKILL.md');
const productionManifestPath = path.join(skillRoot, 'references', 'production-manifest.md');
const shotTemplatesPath = path.join(skillRoot, 'references', 'shot-templates.md');

const skill = readFileSync(skillPath, 'utf8');
const productionManifest = readFileSync(productionManifestPath, 'utf8');
const shotTemplates = readFileSync(shotTemplatesPath, 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('ForeScene previs skill contract', () => {
  it('documents the current still, motion, and imported-character workflow', () => {
    for (const phrase of [
      'agent:frame',
      'agent:video',
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
    const importedWorkflow = readFileSync(path.join(skillRoot, 'examples', 'imported-character-workflow.md'), 'utf8');
    expect(importedWorkflow).toContain('agent:previs');
    expect(importedWorkflow).toContain('imported_character');
    expect(importedWorkflow).toContain('preserve-existing');
  });
});
