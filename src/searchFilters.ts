import type { ClipboardHistoryItem } from './clipboardHistory'
import type { SearchableSnippet } from './snippetSearch'

export type SearchFilters = {
  type?: string
  app?: string
  path?: string
  starred?: boolean
  today?: boolean
}

export type ParsedSearchQuery = {
  text: string
  filters: SearchFilters
}

const KEYED_FILTER = /(?:^|\s)(type|app|path):(?:"([^"]+)"|'([^']+)'|(\S+))/gi

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const filters: SearchFilters = {}
  let text = query.replace(KEYED_FILTER, (_match, key: string, quoted: string, single: string, bare: string) => {
    const value = (quoted || single || bare || '').trim()
    if (!value) return ' '
    if (key.toLowerCase() === 'type') filters.type = normalizeFilterValue(value)
    if (key.toLowerCase() === 'app') filters.app = normalizeFilterValue(value)
    if (key.toLowerCase() === 'path') filters.path = value.trim().toLowerCase()
    return ' '
  })

  text = text
    .split(/\s+/)
    .filter((token) => {
      const normalized = normalizeFilterValue(token)
      if (normalized === 'starred' || normalized === 'favorite' || normalized === 'favourite') {
        filters.starred = true
        return false
      }
      if (normalized === 'today' || normalized === '今日' || normalized === '今天') {
        filters.today = true
        return false
      }
      return Boolean(token)
    })
    .join(' ')
    .trim()

  return { text, filters }
}

export function hasSearchFilters(filters: SearchFilters) {
  return Boolean(filters.type || filters.app || filters.path || filters.starred || filters.today)
}

export function matchesHistoryFilters(
  item: ClipboardHistoryItem,
  filters: SearchFilters,
  now = new Date(),
) {
  if (filters.type && !historyTypeAliases(item).includes(filters.type)) return false
  if (filters.app && !sourceAppText(item).includes(filters.app)) return false
  if (filters.path && !historyPath(item).includes(filters.path)) return false
  if (filters.starred && !item.pinned) return false
  if (filters.today && !isSameLocalDay(item.createdAt, now)) return false
  return true
}

export function matchesSnippetFilters(
  snippet: Pick<SearchableSnippet, 'path' | 'tags' | 'title'> & {
    favorite?: boolean
    createdAt?: string
  },
  filters: SearchFilters,
  now = new Date(),
) {
  if (filters.type && !snippetTypeAliases(snippet).includes(filters.type)) return false
  if (filters.app) return false
  if (filters.path && !snippet.path.toLowerCase().includes(filters.path)) return false
  if (filters.starred && !snippet.favorite) return false
  if (filters.today && (!snippet.createdAt || !isSameLocalDay(snippet.createdAt, now))) return false
  return true
}

function normalizeFilterValue(value: string) {
  return value.trim().toLowerCase()
}

function historyTypeAliases(item: ClipboardHistoryItem) {
  const aliases = new Set<string>([item.kind])
  if (item.contentType) aliases.add(item.contentType)
  if (item.kind === 'image') aliases.add('picture')
  if (item.kind === 'file') {
    aliases.add('files')
    aliases.add('path')
  }
  if (item.kind === 'text') aliases.add('plain')
  return Array.from(aliases).map(normalizeFilterValue)
}

function snippetTypeAliases(snippet: Pick<SearchableSnippet, 'path' | 'tags' | 'title'>) {
  const values = [snippet.path, snippet.title, ...snippet.tags].join(' ').toLowerCase()
  const aliases = new Set<string>()
  if (values.includes('shell')) aliases.add('code')
  if (values.includes('sql')) aliases.add('code')
  if (values.includes('prompt')) aliases.add('text')
  if (values.includes('image')) aliases.add('image')
  if (values.includes('file')) aliases.add('file')
  return Array.from(aliases)
}

function historyPath(item: ClipboardHistoryItem) {
  const contentType = item.contentType ?? item.kind
  return `clipboard/${contentType}`.toLowerCase()
}

function sourceAppText(item: ClipboardHistoryItem) {
  return [item.sourceApp?.name, item.sourceApp?.bundleId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function isSameLocalDay(iso: string, now: Date) {
  const date = new Date(iso)
  return date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
}
