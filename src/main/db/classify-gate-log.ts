import { randomUUID } from 'node:crypto'
import { getDb } from './index'

export interface ClassifyGateSample {
  gateVerdict: 'skip' | 'run'
  /** 'unknown' when the classifier's own response couldn't be parsed (same fail-open case `classifyAndPlan` already treats as "no plan" — still worth a row, since the gate's verdict was still real). */
  classifierComplexity: 'simple' | 'compound' | 'unknown'
  messageLength: number
}

/** Called from `Orchestrator.classifyAndPlan` (via the optional `logClassifyGateSample` constructor option, wired to this in ipc/register.ts) every time the real classifier actually runs — see TASKS.md #95. */
export function logClassifyGateSample(sample: ClassifyGateSample): void {
  getDb()
    .prepare(
      `INSERT INTO classify_gate_log (id, gate_verdict, classifier_complexity, message_length, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(randomUUID(), sample.gateVerdict, sample.classifierComplexity, sample.messageLength, Date.now())
}

export interface ClassifyGateAccuracy {
  totalSamples: number
  /** How many logged samples were turns the gate said 'skip' on (all sampled for calibration, since a 'run' verdict always logs too, from every ordinary classify call). */
  gateSkipped: number
  /** The real danger case: the gate said 'skip' (would have treated this as simple, no classifier call at all, outside a sampled turn) but the real classifier said 'compound'. Should stay at or near 0 before phase 1's gate is ever widened. */
  gateSkippedButWasCompound: number
}

/** No date range/pagination yet — this only needs to answer "is the gate still accurate so far," not serve a paginated report UI, which isn't part of #95's scope. */
export function getClassifyGateAccuracy(): ClassifyGateAccuracy {
  const db = getDb()
  const totalSamples = (db.prepare('SELECT COUNT(*) AS c FROM classify_gate_log').get() as { c: number }).c
  const gateSkipped = (
    db.prepare(`SELECT COUNT(*) AS c FROM classify_gate_log WHERE gate_verdict = 'skip'`).get() as { c: number }
  ).c
  const gateSkippedButWasCompound = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM classify_gate_log WHERE gate_verdict = 'skip' AND classifier_complexity = 'compound'`
      )
      .get() as { c: number }
  ).c
  return { totalSamples, gateSkipped, gateSkippedButWasCompound }
}
