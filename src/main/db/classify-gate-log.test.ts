import { beforeEach, describe, expect, it } from 'vitest'
import { setDbPath } from './index'
import { getClassifyGateAccuracy, logClassifyGateSample } from './classify-gate-log'

describe('classify gate log repository', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('starts empty', () => {
    expect(getClassifyGateAccuracy()).toEqual({ totalSamples: 0, gateSkipped: 0, gateSkippedButWasCompound: 0 })
  })

  it('counts total samples and skip/run verdicts separately', () => {
    logClassifyGateSample({ gateVerdict: 'run', classifierComplexity: 'simple', messageLength: 80 })
    logClassifyGateSample({ gateVerdict: 'skip', classifierComplexity: 'simple', messageLength: 10 })
    logClassifyGateSample({ gateVerdict: 'skip', classifierComplexity: 'simple', messageLength: 12 })

    const accuracy = getClassifyGateAccuracy()
    expect(accuracy.totalSamples).toBe(3)
    expect(accuracy.gateSkipped).toBe(2)
  })

  it('flags the real danger case: the gate skipped but the request was actually compound', () => {
    logClassifyGateSample({ gateVerdict: 'skip', classifierComplexity: 'compound', messageLength: 40 })
    logClassifyGateSample({ gateVerdict: 'skip', classifierComplexity: 'simple', messageLength: 12 })
    logClassifyGateSample({ gateVerdict: 'run', classifierComplexity: 'compound', messageLength: 200 })

    // The 'run' row's own compound result doesn't count as a gate failure —
    // the gate correctly deferred to the real classifier on that one.
    expect(getClassifyGateAccuracy().gateSkippedButWasCompound).toBe(1)
  })
})
