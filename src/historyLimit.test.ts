import { describe, expect, it } from 'vitest'

import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  MIN_HISTORY_LIMIT,
  commitHistoryLimitDraft,
  normalizeHistoryLimit,
} from './historyLimit'

describe('history limit settings', () => {
  it('normalizes persisted limits into the supported range', () => {
    expect(normalizeHistoryLimit('not-a-number')).toBe(DEFAULT_HISTORY_LIMIT)
    expect(normalizeHistoryLimit(5)).toBe(MIN_HISTORY_LIMIT)
    expect(normalizeHistoryLimit(MAX_HISTORY_LIMIT + 100)).toBe(MAX_HISTORY_LIMIT)
  })

  it('commits a typed draft without treating intermediate input as final', () => {
    expect(commitHistoryLimitDraft('', 100)).toBe(100)
    expect(commitHistoryLimitDraft('5', 100)).toBe(MIN_HISTORY_LIMIT)
    expect(commitHistoryLimitDraft('500', 100)).toBe(500)
  })
})
