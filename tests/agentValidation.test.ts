import { describe, expect, it } from 'vitest';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
} from '../src/engine/agent/diagnostics';
import {
  AGENT_INSPECT_COMMANDS,
  buildAgentCapabilities,
} from '../src/engine/agent/capabilities';

describe('agent diagnostics', () => {
  it('builds stable write-access diagnostics', () => {
    const diagnostic = writeAccessRequiredDiagnostic('applyPlan');
    expect(diagnostic.code).toBe(AGENT_DIAGNOSTIC_CODES.writeAccessRequired);
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.message).toContain('applyPlan');
  });

  it('preserves candidate lists on ambiguous targets', () => {
    const diagnostic = agentError('ambiguous_target', 'Multiple matches', {
      path: 'object.query',
      candidates: ['a', 'b'],
    });
    expect(diagnostic.candidates).toEqual(['a', 'b']);
    expect(diagnostic.path).toBe('object.query');
  });
});

describe('agent capabilities', () => {
  it('allows inspection in read-only mode but not mutations', () => {
    const caps = buildAgentCapabilities('read-only');
    expect(caps.inspection).toBe(true);
    expect(caps.mutations).toBe(false);
    expect(caps.commands.inspect).toEqual([...AGENT_INSPECT_COMMANDS]);
    expect(caps.runtime.focusObjects).toBe(false);
  });

  it('enables mutation capability only in read-write mode', () => {
    expect(buildAgentCapabilities('read-write').mutations).toBe(true);
    expect(buildAgentCapabilities('off').inspection).toBe(false);
  });
});
