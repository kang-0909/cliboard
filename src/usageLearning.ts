export type UsageLearningCandidateKind = 'snippet' | 'history' | (string & {})

export interface UsageLearningCandidate {
  id: string
  title: string
  path: string
  kind: UsageLearningCandidateKind
}

export type UsageLearningOrderItem =
  | string
  | UsageLearningCandidate
  | {
      id: string
      title?: string
      path?: string
      kind?: UsageLearningCandidateKind
    }

export interface UsageLearningEvent {
  query: string
  targetApp?: string
  selectedId?: string
  selectedItem?: UsageLearningOrderItem
  initialOrder?: UsageLearningOrderItem[]
  finalOrder?: UsageLearningOrderItem[]
  llm?: {
    used?: boolean
    matchMode?: string
    model?: string
  }
  llmUsed?: boolean
  matchMode?: string
  model?: string
  timestamp?: number | string | Date
  action?: string
  surface?: string
}

export interface UsageLearningOptions {
  now?: number | string | Date
  halfLifeDays?: number
  minQuerySimilarity?: number
  maxBoost?: number
  maxPenalty?: number
  selectedWeight?: number
  unselectedWeight?: number
}

export type UsageLearningScorer = (
  query: string,
  candidate: UsageLearningCandidate,
  targetApp?: string,
) => number

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_HALF_LIFE_DAYS = 21
const DEFAULT_MIN_QUERY_SIMILARITY = 0.34
const DEFAULT_MAX_BOOST = 0.35
const DEFAULT_MAX_PENALTY = 0.06
const DEFAULT_SELECTED_WEIGHT = 0.22
const DEFAULT_UNSELECTED_WEIGHT = 0.018

export function buildHistoricalQueryBoost(
  events: UsageLearningEvent[],
  options: UsageLearningOptions = {},
): UsageLearningScorer {
  const now = toTime(options.now) ?? Date.now()
  const halfLifeDays = Math.max(1, options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS)
  const minQuerySimilarity = options.minQuerySimilarity ?? DEFAULT_MIN_QUERY_SIMILARITY
  const maxBoost = Math.max(0, options.maxBoost ?? DEFAULT_MAX_BOOST)
  const maxPenalty = Math.max(0, options.maxPenalty ?? DEFAULT_MAX_PENALTY)
  const selectedWeight = Math.max(0, options.selectedWeight ?? DEFAULT_SELECTED_WEIGHT)
  const unselectedWeight = Math.max(0, options.unselectedWeight ?? DEFAULT_UNSELECTED_WEIGHT)
  const preparedEvents = events
    .map((event) => ({
      event,
      queryTerms: termsFor(event.query),
      timeWeight: recencyWeight(event.timestamp, now, halfLifeDays),
      selectedId: event.selectedId ?? itemId(event.selectedItem),
    }))
    .filter((event) => event.event.query.trim().length > 0 && event.timeWeight > 0)

  return (query, candidate, targetApp) => {
    const queryTerms = termsFor(query)
    if (queryTerms.length === 0) {
      return 0
    }

    let score = 0

    for (const prepared of preparedEvents) {
      const querySimilarity = tokenSimilarity(queryTerms, prepared.queryTerms)
      if (querySimilarity < minQuerySimilarity) {
        continue
      }

      const baseWeight = querySimilarity * prepared.timeWeight * appWeight(prepared.event.targetApp, targetApp)
      const selectedId = prepared.selectedId

      if (selectedId === candidate.id) {
        score += selectedWeight * baseWeight
      }

      if (selectedId && selectedId !== candidate.id) {
        score -= unselectedExposurePenalty(candidate.id, prepared.event.finalOrder, unselectedWeight, 1.0) * baseWeight
        score -= unselectedExposurePenalty(candidate.id, prepared.event.initialOrder, unselectedWeight, 0.55) * baseWeight
      }
    }

    return clamp(score, -maxPenalty, maxBoost)
  }
}

function termsFor(text: string): string[] {
  const normalized = text.toLowerCase()
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  const terms = new Set<string>()

  for (const word of words) {
    if (word.length <= 1) {
      terms.add(word)
      continue
    }

    terms.add(word)
    if (hasCjk(word)) {
      for (const char of Array.from(word)) {
        terms.add(char)
      }
    }
  }

  return Array.from(terms)
}

function tokenSimilarity(queryTerms: string[], eventTerms: string[]): number {
  if (queryTerms.length === 0 || eventTerms.length === 0) {
    return 0
  }

  let matched = 0
  for (const queryTerm of queryTerms) {
    if (eventTerms.some((eventTerm) => termsMatch(queryTerm, eventTerm))) {
      matched += 1
    }
  }

  const queryCoverage = matched / queryTerms.length
  const eventCoverage = matched / eventTerms.length
  return queryCoverage * 0.7 + eventCoverage * 0.3
}

function termsMatch(a: string, b: string): boolean {
  if (a === b) {
    return true
  }

  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) {
    return true
  }

  const maxLength = Math.max(a.length, b.length)
  return maxLength >= 5 && levenshteinDistance(a, b) / maxLength <= 0.24
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = Array.from({ length: b.length + 1 }, () => 0)

  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    current[0] = aIndex

    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      const substitutionCost = a[aIndex - 1] === b[bIndex - 1] ? 0 : 1
      current[bIndex] = Math.min(
        previous[bIndex] + 1,
        current[bIndex - 1] + 1,
        previous[bIndex - 1] + substitutionCost,
      )
    }

    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index]
    }
  }

  return previous[b.length]
}

function appWeight(eventApp: string | undefined, targetApp: string | undefined): number {
  if (!eventApp || !targetApp) {
    return 0.85
  }

  return eventApp.toLowerCase() === targetApp.toLowerCase() ? 1.25 : 0.55
}

function recencyWeight(timestamp: UsageLearningEvent['timestamp'], now: number, halfLifeDays: number): number {
  const time = toTime(timestamp)
  if (time === undefined) {
    return 0.75
  }

  const ageDays = Math.max(0, (now - time) / DAY_MS)
  return 0.5 ** (ageDays / halfLifeDays)
}

function unselectedExposurePenalty(
  candidateId: string,
  order: UsageLearningOrderItem[] | undefined,
  weight: number,
  listMultiplier: number,
): number {
  if (!order) {
    return 0
  }

  const topIndex = order.slice(0, 5).findIndex((item) => itemId(item) === candidateId)
  if (topIndex < 0) {
    return 0
  }

  return weight * listMultiplier * (1 - topIndex * 0.12)
}

function itemId(item: UsageLearningOrderItem | undefined): string | undefined {
  if (!item) {
    return undefined
  }

  return typeof item === 'string' ? item : item.id
}

function toTime(value: number | string | Date | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(time) ? time : undefined
}

function hasCjk(value: string): boolean {
  return /\p{Script=Han}/u.test(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
