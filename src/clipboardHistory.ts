import { scoreSnippet, type SearchableSnippet } from './snippetSearch'
import { hasSearchFilters, matchesHistoryFilters, parseSearchQuery } from './searchFilters'

export type ClipboardItemKind = 'text' | 'image' | 'file'
export type ClipboardContentType =
  | 'text'
  | 'url'
  | 'code'
  | 'json'
  | 'env'
  | 'jwt'
  | 'api-key'
  | 'rich-text'
  | 'file'
  | 'image'
  | 'screenshot'

export type ClipboardImagePayload = {
  width: number
  height: number
  rgbaBase64?: string
  rgbaBytes?: Uint8Array
  originalByteLength?: number
  previewDataUrl?: string
  caption?: string
}

export type ClipboardSourceApp = {
  name?: string | null
  bundleId?: string | null
}

export type ClipboardHistoryItem = {
  id: string
  kind: ClipboardItemKind
  contentType?: ClipboardContentType
  title: string
  subtitle: string
  signature: string
  content?: string
  html?: string
  files?: string[]
  image?: ClipboardImagePayload
  sourceApp?: ClipboardSourceApp
  pinned?: boolean
  createdAt: string
  updatedAt: string
  copyCount: number
}

export type ClipboardHistoryDraft =
  | {
      kind: 'text'
      content: string
      html?: string
      contentType?: ClipboardContentType
      sourceApp?: ClipboardSourceApp
      createdAt?: string
    }
  | {
      kind: 'file'
      content: string
      files: string[]
      sourceApp?: ClipboardSourceApp
      createdAt?: string
    }
  | {
      kind: 'image'
      image: ClipboardImagePayload
      hash: string
      contentType?: ClipboardContentType
      sourceApp?: ClipboardSourceApp
      createdAt?: string
    }

export const CLIPBOARD_HISTORY_KEY = 'contextclip.clipboard-history.v1'
export const MAX_HISTORY_ITEMS = 100

const FILE_URL_PREFIX = 'file://'
const MAX_TITLE_LENGTH = 84

export function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

export function truncateMiddle(value: string, maxLength = MAX_TITLE_LENGTH) {
  if (value.length <= maxLength) return value
  const keep = Math.max(8, Math.floor((maxLength - 1) / 2))
  return `${value.slice(0, keep)}…${value.slice(-keep)}`
}

export function fileNameFromPath(path: string) {
  const clean = path.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).pop() || clean
}

export function normalizeFilePath(value: string) {
  const trimmed = value.trim().replace(/^["']|["']$/g, '')
  if (!trimmed) return ''
  if (trimmed.startsWith(FILE_URL_PREFIX)) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname)
    } catch {
      return decodeURIComponent(trimmed.slice(FILE_URL_PREFIX.length))
    }
  }
  return trimmed
}

export function detectFilePaths(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map(normalizeFilePath)
    .filter(Boolean)

  if (!lines.length) return []
  const pathLike = lines.filter((line) => {
    if (/^~\//.test(line)) return true
    if (/^\//.test(line)) return true
    if (/^[A-Za-z]:[\\/]/.test(line)) return true
    return false
  })

  return pathLike.length === lines.length ? pathLike : []
}

export function classifyTextClipboard(text: string): ClipboardHistoryDraft | null {
  const content = text.trim()
  if (!content) return null

  const files = detectFilePaths(content)
  if (files.length) {
    return {
      kind: 'file',
      content,
      files,
    }
  }

  return {
    kind: 'text',
    content,
    contentType: detectTextContentType(content),
  }
}

export function classifyRichTextClipboard(text: string, html: string): ClipboardHistoryDraft | null {
  const content = text.trim()
  const richHtml = html.trim()
  if (!content && !richHtml) return null
  return {
    kind: 'text',
    content,
    html: richHtml,
    contentType: 'rich-text',
  }
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function hashBytes(bytes: Uint8Array) {
  let hash = 2166136261
  const stride = Math.max(1, Math.floor(bytes.length / 4096))
  for (let index = 0; index < bytes.length; index += stride) {
    hash ^= bytes[index]
    hash = Math.imul(hash, 16777619)
  }
  hash ^= bytes.length
  return (hash >>> 0).toString(16)
}

export function draftToHistoryItem(draft: ClipboardHistoryDraft, now = new Date().toISOString()) {
  if (draft.kind === 'image') {
    const contentType = draft.contentType ?? detectImageContentType(draft.image, draft.sourceApp)
    return {
      id: `clip-${Date.now()}-${draft.hash}`,
      kind: 'image',
      contentType,
      title: draft.image.caption?.trim() || `Image ${draft.image.width}×${draft.image.height}`,
      subtitle: `${contentType === 'screenshot' ? 'Screenshot' : 'Image'} · ${draft.image.width}×${draft.image.height} pixels`,
      signature: `${contentType}:${draft.image.width}x${draft.image.height}:${draft.hash}`,
      image: draft.image,
      sourceApp: normalizeSourceApp(draft.sourceApp),
      createdAt: draft.createdAt ?? now,
      updatedAt: now,
      copyCount: 0,
    } satisfies ClipboardHistoryItem
  }

  if (draft.kind === 'file') {
    const firstFile = draft.files[0] ?? 'File'
    return {
      id: `clip-${Date.now()}-${hashString(draft.files.join('\n'))}`,
      kind: 'file',
      contentType: 'file',
      title:
        draft.files.length === 1
          ? fileNameFromPath(firstFile)
          : `${draft.files.length} files`,
      subtitle: draft.files.map(fileNameFromPath).join(', '),
      signature: `file:${draft.files.join('\n')}`,
      content: draft.content,
      files: draft.files,
      sourceApp: normalizeSourceApp(draft.sourceApp),
      createdAt: draft.createdAt ?? now,
      updatedAt: now,
      copyCount: 0,
    } satisfies ClipboardHistoryItem
  }

  const content = draft.content.trim()
  const contentType = draft.contentType ?? detectTextContentType(content)
  return {
    id: `clip-${Date.now()}-${hashString(content)}`,
    kind: 'text',
    contentType,
    title: textTitle(content, contentType),
    subtitle: textSubtitle(content, contentType),
    signature: `${contentType}:${content}:${draft.html ? hashString(normalizeHtmlForSignature(draft.html)) : ''}`,
    content,
    html: draft.html?.trim() || undefined,
    sourceApp: normalizeSourceApp(draft.sourceApp),
    createdAt: draft.createdAt ?? now,
    updatedAt: now,
    copyCount: 0,
  } satisfies ClipboardHistoryItem
}

export function mergeHistoryItem(
  items: ClipboardHistoryItem[],
  incoming: ClipboardHistoryItem,
  limit = MAX_HISTORY_ITEMS,
) {
  const existing = items.find((item) => item.signature === incoming.signature)
  const merged = existing
    ? {
        ...incoming,
        id: existing.id,
        pinned: existing.pinned,
        createdAt: existing.createdAt,
        copyCount: existing.copyCount,
        sourceApp: incoming.sourceApp ?? existing.sourceApp,
        title: existing.image?.caption ? existing.title : incoming.title,
        image:
          incoming.kind === 'image' && incoming.image
            ? {
                ...incoming.image,
                caption: existing.image?.caption ?? incoming.image.caption,
              }
            : incoming.image,
      }
    : incoming

  return trimHistoryItems(
    [merged, ...items.filter((item) => item.signature !== incoming.signature)],
    limit,
  )
}

export function replaceHistoryItem(
  items: ClipboardHistoryItem[],
  itemId: string,
  replacement: ClipboardHistoryItem,
  limit = MAX_HISTORY_ITEMS,
) {
  const withoutCurrent = items.filter((item) => item.id !== itemId)
  const duplicate = withoutCurrent.find((item) => item.signature === replacement.signature)
  const selectedId = duplicate?.id ?? replacement.id
  return {
    items: mergeHistoryItem(withoutCurrent, replacement, limit),
    selectedId,
  }
}

export function recordHistoryItemCopied(
  items: ClipboardHistoryItem[],
  itemId: string,
  timestamp = new Date().toISOString(),
) {
  const copied = items.find((item) => item.id === itemId)
  if (!copied) return items

  const updated = {
    ...copied,
    copyCount: copied.copyCount + 1,
    updatedAt: timestamp,
  }

  return [updated, ...items.filter((item) => item.id !== itemId)]
}

export function trimHistoryItems(items: ClipboardHistoryItem[], limit = MAX_HISTORY_ITEMS) {
  if (items.length <= limit) return items
  const kept = items.slice(0, limit)
  const keptIds = new Set(kept.map((item) => item.id))
  const protectedPinned = items
    .slice(limit)
    .filter((item) => item.pinned && !keptIds.has(item.id))
  return [...kept, ...protectedPinned]
}

export function historySearchText(item: ClipboardHistoryItem) {
  return [
    item.kind,
    item.contentType,
    historySearchTitle(item),
    item.kind === 'image' ? '' : item.subtitle,
    item.content,
    item.html ? 'rich text html formatted' : '',
    item.sourceApp?.name,
    ...(item.files ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function historySearchTitle(item: ClipboardHistoryItem) {
  if (item.kind !== 'image') return item.title
  return item.image?.caption || (item.contentType === 'screenshot' ? 'screenshot image' : 'image')
}

export function historyItemToSearchable(item: ClipboardHistoryItem): SearchableSnippet {
  const imageDescription = item.image?.caption ?? ''
  const fileNames = item.files?.map(fileNameFromPath) ?? []
  const sourceAppText = sourceAppDisplayText(item.sourceApp)
  const path =
    item.kind === 'file'
      ? 'Clipboard/File'
      : item.kind === 'image'
        ? item.contentType === 'screenshot' ? 'Clipboard/Screenshot' : 'Clipboard/Image'
        : `Clipboard/${titleCase(item.contentType ?? 'Text')}`

  return {
    id: item.id,
    title: historySearchTitle(item),
    path,
    description: [
      item.kind,
      item.kind === 'image' ? '' : item.subtitle,
      imageDescription,
      sourceAppText,
      ...fileNames,
    ]
      .filter(Boolean)
      .join(' '),
    template: historySearchText(item),
    tags: [
      'clipboard',
      'history',
      item.kind,
      item.contentType ?? '',
      item.kind === 'file' ? 'file path' : '',
      item.kind === 'image' ? 'image screenshot picture' : '',
      item.html ? 'rich text html formatted' : '',
      ...fileNames.map((name) => name.split('.').pop() ?? '').filter(Boolean),
    ].filter(Boolean),
    intents: [
      item.kind === 'text' ? 'paste copied text command note' : '',
      item.kind === 'file' ? 'paste copied file path open file' : '',
      item.kind === 'image' ? 'paste copied image screenshot picture' : '',
      item.image?.caption ?? '',
      sourceAppText,
    ].filter(Boolean),
    favorite: false,
    useCount: 0,
  }
}

export function rankHistoryItems(
  items: ClipboardHistoryItem[],
  query: string,
  targetApp?: ClipboardSourceApp | null,
  learningBoost?: (item: ClipboardHistoryItem, query: string) => number,
) {
  const parsed = parseSearchQuery(query)
  const filtered = hasSearchFilters(parsed.filters)
    ? items.filter((item) => matchesHistoryFilters(item, parsed.filters))
    : items
  const normalizedQuery = parsed.text.trim().toLowerCase()
  if (!normalizedQuery) return filtered

  return filtered
    .map((item, index) => ({
      item,
      index,
      score: scoreHistoryItem(item, normalizedQuery, targetApp) +
        (learningBoost?.(item, normalizedQuery) ?? 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return left.index - right.index
    })
    .map(({ item }) => item)
}

export function scoreHistoryItem(
  item: ClipboardHistoryItem,
  query: string,
  targetApp?: ClipboardSourceApp | null,
) {
  return scoreSnippet(historyItemToSearchable(item), query, 'hybrid') +
    historyExactContentBoost(item, query) +
    historyKindBoost(item, query) +
    sourceAppBoost(item.sourceApp, targetApp)
}

function historyExactContentBoost(item: ClipboardHistoryItem, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0

  const content = itemToClipboardText(item).toLowerCase()
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const exactishQuery = /^[\w./:@-]+$/.test(normalizedQuery)
  let boost = 0

  if (content.includes(normalizedQuery)) {
    boost += exactishQuery ? 900 : 420
  } else if (tokens.length > 1 && tokens.every((token) => content.includes(token))) {
    boost += 240
  }

  return boost
}

function historyKindBoost(item: ClipboardHistoryItem, query: string) {
  let boost = 0
  const searchableText = historySearchText(item)
  const textCommandQuery =
    /\b(shell|terminal|cli|command|cmd|exec|kubectl|docker|git|ssh)\b|命令|进入|容器/.test(query)
  const commandLikeText =
    /\b(kubectl|docker|git|ssh|curl|npm|pnpm|yarn|python|bytedcli|huggingface-cli)\b|--/.test(
      searchableText,
    )

  if (item.kind === 'text' && textCommandQuery && commandLikeText) {
    boost += 80
  }

  if (item.kind === 'image' && /\b(image|screenshot|picture|photo)\b|图片|截图/.test(query)) {
    boost += 80
  }

  if (item.kind === 'file' && /\b(file|path|pdf|doc|report|folder)\b|文件|路径|报告/.test(query)) {
    boost += 60
  }

  if (item.contentType === 'json' && /\b(json|object|payload|配置)\b/.test(query)) boost += 60
  if (item.contentType === 'env' && /\b(env|environment|secret|环境变量)\b/.test(query)) boost += 60
  if (item.contentType === 'url' && /\b(url|link|website|网页|链接)\b/.test(query)) boost += 50
  if (item.contentType === 'jwt' && /\b(jwt|token|令牌)\b/.test(query)) boost += 70
  if (item.contentType === 'api-key' && /\b(api key|apikey|key|secret|密钥)\b/.test(query)) boost += 70
  if (item.contentType === 'rich-text' && /\b(rich|html|formatted|格式)\b/.test(query)) boost += 60

  return boost
}

export function sameSourceApp(
  left?: ClipboardSourceApp | null,
  right?: ClipboardSourceApp | null,
) {
  const leftBundleId = normalizeAppField(left?.bundleId)
  const rightBundleId = normalizeAppField(right?.bundleId)
  if (leftBundleId && rightBundleId) return leftBundleId === rightBundleId

  const leftName = normalizeAppField(left?.name)
  const rightName = normalizeAppField(right?.name)
  return Boolean(leftName && rightName && leftName === rightName)
}

function sourceAppBoost(
  sourceApp?: ClipboardSourceApp | null,
  targetApp?: ClipboardSourceApp | null,
) {
  return sameSourceApp(sourceApp, targetApp) ? 35 : 0
}

function sourceAppDisplayText(sourceApp?: ClipboardSourceApp | null) {
  return sourceApp?.name ?? ''
}

function sourceAppSearchText(sourceApp?: ClipboardSourceApp | null) {
  return [sourceApp?.name, sourceApp?.bundleId].filter(Boolean).join(' ')
}

function normalizeSourceApp(sourceApp?: ClipboardSourceApp | null) {
  const name = sourceApp?.name?.trim()
  const bundleId = sourceApp?.bundleId?.trim()
  if (!name && !bundleId) return undefined
  return { name: name || undefined, bundleId: bundleId || undefined }
}

function normalizeAppField(value?: string | null) {
  return value?.trim().toLowerCase() ?? ''
}

export function itemToClipboardText(item: ClipboardHistoryItem) {
  if (item.kind === 'file') return item.files?.join('\n') ?? item.content ?? ''
  return item.content ?? ''
}

export function detectTextContentType(content: string): ClipboardContentType {
  const trimmed = content.trim()
  if (isJwt(trimmed)) return 'jwt'
  if (isApiKey(trimmed)) return 'api-key'
  if (isJson(trimmed)) return 'json'
  if (isEnvBlock(trimmed)) return 'env'
  if (isUrlText(trimmed)) return 'url'
  if (isCodeLike(trimmed)) return 'code'
  return 'text'
}

export function detectImageContentType(
  image: ClipboardImagePayload,
  sourceApp?: ClipboardSourceApp,
): ClipboardContentType {
  const appText = sourceAppSearchText(sourceApp).toLowerCase()
  if (image.caption?.toLowerCase().includes('screenshot')) return 'screenshot'
  if (/\bscreenshot\b|截屏|截图/.test(appText)) return 'screenshot'
  return 'image'
}

export function hashString(value: string) {
  return hashBytes(new TextEncoder().encode(value))
}

function isJson(value: string) {
  if (!/^\s*[[{]/.test(value)) return false
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function isUrlText(value: string) {
  const lines = value.split(/\s+/).filter(Boolean)
  if (!lines.length || lines.length > 3) return false
  return lines.every((line) => {
    try {
      const url = new URL(line)
      return ['http:', 'https:', 'file:'].includes(url.protocol)
    } catch {
      return false
    }
  })
}

function isEnvBlock(value: string) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return false
  return lines.every((line) =>
    /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=.*/.test(line) ||
    /^#[A-Za-z0-9_ -]+/.test(line),
  )
}

function isJwt(value: string) {
  const token = value.trim()
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false
  try {
    const header = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof header === 'object' && header !== null && 'alg' in header
  } catch {
    return false
  }
}

function isApiKey(value: string) {
  const trimmed = value.trim()
  if (/\s/.test(trimmed)) return false
  return /^(sk-[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})$/.test(trimmed) ||
    /^[A-Za-z0-9_-]{32,}$/.test(trimmed)
}

function isCodeLike(value: string) {
  const trimmed = value.trim()
  return /```/.test(trimmed) ||
    /\b(function|const|let|var|class|import|export|def|SELECT|FROM|WHERE)\b/.test(trimmed) ||
    /^[\w./-]+\s+.*--[\w-]+/.test(trimmed) ||
    /\b(kubectl|docker|git|ssh|curl|npm|pnpm|yarn|python|bytedcli|huggingface-cli)\b/.test(trimmed)
}

function textTitle(content: string, contentType: ClipboardContentType) {
  if (contentType === 'api-key') return maskSecret(content, 'API key')
  if (contentType === 'jwt') return maskSecret(content, 'JWT')
  if (contentType === 'json') return 'JSON payload'
  if (contentType === 'env') return envTitle(content)
  if (contentType === 'url') return urlTitle(content)
  if (contentType === 'rich-text') return truncateMiddle(collapseWhitespace(content) || 'Rich text')
  if (contentType === 'code') return truncateMiddle(collapseWhitespace(content) || 'Code')
  return truncateMiddle(collapseWhitespace(content) || 'Text')
}

function textSubtitle(content: string, contentType: ClipboardContentType) {
  if (contentType === 'json') return `${content.length} chars`
  if (contentType === 'env') {
    const count = envVariableLines(content).length
    return count ? `Environment variables · ${count} variables` : 'Environment variables'
  }
  if (contentType === 'url') {
    try {
      return new URL(content.split(/\s+/)[0]).hostname
    } catch {
      return ''
    }
  }
  if (contentType === 'rich-text') return 'Formatted text'
  if (contentType === 'code') return 'Code'
  if (contentType === 'api-key' || contentType === 'jwt') return 'Sensitive token'
  return ''
}

function envTitle(content: string) {
  const preview = envVariableLines(content)
    .slice(0, 3)
    .map(envLinePreview)
    .filter(Boolean)
    .join(' · ')
  return truncateMiddle(preview || collapseWhitespace(content) || 'Environment variables')
}

function envVariableLines(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=.*/.test(line))
}

function envLinePreview(line: string) {
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
  if (!match) return ''
  const [, key, rawValue] = match
  const value = rawValue.trim().replace(/^["']|["']$/g, '')
  if (!value) return `${key}=`
  if (isSensitiveEnvKey(key)) return `${key}=••••`
  return `${key}=${truncateMiddle(value, 34)}`
}

function isSensitiveEnvKey(key: string) {
  return /(?:TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i.test(key)
}

function urlTitle(content: string) {
  try {
    const url = new URL(content.split(/\s+/)[0])
    return truncateMiddle(url.hostname + url.pathname)
  } catch {
    return truncateMiddle(content)
  }
}

function maskSecret(content: string, label: string) {
  const trimmed = content.trim()
  if (trimmed.length <= 10) return label
  return `${label} ${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function normalizeHtmlForSignature(html: string) {
  return html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?(?:html|body)[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}
