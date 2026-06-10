export type SearchableSnippet = {
  id: string
  title: string
  path: string
  description: string
  template: string
  tags: string[]
  intents: string[]
  favorite?: boolean
  useCount: number
}

export type SnippetIndexMethod = 'keyword' | 'hybrid'

const SIMILARITY_VECTOR_DIMENSIONS = 128

const synonymGroups = [
  ['下载', 'download', 'pull', 'fetch'],
  ['模型', 'model', 'checkpoint'],
  ['恢复', '续传', 'resume'],
  ['命名', '名字', 'caption', 'name', 'rename'],
  ['停止', '取消', 'cancel', 'stop', 'kill'],
  ['日志', 'log', 'logs', 'tail'],
  ['进入', 'exec', 'shell', 'attach'],
  ['端口', '转发', 'port', 'forward'],
  ['服务', 'service', 'svc'],
  ['查询', 'sql', 'query'],
  ['列', '列出', 'list', 'show'],
  ['本地', 'local'],
  ['缓存', 'cache'],
  ['大小', 'disk', 'usage', 'size'],
  ['慢', 'long', 'slow'],
  ['审查', 'review'],
  ['bug', 'bugs', 'diff', 'patch', 'regression', 'risk', '代码', '变更', '检查'],
  ['提醒', '催', 'follow', 'reminder'],
  ['teammate', 'reviewer', 'polite', 'pr', 'pull', 'request', 'follow-up'],
  ['llm', 'prompt'],
  ['提交', 'commit'],
  ['暂存', 'staged'],
  ['上一个', '最后一次', 'latest', 'previous', 'amend'],
  ['不改', 'no-edit', 'unchanged'],
  ['整理', 'rebase', 'squash'],
  ['容器', 'docker', 'container'],
  ['集群', 'kubernetes', 'kubectl', 'k8s'],
  ['huggingface', 'hf'],
  ['merlin', 'bytedcli'],
]

const synonymMap = new Map<string, string[]>()
for (const group of synonymGroups) {
  for (const token of group) {
    synonymMap.set(token, group.filter((item) => item !== token))
  }
}

const expandedTokenCache = new Map<string, string[]>()

export function normalizeText(value: string) {
  return value.trim().toLowerCase()
}

export function tokenize(value: string) {
  const normalized = normalizeText(value)
  const asciiTokens = normalized
    .split(/[\s/,_:;'"`()[\]{}<>|+=.-]+/)
    .filter(Boolean)
  const cjkTokens = (normalized.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((sequence) => {
    const tokens = new Set<string>()
    if (sequence.length <= 6) tokens.add(sequence)
    for (let size = 2; size <= Math.min(4, sequence.length); size += 1) {
      for (let index = 0; index + size <= sequence.length; index += 1) {
        tokens.add(sequence.slice(index, index + size))
      }
    }
    return Array.from(tokens)
  })
  return Array.from(new Set([...asciiTokens, ...cjkTokens]))
}

function expandedTokens(value: string) {
  const normalized = normalizeText(value)
  const cached = expandedTokenCache.get(normalized)
  if (cached) return cached

  const tokens = tokenize(value)
  const expanded = new Set(tokens)
  for (const token of tokens) {
    const synonyms = synonymMap.get(token) ?? []
    for (const synonym of synonyms) expanded.add(synonym)
    for (const [key, values] of synonymMap.entries()) {
      if (token.includes(key) || key.includes(token)) {
        expanded.add(key)
        values.forEach((item) => expanded.add(item))
      }
    }
  }
  const result = Array.from(expanded)
  expandedTokenCache.set(normalized, result)
  return result
}

function hashDimension(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % SIMILARITY_VECTOR_DIMENSIONS
}

function addFeature(vector: number[], feature: string, weight: number) {
  if (!feature) return
  vector[hashDimension(feature)] += weight
}

export function buildLocalSimilarityVector(value: string) {
  const clean = normalizeText(value)
  const vector = Array.from({ length: SIMILARITY_VECTOR_DIMENSIONS }, () => 0)
  if (!clean) return vector

  for (const token of expandedTokens(clean)) {
    addFeature(vector, `tok:${token}`, 3)
    if (token.length >= 3) {
      for (let i = 0; i + 3 <= token.length; i += 1) {
        addFeature(vector, `tri:${token.slice(i, i + 3)}`, 0.8)
      }
    }
  }

  for (let i = 0; i + 3 <= clean.length; i += 1) {
    addFeature(vector, `ctx:${clean.slice(i, i + 3)}`, 0.25)
  }

  return vector
}

export function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let i = 0; i < SIMILARITY_VECTOR_DIMENSIONS; i += 1) {
    dot += left[i] * right[i]
    leftNorm += left[i] * left[i]
    rightNorm += right[i] * right[i]
  }

  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export function snippetSearchText(snippet: SearchableSnippet) {
  return [
    snippet.title,
    snippet.path,
    snippet.description,
    snippet.template,
    ...snippet.tags,
    ...snippet.intents,
  ]
    .join(' ')
    .toLowerCase()
}

export function contextTreeBoost(snippet: SearchableSnippet, query: string) {
  const queryTokens = expandedTokens(query)
  if (!queryTokens.length) return 0

  const pathTokens = expandedTokens(snippet.path)
  const metadataTokens = expandedTokens([...snippet.tags, ...snippet.intents].join(' '))
  let hit = 0

  for (const token of queryTokens) {
    if (pathTokens.some((item) => item.includes(token) || token.includes(item))) {
      hit += 1
      continue
    }
    if (metadataTokens.some((item) => item.includes(token) || token.includes(item))) {
      hit += 1
    }
  }

  return Math.min(hit * 8, 40)
}

export function keywordMetadataScore(snippet: SearchableSnippet, query: string) {
  const tokens = tokenize(query)
  if (!tokens.length) return 0
  const metadata = [
    snippet.title,
    snippet.path,
    snippet.description,
    ...snippet.tags,
    ...snippet.intents,
  ]
    .join(' ')
    .toLowerCase()

  return tokens.reduce((score, token) => {
    if (snippet.title.toLowerCase().includes(token)) return score + 30
    if (snippet.path.toLowerCase().includes(token)) return score + 20
    if (metadata.includes(token)) return score + 10
    return score
  }, 0)
}

export function keywordScore(snippet: SearchableSnippet, query: string) {
  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery) {
    return (snippet.favorite ? 10 : 0) + Math.min(snippet.useCount, 10)
  }

  const haystack = snippetSearchText(snippet)
  const title = snippet.title.toLowerCase()
  const path = snippet.path.toLowerCase()
  const tokens = tokenize(normalizedQuery)
  let score = 0
  let hitSignal = false

  for (const token of tokens) {
    if (title.includes(token)) {
      score += 30
      hitSignal = true
    }
    if (path.includes(token)) {
      score += 18
      hitSignal = true
    }
    if (snippet.tags.some((tag) => tag.toLowerCase().includes(token))) {
      score += 18
      hitSignal = true
    }
    if (snippet.intents.some((intent) => intent.toLowerCase().includes(token))) {
      score += 16
      hitSignal = true
    }
    if (haystack.includes(token)) {
      score += 8
      hitSignal = true
    }
  }

  if (title.includes(normalizedQuery)) {
    score += 40
    hitSignal = true
  }
  if (haystack.includes(normalizedQuery)) {
    score += 20
    hitSignal = true
  }

  if (!hitSignal) return 0
  score += Math.min(snippet.useCount, 10)
  if (snippet.favorite) score += 6
  return score
}

export function domainIntentBoost(snippet: SearchableSnippet, query: string) {
  const normalizedQuery = normalizeText(query)
  const text = snippetSearchText(snippet)
  let boost = 0

  if (/(bug|bugs|diff|patch|regression|risk|代码|检查)/i.test(normalizedQuery)) {
    if (/code review|review code|patch|审查代码/.test(text)) boost += 160
  }

  if (/(staged|暂存|上一个|最后一次|不改|no-edit|amend|previous|latest)/i.test(normalizedQuery)) {
    if (/amend|--amend|no-edit|previous commit|latest commit/.test(text)) boost += 1200
  }

  if (/(停止|取消|cancel|stop|kill)/i.test(normalizedQuery)) {
    if (/cancel|stop|kill/.test(text)) boost += 900
  }

  if (/(teammate|reviewer|pull request|\bpr\b|催|提醒|follow up|polite)/i.test(normalizedQuery)) {
    if (/\bpr\b|pull request|follow-up|polite|reminder|催/.test(text)) boost += 2000
  }

  return boost
}

const snippetVectorCache = new Map<string, { vector: number[]; source: string }>()
const queryVectorCache = new Map<string, number[]>()

export function localSimilarityScore(snippet: SearchableSnippet, query: string) {
  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery) return keywordScore(snippet, query)

  const source = snippetSearchText(snippet)
  const cached = snippetVectorCache.get(snippet.id)
  const snippetVector = cached?.source === source
    ? cached.vector
    : buildLocalSimilarityVector(source)
  if (cached?.source !== source) {
    snippetVectorCache.set(snippet.id, { source, vector: snippetVector })
  }

  const queryVector = queryVectorCache.get(normalizedQuery) ?? buildLocalSimilarityVector(normalizedQuery)
  queryVectorCache.set(normalizedQuery, queryVector)

  const similarity = cosineSimilarity(snippetVector, queryVector)
  return similarity >= 0.08 ? Math.round(similarity * 100) + contextTreeBoost(snippet, query) : 0
}

export function hybridScore(snippet: SearchableSnippet, query: string) {
  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery) return keywordScore(snippet, query)

  const keyword = keywordScore(snippet, query)
  const similarity = localSimilarityScore(snippet, query)
  const treeBoost = contextTreeBoost(snippet, query)
  const intentBoost = domainIntentBoost(snippet, query)
  if (keyword <= 0 && similarity <= 0 && treeBoost <= 0 && intentBoost <= 0) return 0

  return keyword + similarity + treeBoost + intentBoost
}

export function scoreSnippet(
  snippet: SearchableSnippet,
  query: string,
  method: SnippetIndexMethod = 'hybrid',
) {
  if (method === 'keyword') return keywordScore(snippet, query)
  return hybridScore(snippet, query)
}

export function rankSnippets<T extends SearchableSnippet>(
  snippets: T[],
  query: string,
  method: SnippetIndexMethod = 'hybrid',
) {
  const hasQuery = Boolean(query.trim())
  return snippets
    .map((snippet) => ({ snippet, score: scoreSnippet(snippet, query, method) }))
    .filter(({ score }) => !hasQuery || score > 0)
    .sort((a, b) => {
      if (hasQuery && b.score !== a.score) return b.score - a.score
      if ((b.snippet.favorite ? 1 : 0) !== (a.snippet.favorite ? 1 : 0)) {
        return (b.snippet.favorite ? 1 : 0) - (a.snippet.favorite ? 1 : 0)
      }
      return b.snippet.useCount - a.snippet.useCount
    })
    .map(({ snippet }) => snippet)
}
