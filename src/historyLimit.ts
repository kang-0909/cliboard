import { MAX_HISTORY_ITEMS } from './clipboardHistory'

export const DEFAULT_HISTORY_LIMIT = MAX_HISTORY_ITEMS
export const MIN_HISTORY_LIMIT = 10
export const MAX_HISTORY_LIMIT = 1000

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function normalizeHistoryLimit(value: unknown, fallback = DEFAULT_HISTORY_LIMIT) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.round(clampNumber(numeric, MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT))
}

export function commitHistoryLimitDraft(draft: string, currentLimit: number) {
  const trimmed = draft.trim()
  return normalizeHistoryLimit(trimmed || currentLimit, currentLimit)
}
