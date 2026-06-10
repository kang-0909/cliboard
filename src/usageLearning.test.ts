import { describe, expect, it } from 'vitest'
import {
  buildHistoricalQueryBoost,
  type UsageLearningCandidate,
  type UsageLearningEvent,
} from './usageLearning'

const now = Date.UTC(2026, 4, 12)
const day = 24 * 60 * 60 * 1000

function candidate(
  id: string,
  title = 'Download Hugging Face model',
  path = 'Shell/HuggingFace',
  kind: UsageLearningCandidate['kind'] = 'snippet',
): UsageLearningCandidate {
  return { id, title, path, kind }
}

function selectedEvent(overrides: Partial<UsageLearningEvent> = {}): UsageLearningEvent {
  return {
    query: 'download huggingface model',
    targetApp: 'Terminal',
    selectedId: 'hf-download',
    selectedItem: candidate('hf-download'),
    initialOrder: ['hf-download', 'git-amend', 'docker-logs'],
    finalOrder: ['hf-download', 'docker-logs', 'git-amend'],
    llm: {
      used: true,
      matchMode: 'hybrid',
      model: 'test-model',
    },
    timestamp: now,
    action: 'select',
    surface: 'launcher',
    ...overrides,
  }
}

describe('usage learning boost', () => {
  it('boosts a selected candidate for a similar query', () => {
    const scorer = buildHistoricalQueryBoost([selectedEvent()], { now })

    expect(scorer('huggingface model download', candidate('hf-download'), 'Terminal')).toBeGreaterThan(0)
  })

  it('weakens the boost when the target app differs', () => {
    const scorer = buildHistoricalQueryBoost([selectedEvent()], { now })

    const sameApp = scorer('download huggingface model', candidate('hf-download'), 'Terminal')
    const differentApp = scorer('download huggingface model', candidate('hf-download'), 'Notes')

    expect(differentApp).toBeGreaterThan(0)
    expect(differentApp).toBeLessThan(sameApp)
  })

  it('does not boost unrelated queries even when the app matches', () => {
    const scorer = buildHistoricalQueryBoost([selectedEvent()], { now })

    expect(scorer('amend latest git commit', candidate('hf-download'), 'Terminal')).toBe(0)
  })

  it('applies only a light penalty for exposed but unselected top items', () => {
    const scorer = buildHistoricalQueryBoost([selectedEvent()], { now })

    const exposed = scorer('download huggingface model', candidate('docker-logs'), 'Terminal')
    const selected = scorer('download huggingface model', candidate('hf-download'), 'Terminal')

    expect(exposed).toBeLessThan(0)
    expect(Math.abs(exposed)).toBeLessThan(selected)
    expect(Math.abs(exposed)).toBeLessThan(0.06)
  })

  it('weights recent events higher than old events', () => {
    const recentScorer = buildHistoricalQueryBoost([selectedEvent({ timestamp: now - day })], { now })
    const oldScorer = buildHistoricalQueryBoost([selectedEvent({ timestamp: now - 60 * day })], { now })

    const recent = recentScorer('download huggingface model', candidate('hf-download'), 'Terminal')
    const old = oldScorer('download huggingface model', candidate('hf-download'), 'Terminal')

    expect(recent).toBeGreaterThan(old)
  })

  it('caps accumulated positive boost', () => {
    const events = Array.from({ length: 12 }, (_, index) => selectedEvent({ timestamp: now - index * day }))
    const scorer = buildHistoricalQueryBoost(events, { now, maxBoost: 0.3 })

    expect(scorer('download huggingface model', candidate('hf-download'), 'Terminal')).toBe(0.3)
  })

  it('supports history candidates', () => {
    const scorer = buildHistoricalQueryBoost(
      [
        selectedEvent({
          selectedId: 'history-1',
          selectedItem: candidate('history-1', 'Copied Hugging Face command', 'Clipboard/Terminal', 'history'),
        }),
      ],
      { now },
    )

    expect(
      scorer(
        'download huggingface model',
        candidate('history-1', 'Copied Hugging Face command', 'Clipboard/Terminal', 'history'),
        'Terminal',
      ),
    ).toBeGreaterThan(0)
  })
})
