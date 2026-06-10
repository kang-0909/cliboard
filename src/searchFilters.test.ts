import { describe, expect, it } from 'vitest'
import { matchesSnippetFilters, parseSearchQuery } from './searchFilters'

describe('search filter parsing', () => {
  it('extracts keyed filters and leaves the natural language query', () => {
    const parsed = parseSearchQuery('type:image app:chrome path:Clipboard/Screenshot today failed rollout')

    expect(parsed.text).toBe('failed rollout')
    expect(parsed.filters).toEqual({
      type: 'image',
      app: 'chrome',
      path: 'clipboard/screenshot',
      today: true,
    })
  })

  it('supports snippet path and starred filters', () => {
    const parsed = parseSearchQuery('path:Shell/HuggingFace starred download model')
    const snippet = {
      id: 'hf',
      title: 'Download model',
      path: 'Shell/HuggingFace',
      description: '',
      template: '',
      tags: ['shell'],
      intents: [],
      favorite: true,
      useCount: 0,
    }

    expect(parsed.text).toBe('download model')
    expect(matchesSnippetFilters(snippet, parsed.filters)).toBe(true)
    expect(matchesSnippetFilters({ ...snippet, favorite: false }, parsed.filters)).toBe(false)
  })
})
