import type { AgentTelemetry } from '../report';
import type { CandidateMatch } from './dom-check';
import type { LocatorUsage } from './locators';
import type { Check, Proposal, Refusal, RepairEdit } from './proposal';

export const HEAL_SCHEMA_VERSION = '1.0';

/**
 * not_eligible  – the deterministic gate declined (no model call)
 * refused       – the agent declined to repair
 * rejected      – the agent's proposals failed the deterministic checks
 * error         – the agent could not finish (API error, limits)
 * proposed      – a checked proposal is waiting for validation
 * validated     – the patched tests passed in the worktree: a PR may be prepared
 * failed_validation – the patched tests did not pass
 */
export type HealStatus = 'not_eligible' | 'refused' | 'rejected' | 'error' | 'proposed' | 'validated' | 'failed_validation';

export interface PhaseResult {
  name: string;
  /** Playwright location filters / spec files that were run. */
  targets: string[];
  expected: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  /** Tests that were required to run in this phase but did not. */
  missing: string[];
  exitCode: number | null;
  durationMs: number;
  failures: Array<{ title: string; error: string }>;
}

export interface HealResult {
  schemaVersion: string;
  generatedAt: string;
  status: HealStatus;
  reason: string;
  notes: string[];
  run: { url: string | null; commit: string | null; branch: string | null; eventName: string | null };
  plan: {
    failingLocator: string;
    failingTestId: string;
    file: string;
    line: number;
    property: string | null;
    scope: string | null;
    usage: LocatorUsage;
    tests: Array<{ id: string; title: string; file: string; line: number | null }>;
    deferred: Array<{ testId: string; tests: string[] }>;
  } | null;
  proposal: Proposal | null;
  refusal: Refusal | null;
  checks: Check[];
  edit: RepairEdit | null;
  target: CandidateMatch | null;
  evidence: Array<{ evidenceId: string; source: string; observation: string; excerpt: string }>;
  agent: AgentTelemetry | null;
  validation: { phases: PhaseResult[]; patch: string | null } | null;
}
