import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCandidateBrief } from './brief';
import { harnessFailure, modelFailure } from './failures';
import { findForbiddenCandidateFiles } from './forbidden';
import { hashDirectory } from './hashes';
import {
  enforceGitIdentity,
  gitIdentity,
  unauthorizedRepoModifications,
  type GitIdentityRecord,
} from './git';
import { createBenchmarkRunLayout, type BenchmarkRunLayout } from './layout';
import type { BenchmarkFailure, BenchmarkSpecV1 } from './types';
import { validateTechnicalBenchmark, type TechnicalValidation } from './validator';

export async function prepareBenchmarkRun(input: {
  spec: BenchmarkSpecV1;
  specPath: string;
  runRoot: string;
  url?: string;
  enforceRepositoryState?: boolean;
}): Promise<{ layout: BenchmarkRunLayout; failure?: BenchmarkFailure; git?: GitIdentityRecord }> {
  const layout = await createBenchmarkRunLayout(input.runRoot);
  await writeFile(layout.specPath, `${JSON.stringify(input.spec, null, 2)}\n`, 'utf8');
  const git = await gitIdentity();
  await writeFile(layout.gitPath, `${JSON.stringify(git, null, 2)}\n`, 'utf8');
  if (input.enforceRepositoryState !== false) {
    const gitFailure = enforceGitIdentity(git);
    if (gitFailure) return { layout, git, failure: gitFailure };
  }

  let projectPackage: string | undefined;
  if (input.spec.basePackage) {
    const source = path.resolve(path.dirname(input.specPath), input.spec.basePackage);
    projectPackage = path.join(layout.projectDir, path.basename(source));
    try {
      await cp(source, projectPackage);
    } catch (error) {
      return {
        layout,
        git,
        failure: harnessFailure(`Could not copy base package ${source}: ${error instanceof Error ? error.message : String(error)}`),
      };
    }
  }

  const brief = buildCandidateBrief({
    spec: input.spec,
    layout,
    url: input.url,
    projectPackage,
  });
  await writeFile(layout.briefPath, `${JSON.stringify(brief, null, 2)}\n`, 'utf8');
  return { layout, git };
}

export async function collectBenchmarkRun(input: {
  spec: BenchmarkSpecV1;
  layout: BenchmarkRunLayout;
  enforceRepositoryState?: boolean;
}): Promise<{ failure?: BenchmarkFailure; validation: TechnicalValidation }> {
  if (input.enforceRepositoryState !== false) {
    const before = JSON.parse(await readFile(input.layout.gitPath, 'utf8')) as GitIdentityRecord;
    const after = await gitIdentity();
    const drift = unauthorizedRepoModifications(before, after);
    if (drift) {
      return {
        failure: drift,
        validation: { ok: false, checks: [{ id: 'git.unauthorized', ok: false, message: drift.message }] },
      };
    }
  }

  const forbidden = await findForbiddenCandidateFiles(input.layout.workDir);
  if (forbidden.length > 0) {
    return {
      failure: modelFailure(
        'Candidate created forbidden harness glue. Use documented Agent CLI commands.',
        'harness.forbidden',
      ),
      validation: {
        ok: false,
        checks: forbidden.map((hit) => ({ id: hit.relativePath, ok: false, message: hit.reason })),
      },
    };
  }

  const hashes = await hashDirectory(input.layout.artifactDir);
  await writeFile(input.layout.hashesPath, `${JSON.stringify({ files: hashes }, null, 2)}\n`, 'utf8');
  const validation = await validateTechnicalBenchmark(input.spec, input.layout);
  await writeFile(input.layout.validationPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
  if (!validation.ok) {
    return {
      validation,
      failure: modelFailure('Technical validator failed.', 'harness.technical-validator'),
    };
  }
  return { validation };
}
