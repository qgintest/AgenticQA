/**
 * Every successful tool call is recorded as a piece of evidence with an id (E1, E2, ...). The model
 * must cite these ids in its report; ids it never received are rejected during grounding.
 */

export interface EvidenceRecord {
  id: string;
  tool: string;
  testId: string | null;
  /** Human-readable description of what was inspected (no absolute paths). */
  source: string;
  /** Short redacted excerpt of what the tool returned, for the report. */
  excerpt: string;
}

export class EvidenceStore {
  private readonly records = new Map<string, EvidenceRecord>();

  add(tool: string, testId: string | null, source: string, excerpt: string): EvidenceRecord {
    const id = `E${this.records.size + 1}`;
    const rec: EvidenceRecord = { id, tool, testId, source, excerpt: excerpt.slice(0, 600) };
    this.records.set(id, rec);
    return rec;
  }

  get(id: string): EvidenceRecord | undefined {
    return this.records.get(id);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  all(): EvidenceRecord[] {
    return [...this.records.values()];
  }
}
