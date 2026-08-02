/**
 * Stable diagnostic codes and helpers for previs production manifests.
 */

export type PrevisDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface PrevisDiagnostic {
  code: string;
  message: string;
  severity: PrevisDiagnosticSeverity;
  path?: string;
  /** Related entity id when known. */
  entityId?: string;
}

export const PREVIS_DIAGNOSTIC_CODES = {
  schemaVersion: 'schema_version',
  invalidType: 'invalid_type',
  missingField: 'missing_field',
  emptyField: 'empty_field',
  duplicateId: 'duplicate_id',
  duplicateShotNumber: 'duplicate_shot_number',
  unknownReference: 'unknown_reference',
  unsupportedTemplate: 'unsupported_template',
  unsupportedValue: 'unsupported_value',
  limitExceeded: 'limit_exceeded',
  invalidRange: 'invalid_range',
  invalidCombination: 'invalid_combination',
  customBlueprintUnsupported: 'custom_blueprint_unsupported',
  missingSavedRigPackage: 'missing_saved_rig_package',
  unsupportedSavedRigExtension: 'unsupported_saved_rig_extension',
  unexpectedRigPackage: 'unexpected_rig_package',
  missingImportedCharacterSource: 'missing_imported_character_source',
} as const;

export function previsError(
  code: string,
  message: string,
  extras: Partial<Pick<PrevisDiagnostic, 'path' | 'entityId'>> = {},
): PrevisDiagnostic {
  return { code, message, severity: 'error', ...extras };
}

export function previsWarning(
  code: string,
  message: string,
  extras: Partial<Pick<PrevisDiagnostic, 'path' | 'entityId'>> = {},
): PrevisDiagnostic {
  return { code, message, severity: 'warning', ...extras };
}

export function previsInfo(
  code: string,
  message: string,
  extras: Partial<Pick<PrevisDiagnostic, 'path' | 'entityId'>> = {},
): PrevisDiagnostic {
  return { code, message, severity: 'info', ...extras };
}

export function formatPrevisDiagnostics(diagnostics: PrevisDiagnostic[]): string {
  return diagnostics
    .map((item) => {
      const path = item.path ? ` (${item.path})` : '';
      return `[${item.severity}] ${item.code}${path}: ${item.message}`;
    })
    .join('\n');
}
