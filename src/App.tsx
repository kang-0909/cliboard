import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Dispatch,
  MouseEvent,
  SetStateAction,
} from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import {
  Braces,
  Check,
  Clipboard,
  Copy,
  Database,
  FileText,
  History,
  Image as ImageIcon,
  KeyRound,
  MessageSquareText,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  TerminalSquare,
  Trash2,
  Wand2,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Image as TauriImage } from '@tauri-apps/api/image'
import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window'
import {
  readImage,
  readText,
  writeImage,
  writeText,
} from '@tauri-apps/plugin-clipboard-manager'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  CLIPBOARD_HISTORY_KEY,
  MAX_HISTORY_ITEMS,
  base64ToBytes,
  classifyRichTextClipboard,
  classifyTextClipboard,
  detectImageContentType,
  draftToHistoryItem,
  hashBytes,
  itemToClipboardText,
  mergeHistoryItem,
  rankHistoryItems,
  recordHistoryItemCopied,
  replaceHistoryItem,
  trimHistoryItems,
} from './clipboardHistory'
import type {
  ClipboardHistoryItem,
  ClipboardImagePayload,
  ClipboardSourceApp,
} from './clipboardHistory'
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  MIN_HISTORY_LIMIT,
  commitHistoryLimitDraft,
  normalizeHistoryLimit,
} from './historyLimit'
import { redactLogValue } from './logRedaction'
import { hasSearchFilters, matchesSnippetFilters, parseSearchQuery } from './searchFilters'
import {
  keywordMetadataScore,
  rankSnippets,
  scoreSnippet,
} from './snippetSearch'
import {
  buildHistoricalQueryBoost,
  type UsageLearningCandidate,
  type UsageLearningEvent,
  type UsageLearningScorer,
} from './usageLearning'
import 'katex/dist/katex.min.css'
import './App.css'

type ParamDef = {
  label?: string
  default?: string
  required?: boolean
  placeholder?: string
}

type Snippet = {
  id: string
  title: string
  path: string
  description: string
  template: string
  tags: string[]
  intents: string[]
  params: Record<string, ParamDef>
  favorite?: boolean
  useCount: number
  createdAt: string
  updatedAt: string
  lastUsed?: string
  appUsage?: Record<string, number>
}

type SettingsState = {
  apiKey: string
  baseUrl: string
  model: string
  historyLimit: number
  llmEnabled: boolean
  llmMatchEnabled: boolean
  autoCopy: boolean
  matchMode: MatchMode
  thinkingMode: ThinkingMode
}

type MatchMode = 'turbo' | 'direct' | 'direct-vote' | 'candidate-vote' | 'batch'
type ThinkingMode = 'enabled' | 'disabled'

type ToastState = {
  tone: 'neutral' | 'success' | 'warning'
  text: string
}

type LauncherSurface = 'history' | 'snippets' | 'ask'

type LauncherWakePayload = {
  surface?: LauncherSurface
  app?: ClipboardSourceApp | null
}

type KeyboardSnapshot = {
  mode: 'render' | 'edit' | 'settings'
  query: string
  selectedHistoryItem?: ClipboardHistoryItem
  selectedSnippet?: Snippet
  surface: LauncherSurface
}

type KeyboardActions = {
  handleAskLlm: () => Promise<void>
  handleCopy: (options?: CopyActionOptions) => Promise<void>
  handleCopyHistoryItem: (item: ClipboardHistoryItem, options?: CopyActionOptions) => Promise<void>
  handleSmartMatch: (options?: CopyActionOptions) => Promise<void>
  hideLauncherWindow: () => Promise<void>
  moveHistorySelection: (delta: number) => void
  moveSnippetSelection: (delta: number) => void
  setMode: Dispatch<SetStateAction<'render' | 'edit' | 'settings'>>
}

type CopyActionOptions = {
  pasteAfterCopy?: boolean
}

type ClipboardStorageUsage = {
  imageBytes: number
  itemCount: number
  metadataBytes: number
  originalImageCount: number
  totalBytes: number
}

type SmartMatch = {
  id: string
  reason?: string
  parameter_values?: Record<string, string>
  output?: string
}

type BatchMatchResponse = {
  matches?: SmartMatch[]
  candidates?: SmartMatch[]
  id?: string
  reason?: string
  parameter_values?: Record<string, string>
}

type AllInOneMatchResponse = {
  reason?: string
  candidates?: SmartMatch[]
  likely_candidates?: SmartMatch[]
  selected?: {
    id?: string
    parameter_values?: Record<string, string>
    output?: string
  }
  id?: string
  parameter_values?: Record<string, string>
  output?: string
  final_output?: string
  text?: string
}

type SnippetClassificationResponse = {
  reason?: string
  path_decision?: 'reuse_existing' | 'create_new'
  source?: 'clipboard_history' | 'search_query' | 'manual'
  title?: string
  path?: string
  description?: string
  template?: string
  tags?: string[]
  intents?: string[]
  params?: Record<string, ParamDef>
}

type SnippetDraftSource = 'clipboard_history' | 'search_query' | 'manual'

type LlmLogEntry = {
  id: string
  createdAt: string
  completedAt?: string
  durationMs?: number
  usage?: TokenUsage
  operation: string
  input: unknown
  output?: unknown
  error?: string
}

type UsageLogEntry = {
  id: string
  createdAt: string
  completedAt?: string
  durationMs?: number
  surface: LauncherSurface
  action: 'history-copy' | 'snippet-copy' | 'snippet-match'
  query: string
  targetApp?: ClipboardSourceApp | null
  llm: {
    used: boolean
    matchMode?: MatchMode
    model?: string
    error?: string
  }
  selected?: {
    id: string
    title: string
    kind?: string
    path?: string
    output?: string
  }
  ranks: {
    initialRank?: number | null
    finalRank?: number | null
    finalRankingSource?: 'local'
  }
  candidates: {
    initialTotal: number
    finalTotal: number
    initialOrder: UsageCandidateRef[]
    finalOrder: UsageCandidateRef[]
  }
  metadata?: Record<string, unknown>
}

type UsageCandidateRef = {
  id: string
  title: string
  kind?: string
  path?: string
}

type TokenUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  completion_tokens_details?: {
    reasoning_tokens?: number
  }
}

type ModelMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type AskChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string
      reasoning?: string
      reasoning_content?: string
    }
  }>
  usage?: TokenUsage
}

type ChatCompletionStreamEvent = {
  requestId: string
  chunk?: string
  done?: boolean
  error?: string
}

const SNIPPETS_KEY = 'contextclip.snippets.v1'
const DELETED_SNIPPET_IDS_KEY = 'contextclip.deleted-snippet-ids.v1'
const SETTINGS_KEY = 'contextclip.settings.v1'
const LLM_LOGS_KEY = 'contextclip.llm-logs.v1'
const USAGE_LOGS_KEY = 'contextclip.usage-logs.v1'
const ASK_MESSAGES_KEY = 'contextclip.ask-messages.v1'
const HISTORY_DB_NAME = 'contextclip-storage'
const HISTORY_DB_VERSION = 2
const HISTORY_STORE_NAME = 'kv'
const HISTORY_IMAGE_STORE_NAME = 'images'
const HISTORY_ITEMS_KEY = 'clipboard-history'
const PANEL_SIZE = new LogicalSize(748, 548)
const HISTORY_POLL_MS = 350
const HISTORY_SLOW_SAMPLE_WARN_MS = 1200
const IMAGE_PREVIEW_MAX_EDGE = 220
const TOAST_AUTO_HIDE_MS = 1600
const LLM_CANDIDATE_BATCH_SIZE = 50
const MAX_BATCH_MATCHES = 5
const MAX_LLM_LOGS = 20
const MAX_USAGE_LOGS = 500
const MAX_USAGE_CANDIDATES = 100
const MAX_ASK_MESSAGES = 80
const ASK_CONTEXT_MESSAGES = 16
const MAX_LOG_ARRAY_ITEMS = 80
const MAX_LOG_STRING_LENGTH = 1200
const MAX_PERSISTED_ORIGINAL_IMAGE_BYTES = 8 * 1024 * 1024
const PASTE_AFTER_HIDE_DELAY_MS = 90
const LLM_REQUEST_TIMEOUT_MS = 90_000
const IS_MACOS = /mac/i.test(navigator.platform)
const XIAOMI_VISION_API_KEY = import.meta.env.VITE_XIAOMI_VISION_API_KEY ?? ''
const XIAOMI_VISION_BASE_URL = 'https://api.xiaomimimo.com/v1'
const XIAOMI_VISION_MODEL = 'xiaomi/mimo-v2-omni'

const providerPresets = {
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    thinkingMode: 'disabled' as ThinkingMode,
  },
  stepfun: {
    apiKey: '',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-3.5-flash',
    thinkingMode: 'disabled' as ThinkingMode,
  },
}

const defaultSettings: SettingsState = {
  ...providerPresets.deepseek,
  historyLimit: DEFAULT_HISTORY_LIMIT,
  llmEnabled: true,
  llmMatchEnabled: false,
  autoCopy: true,
  matchMode: 'turbo',
}

const matchModeOptions: Array<{ value: MatchMode; label: string }> = [
  { value: 'turbo', label: '极速' },
  { value: 'direct', label: '快速' },
  { value: 'direct-vote', label: '平衡' },
  { value: 'candidate-vote', label: '精准' },
  { value: 'batch', label: '最稳' },
]

type ProviderOption = 'deepseek' | 'stepfun' | 'custom'

const providerOptions: Array<{ value: ProviderOption; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'stepfun', label: 'StepFun' },
  { value: 'custom', label: 'Custom' },
]

function isLlmAvailable(settings: SettingsState) {
  return settings.llmEnabled && Boolean(settings.apiKey.trim())
}

function shouldUseLlmForMatch(settings: SettingsState) {
  return settings.llmMatchEnabled && isLlmAvailable(settings)
}

function providerOption(settings: SettingsState): ProviderOption {
  const baseUrl = settings.baseUrl.toLowerCase()
  if (baseUrl.includes('stepfun.com')) return 'stepfun'
  if (baseUrl.includes('deepseek.com')) return 'deepseek'
  return 'custom'
}

const now = () => new Date().toISOString()

const seedSnippets: Snippet[] = [
  {
    id: 'git-amend-no-edit',
    title: 'Amend latest commit',
    path: 'Shell/Git',
    description: '把当前暂存区合并到最后一次 commit，不改 commit message。',
    template: 'git add {{files}}\ngit commit --amend --no-edit',
    tags: ['git', 'commit', 'amend'],
    intents: ['fix latest commit', 'amend commit', 'add files to previous commit'],
    params: {
      files: {
        label: 'Files',
        default: '.',
        required: true,
        placeholder: '. or src/App.tsx',
      },
    },
    favorite: true,
    useCount: 6,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'git-rebase-main',
    title: 'Interactive rebase from main',
    path: 'Shell/Git',
    description: '整理当前分支相对 main 的提交历史。',
    template: 'git fetch origin\ngit rebase -i origin/{{base_branch}}',
    tags: ['git', 'rebase', 'history'],
    intents: ['squash commits', 'clean branch history', 'interactive rebase'],
    params: {
      base_branch: {
        label: 'Base branch',
        default: 'main',
        required: true,
      },
    },
    useCount: 4,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'kubectl-exec-pod',
    title: 'Exec into a Kubernetes pod',
    path: 'Shell/Kubernetes',
    description: '进入 pod 的交互 shell，适合临时排查线上容器。',
    template: 'kubectl exec -it {{pod}} -n {{namespace}} -- {{shell}}',
    tags: ['kubectl', 'k8s', 'debug', 'pod'],
    intents: ['enter pod', 'debug container shell', 'kubectl exec'],
    params: {
      pod: {
        label: 'Pod',
        required: true,
        placeholder: 'api-7d96f9',
      },
      namespace: {
        label: 'Namespace',
        default: 'default',
        required: true,
      },
      shell: {
        label: 'Shell',
        default: '/bin/sh',
        required: true,
      },
    },
    favorite: true,
    useCount: 12,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'kubectl-port-forward',
    title: 'Port-forward a service',
    path: 'Shell/Kubernetes',
    description: '把集群里的 service 临时映射到本地端口。',
    template:
      'kubectl port-forward svc/{{service}} {{local_port}}:{{remote_port}} -n {{namespace}}',
    tags: ['kubectl', 'k8s', 'port-forward'],
    intents: ['forward service', 'open service locally', 'debug k8s service'],
    params: {
      service: {
        label: 'Service',
        required: true,
        placeholder: 'api',
      },
      local_port: {
        label: 'Local port',
        default: '8080',
        required: true,
      },
      remote_port: {
        label: 'Remote port',
        default: '80',
        required: true,
      },
      namespace: {
        label: 'Namespace',
        default: 'default',
        required: true,
      },
    },
    useCount: 7,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'docker-tail-service',
    title: 'Tail Docker Compose logs',
    path: 'Shell/Docker',
    description: '持续查看某个 compose service 的最近日志。',
    template: 'docker compose logs -f --tail={{tail}} {{service}}',
    tags: ['docker', 'compose', 'logs'],
    intents: ['watch service logs', 'tail docker logs', 'debug compose service'],
    params: {
      tail: {
        label: 'Tail lines',
        default: '200',
        required: true,
      },
      service: {
        label: 'Service',
        required: true,
        placeholder: 'web',
      },
    },
    useCount: 9,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'bytedcli-merlin-job-fork-run',
    title: 'Fork a Merlin job run',
    path: 'Shell/Merlin',
    description: 'Fork 指定 Merlin job run，默认沿用常用 caption，也可以临时改名。',
    template:
      'bytedcli merlin job fork-run --source-job-run-id {{source_job_run_id}} --caption "{{caption}}"',
    tags: ['bytedcli', 'merlin', 'fork-run', 'job'],
    intents: [
      'fork merlin job',
      'rerun merlin job from source run',
      'bytedcli merlin job fork-run',
      '在 merlin 上 fork job',
    ],
    params: {
      source_job_run_id: {
        label: 'Source job run id',
        required: true,
        placeholder: '737b598b9b06ca1b or abcde',
      },
      caption: {
        label: 'Caption',
        default: 'vllm_019_ascend_fork_8',
        required: true,
      },
    },
    favorite: true,
    useCount: 8,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'huggingface-download',
    title: 'Download from Hugging Face',
    path: 'Shell/HuggingFace',
    description: '下载 Hugging Face 模型到本地目录，可选恢复下载。',
    template:
      'huggingface-cli download {{model_id}} --local-dir {{local_dir}}{{resume_download_flag}}',
    tags: ['huggingface', 'download', 'ai'],
    intents: [
      'huggingface download',
      'huggingface-cli download',
      '下载 huggingface 模型',
      'huggingface 模型下载',
      '下载模型',
      '下载 deepseek 模型',
      'deepseek model download',
      '恢复下载',
      'resume download',
    ],
    params: {
      model_id: {
        label: 'Model ID',
        required: true,
        placeholder: 'Qwen/Qwen2-7B-Instruct',
      },
      local_dir: {
        label: 'Local dir',
        required: true,
        default: '~/models',
        placeholder: '~/models/models--Qwen--Qwen2-7B-Instruct',
      },
      resume_download_flag: {
        label: 'Resume download flag',
        required: false,
        default: '',
      },
    },
    useCount: 2,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'sql-find-long-running',
    title: 'Find long running Postgres queries',
    path: 'SQL/Postgres',
    description: '列出运行时间超过阈值的查询，方便排查慢 SQL。',
    template:
      "select pid, now() - query_start as duration, state, query\nfrom pg_stat_activity\nwhere state <> 'idle'\n  and now() - query_start > interval '{{minutes}} minutes'\norder by duration desc;",
    tags: ['sql', 'postgres', 'debug'],
    intents: ['find slow queries', 'postgres running queries', 'database investigation'],
    params: {
      minutes: {
        label: 'Minutes',
        default: '5',
        required: true,
      },
    },
    useCount: 3,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'prompt-code-review',
    title: 'Focused code review prompt',
    path: 'Prompts/Code Review',
    description: '让 LLM 按风险优先级审查一个变更。',
    template:
      'Review this change for correctness, regression risk, missing tests, and edge cases. Focus on actionable issues first.\n\nContext:\n{{context}}\n\nPatch:\n{{patch}}',
    tags: ['prompt', 'review', 'code'],
    intents: ['review code', 'find bugs in patch', 'ask llm for code review'],
    params: {
      context: {
        label: 'Context',
        default: 'This is a focused implementation patch.',
        required: true,
      },
      patch: {
        label: 'Patch',
        required: true,
        placeholder: 'Paste diff or summary',
      },
    },
    useCount: 5,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'writing-pr-followup',
    title: 'Polite PR follow-up',
    path: 'Writing/PR',
    description: '温和催一下 review，不显得冒犯。',
    template:
      'Hi {{name}}, gentle ping on this PR when you have a moment. The main thing I need eyes on is {{focus}}. Thanks!',
    tags: ['writing', 'review', 'follow-up'],
    intents: ['polite reminder', 'follow up on review', 'ask reviewer'],
    params: {
      name: {
        label: 'Name',
        required: true,
        placeholder: 'Alex',
      },
      focus: {
        label: 'Focus',
        default: 'the behavior and test coverage',
        required: true,
      },
    },
    useCount: 2,
    createdAt: now(),
    updatedAt: now(),
  },
]

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be full after large clipboard captures; history uses IndexedDB.
  }
}

function parseMaybeJson(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function jsonByteSize(value: unknown) {
  try {
    return new Blob([JSON.stringify(value)]).size
  } catch {
    return JSON.stringify(value).length
  }
}

function base64ByteSize(value?: string) {
  if (!value) return 0
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

function originalImageByteLength(image?: ClipboardImagePayload) {
  return image?.originalByteLength ?? image?.rgbaBytes?.byteLength ?? base64ByteSize(image?.rgbaBase64)
}

function originalImageBytes(image: ClipboardImagePayload) {
  if (image.rgbaBytes) return image.rgbaBytes
  if (image.rgbaBase64) return base64ToBytes(image.rgbaBase64)
  return undefined
}

function estimateClipboardStorageUsage(
  items: ClipboardHistoryItem[],
  limit: number,
): ClipboardStorageUsage {
  const compacted = compactHistoryForStorage(items, limit)
  const imageBytes = items.reduce(
    (total, item) => total + originalImageByteLength(item.image),
    0,
  )
  return {
    imageBytes,
    itemCount: compacted.length,
    metadataBytes: jsonByteSize(compacted),
    originalImageCount: items.filter(
      (item) => item.image?.rgbaBase64 || item.image?.rgbaBytes || item.image?.originalByteLength,
    ).length,
    totalBytes: jsonByteSize(compacted) + imageBytes,
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}

function shouldOpenExternally(href?: string) {
  if (!href) return false
  return /^(https?:|mailto:|tel:)/i.test(href)
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="ask-markdown">
      <ReactMarkdown
        components={{
          a: ({ children, href, ...props }) => (
            <a
              {...props}
              href={href}
              rel="noreferrer"
              target="_blank"
              onClick={(event) => {
                if (!href || !shouldOpenExternally(href)) return
                event.preventDefault()
                void openUrl(href).catch(() => {
                  window.open(href, '_blank', 'noopener,noreferrer')
                })
              }}
            >
              {children}
            </a>
          ),
      }}
      rehypePlugins={[rehypeKatex]}
      remarkPlugins={[remarkMath, remarkGfm]}
    >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function loadLlmLogs() {
  return loadJson<LlmLogEntry[]>(LLM_LOGS_KEY, [])
}

function loadUsageLogs() {
  return loadJson<UsageLogEntry[]>(USAGE_LOGS_KEY, [])
}

function loadAskMessages() {
  return loadJson<AskChatMessage[]>(ASK_MESSAGES_KEY, [])
}

function compactLogValue(value: unknown, depth = 0, key?: string): unknown {
  const redacted = redactLogValue(value, key)
  if (typeof redacted === 'string') {
    return redacted.length > MAX_LOG_STRING_LENGTH
      ? `${redacted.slice(0, MAX_LOG_STRING_LENGTH)}... [truncated ${redacted.length - MAX_LOG_STRING_LENGTH} chars]`
      : redacted
  }

  if (typeof redacted !== 'object' || redacted === null) return redacted

  if (Array.isArray(redacted)) {
    const visible = redacted
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => compactLogValue(item, depth + 1))
    if (redacted.length > MAX_LOG_ARRAY_ITEMS) {
      visible.push(`[truncated ${redacted.length - MAX_LOG_ARRAY_ITEMS} more items]`)
    }
    return visible
  }

  if (depth > 7) return '[truncated nested object]'

  return Object.fromEntries(
    Object.entries(redacted).map(([childKey, child]) => [
      childKey,
      compactLogValue(child, depth + 1, childKey),
    ]),
  )
}

function readableCandidate(candidate: unknown) {
  if (!candidate || typeof candidate !== 'object') return compactLogValue(candidate)
  const item = candidate as {
    id?: unknown
    title?: unknown
    metadata?: {
      path?: unknown
      description?: unknown
      tags?: unknown
      intents?: unknown
      params?: Record<string, unknown>
    }
  }
  return compactLogValue({
    id: item.id,
    title: item.title,
    path: item.metadata?.path,
    description: item.metadata?.description,
    tags: item.metadata?.tags,
    intents: item.metadata?.intents,
    param_keys: item.metadata?.params ? Object.keys(item.metadata.params) : [],
  })
}

function readableLogContent(content: unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return compactLogValue(content)
  }

  const objectContent = content as {
    candidate_tree?: Array<{ path?: unknown; candidates?: unknown[] }>
  }
  if (Array.isArray(objectContent.candidate_tree)) {
    return compactLogValue({
      ...objectContent,
      candidate_tree: objectContent.candidate_tree.map((group) => ({
        path: group.path,
        candidate_count: group.candidates?.length ?? 0,
        candidates: (group.candidates ?? []).map(readableCandidate),
      })),
    })
  }

  return compactLogValue(content)
}

function saveLlmLogs(logs: LlmLogEntry[]) {
  for (let limit = logs.length; limit >= 1; limit = Math.floor(limit / 2)) {
    try {
      localStorage.setItem(LLM_LOGS_KEY, JSON.stringify(logs.slice(0, limit)))
      return
    } catch {
      // Keep shrinking until the browser accepts the debug payload.
    }
  }

  try {
    localStorage.setItem(LLM_LOGS_KEY, JSON.stringify([]))
  } catch {
    // Ignore storage failures; the main workflow should not break because logging failed.
  }
}

function writeLlmLog(entry: Omit<LlmLogEntry, 'id' | 'createdAt'> & { createdAt?: string }) {
  const logs = loadLlmLogs()
  saveLlmLogs([
    {
      id: `llm-log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: entry.createdAt ?? now(),
      completedAt: entry.completedAt,
      durationMs: entry.durationMs,
      usage: entry.usage,
      operation: entry.operation,
      input: compactLogValue(entry.input),
      output: compactLogValue(entry.output),
      error: entry.error ? (redactLogValue(entry.error) as string) : undefined,
    },
    ...logs,
  ].slice(0, MAX_LLM_LOGS))
}

function clearLlmLogs() {
  saveLlmLogs([])
}

function saveUsageLogs(logs: UsageLogEntry[]) {
  for (let limit = logs.length; limit >= 1; limit = Math.floor(limit / 2)) {
    try {
      localStorage.setItem(USAGE_LOGS_KEY, JSON.stringify(logs.slice(0, limit)))
      return
    } catch {
      // Keep shrinking until the browser accepts the tuning log payload.
    }
  }

  try {
    localStorage.setItem(USAGE_LOGS_KEY, JSON.stringify([]))
  } catch {
    // Usage logging is best-effort and must not break clipboard workflows.
  }
}

function writeUsageLog(entry: Omit<UsageLogEntry, 'id' | 'createdAt'> & { createdAt?: string }) {
  const logs = loadUsageLogs()
  const nextLogs = [
    {
      id: `usage-log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: entry.createdAt ?? now(),
      completedAt: entry.completedAt,
      durationMs: entry.durationMs,
      surface: entry.surface,
      action: entry.action,
      query: redactLogValue(entry.query) as string,
      targetApp: entry.targetApp,
      llm: {
        ...entry.llm,
        error: entry.llm.error ? (redactLogValue(entry.llm.error) as string) : undefined,
      },
      selected: entry.selected
        ? (compactLogValue(entry.selected) as UsageLogEntry['selected'])
        : undefined,
      ranks: entry.ranks,
      candidates: {
        ...entry.candidates,
        initialOrder: entry.candidates.initialOrder.slice(0, MAX_USAGE_CANDIDATES),
        finalOrder: entry.candidates.finalOrder.slice(0, MAX_USAGE_CANDIDATES),
      },
      metadata: entry.metadata
        ? (compactLogValue(entry.metadata) as Record<string, unknown>)
        : undefined,
    },
    ...logs,
  ].slice(0, MAX_USAGE_LOGS)
  saveUsageLogs(nextLogs)
  return nextLogs
}

function clearUsageLogs() {
  saveUsageLogs([])
}

function formatModelMessages(messages: ModelMessage[]) {
  return messages.map((message) => ({
    ...message,
    content: readableLogContent(parseMaybeJson(message.content)),
  }))
}

function formatTokenUsage(usage?: TokenUsage) {
  if (!usage) return ''
  const generatedTokens = usage.completion_tokens
  const parts = [
    usage.prompt_tokens !== undefined ? `in ${usage.prompt_tokens}` : '',
    generatedTokens !== undefined ? `generated ${generatedTokens}` : '',
    usage.completion_tokens_details?.reasoning_tokens !== undefined
      ? `reasoning ${usage.completion_tokens_details.reasoning_tokens}`
      : '',
    usage.total_tokens !== undefined ? `total ${usage.total_tokens}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' / ') : ''
}

function loadDeletedSnippetIds() {
  return loadJson<string[]>(DELETED_SNIPPET_IDS_KEY, [])
}

function rememberDeletedSnippetId(snippetId: string) {
  saveJson(
    DELETED_SNIPPET_IDS_KEY,
    Array.from(new Set([...loadDeletedSnippetIds(), snippetId])),
  )
}

function loadSnippets() {
  const saved = loadJson<Snippet[] | null>(SNIPPETS_KEY, null)
  const deletedIds = new Set(loadDeletedSnippetIds())
  if (!saved?.length) return seedSnippets.filter((snippet) => !deletedIds.has(snippet.id))

  const savedIds = new Set(saved.map((snippet) => snippet.id))
  const missingSeeds = seedSnippets.filter((snippet) => !savedIds.has(snippet.id) && !deletedIds.has(snippet.id))
  return [...saved.filter((snippet) => !deletedIds.has(snippet.id)), ...missingSeeds]
}

function loadSettings() {
  const saved = loadJson<Partial<SettingsState>>(SETTINGS_KEY, {})
  const savedMatchMode = saved.matchMode === 'direct' ? 'turbo' : saved.matchMode
  const migratedLlmEnabled =
    saved.llmEnabled === false && saved.llmMatchEnabled === undefined
      ? defaultSettings.llmEnabled
      : (saved.llmEnabled ?? defaultSettings.llmEnabled)
  return {
    ...defaultSettings,
    ...saved,
    apiKey: saved.apiKey?.trim() ? saved.apiKey : defaultSettings.apiKey,
    historyLimit: normalizeHistoryLimit(saved.historyLimit),
    llmEnabled: migratedLlmEnabled,
    llmMatchEnabled: saved.llmMatchEnabled ?? defaultSettings.llmMatchEnabled,
    matchMode: savedMatchMode ?? defaultSettings.matchMode,
    thinkingMode: saved.thinkingMode ?? defaultSettings.thinkingMode,
  }
}

function loadClipboardHistory(limit = DEFAULT_HISTORY_LIMIT, stripOriginalImages = true) {
  return sanitizeClipboardHistory(
    loadJson<ClipboardHistoryItem[]>(CLIPBOARD_HISTORY_KEY, []),
    limit,
    stripOriginalImages,
  )
}

function shouldKeepOriginalImageBytes(width: number, height: number, byteLength: number) {
  return (
    byteLength <= MAX_PERSISTED_ORIGINAL_IMAGE_BYTES &&
    width * height * 4 <= MAX_PERSISTED_ORIGINAL_IMAGE_BYTES
  )
}

function imageHistoryPayload(rgba: Uint8Array, width: number, height: number) {
  const shouldKeepOriginal = shouldKeepOriginalImageBytes(width, height, rgba.byteLength)
  return {
    width,
    height,
    originalByteLength: shouldKeepOriginal ? rgba.byteLength : undefined,
    rgbaBytes: shouldKeepOriginal ? rgba : undefined,
    previewDataUrl: imagePreviewDataUrl(rgba, width, height),
  }
}

function stripOriginalImageForMemory(item: ClipboardHistoryItem): ClipboardHistoryItem {
  if (item.kind !== 'image' || (!item.image?.rgbaBase64 && !item.image?.rgbaBytes)) return item
  const image = { ...item.image }
  delete image.rgbaBase64
  delete image.rgbaBytes
  return {
    ...item,
    image,
  }
}

function stripOriginalImagesForMemory(items: ClipboardHistoryItem[]) {
  return items.map(stripOriginalImageForMemory)
}

function compactHistoryForStorage(items: ClipboardHistoryItem[], limit = MAX_HISTORY_ITEMS) {
  return trimHistoryItems(items, limit).map((item) => {
    if (item.kind !== 'image' || !item.image) return item
    return {
      ...item,
      image: {
        width: item.image.width,
        height: item.image.height,
        originalByteLength: originalImageByteLength(item.image),
        previewDataUrl: item.image.previewDataUrl,
        caption: item.image.caption,
      },
    }
  })
}

function sanitizeClipboardHistory(
  value: unknown,
  limit = DEFAULT_HISTORY_LIMIT,
  stripOriginalImages = true,
) {
  if (!Array.isArray(value)) return []
  const validItems = value
    .filter((item): item is ClipboardHistoryItem => {
      if (!item || typeof item !== 'object') return false
      const candidate = item as Partial<ClipboardHistoryItem>
      return Boolean(candidate.id && candidate.kind && candidate.signature)
    })
  const trimmed = trimHistoryItems(validItems, limit)
  return stripOriginalImages ? stripOriginalImagesForMemory(trimmed) : trimmed
}

function storedTime(item: ClipboardHistoryItem) {
  return Date.parse(item.updatedAt || item.createdAt || '') || 0
}

function mergeStoredHistoryItems(limit: number, ...sources: ClipboardHistoryItem[][]) {
  const bySignature = new Map<string, ClipboardHistoryItem>()
  for (const item of sources.flat()) {
    const existing = bySignature.get(item.signature)
    if (!existing) {
      bySignature.set(item.signature, item)
      continue
    }

    const latest = storedTime(item) >= storedTime(existing) ? item : existing
    const older = latest === item ? existing : item
    bySignature.set(item.signature, {
      ...latest,
      pinned: Boolean(latest.pinned || older.pinned),
      copyCount: Math.max(latest.copyCount ?? 0, older.copyCount ?? 0),
      image:
        latest.kind === 'image' && latest.image
          ? {
              ...latest.image,
              originalByteLength:
                latest.image.originalByteLength ??
                older.image?.originalByteLength ??
                originalImageByteLength(latest.image) ??
                originalImageByteLength(older.image),
              rgbaBase64: latest.image.rgbaBase64 ?? older.image?.rgbaBase64,
              rgbaBytes: latest.image.rgbaBytes ?? older.image?.rgbaBytes,
              previewDataUrl: latest.image.previewDataUrl ?? older.image?.previewDataUrl,
              caption: latest.image.caption ?? older.image?.caption,
            }
          : latest.image,
    })
  }

  return trimHistoryItems(
    Array.from(bySignature.values()).sort((left, right) => storedTime(right) - storedTime(left)),
    limit,
  )
}

function compactHistoryForLocalStorage(items: ClipboardHistoryItem[], limit: number) {
  return compactHistoryForStorage(items, Math.min(30, limit))
}

function openHistoryDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'))
      return
    }

    const request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        database.createObjectStore(HISTORY_STORE_NAME)
      }
      if (!database.objectStoreNames.contains(HISTORY_IMAGE_STORE_NAME)) {
        database.createObjectStore(HISTORY_IMAGE_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to open clipboard history store'))
  })
}

async function readOriginalImageFromIndexedDb(signature: string) {
  const database = await openHistoryDatabase()
  try {
    return await new Promise<ClipboardImagePayload | undefined>((resolve, reject) => {
      const transaction = database.transaction(HISTORY_IMAGE_STORE_NAME, 'readonly')
      const request = transaction.objectStore(HISTORY_IMAGE_STORE_NAME).get(signature)
      request.onsuccess = () => resolve(request.result as ClipboardImagePayload | undefined)
      request.onerror = () =>
        reject(request.error ?? new Error('Failed to read clipboard image original'))
    })
  } finally {
    database.close()
  }
}

async function writeOriginalImagesToIndexedDb(items: ClipboardHistoryItem[]) {
  const imageItems = items.filter(
    (item) => item.kind === 'image' && (item.image?.rgbaBase64 || item.image?.rgbaBytes),
  )
  const activeSignatures = new Set(items.map((item) => item.signature))
  const database = await openHistoryDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HISTORY_IMAGE_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(HISTORY_IMAGE_STORE_NAME)

      for (const item of imageItems) {
        const image = item.image
        if (!image?.rgbaBase64 && !image?.rgbaBytes) continue
        store.put(
          {
            width: image.width,
            height: image.height,
            originalByteLength: originalImageByteLength(image),
            rgbaBytes: image.rgbaBytes,
            rgbaBase64: image.rgbaBase64,
          } satisfies ClipboardImagePayload,
          item.signature,
        )
      }

      const keysRequest = store.getAllKeys()
      keysRequest.onsuccess = () => {
        for (const key of keysRequest.result) {
          if (typeof key === 'string' && !activeSignatures.has(key)) {
            store.delete(key)
          }
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Failed to write clipboard image history'))
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Aborted writing clipboard image history'))
    })
  } finally {
    database.close()
  }
}

async function writeOriginalImageToIndexedDb(item: ClipboardHistoryItem) {
  const image = item.kind === 'image' ? item.image : undefined
  if (!image?.rgbaBase64 && !image?.rgbaBytes) return

  const database = await openHistoryDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HISTORY_IMAGE_STORE_NAME, 'readwrite')
      const request = transaction.objectStore(HISTORY_IMAGE_STORE_NAME).put(
          {
            width: image.width,
            height: image.height,
            originalByteLength: originalImageByteLength(image),
            rgbaBytes: image.rgbaBytes,
            rgbaBase64: image.rgbaBase64,
          } satisfies ClipboardImagePayload,
        item.signature,
      )
      request.onsuccess = () => resolve()
      request.onerror = () =>
        reject(request.error ?? new Error('Failed to write clipboard image original'))
    })
  } finally {
    database.close()
  }
}

async function readHistoryFromIndexedDb(limit: number) {
  const database = await openHistoryDatabase()
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(HISTORY_STORE_NAME, 'readonly')
      const request = transaction.objectStore(HISTORY_STORE_NAME).get(HISTORY_ITEMS_KEY)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(request.error ?? new Error('Failed to read clipboard history'))
    })
    return sanitizeClipboardHistory(value, limit)
  } finally {
    database.close()
  }
}

async function writeHistoryToIndexedDb(items: ClipboardHistoryItem[]) {
  const database = await openHistoryDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HISTORY_STORE_NAME, 'readwrite')
      const request = transaction
        .objectStore(HISTORY_STORE_NAME)
        .put(items, HISTORY_ITEMS_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () =>
        reject(request.error ?? new Error('Failed to write clipboard history'))
    })
  } finally {
    database.close()
  }
}

async function loadClipboardHistoryFromStorage(limit: number) {
  let indexedItems: ClipboardHistoryItem[] = []
  try {
    indexedItems = await readHistoryFromIndexedDb(limit)
  } catch {
    // Fall through to the old localStorage key for browser previews and migration.
  }

  const localItems = loadClipboardHistory(limit, false)
  const merged = mergeStoredHistoryItems(limit, indexedItems, localItems)
  try {
    await writeOriginalImagesToIndexedDb(merged)
  } catch {
    // Loading history should not fail just because image migration/pruning failed.
  }
  return stripOriginalImagesForMemory(merged)
}

async function saveClipboardHistory(items: ClipboardHistoryItem[], limit: number) {
  const compacted = compactHistoryForStorage(items, limit)
  try {
    await writeOriginalImagesToIndexedDb(items).catch((error) =>
      console.warn('Cliboard failed to persist original clipboard images', error),
    )
    await writeHistoryToIndexedDb(compacted)
    localStorage.removeItem(CLIPBOARD_HISTORY_KEY)
  } catch {
    saveJson(CLIPBOARD_HISTORY_KEY, compactHistoryForLocalStorage(compacted, limit))
  }
}

function stripQuotes(value: string) {
  return value.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
}

function shellTokens(value: string) {
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g)
  return matches ?? []
}

function flagAliasVariants(name: string) {
  const dashed = name.toLowerCase().replaceAll('_', '-')
  const underscored = dashed.replaceAll('-', '_')
  const compact = dashed.replaceAll('-', '')
  return Array.from(new Set([dashed, underscored, compact]))
}

function readFlagValue(query: string, paramName: string) {
  const tokens = shellTokens(query)
  const aliases = flagAliasVariants(paramName)
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i]
    const next = tokens[i + 1]
    const lower = raw.toLowerCase()
    for (const alias of aliases) {
      const longFlag = `--${alias}`
      const equalsPrefix = `${longFlag}=`
      if (lower === longFlag) {
        if (next && !next.startsWith('-')) return { found: true, value: stripQuotes(next) }
        return { found: true, value: '' }
      }
      if (lower.startsWith(equalsPrefix)) {
        return { found: true, value: stripQuotes(raw.slice(equalsPrefix.length)) }
      }
      if (lower.length === 2 && lower.startsWith('-') && lower[1] === alias[0]) {
        if (next && !next.startsWith('-')) return { found: true, value: stripQuotes(next) }
        return { found: true, value: '' }
      }
    }
  }
  return { found: false, value: '' }
}

function looksLikePath(text: string) {
  return text.includes('/') || text.includes('\\') || text.startsWith('~')
}

function isBooleanFlagParam(paramName: string) {
  return paramName.endsWith('_flag') || paramName.endsWith('_option') || /enable|disable|force/.test(paramName)
}

function hasTemplateFragments(template: string, ...fragments: string[]) {
  const lower = template.toLowerCase()
  return fragments.every((fragment) => lower.includes(fragment.toLowerCase()))
}

function inferQuotedOrRaw(text: string | undefined) {
  if (!text) return undefined
  return stripQuotes(text.trim())
}

function inferMerlinParams(normalizedQuery: string, values: Record<string, string>) {
  const sourceFlag = normalizedQuery.match(/--source-job-run-id\s+([^\s"']+)/i)
  const captionFlag = normalizedQuery.match(/--caption\s+["']([^"']+)["']/i)
  const captionPhrase = normalizedQuery.match(
    /(?:命名为|命名成|名称为|名字叫|名字为|caption(?:名称|名字)?\s*(?:改成|叫|为|是)?|named\s+as|name\s+it)\s*["'“”‘’]?([a-zA-Z0-9][\w.-]{2,})["'“”‘’]?/i,
  )
  const caption = captionFlag?.[1] ?? captionPhrase?.[1]
  const queryWithoutCaption = caption
    ? normalizedQuery.replace(caption, ' ')
    : normalizedQuery

  const idNearJob = queryWithoutCaption.match(
    /([a-zA-Z0-9][a-zA-Z0-9_-]{3,})\s*(?:这个|的)?\s*(?:job|run|任务)/i,
  )
  const idAfterJob = queryWithoutCaption.match(
    /(?:job|run|任务)[^\w-]+([a-zA-Z0-9][a-zA-Z0-9_-]{3,})/i,
  )
  const stopWords = new Set([
    'fork',
    'merlin',
    'job',
    'run',
    'source',
    'source-job-run-id',
    'caption',
    'bytedcli',
    'fork-run',
    'name',
    'named',
    'vllm',
  ])
  const candidateIds = Array.from(
    queryWithoutCaption.matchAll(/[a-zA-Z0-9][a-zA-Z0-9_-]{3,}/g),
  )
    .map((match) => match[0])
    .filter((token) => {
      const lower = token.toLowerCase()
      return lower !== caption?.toLowerCase() && !stopWords.has(lower)
    })

  const explicitSourceId = (value?: string) => {
    if (!value) return undefined
    const lower = value.toLowerCase()
    return lower !== caption?.toLowerCase() && !stopWords.has(lower) ? value : undefined
  }

  const sourceId =
    sourceFlag?.[1] ??
    explicitSourceId(idAfterJob?.[1]) ??
    explicitSourceId(idNearJob?.[1]) ??
    candidateIds.find((token) => /\d/.test(token)) ??
    candidateIds[0]

  if (sourceId) values.source_job_run_id = sourceId
  if (caption) values.caption = stripQuotes(caption)
}

function inferHuggingFaceParams(query: string, values: Record<string, string>) {
  const full = query.trim()
  if (!full) return

  const explicitLocalDirFlag = readFlagValue(full, 'local_dir')
  if (explicitLocalDirFlag.found && explicitLocalDirFlag.value) {
    values.local_dir = explicitLocalDirFlag.value
  }

  const modelFromCommand = full.match(
    /huggingface[-\s]?cli\s+download\s+(".*?"|'.*?'|\S+)\s*(?:--|\s|$)/i,
  )
  if (modelFromCommand) {
    const modelToken = inferQuotedOrRaw(modelFromCommand[1])
    if (modelToken && looksLikePath(modelToken)) {
      values.model_id = modelToken
    }
  }

  const resumePhrase = /(?:恢复下载|断点续传|加.*?恢复下载|加.*?resume\s+download|开启.*?恢复下载|启用.*?恢复下载|with\s+resume)/i
  const resumeExplicit = readFlagValue(full, 'resume_download_flag')
  if (
    resumeExplicit.found ||
    resumePhrase.test(full)
  ) {
    const explicitFlag = resumeExplicit.found ? resumeExplicit.value : ''
    values.resume_download_flag = explicitFlag || '--resume-download'
  }
}

function extractParams(template: string) {
  const matches = template.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)
  return Array.from(new Set(Array.from(matches).map((match) => match[1])))
}

function ensureParamDefs(snippet: Snippet) {
  const params = { ...snippet.params }
  for (const name of extractParams(snippet.template)) {
    params[name] ??= {
      label: name.replaceAll('_', ' '),
      required: true,
    }
  }
  return params
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    return values[key] ?? ''
  })
}

function inferParamValues(query: string, snippet: Snippet) {
  const values: Record<string, string> = {}
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return values

  const params = ensureParamDefs(snippet)
  for (const key of Object.keys(params)) {
    const parsed = readFlagValue(normalizedQuery, key)
    if (parsed.found && parsed.value !== '') {
      values[key] = parsed.value
    } else if (parsed.found && parsed.value === '' && isBooleanFlagParam(key)) {
      values[key] = '--' + key.replaceAll('_', '-')
    }
  }

  const isMerlinFork = snippet.id === 'bytedcli-merlin-job-fork-run' ||
    hasTemplateFragments(snippet.template, 'bytedcli', 'merlin', 'fork-run', 'source-job-run-id')
  const isHuggingFace = snippet.id === 'huggingface-download' ||
    hasTemplateFragments(snippet.template, 'huggingface-cli', 'download')

  if (isMerlinFork) {
    inferMerlinParams(normalizedQuery, values)
  }

  if (isHuggingFace) {
    inferHuggingFaceParams(normalizedQuery, values)
  }

  return values
}

function initialParamValues(snippet?: Snippet) {
  if (!snippet) return {}
  const params = ensureParamDefs(snippet)
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, value.default ?? '']),
  )
}

async function copyToClipboard(value: string) {
  try {
    await writeText(value)
    return 'tauri'
  } catch {
    await navigator.clipboard.writeText(value)
    return 'browser'
  }
}

async function readClipboardFiles() {
  try {
    const files = await invoke<string[]>('read_clipboard_files')
    return files.filter((file) => file.trim())
  } catch {
    return []
  }
}

async function writeClipboardFiles(files: string[]) {
  await invoke('write_clipboard_files', { files })
}

async function readClipboardHtml() {
  try {
    const html = await invoke<string>('read_clipboard_html')
    return html.trim()
  } catch {
    return ''
  }
}

async function readClipboardTextAndHtml() {
  try {
    return await invoke<{ text: string; html: string }>('read_clipboard_text_and_html')
  } catch {
    try {
      const text = await readText()
      const html = await readClipboardHtml()
      return { text, html }
    } catch {
      return { text: '', html: '' }
    }
  }
}

async function writeClipboardHtml(html: string, altText: string) {
  await invoke('write_clipboard_html', { html, altText })
}

async function readActiveApplication() {
  try {
    return await invoke<ClipboardSourceApp | null>('read_active_application')
  } catch {
    return null
  }
}

async function readClipboardChangeCount() {
  try {
    return await invoke<number | null>('clipboard_change_count')
  } catch {
    return null
  }
}

function appUsageKey(app?: ClipboardSourceApp | null) {
  return app?.bundleId?.trim() || app?.name?.trim() || ''
}

function rankSnippetsWithAppContext(
  snippets: Snippet[],
  query: string,
  targetApp?: ClipboardSourceApp | null,
  learningScorer?: UsageLearningScorer,
) {
  const parsed = parseSearchQuery(query)
  const filtered = hasSearchFilters(parsed.filters)
    ? snippets.filter((snippet) => matchesSnippetFilters(snippet, parsed.filters))
    : snippets
  const normalizedQuery = parsed.text.trim()
  if (!normalizedQuery) return rankSnippets(filtered, normalizedQuery, 'hybrid')

  return filtered
    .map((snippet, index) => ({
      snippet,
      index,
      score: scoreSnippet(snippet, normalizedQuery, 'hybrid') +
        snippetAppUsageBoost(snippet, targetApp) +
        (learningScorer?.(
          normalizedQuery,
          snippetLearningCandidate(snippet),
          appUsageKey(targetApp),
        ) ?? 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      if ((right.snippet.favorite ? 1 : 0) !== (left.snippet.favorite ? 1 : 0)) {
        return (right.snippet.favorite ? 1 : 0) - (left.snippet.favorite ? 1 : 0)
      }
      if (right.snippet.useCount !== left.snippet.useCount) {
        return right.snippet.useCount - left.snippet.useCount
      }
      return left.index - right.index
    })
    .map(({ snippet }) => snippet)
}

function rankOfId<T extends { id: string }>(items: T[], id?: string) {
  if (!id) return null
  const index = items.findIndex((item) => item.id === id)
  return index === -1 ? null : index + 1
}

function snippetUsageRef(snippet: Snippet): UsageCandidateRef {
  return {
    id: snippet.id,
    title: snippet.title,
    path: snippet.path,
  }
}

function historyUsageRef(item: ClipboardHistoryItem): UsageCandidateRef {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    path: historyLearningPath(item),
  }
}

function historyTypeLabel(item: ClipboardHistoryItem) {
  return item.contentType ?? item.kind
}

function historyListMeta(item: ClipboardHistoryItem) {
  if (item.kind === 'text' && item.contentType && item.contentType !== 'text') {
    return item.subtitle || historyTypeLabel(item)
  }
  return item.kind !== 'text' ? item.subtitle : ''
}

function snippetLearningCandidate(snippet: Snippet): UsageLearningCandidate {
  return {
    id: snippet.id,
    title: snippet.title,
    path: snippet.path,
    kind: 'snippet',
  }
}

function historyLearningCandidate(item: ClipboardHistoryItem): UsageLearningCandidate {
  return {
    id: item.id,
    title: item.title,
    path: historyLearningPath(item),
    kind: 'history',
  }
}

function historyLearningPath(item: ClipboardHistoryItem) {
  return `Clipboard/${historyTypeLabel(item)}`
}

function usageLogToLearningEvent(entry: UsageLogEntry): UsageLearningEvent {
  return {
    query: entry.query,
    targetApp: appUsageKey(entry.targetApp),
    selectedId: entry.selected?.id,
    selectedItem: entry.selected,
    initialOrder: entry.candidates.initialOrder,
    finalOrder: entry.candidates.finalOrder,
    llm: entry.llm,
    timestamp: entry.completedAt ?? entry.createdAt,
    action: entry.action,
    surface: entry.surface,
  }
}

function snippetAppUsageBoost(snippet: Snippet, targetApp?: ClipboardSourceApp | null) {
  const key = appUsageKey(targetApp)
  if (!key) return 0
  const usage = snippet.appUsage?.[key] ?? 0
  return Math.min(usage * 18, 72)
}

function imagePreviewDataUrl(rgba: Uint8Array, width: number, height: number) {
  const scale = Math.min(1, IMAGE_PREVIEW_MAX_EDGE / Math.max(width, height))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const target = document.createElement('canvas')
  target.width = targetWidth
  target.height = targetHeight
  const targetContext = target.getContext('2d')
  if (!targetContext) return undefined

  const preview = targetContext.createImageData(targetWidth, targetHeight)
  const targetPixels = preview.data
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor(y / scale))
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor(x / scale))
      const sourceIndex = (sourceY * width + sourceX) * 4
      const targetIndex = (y * targetWidth + x) * 4
      targetPixels[targetIndex] = rgba[sourceIndex]
      targetPixels[targetIndex + 1] = rgba[sourceIndex + 1]
      targetPixels[targetIndex + 2] = rgba[sourceIndex + 2]
      targetPixels[targetIndex + 3] = rgba[sourceIndex + 3]
    }
  }
  targetContext.putImageData(preview, 0, 0)
  return target.toDataURL('image/png')
}

async function readClipboardHistoryItem(knownSignature?: string, changeCount?: number | null) {
  const sourceApp = await readActiveApplication()
  const historySourceApp = sourceApp ?? undefined
  const files = await readClipboardFiles()
  if (files.length) {
    return draftToHistoryItem({
      kind: 'file',
      content: files.join('\n'),
      files,
      sourceApp: historySourceApp,
    })
  }

  const textAndHtml = await readClipboardTextAndHtml()
  if (textAndHtml.text.trim() || textAndHtml.html.trim()) {
    const draft = textAndHtml.html.trim()
      ? classifyRichTextClipboard(textAndHtml.text, textAndHtml.html)
      : classifyTextClipboard(textAndHtml.text)
    if (draft) return draftToHistoryItem({ ...draft, sourceApp: historySourceApp })
  }

  try {
    const image = await readImage()
    const size = await image.size()
    const expectedByteLength = size.width * size.height * 4
    if (
      size.width > 0 &&
      size.height > 0 &&
      !shouldKeepOriginalImageBytes(size.width, size.height, expectedByteLength)
    ) {
      const contentType = detectImageContentType(
        { width: size.width, height: size.height },
        historySourceApp,
      )
      const hash = `large-${changeCount ?? `${size.width}x${size.height}`}`
      return draftToHistoryItem({
        kind: 'image',
        hash,
        contentType,
        image: {
          width: size.width,
          height: size.height,
        },
        sourceApp: historySourceApp,
      })
    }
    const rgba = await image.rgba()
    if (size.width > 0 && size.height > 0 && rgba.byteLength > 0) {
      const hash = hashBytes(rgba)
      const contentType = detectImageContentType(
        { width: size.width, height: size.height },
        historySourceApp,
      )
      const signature = `${contentType}:${size.width}x${size.height}:${hash}`
      if (signature === knownSignature) return null
      return draftToHistoryItem({
        kind: 'image',
        hash,
        contentType,
        image: imageHistoryPayload(rgba, size.width, size.height),
        sourceApp: historySourceApp,
      })
    }
  } catch {
    // Most clipboard writes are not images; text probing below handles the common path.
  }

  return null
}

async function generateImageCaption(previewDataUrl: string) {
  if (!XIAOMI_VISION_API_KEY.trim()) return ''
  const payload = await invoke<ChatCompletionResponse>('chat_completion', {
    baseUrl: XIAOMI_VISION_BASE_URL,
    apiKey: XIAOMI_VISION_API_KEY,
    body: {
      model: XIAOMI_VISION_MODEL,
      thinking: { type: 'disabled' },
      temperature: 0,
      max_tokens: 48,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '给这张剪贴板图片生成一个简短标题。只返回标题本身，不要解释，不要超过12个中文字或8个英文词。',
            },
            {
              type: 'image_url',
              image_url: { url: previewDataUrl },
            },
          ],
        },
      ],
    },
  })
  const caption = payload.choices?.[0]?.message?.content?.trim()
  return caption?.replace(/^["'“”]+|["'“”]+$/g, '') || ''
}

function parseJsonFromModel<T>(content: string) {
  const trimmed = content.trim().replace(/^```json\s*|\s*```$/g, '')
  try {
    return JSON.parse(trimmed) as T
  } catch (error) {
    const start = trimmed.indexOf('{')
    if (start < 0) throw error
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index]
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (char === '{') depth += 1
      if (char === '}') depth -= 1
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, index + 1)) as T
      }
    }
    throw error
  }
}

function sanitizeParsedModelResponse<T>(operation: string, parsed: T): T {
  if (operation !== 'turbo-direct-match' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed
  }

  const { reason: _reason, candidates: _candidates, likely_candidates: _likelyCandidates, ...rest } =
    parsed as Record<string, unknown>
  void _reason
  void _candidates
  void _likelyCandidates
  return rest as T
}

function outputForLlmLog(
  operation: string,
  parsed: unknown,
  rawParsed: unknown,
  rawReasoning?: string,
) {
  if (operation === 'turbo-direct-match') {
    return {
      raw_content: rawParsed,
      parsed_for_app: parsed,
    }
  }
  return {
    reasoning: rawReasoning || undefined,
    content: parsed,
  }
}

function shouldDisableJsonMode(settings: SettingsState) {
  return settings.baseUrl.toLowerCase().includes('stepfun.com') &&
    settings.model.toLowerCase().includes('flash')
}

function reasoningConfig(settings: SettingsState) {
  const baseUrl = settings.baseUrl.toLowerCase()
  const model = settings.model.toLowerCase()
  if (baseUrl.includes('deepseek.com')) {
    return {
      request: { thinking: { type: settings.thinkingMode } },
      log: { provider: 'deepseek', thinking: { type: settings.thinkingMode } },
    }
  }
  if (baseUrl.includes('stepfun.com') && model.includes('step-3.5-flash-2603')) {
    const reasoningEffort = settings.thinkingMode === 'enabled' ? 'high' : 'low'
    return {
      request: { reasoning_effort: reasoningEffort },
      log: { provider: 'stepfun', reasoning_effort: reasoningEffort },
    }
  }
  return { request: {}, log: 'provider/model default' }
}

function providerPromptPrefix(settings: SettingsState) {
  const baseUrl = settings.baseUrl.toLowerCase()
  if (baseUrl.includes('stepfun.com') && settings.thinkingMode === 'disabled') {
    return 'Do not reason step by step. Answer directly with the requested JSON only. '
  }
  return ''
}

function providerTextPromptPrefix(settings: SettingsState) {
  const baseUrl = settings.baseUrl.toLowerCase()
  if (baseUrl.includes('stepfun.com') && settings.thinkingMode === 'disabled') {
    return 'Do not reason step by step. Answer directly and concisely. '
  }
  return ''
}

function shouldUseBrowserLlmFallback(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /__TAURI_INTERNALS__|not available|is not a function|forbidden/i.test(message)
}

function textFromChatCompletion(payload: ChatCompletionResponse) {
  return payload.choices?.[0]?.message?.content?.trim() ?? ''
}

function parseChatCompletionStreamChunk(chunk: string, onText: (delta: string) => void) {
  const trimmed = chunk.trim()
  if (!trimmed || trimmed === '[DONE]') return

  try {
    const parsed = JSON.parse(trimmed) as {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_content?: string
        }
        message?: {
          content?: string
        }
      }>
    }
    const delta =
      parsed.choices?.[0]?.delta?.content ??
      parsed.choices?.[0]?.message?.content ??
      ''
    if (delta) onText(delta)
  } catch {
    // Ignore provider heartbeat or partial lines; the caller keeps buffering.
  }
}

async function requestModelJson<T>(
  settings: SettingsState,
  operation: string,
  messages: ModelMessage[],
) {
  const startedAt = now()
  const startedAtMs = performance.now()
  const responseFormat = shouldDisableJsonMode(settings)
    ? undefined
    : { type: 'json_object' }
  const reasoning = reasoningConfig(settings)
  const promptPrefix = providerPromptPrefix(settings)
  const requestMessages = promptPrefix
    ? messages.map((message, index) =>
        index === 0 && message.role === 'system'
          ? { ...message, content: `${promptPrefix}${message.content}` }
          : message,
      )
    : messages
  const body = {
    model: settings.model,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...reasoning.request,
    messages: requestMessages,
    max_tokens: 4096,
    temperature: 0.1,
  }
  const responseFormatForLog = responseFormat ?? 'disabled for StepFun flash compatibility'
  const reasoningForLog = reasoning.log

  try {
    let payload: ChatCompletionResponse
    try {
      payload = await invoke<ChatCompletionResponse>('chat_completion', {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        body,
      })
    } catch (error) {
      if (!shouldUseBrowserLlmFallback(error)) throw error

      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } finally {
        window.clearTimeout(timeout)
      }

      if (!response.ok) {
        const text = await response.text()
        // eslint-disable-next-line preserve-caught-error -- HTTP status errors are synthesized from a Response, not from a caught exception.
        throw new Error(`LLM HTTP ${response.status}${text ? ` ${text}` : ''}`)
      }
      payload = await response.json()
    }

    const message = payload.choices?.[0]?.message
    const content = message?.content
    if (!content) {
      throw new Error('LLM returned an empty response')
    }
    const rawParsed = parseJsonFromModel<T>(content)
    const parsed = sanitizeParsedModelResponse(operation, rawParsed)
    const rawReasoning = message?.reasoning ?? message?.reasoning_content
    const completedAt = now()
    writeLlmLog({
      createdAt: startedAt,
      completedAt,
      durationMs: Math.round(performance.now() - startedAtMs),
      usage: payload.usage,
      operation,
      input: {
        model: body.model,
        response_format: responseFormatForLog,
        reasoning: reasoningForLog,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        messages: formatModelMessages(requestMessages),
      },
      output: outputForLlmLog(operation, parsed, rawParsed, rawReasoning),
    })
    return parsed
  } catch (error) {
    const completedAt = now()
    writeLlmLog({
      createdAt: startedAt,
      completedAt,
      durationMs: Math.round(performance.now() - startedAtMs),
      operation,
      input: {
        model: body.model,
        response_format: responseFormatForLog,
        reasoning: reasoningForLog,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        messages: formatModelMessages(requestMessages),
      },
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function requestModelText(
  settings: SettingsState,
  operation: string,
  messages: ModelMessage[],
) {
  const startedAt = now()
  const startedAtMs = performance.now()
  const reasoning = reasoningConfig(settings)
  const promptPrefix = providerTextPromptPrefix(settings)
  const requestMessages = promptPrefix
    ? messages.map((message, index) =>
        index === 0 && message.role === 'system'
          ? { ...message, content: `${promptPrefix}${message.content}` }
          : message,
      )
    : messages
  const body = {
    model: settings.model,
    ...reasoning.request,
    messages: requestMessages,
    max_tokens: 2048,
    temperature: 0.2,
  }

  try {
    let payload: ChatCompletionResponse
    try {
      payload = await invoke<ChatCompletionResponse>('chat_completion', {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        body,
      })
    } catch (error) {
      if (!shouldUseBrowserLlmFallback(error)) throw error

      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } finally {
        window.clearTimeout(timeout)
      }

      if (!response.ok) {
        const text = await response.text()
        // eslint-disable-next-line preserve-caught-error -- HTTP status errors are synthesized from a Response, not from a caught exception.
        throw new Error(`LLM HTTP ${response.status}${text ? ` ${text}` : ''}`)
      }
      payload = await response.json()
    }

    const content = textFromChatCompletion(payload)
    if (!content) throw new Error('LLM returned an empty response')
    const completedAt = now()
    writeLlmLog({
      createdAt: startedAt,
      completedAt,
      durationMs: Math.round(performance.now() - startedAtMs),
      usage: payload.usage,
      operation,
      input: {
        model: body.model,
        response_format: 'text',
        reasoning: reasoning.log,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        messages: formatModelMessages(requestMessages),
      },
      output: {
        reasoning:
          payload.choices?.[0]?.message?.reasoning ??
          payload.choices?.[0]?.message?.reasoning_content ??
          undefined,
        content,
      },
    })
    return content
  } catch (error) {
    const completedAt = now()
    writeLlmLog({
      createdAt: startedAt,
      completedAt,
      durationMs: Math.round(performance.now() - startedAtMs),
      operation,
      input: {
        model: body.model,
        response_format: 'text',
        reasoning: reasoning.log,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        messages: formatModelMessages(requestMessages),
      },
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function requestModelTextStream(
  settings: SettingsState,
  operation: string,
  messages: ModelMessage[],
  onDelta: (delta: string, fullText: string) => void,
) {
  const startedAt = now()
  const startedAtMs = performance.now()
  const reasoning = reasoningConfig(settings)
  const promptPrefix = providerTextPromptPrefix(settings)
  const requestMessages = promptPrefix
    ? messages.map((message, index) =>
        index === 0 && message.role === 'system'
          ? { ...message, content: `${promptPrefix}${message.content}` }
          : message,
      )
    : messages
  const body = {
    model: settings.model,
    ...reasoning.request,
    messages: requestMessages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 2048,
    temperature: 0.2,
  }
  const requestId = `ask-stream-${Date.now()}-${Math.random().toString(16).slice(2)}`
  let fullText = ''
  let buffer = ''
  let streamedUsage: TokenUsage | undefined
  let unlisten: (() => void) | undefined

  function appendSseChunk(chunk: string) {
    buffer += chunk
    let lineBreak = buffer.indexOf('\n')
    while (lineBreak >= 0) {
      const rawLine = buffer.slice(0, lineBreak)
      buffer = buffer.slice(lineBreak + 1)
      const line = rawLine.trim()
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data) as { usage?: TokenUsage }
            if (parsed.usage) streamedUsage = parsed.usage
          } catch {
            // The text parser below tolerates malformed or partial data lines.
          }
          parseChatCompletionStreamChunk(data, (delta) => {
            fullText += delta
            onDelta(delta, fullText)
          })
        }
      }
      lineBreak = buffer.indexOf('\n')
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      listen<ChatCompletionStreamEvent>(
        'chat-completion-stream',
        ({ payload }) => {
          if (payload.requestId !== requestId) return
          if (payload.error) {
            reject(new Error(payload.error))
            return
          }
          if (payload.chunk) appendSseChunk(payload.chunk)
          if (payload.done) resolve()
        },
      )
        .then((dispose) => {
          unlisten = dispose
          return invoke<void>('chat_completion_stream', {
            requestId,
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            body,
          })
        })
        .then(() => resolve())
        .catch(reject)
    })

    const remainder = buffer.trim()
    if (remainder) appendSseChunk('\n')
    if (!fullText.trim()) throw new Error('LLM returned an empty response')
    const completedAt = now()
    writeLlmLog({
      createdAt: startedAt,
      completedAt,
      durationMs: Math.round(performance.now() - startedAtMs),
      usage: streamedUsage,
      operation,
      input: {
        model: body.model,
        response_format: 'text',
        reasoning: reasoning.log,
        stream: true,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        messages: formatModelMessages(requestMessages),
      },
      output: { content: fullText },
    })
    return fullText
  } catch (error) {
    if (shouldUseBrowserLlmFallback(error)) {
      const fallback = await requestModelText(settings, `${operation}-fallback`, messages)
      onDelta(fallback, fallback)
      return fallback
    }

    const completedAt = now()
    writeLlmLog({
      createdAt: startedAt,
      completedAt,
      durationMs: Math.round(performance.now() - startedAtMs),
      operation,
      input: {
        model: body.model,
        response_format: 'text',
        reasoning: reasoning.log,
        stream: true,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        messages: formatModelMessages(requestMessages),
      },
      output: fullText ? { partial_content: fullText } : undefined,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    unlisten?.()
  }
}

function snippetCandidateCard(snippet: Snippet) {
  return {
    id: snippet.id,
    title: snippet.title,
    metadata: {
      path: snippet.path,
      description: snippet.description,
      tags: snippet.tags,
      intents: snippet.intents,
      params: ensureParamDefs(snippet),
      favorite: Boolean(snippet.favorite),
      useCount: snippet.useCount,
    },
  }
}

function snippetFullCandidateCard(snippet: Snippet) {
  return {
    ...snippetCandidateCard(snippet),
    template: snippet.template,
  }
}

function sortSnippetsForCandidateOrder(
  snippets: Snippet[],
  order: 'forward' | 'reverse' | 'popular',
) {
  const sorted = [...snippets].sort((left, right) => {
    if (order === 'popular') {
      const favoriteOrder = Number(Boolean(right.favorite)) - Number(Boolean(left.favorite))
      if (favoriteOrder !== 0) return favoriteOrder
      if (right.useCount !== left.useCount) return right.useCount - left.useCount
    }
    const pathOrder = left.path.localeCompare(right.path)
    if (pathOrder !== 0) return pathOrder
    return left.title.localeCompare(right.title)
  })
  if (order === 'reverse') sorted.reverse()
  return sorted
}

function buildFullCandidateTree(
  snippets: Snippet[],
  order: 'forward' | 'reverse' | 'popular' = 'forward',
) {
  const groups: Array<{ path: string; candidates: ReturnType<typeof snippetFullCandidateCard>[] }> = []
  for (const snippet of sortSnippetsForCandidateOrder(snippets, order)) {
    const lastGroup = groups[groups.length - 1]
    const card = snippetFullCandidateCard(snippet)
    if (lastGroup?.path === snippet.path) {
      lastGroup.candidates.push(card)
    } else {
      groups.push({ path: snippet.path, candidates: [card] })
    }
  }
  return groups
}

function buildTreeCandidateBatches(
  snippets: Snippet[],
  batchSize = LLM_CANDIDATE_BATCH_SIZE,
  direction: 'forward' | 'reverse' = 'forward',
) {
  const sorted = sortSnippetsForCandidateOrder(snippets, direction)

  const batches: Array<{ groups: Array<{ path: string; candidates: ReturnType<typeof snippetCandidateCard>[] }> }> = []
  let currentGroups: Array<{ path: string; candidates: ReturnType<typeof snippetCandidateCard>[] }> = []
  let currentCount = 0

  for (const snippet of sorted) {
    if (currentCount >= batchSize) {
      batches.push({ groups: currentGroups })
      currentGroups = []
      currentCount = 0
    }

    const card = snippetCandidateCard(snippet)
    const lastGroup = currentGroups[currentGroups.length - 1]
    if (lastGroup?.path === snippet.path && currentCount < batchSize) {
      lastGroup.candidates.push(card)
    } else {
      currentGroups.push({ path: snippet.path, candidates: [card] })
    }
    currentCount += 1
  }

  if (currentGroups.length) {
    batches.push({ groups: currentGroups })
  }
  return batches
}

async function askModelForBatchMatches(
  rawQuery: string,
  candidateOrder: 'forward' | 'reverse',
  candidateTree: { groups: Array<{ path: string; candidates: ReturnType<typeof snippetCandidateCard>[] }> },
  settings: SettingsState,
) {
  const response = await requestModelJson<BatchMatchResponse>(settings, 'batch-match-candidates', [
    {
      role: 'system',
      content:
        'Select reusable clipboard snippet candidates from a tree-structured candidate list. Use only the provided ids. Return exactly one JSON object with this schema: {"matches":[{"reason":string,"id":string,"parameter_values":object}]}. Return up to 5 matches. Put reason before the answer id. Extract parameters directly from the user request with the LLM. If no candidate is plausible, return {"matches":[]}. Do not include markdown or extra keys.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        raw_query: rawQuery,
        candidate_order: candidateOrder,
        candidate_tree: candidateTree.groups,
      }),
    },
  ])

  const matches = response.matches ?? response.candidates
  if (matches?.length) return matches.slice(0, MAX_BATCH_MATCHES)
  if (response.id) {
    return [
      {
        id: response.id,
        reason: response.reason,
        parameter_values: response.parameter_values,
      },
    ]
  }
  return []
}

function dedupeSmartMatches(matches: SmartMatch[]) {
  const byId = new Map<string, SmartMatch>()
  for (const match of matches) {
    if (!match.id) continue
    if (!byId.has(match.id)) byId.set(match.id, match)
  }
  return Array.from(byId.values())
}

function normalizeAllInOneResponse(response: AllInOneMatchResponse, fallbackReason?: string): SmartMatch {
  const selected = response.selected ?? {
    id: response.id ?? '',
    parameter_values: response.parameter_values,
  }
  return {
    id: selected.id ?? '',
    parameter_values: selected.parameter_values,
    reason: response.reason ?? fallbackReason,
    output: response.output ?? response.final_output ?? response.text ?? selected.output,
  }
}

async function askModelForAllInOneMatch(
  query: string,
  snippets: Snippet[],
  settings: SettingsState,
  candidateOrder: 'forward' | 'reverse' | 'popular' = 'forward',
  operation = 'all-in-one-match',
) {
  const response = await requestModelJson<AllInOneMatchResponse>(settings, operation, [
    {
      role: 'system',
      content:
        'You are selecting and rendering one reusable clipboard snippet. Inspect all tree-grouped candidates in order. First identify up to 10 plausible candidates, then choose exactly one final snippet, extract parameter values, and produce the exact final clipboard output. Return exactly one JSON object with this schema: {"reason":string,"candidates":[{"reason":string,"id":string,"parameter_values":object}],"selected":{"id":string,"parameter_values":object},"output":string}. Put reason before answer fields. Do not put reason inside selected. Use only provided candidate ids. The output must be exact text to copy. Apply requested command modifications such as adding flags or changing options even when the template has no placeholder. Do not include markdown or extra keys.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        raw_query: query,
        candidate_order: candidateOrder,
        candidate_tree: buildFullCandidateTree(snippets, candidateOrder),
      }),
    },
  ])

  return normalizeAllInOneResponse(response, `All-in-one ${candidateOrder} match`)
}

async function askModelForDirectMatch(
  query: string,
  snippets: Snippet[],
  settings: SettingsState,
  candidateOrder: 'forward' | 'reverse' | 'popular' = 'forward',
  operation = 'direct-match',
) {
  const response = await requestModelJson<AllInOneMatchResponse>(settings, operation, [
    {
      role: 'system',
      content:
        'Directly choose and render one reusable clipboard snippet. Inspect all tree-grouped candidates in order, choose exactly one final snippet, extract parameter values, and produce the exact final clipboard output. Do not list plausible candidates. Return exactly one JSON object with this schema: {"reason":string,"selected":{"id":string,"parameter_values":object},"output":string}. Put reason before answer fields. Do not put reason inside selected. Use only provided candidate ids. The output must be exact text to copy. Apply requested command modifications such as adding flags or changing options even when the template has no placeholder. Do not include markdown or extra keys.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        raw_query: query,
        candidate_order: candidateOrder,
        candidate_tree: buildFullCandidateTree(snippets, candidateOrder),
      }),
    },
  ])

  return normalizeAllInOneResponse(response, `Direct ${candidateOrder} match`)
}

async function askModelForTurboMatch(
  query: string,
  snippets: Snippet[],
  settings: SettingsState,
) {
  const response = await requestModelJson<AllInOneMatchResponse>(settings, 'turbo-direct-match', [
    {
      role: 'system',
      content:
        'Directly choose and render one reusable clipboard snippet. Inspect all tree-grouped candidates in order, choose exactly one final snippet, extract parameter values, and produce the exact final clipboard output. Return exactly one JSON object with this schema: {"selected":{"id":string,"parameter_values":object},"output":string}. Do not include reason, candidates, markdown, or extra keys. Use only provided candidate ids. The output must be exact text to copy. Apply requested command modifications such as adding flags or changing options even when the template has no placeholder.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        raw_query: query,
        candidate_order: 'popular',
        candidate_tree: buildFullCandidateTree(snippets, 'popular'),
      }),
    },
  ])

  return normalizeAllInOneResponse(response, 'Turbo direct match')
}

function chooseVotedMatch(matches: SmartMatch[]) {
  const byId = new Map<string, SmartMatch[]>()
  for (const match of matches) {
    if (!match.id) continue
    byId.set(match.id, [...(byId.get(match.id) ?? []), match])
  }

  const ranked = Array.from(byId.entries()).sort(([, leftMatches], [, rightMatches]) => {
    if (rightMatches.length !== leftMatches.length) return rightMatches.length - leftMatches.length
    return 0
  })

  const [winnerId, winnerMatches] = ranked[0] ?? []
  if (!winnerId || !winnerMatches?.length) {
    throw new Error('LLM vote found no plausible snippet')
  }

  const winner = winnerMatches[0]
  const alternatives = ranked.slice(1).map(([id, voteMatches]) => ({
    id,
    votes: voteMatches.length,
  }))

  return {
    ...winner,
    reason: `${winner.reason ?? 'Voted direct match'} Votes: ${winnerMatches.length}/3. Alternatives: ${JSON.stringify(alternatives)}`,
  }
}

async function askModelForDirectVoteMatch(
  query: string,
  snippets: Snippet[],
  settings: SettingsState,
) {
  const matches = await Promise.all(
    (['forward', 'reverse', 'popular'] as const).map((candidateOrder) =>
      askModelForDirectMatch(
        query,
        snippets,
        settings,
        candidateOrder,
        `direct-vote-${candidateOrder}`,
      ),
    ),
  )
  return chooseVotedMatch(matches)
}

async function askModelForCandidateVoteMatch(
  query: string,
  snippets: Snippet[],
  settings: SettingsState,
) {
  const matches = await Promise.all(
    (['forward', 'reverse', 'popular'] as const).map((candidateOrder) =>
      askModelForAllInOneMatch(
        query,
        snippets,
        settings,
        candidateOrder,
        `candidate-vote-${candidateOrder}`,
      ),
    ),
  )
  return chooseVotedMatch(matches)
}

async function askModelForSmartMatch(
  query: string,
  snippets: Snippet[],
  settings: SettingsState,
) {
  if (settings.matchMode === 'turbo') {
    return askModelForTurboMatch(query, snippets, settings)
  }
  if (settings.matchMode === 'direct-vote') {
    return askModelForDirectVoteMatch(query, snippets, settings)
  }
  if (settings.matchMode === 'candidate-vote') {
    return askModelForCandidateVoteMatch(query, snippets, settings)
  }
  if (settings.matchMode === 'batch') {
    return askModelForMatch(query, snippets, settings)
  }
  return askModelForDirectMatch(query, snippets, settings)
}

async function askModelForMatch(
  query: string,
  snippets: Snippet[],
  settings: SettingsState,
): Promise<SmartMatch> {
  const requests = (['forward', 'reverse'] as const).flatMap((candidateOrder) =>
    buildTreeCandidateBatches(snippets, LLM_CANDIDATE_BATCH_SIZE, candidateOrder).map((batch) =>
      askModelForBatchMatches(query, candidateOrder, batch, settings),
    ),
  )
  const batchMatches = (await Promise.all(requests)).flat()

  const finalists = dedupeSmartMatches(batchMatches)
  if (!finalists.length) {
    throw new Error('LLM found no plausible snippet')
  }

  const finalistIds = new Set(finalists.map((match) => match.id))
  const finalistSnippets = snippets
    .filter((snippet) => finalistIds.has(snippet.id))
    .map((snippet) => ({
      id: snippet.id,
      title: snippet.title,
      path: snippet.path,
      description: snippet.description,
      tags: snippet.tags,
      intents: snippet.intents,
      params: ensureParamDefs(snippet),
      template: snippet.template,
      batch_notes: finalists
        .filter((match) => match.id === snippet.id)
        .map((match) => ({
          reason: match.reason,
          parameter_values: match.parameter_values,
        })),
    }))

  const response = await requestModelJson<AllInOneMatchResponse>(settings, 'choose-and-finalize-snippet', [
    {
      role: 'system',
      content:
        'Choose the single best reusable clipboard snippet from the finalists and produce the final clipboard output in the same response. Use only a provided id. Return exactly one JSON object with this schema: {"reason":string,"selected":{"id":string,"parameter_values":object},"output":string}. Put reason before answer fields. Do not put reason inside selected. Extract parameter_values directly from the user request. For CLI-style flags, return full flag tokens when the template expects a flag value. The output must be exact text to copy and may include requested flags or option changes even when the template did not have a placeholder. Do not include markdown or extra keys.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        raw_query: query,
        finalists: finalistSnippets,
      }),
    },
  ])
  return normalizeAllInOneResponse(response, 'Batch finalist match')
}

function blankSnippetFromTemplate(template: string): Snippet {
  const trimmed = template.trim()
  const { title, path, description } = inferSnippetMetadata(trimmed)
  return {
    id: `snippet-${Date.now()}`,
    title,
    path,
    description,
    template: trimmed,
    tags: [],
    intents: [],
    params: {},
    useCount: 0,
    createdAt: now(),
    updatedAt: now(),
  }
}

function sourceLabelForSnippetDraft(source?: SnippetDraftSource) {
  if (source === 'clipboard_history') return 'clipboard history'
  if (source === 'search_query') return 'search query'
  return 'manual input'
}

function snippetPathSummary(snippets: Snippet[]) {
  const groups = new Map<string, { count: number; examples: string[] }>()
  for (const snippet of snippets) {
    const group = groups.get(snippet.path) ?? { count: 0, examples: [] }
    group.count += 1
    if (group.examples.length < 4) group.examples.push(snippet.title)
    groups.set(snippet.path, group)
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, group]) => ({
      path,
      count: group.count,
      examples: group.examples,
    }))
}

function cleanStringArray(value: unknown, limit: number) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, limit)
}

function sanitizeParameterName(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function cleanParamDefs(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const params: Record<string, ParamDef> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = sanitizeParameterName(rawKey)
    if (!key) continue
    const source =
      rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
        ? rawValue as Record<string, unknown>
        : {}
    params[key] = {
      label: typeof source.label === 'string' && source.label.trim()
        ? source.label.trim()
        : key.replaceAll('_', ' '),
      default:
        typeof source.default === 'string'
          ? source.default
          : typeof rawValue === 'string'
            ? rawValue
            : undefined,
      required: typeof source.required === 'boolean' ? source.required : true,
      placeholder: typeof source.placeholder === 'string' ? source.placeholder : undefined,
    }
  }
  return params
}

function applySnippetClassification(
  snippet: Snippet,
  classification: SnippetClassificationResponse,
) {
  const title = typeof classification.title === 'string' ? classification.title.trim() : ''
  const path = typeof classification.path === 'string' ? classification.path.trim() : ''
  const description =
    typeof classification.description === 'string' ? classification.description.trim() : ''
  const template = typeof classification.template === 'string' ? classification.template.trim() : ''
  const params = cleanParamDefs(classification.params)

  return {
    ...snippet,
    title: title || snippet.title,
    path: path || snippet.path,
    description: description || snippet.description,
    template: template || snippet.template,
    tags: cleanStringArray(classification.tags, 8),
    intents: cleanStringArray(classification.intents, 8),
    params: Object.keys(params).length ? params : snippet.params,
    updatedAt: now(),
  }
}

async function classifySnippetWithLlm(
  settings: SettingsState,
  snippets: Snippet[],
  snippet: Snippet,
  source: SnippetDraftSource,
) {
  return requestModelJson<SnippetClassificationResponse>(settings, 'classify-snippet', [
    {
      role: 'system',
      content:
        'Generate a reusable smart clipboard snippet from one source item. Return exactly one JSON object with this schema: {"reason":string,"path_decision":"reuse_existing"|"create_new","source":"clipboard_history"|"search_query"|"manual","title":string,"path":string,"description":string,"template":string,"tags":string[],"intents":string[],"params":object}. Put reason first. Path should look like Domain/Subdomain, for example Shell/Git, Shell/HuggingFace, Prompts/Code Review, SQL/Postgres, Writing/PR. Reuse an existing path when suitable; otherwise create a concise new path. If the source is a CLI command, turn volatile literals into {{param_name}} placeholders: ids, model names, local paths, ports, namespaces, captions, branch names, URLs, file paths, query values, flags that users commonly change. Keep stable command words and stable flags in the template. Params must map names to objects like {"label":string,"default":string,"required":boolean,"placeholder":string}. The default should be the original copied value when available. Tags are short lookup terms; intents are natural-language ways a user might ask for this snippet. Keep the template directly usable and do not invent unsafe commands. Do not include markdown, extra keys, or trailing text.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        source,
        source_label: sourceLabelForSnippetDraft(source),
        existing_tree: snippetPathSummary(snippets),
        snippet: {
          title: snippet.title,
          path: snippet.path,
          description: snippet.description,
          template: snippet.template,
          tags: snippet.tags,
          intents: snippet.intents,
          params: snippet.params,
        },
      }),
    },
  ])
}

function inferSnippetMetadata(template: string) {
  const normalizedTemplate = template.toLowerCase()
  const firstLine = template
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''

  if (!firstLine) {
    return {
      title: 'New snippet',
      path: 'Shell/General',
      description: '',
    }
  }

  const fallbackTitle = `Snippet: ${firstLine.slice(0, 48)}${firstLine.length > 48 ? '…' : ''}`
  const compact = firstLine.length > 110 ? `${firstLine.slice(0, 107)}…` : firstLine

  if (normalizedTemplate.includes('bytedcli') && normalizedTemplate.includes('merlin')) {
    return {
      title: firstLine.includes('fork-run') ? 'Fork a Merlin job run' : 'Bytedance Merlin command',
      path: 'Shell/Merlin',
      description: `Auto-generated from: ${compact}`,
    }
  }

  if (normalizedTemplate.includes('huggingface-cli') && normalizedTemplate.includes('download')) {
    return {
      title: 'Download from Hugging Face',
      path: 'Shell/HuggingFace',
      description: `Auto-generated from: ${compact}`,
    }
  }

  if (
    normalizedTemplate.includes('kubectl') ||
    normalizedTemplate.includes('kubernetes') ||
    normalizedTemplate.includes('k8s')
  ) {
    return {
      title: `Kubernetes: ${firstLine.split(' ')[0]}`,
      path: 'Shell/Kubernetes',
      description: `Auto-generated from: ${compact}`,
    }
  }

  if (normalizedTemplate.includes('git')) {
    return {
      title: `Git: ${firstLine.split(' ')[0]}`,
      path: 'Shell/Git',
      description: `Auto-generated from: ${compact}`,
    }
  }

  if (normalizedTemplate.includes('docker')) {
    return {
      title: `Docker: ${firstLine.split(' ')[0]}`,
      path: 'Shell/Docker',
      description: `Auto-generated from: ${compact}`,
    }
  }

  if (normalizedTemplate.includes('select ') || normalizedTemplate.includes('from ')) {
    return {
      title: `SQL: ${firstLine.slice(0, 48)}${firstLine.length > 48 ? '…' : ''}`,
      path: 'SQL/General',
      description: `Auto-generated from: ${compact}`,
    }
  }

  return {
    title: fallbackTitle,
    path: 'Shell/General',
    description: `Auto-generated from: ${compact}`,
  }
}

function inferCommandFromQuery(text: string) {
  const trimmed = text.trim()
  return trimmed
}

function App() {
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets)
  const [settings, setSettings] = useState<SettingsState>(loadSettings)
  const [historyItems, setHistoryItems] = useState<ClipboardHistoryItem[]>(() =>
    loadClipboardHistory(settings.historyLimit),
  )
  const [historyReady, setHistoryReady] = useState(false)
  const [query, setQuery] = useState('')
  const [surface, setSurface] = useState<LauncherSurface>('history')
  const [askQuestion, setAskQuestion] = useState('')
  const [askAnswer, setAskAnswer] = useState('')
  const [askError, setAskError] = useState('')
  const [askBusy, setAskBusy] = useState(false)
  const [askStreaming] = useState(true)
  const [selectedId, setSelectedId] = useState(snippets[0]?.id ?? '')
  const [selectedHistoryId, setSelectedHistoryId] = useState('')
  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    initialParamValues(snippets[0]),
  )
  const [toast, setToast] = useState<ToastState>({
    tone: 'neutral',
    text: 'Ready',
  })
  const [mode, setMode] = useState<'render' | 'edit' | 'settings'>('render')
  const [draft, setDraft] = useState<Snippet | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiRenderedOutput, setAiRenderedOutput] = useState('')
  const [llmLogs, setLlmLogs] = useState<LlmLogEntry[]>(loadLlmLogs)
  const [usageLogs, setUsageLogs] = useState<UsageLogEntry[]>(loadUsageLogs)
  const [askMessages, setAskMessages] = useState<AskChatMessage[]>(loadAskMessages)
  const [targetApp, setTargetApp] = useState<ClipboardSourceApp | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const askScrollRef = useRef<HTMLDivElement>(null)
  const historyItemsRef = useRef(historyItems)
  const keyboardActionsRef = useRef<KeyboardActions | null>(null)
  const keyboardSnapshotRef = useRef<KeyboardSnapshot | null>(null)
  const targetAppRef = useRef<ClipboardSourceApp | null>(null)
  const askQuestionRef = useRef('')
  const askBusyRef = useRef(false)
  const isComposingRef = useRef(false)

  async function hideLauncherWindow() {
    let hiddenNativePanel = false
    try {
      await invoke('hide_launcher_panel')
      hiddenNativePanel = true
    } catch {
      // Browser preview and non-native fallback still use the Tauri window.
    }

    try {
      if (!hiddenNativePanel) await getCurrentWindow().hide()
    } catch {
      // Browser preview does not expose Tauri window controls.
    }
  }

  async function pasteAfterLauncherHides() {
    try {
      await invoke('paste_after_hiding_launcher_panel')
    } catch {
      await hideLauncherWindow()
      await new Promise((resolve) => window.setTimeout(resolve, PASTE_AFTER_HIDE_DELAY_MS))
      try {
        await invoke('paste_to_frontmost_app')
      } catch {
        setToast({
          tone: 'warning',
          text: IS_MACOS
            ? 'Copied. Grant Accessibility permission to auto-paste.'
            : 'Copied. Auto-paste is only available on macOS.',
        })
      }
    }
  }
  const snippetRowRefs = useRef(new Map<string, HTMLDivElement>())
  const historyRowRefs = useRef(new Map<string, HTMLDivElement>())
  const latestClipboardSignature = useRef('')
  const latestClipboardChangeCount = useRef<number | null>(null)
  const clipboardSampleInFlight = useRef(false)
  const clipboardSamplePending = useRef(false)
  const initialHistoryLimitRef = useRef(settings.historyLimit)

  useEffect(() => {
    historyItemsRef.current = historyItems
  }, [historyItems])

  useEffect(() => {
    targetAppRef.current = targetApp
  }, [targetApp])

  useEffect(() => {
    askQuestionRef.current = askQuestion
  }, [askQuestion])

  useEffect(() => {
    askBusyRef.current = askBusy
  }, [askBusy])

  useEffect(() => {
    if (surface !== 'ask') return
    const element = askScrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [askAnswer, askMessages, surface])

  useEffect(() => saveJson(SNIPPETS_KEY, snippets), [snippets])
  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings])
  useEffect(() => saveJson(ASK_MESSAGES_KEY, askMessages), [askMessages])

  useEffect(() => {
    let cancelled = false
    void loadClipboardHistoryFromStorage(initialHistoryLimitRef.current).then((items) => {
      if (cancelled) return
      historyItemsRef.current = items
      setHistoryItems(items)
      setHistoryReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!historyReady) return
    void saveClipboardHistory(historyItems, settings.historyLimit)
  }, [historyItems, historyReady, settings.historyLimit])

  useEffect(() => {
    if (toast.tone === 'neutral') return
    const timer = window.setTimeout(() => {
      setToast({ tone: 'neutral', text: '' })
    }, TOAST_AUTO_HIDE_MS)
    return () => window.clearTimeout(timer)
  }, [toast.tone, toast.text])

  const selectedSnippet = useMemo(
    () => snippets.find((snippet) => snippet.id === selectedId) ?? snippets[0],
    [snippets, selectedId],
  )

  const learningScorer = useMemo(
    () =>
      buildHistoricalQueryBoost(usageLogs.map(usageLogToLearningEvent), {
        maxBoost: 42,
        maxPenalty: 8,
        selectedWeight: 26,
        unselectedWeight: 2.4,
      }),
    [usageLogs],
  )

  const rankedHistoryItems = useMemo(
    () =>
      rankHistoryItems(historyItems, query, targetApp, (item, normalizedQuery) =>
        learningScorer(
          normalizedQuery,
          historyLearningCandidate(item),
          appUsageKey(targetApp),
        ),
      ),
    [historyItems, learningScorer, query, targetApp],
  )

  const selectedHistoryItem = useMemo(
    () => {
      const selected = rankedHistoryItems.find((item) => item.id === selectedHistoryId)
      if (selected) return selected
      if (rankedHistoryItems.length) return rankedHistoryItems[0]
      return query.trim() ? undefined : historyItems[0]
    },
    [historyItems, query, rankedHistoryItems, selectedHistoryId],
  )
  const selectedHistoryCopyable =
    selectedHistoryItem &&
    (selectedHistoryItem.kind !== 'image' || Boolean(selectedHistoryItem.image))
  const clipboardStorageUsage = useMemo(
    () => estimateClipboardStorageUsage(historyItems, settings.historyLimit),
    [historyItems, settings.historyLimit],
  )

  keyboardSnapshotRef.current = {
    mode,
    query,
    selectedHistoryItem,
    selectedSnippet,
    surface,
  }
  keyboardActionsRef.current = {
    handleAskLlm,
    handleCopy,
    handleCopyHistoryItem,
    handleSmartMatch,
    hideLauncherWindow,
    moveHistorySelection,
    moveSnippetSelection,
    setMode,
  }

  useEffect(() => {
    if (surface !== 'history' || !selectedHistoryItem) return
    historyRowRefs.current.get(selectedHistoryItem.id)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [selectedHistoryItem, surface])

  useEffect(() => {
    if (surface !== 'snippets' || !selectedSnippet) return
    snippetRowRefs.current.get(selectedSnippet.id)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [selectedSnippet, surface])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const snapshot = keyboardSnapshotRef.current
      const actions = keyboardActionsRef.current
      if (!snapshot || !actions) return
      const target = event.target as HTMLElement | null
      const nativeEvent = event as KeyboardEvent & { isComposing?: boolean }
      const isComposing = isComposingRef.current || nativeEvent.isComposing || event.keyCode === 229
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable

      if (isComposing && (event.key === 'Enter' || event.key === 'Process')) {
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }

      if (isTyping && target !== searchRef.current) {
        return
      }

      if (
        event.key === 'Enter' &&
        !event.metaKey &&
        !event.ctrlKey &&
        snapshot.surface === 'ask' &&
        askQuestionRef.current.trim()
      ) {
        event.preventDefault()
        void actions.handleAskLlm()
        return
      }

      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && snapshot.query.trim()) {
        event.preventDefault()
        if (snapshot.surface === 'snippets') void actions.handleSmartMatch({ pasteAfterCopy: true })
        else if (snapshot.selectedHistoryItem) {
          void actions.handleCopyHistoryItem(snapshot.selectedHistoryItem, { pasteAfterCopy: true })
        }
        return
      }

      if (
        event.key === 'Enter' &&
        !event.metaKey &&
        !event.ctrlKey &&
        snapshot.surface === 'history' &&
        snapshot.selectedHistoryItem
      ) {
        event.preventDefault()
        void actions.handleCopyHistoryItem(snapshot.selectedHistoryItem, { pasteAfterCopy: true })
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        if (snapshot.surface === 'ask') {
          void actions.handleAskLlm()
        } else if (snapshot.surface === 'history' && snapshot.selectedHistoryItem) {
          void actions.handleCopyHistoryItem(snapshot.selectedHistoryItem, { pasteAfterCopy: true })
        } else if (snapshot.selectedSnippet) {
          void actions.handleCopy({ pasteAfterCopy: true })
        }
        return
      }

      if (
        (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
        (!isTyping || target === searchRef.current) &&
        snapshot.surface !== 'ask'
      ) {
        event.preventDefault()
        if (snapshot.surface === 'history') {
          actions.moveHistorySelection(event.key === 'ArrowDown' ? 1 : -1)
        } else {
          actions.moveSnippetSelection(event.key === 'ArrowDown' ? 1 : -1)
        }
        return
      }

      if (
        snapshot.surface === 'history' &&
        (event.metaKey || event.ctrlKey) &&
        event.key === 'Backspace'
      ) {
        event.preventDefault()
        if (snapshot.selectedHistoryItem) deleteHistoryItem(snapshot.selectedHistoryItem.id)
        return
      }

      if (event.key === 'Escape') {
        if (snapshot.mode === 'settings' || snapshot.mode === 'edit') {
          actions.setMode('render')
          return
        }
        void actions.hideLauncherWindow()
        return
      }

      if (!isTyping && event.key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    let unlistenClose: (() => void) | undefined
    let unlistenFocus: (() => void) | undefined
    let unlistenWake: (() => void) | undefined

    function focusLauncher(payload?: LauncherWakePayload | null) {
      const nextSurface = payload?.surface ?? 'history'
      setTargetApp(payload?.app ?? null)
      setMode('render')
      setSurface(nextSurface)
      if (nextSurface === 'ask') {
        setAskQuestion('')
        setAskAnswer('')
        setAskError('')
      } else {
        setQuery('')
        setSelectedHistoryId('')
        setSelectedId('')
        setAiRenderedOutput('')
      }
      window.setTimeout(() => searchRef.current?.focus(), 40)
    }

    async function preparePanelWindow() {
      try {
        const appWindow = getCurrentWindow()
        await appWindow.setSize(PANEL_SIZE)
        unlistenClose = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault()
          await hideLauncherWindow()
        })
        if (!IS_MACOS) {
          unlistenFocus = await appWindow.onFocusChanged(async ({ payload: focused }) => {
            if (!focused) {
              await hideLauncherWindow()
            }
          })
        }
      } catch {
        // Browser preview does not expose Tauri window controls.
      }

      try {
        unlistenWake = await listen<LauncherWakePayload | null>('launcher-wake', ({ payload }) =>
          focusLauncher(payload),
        )
      } catch {
        // Browser preview does not receive native wake events.
      }

      focusLauncher()
    }

    void preparePanelWindow()
    return () => {
      unlistenClose?.()
      unlistenFocus?.()
      unlistenWake?.()
    }
  }, [])

  useEffect(() => {
    if (!historyReady) return
    let cancelled = false

    async function sampleClipboard() {
      if (clipboardSampleInFlight.current) {
        clipboardSamplePending.current = true
        return
      }
      clipboardSampleInFlight.current = true
      const startedAt = performance.now()
      try {
        const changeCount = await readClipboardChangeCount()
        if (changeCount !== null && changeCount === latestClipboardChangeCount.current) return

        const item = await readClipboardHistoryItem(
          latestClipboardSignature.current,
          changeCount,
        )
        if (changeCount !== null) {
          latestClipboardChangeCount.current = changeCount
        }
        if (cancelled || !item || item.signature === latestClipboardSignature.current) return

        latestClipboardSignature.current = item.signature
        if (item.kind === 'image' && (item.image?.rgbaBase64 || item.image?.rgbaBytes)) {
          await writeOriginalImageToIndexedDb(item).catch((error) =>
            console.warn('Cliboard failed to persist clipboard image original', error),
          )
        }
        const memoryItem = stripOriginalImageForMemory(item)
        setHistoryItems((current) => {
          const nextItems = mergeHistoryItem(current, memoryItem, settings.historyLimit)
          historyItemsRef.current = nextItems
          return nextItems
        })
        setSelectedHistoryId('')
        if (
          memoryItem.kind === 'image' &&
          memoryItem.image?.previewDataUrl &&
          !memoryItem.image.caption
        ) {
          void generateImageCaption(memoryItem.image.previewDataUrl)
            .then((caption) => {
              if (!caption || cancelled) return
              setHistoryItems((current) => {
                const nextItems = trimHistoryItems(
                  current.map((historyItem) => {
                    if (
                      historyItem.signature !== memoryItem.signature ||
                      historyItem.kind !== 'image'
                    ) {
                      return historyItem
                    }
                    const fallbackImage = memoryItem.image
                    if (!fallbackImage) return historyItem
                    const image = historyItem.image ?? fallbackImage
                    return {
                      ...historyItem,
                      contentType: detectImageContentType(
                        { ...image, caption },
                        historyItem.sourceApp,
                      ),
                      title: caption,
                      subtitle: `${caption.toLowerCase().includes('screenshot') ? 'Screenshot' : 'Image'} · ${image.width}×${image.height} pixels`,
                      image: historyItem.image ? { ...historyItem.image, caption } : historyItem.image,
                      updatedAt: now(),
                    }
                  }),
                  settings.historyLimit,
                )
                historyItemsRef.current = nextItems
                return nextItems
              })
            })
            .catch(() => undefined)
        }
      } catch (error) {
        console.warn('Cliboard clipboard history sample failed', error)
      } finally {
        const elapsed = performance.now() - startedAt
        if (elapsed > HISTORY_SLOW_SAMPLE_WARN_MS) {
          console.warn(`Cliboard clipboard history sample took ${Math.round(elapsed)}ms`)
        }
        clipboardSampleInFlight.current = false
        if (clipboardSamplePending.current && !cancelled) {
          clipboardSamplePending.current = false
          void sampleClipboard()
        }
      }
    }

    void sampleClipboard()
    const timer = window.setInterval(() => void sampleClipboard(), HISTORY_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [historyReady, settings.historyLimit])

  const localRankedSnippets = useMemo(() => {
    return rankSnippetsWithAppContext(snippets, query, targetApp, learningScorer)
  }, [learningScorer, query, snippets, targetApp])

  const rankedSnippets = localRankedSnippets

  const rendered = selectedSnippet
    ? renderTemplate(selectedSnippet.template, paramValues)
    : ''
  const finalRendered = aiRenderedOutput || rendered

  const selectedParams = selectedSnippet ? ensureParamDefs(selectedSnippet) : {}
  const missingParams = Object.entries(selectedParams)
    .filter(([, def]) => def.required)
    .filter(([key]) => !paramValues[key]?.trim())
    .map(([key]) => key)

  function recordSnippetUsageLog({
    action,
    selected,
    llm,
    output,
    durationMs,
    metadata,
  }: {
    action: UsageLogEntry['action']
    selected: Snippet
    llm: UsageLogEntry['llm']
    output?: string
    durationMs?: number
    metadata?: Record<string, unknown>
  }) {
    setUsageLogs(writeUsageLog({
      completedAt: now(),
      durationMs,
      surface: 'snippets',
      action,
      query,
      targetApp: targetAppRef.current,
      llm,
      selected: {
        id: selected.id,
        title: selected.title,
        path: selected.path,
        output,
      },
      ranks: {
        initialRank: rankOfId(localRankedSnippets, selected.id),
        finalRank: rankOfId(rankedSnippets, selected.id),
        finalRankingSource: 'local',
      },
      candidates: {
        initialTotal: localRankedSnippets.length,
        finalTotal: rankedSnippets.length,
        initialOrder: localRankedSnippets.map(snippetUsageRef),
        finalOrder: rankedSnippets.map(snippetUsageRef),
      },
      metadata,
    }))
  }

  function recordHistoryUsageLog(
    item: ClipboardHistoryItem,
    options: { durationMs?: number; metadata?: Record<string, unknown> } = {},
  ) {
    setUsageLogs(writeUsageLog({
      completedAt: now(),
      durationMs: options.durationMs,
      surface: 'history',
      action: 'history-copy',
      query,
      targetApp: targetAppRef.current,
      llm: { used: false },
      selected: {
        id: item.id,
        title: item.title,
        kind: item.kind,
        path: historyLearningPath(item),
        output: itemToClipboardText(item),
      },
      ranks: {
        initialRank: rankOfId(rankedHistoryItems, item.id),
        finalRank: rankOfId(rankedHistoryItems, item.id),
        finalRankingSource: 'local',
      },
      candidates: {
        initialTotal: rankedHistoryItems.length,
        finalTotal: rankedHistoryItems.length,
        initialOrder: rankedHistoryItems.map(historyUsageRef),
        finalOrder: rankedHistoryItems.map(historyUsageRef),
      },
      metadata: options.metadata,
    }))
  }

  function selectSnippet(id: string) {
    const snippet = snippets.find((item) => item.id === id)
    setSelectedId(id)
    setParamValues(initialParamValues(snippet))
    setAiRenderedOutput('')
    setMode('render')
  }

  function updateSearchQuery(nextQuery: string) {
    setQuery(nextQuery)

    if (surface === 'history') {
      const nextRanked = rankHistoryItems(
        historyItemsRef.current,
        nextQuery,
        targetAppRef.current,
        (item, normalizedQuery) =>
          learningScorer(
            normalizedQuery,
            historyLearningCandidate(item),
            appUsageKey(targetAppRef.current),
          ),
      )
      setSelectedHistoryId(nextRanked[0]?.id ?? '')
      return
    }

    const nextRanked = rankSnippetsWithAppContext(
      snippets,
      nextQuery,
      targetAppRef.current,
      learningScorer,
    )
    const firstSnippet = nextRanked[0]
    setSelectedId(firstSnippet?.id ?? '')
    setParamValues(initialParamValues(firstSnippet))
    setAiRenderedOutput('')
  }

  function setSnippetUsage(snippetId: string, app?: ClipboardSourceApp | null) {
    const key = appUsageKey(app)
    setSnippets((current) =>
      current.map((snippet) =>
        snippet.id === snippetId
          ? {
              ...snippet,
              useCount: snippet.useCount + 1,
              appUsage: key
                ? {
                    ...(snippet.appUsage ?? {}),
                    [key]: (snippet.appUsage?.[key] ?? 0) + 1,
                  }
                : snippet.appUsage,
              lastUsed: now(),
              updatedAt: now(),
            }
          : snippet,
      ),
    )
  }

  async function handleCopy(options: CopyActionOptions = {}) {
    if (!selectedSnippet) return
    if (missingParams.length) {
      setToast({
        tone: 'warning',
        text: `Missing: ${missingParams.join(', ')}`,
      })
      return
    }

    const started = performance.now()
    try {
      const channel = await copyToClipboard(finalRendered)
      setSnippetUsage(selectedSnippet.id, targetAppRef.current)
      recordSnippetUsageLog({
        action: 'snippet-copy',
        selected: selectedSnippet,
        output: finalRendered,
        durationMs: Math.round(performance.now() - started),
        llm: { used: Boolean(aiRenderedOutput), matchMode: settings.matchMode, model: settings.model },
        metadata: {
          copy_channel: channel,
          missing_params: missingParams,
          parameter_values: paramValues,
          rendered_from_llm: Boolean(aiRenderedOutput),
        },
      })
      setToast({
        tone: 'success',
        text: channel === 'tauri' ? 'Copied with desktop clipboard' : 'Copied',
      })
      if (options.pasteAfterCopy) {
        await pasteAfterLauncherHides()
      }
    } catch (error) {
      setToast({
        tone: 'warning',
        text: error instanceof Error ? error.message : 'Copy failed',
      })
    }
  }

  async function handleSmartMatch(options: CopyActionOptions = {}) {
    if (!query.trim()) {
      setToast({ tone: 'warning', text: 'Type a natural-language request first' })
      searchRef.current?.focus()
      return
    }

    setAiBusy(true)
    const started = performance.now()
    const useLlm = shouldUseLlmForMatch(settings)
    const fallbackTop = [...snippets]
      .sort((a, b) => keywordMetadataScore(b, query) - keywordMetadataScore(a, query))

    try {
      const match = useLlm
        ? await askModelForSmartMatch(query, snippets, settings)
        : {
            id: fallbackTop[0]?.id,
            reason: !settings.llmMatchEnabled
              ? 'Local metadata match. LLM Match is off in Settings.'
              : settings.apiKey.trim()
                ? 'Local metadata match. Enable LLM features in Settings to use model matching.'
                : 'Local metadata match. Add an API key in Settings to use LLM matching.',
          }

      const matchedSnippet = snippets.find((snippet) => snippet.id === match.id)
      if (!matchedSnippet) throw new Error('No matching snippet found')
      const nextParamValues = {
        ...initialParamValues(matchedSnippet),
        ...(useLlm ? {} : inferParamValues(query, matchedSnippet)),
        ...(match.parameter_values ?? {}),
      }
      const locallyRendered = renderTemplate(matchedSnippet.template, nextParamValues)
      const finalOutput = match.output ?? locallyRendered

      setSelectedId(matchedSnippet.id)
      setParamValues(nextParamValues)
      setAiRenderedOutput(finalOutput)
      setMode('render')
      recordSnippetUsageLog({
        action: 'snippet-match',
        selected: matchedSnippet,
        output: finalOutput,
        durationMs: Math.round(performance.now() - started),
        llm: {
          used: useLlm,
          matchMode: settings.matchMode,
          model: useLlm ? settings.model : undefined,
        },
        metadata: {
          reason: match.reason,
          parameter_values: nextParamValues,
          output_changed_by_llm: finalOutput !== locallyRendered,
          llm_candidate_order_popular: sortSnippetsForCandidateOrder(snippets, 'popular')
            .slice(0, MAX_USAGE_CANDIDATES)
            .map(snippetUsageRef),
        },
      })
      setToast({
        tone: useLlm ? 'success' : 'neutral',
        text: match.reason ?? `Matched ${matchedSnippet.title}`,
      })
      if (options.pasteAfterCopy) {
        const channel = await copyToClipboard(finalOutput)
        setSnippetUsage(matchedSnippet.id, targetAppRef.current)
        recordSnippetUsageLog({
          action: 'snippet-copy',
          selected: matchedSnippet,
          output: finalOutput,
          durationMs: Math.round(performance.now() - started),
          llm: {
            used: useLlm,
            matchMode: settings.matchMode,
            model: useLlm ? settings.model : undefined,
          },
          metadata: {
            copy_channel: channel,
            pasted_after_match: true,
            parameter_values: nextParamValues,
            rendered_from_llm: finalOutput !== locallyRendered,
          },
        })
        await pasteAfterLauncherHides()
      }
    } catch (error) {
      const fallback = fallbackTop[0]
      if (fallback) {
        setSelectedId(fallback.id)
        setParamValues({
          ...initialParamValues(fallback),
          ...inferParamValues(query, fallback),
        })
        setAiRenderedOutput('')
        setMode('render')
        const fallbackOutput = renderTemplate(fallback.template, {
          ...initialParamValues(fallback),
          ...inferParamValues(query, fallback),
        })
        recordSnippetUsageLog({
          action: 'snippet-match',
          selected: fallback,
          output: fallbackOutput,
          durationMs: Math.round(performance.now() - started),
          llm: {
            used: useLlm,
            matchMode: settings.matchMode,
            model: useLlm ? settings.model : undefined,
            error: error instanceof Error ? error.message : 'LLM failed',
          },
          metadata: {
            fallback: true,
            llm_candidate_order_popular: sortSnippetsForCandidateOrder(snippets, 'popular')
              .slice(0, MAX_USAGE_CANDIDATES)
              .map(snippetUsageRef),
          },
        })
        setToast({
          tone: 'warning',
          text:
            error instanceof Error
              ? `${error.message}. Used local match instead.`
              : 'LLM failed. Used local match instead.',
        })
        if (options.pasteAfterCopy) {
          const channel = await copyToClipboard(fallbackOutput)
          setSnippetUsage(fallback.id, targetAppRef.current)
          recordSnippetUsageLog({
            action: 'snippet-copy',
            selected: fallback,
            output: fallbackOutput,
            durationMs: Math.round(performance.now() - started),
            llm: {
              used: useLlm,
              matchMode: settings.matchMode,
              model: useLlm ? settings.model : undefined,
              error: error instanceof Error ? error.message : 'LLM failed',
            },
            metadata: {
              copy_channel: channel,
              fallback: true,
              pasted_after_match: true,
            },
          })
          await pasteAfterLauncherHides()
        }
      }
    } finally {
      setLlmLogs(loadLlmLogs())
      setAiBusy(false)
    }
  }

  async function handleAskLlm() {
    if (askBusyRef.current) return
    const question = askQuestion.trim()
    if (!question) {
      setToast({ tone: 'warning', text: 'Type a question first' })
      searchRef.current?.focus()
      return
    }
    if (!settings.llmEnabled) {
      setAskError('LLM is disabled. Turn it on in Settings to use Ask.')
      setToast({ tone: 'warning', text: 'LLM is disabled' })
      return
    }
    if (!settings.apiKey.trim()) {
      setAskError('Missing API key. Open Settings and choose a provider first.')
      setToast({ tone: 'warning', text: 'Missing API key' })
      return
    }

    askBusyRef.current = true
    const userMessage: AskChatMessage = {
      id: `ask-user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: 'user',
      content: question,
      createdAt: now(),
    }
    const contextMessages: ModelMessage[] = askMessages
      .slice(-ASK_CONTEXT_MESSAGES)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }))
    const messages: ModelMessage[] = [
      {
        role: 'system',
        content:
          'You are a compact desktop assistant inside a clipboard app. Answer the user directly. Be accurate, concise, and practical. Use code blocks for commands or code when helpful. Do not reveal hidden reasoning.',
      },
      ...contextMessages,
      { role: 'user', content: question },
    ]

    setAskBusy(true)
    setAskError('')
    setAskAnswer('')
    setAskQuestion('')
    setAskMessages((current) => [...current, userMessage].slice(-MAX_ASK_MESSAGES))
    try {
      let answer = ''
      if (askStreaming) {
        await requestModelTextStream(settings, 'ask-llm-stream', messages, (_delta, fullText) => {
          answer = fullText
          setAskAnswer(fullText)
        })
      } else {
        answer = await requestModelText(settings, 'ask-llm', messages)
        setAskAnswer(answer)
      }
      if (answer.trim()) {
        const assistantMessage: AskChatMessage = {
          id: `ask-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'assistant',
          content: answer,
          createdAt: now(),
        }
        setAskMessages((current) => [...current, assistantMessage].slice(-MAX_ASK_MESSAGES))
        setAskAnswer('')
      }
      setLlmLogs(loadLlmLogs())
    } catch (error) {
      setAskError(error instanceof Error ? error.message : 'LLM request failed')
    } finally {
      askBusyRef.current = false
      setAskBusy(false)
    }
  }

  function handleSaveDraft() {
    if (!draft) return
    const saved: Snippet = {
      ...draft,
      params: ensureParamDefs(draft),
      tags: draft.tags.map((tag) => tag.trim()).filter(Boolean),
      intents: draft.intents.map((intent) => intent.trim()).filter(Boolean),
      updatedAt: now(),
    }

    setSnippets((current) => {
      const exists = current.some((snippet) => snippet.id === saved.id)
      return exists
        ? current.map((snippet) => (snippet.id === saved.id ? saved : snippet))
        : [saved, ...current]
    })
    setSelectedId(saved.id)
    setAiRenderedOutput('')
    setMode('render')
    setToast({ tone: 'success', text: 'Snippet saved' })
  }

  function startSmartSnippetDraft(
    template: string,
    options?: { requireTemplate?: boolean; source?: SnippetDraftSource },
  ) {
    const trimmed = template.trim()
    if (options?.requireTemplate && !trimmed) {
      setToast({ tone: 'warning', text: 'Only text or file history can become a snippet' })
      return
    }

    const source = options?.source ?? 'manual'
    setAiRenderedOutput('')
    const nextDraft = blankSnippetFromTemplate(trimmed)
    setDraft(nextDraft)
    setSurface('snippets')
    setMode('edit')

    if (!nextDraft.template.trim()) return
    if (!isLlmAvailable(settings)) return

    setToast({ tone: 'neutral', text: 'Generating smart snippet...' })
    void classifySnippetWithLlm(settings, snippets, nextDraft, source)
      .then((classification) => {
        setDraft((current) => {
          if (!current || current.id !== nextDraft.id || current.template !== nextDraft.template) {
            return current
          }
          return applySnippetClassification(current, classification)
        })
        setToast({
          tone: 'success',
          text:
            classification.path_decision === 'create_new'
              ? 'Smart snippet generated in a new path'
              : 'Smart snippet generated',
        })
      })
      .catch((error) => {
        setToast({
          tone: 'warning',
          text:
            error instanceof Error
              ? `Smart snippet generation failed: ${error.message}`
              : 'Smart snippet generation failed',
        })
      })
      .finally(() => setLlmLogs(loadLlmLogs()))
  }

  function createDraft() {
    startSmartSnippetDraft(inferCommandFromQuery(query), { source: 'search_query' })
  }

  function createSnippetFromHistory(item: ClipboardHistoryItem) {
    startSmartSnippetDraft(itemToClipboardText(item), {
      requireTemplate: true,
      source: 'clipboard_history',
    })
  }

  function editSelected() {
    if (!selectedSnippet) return
    setAiRenderedOutput('')
    setDraft({ ...selectedSnippet, params: ensureParamDefs(selectedSnippet) })
    setMode('edit')
  }

  function toggleFavorite(snippetId: string) {
    setSnippets((current) =>
      current.map((snippet) =>
        snippet.id === snippetId
          ? { ...snippet, favorite: !snippet.favorite, updatedAt: now() }
          : snippet,
      ),
    )
  }

  function deleteSnippet(snippetId: string) {
    const snippet = snippets.find((item) => item.id === snippetId)
    if (!snippet) return
    if (!window.confirm(`Delete "${snippet.title}"?`)) return

    rememberDeletedSnippetId(snippetId)
    const nextSnippets = snippets.filter((item) => item.id !== snippetId)
    const replacement = nextSnippets[0]
    setSnippets(nextSnippets)
    setSelectedId(replacement?.id ?? '')
    setParamValues(initialParamValues(replacement))
    setAiRenderedOutput('')
    setMode('render')
    setToast({ tone: 'success', text: 'Snippet deleted' })
  }

  function handleClearLlmLogs() {
    clearLlmLogs()
    setLlmLogs([])
  }

  function handleClearUsageLogs() {
    clearUsageLogs()
    setUsageLogs([])
  }

  function moveHistorySelection(delta: number) {
    if (!rankedHistoryItems.length) return
    const currentIndex = Math.max(
      0,
      rankedHistoryItems.findIndex((item) => item.id === selectedHistoryItem?.id),
    )
    const nextIndex = Math.min(
      rankedHistoryItems.length - 1,
      Math.max(0, currentIndex + delta),
    )
    setSelectedHistoryId(rankedHistoryItems[nextIndex].id)
  }

  function moveSnippetSelection(delta: number) {
    if (!rankedSnippets.length) return
    const currentIndex = Math.max(
      0,
      rankedSnippets.findIndex((snippet) => snippet.id === selectedSnippet?.id),
    )
    const nextIndex = Math.min(
      rankedSnippets.length - 1,
      Math.max(0, currentIndex + delta),
    )
    selectSnippet(rankedSnippets[nextIndex].id)
  }

  function deleteHistoryItem(itemId: string) {
    setHistoryItems((current) => {
      const nextItems = current.filter((item) => item.id !== itemId)
      historyItemsRef.current = nextItems
      return nextItems
    })
    setSelectedHistoryId('')
    setToast({ tone: 'success', text: 'Removed from history' })
  }

  function clearUnstarredHistory() {
    setHistoryItems((current) => {
      const nextItems = current.filter((item) => item.pinned)
      historyItemsRef.current = nextItems
      return nextItems
    })
    setSelectedHistoryId('')
    setToast({ tone: 'success', text: 'Cleared unstarred history' })
  }

  function updateHistoryLimit(nextLimit: number) {
    const limit = normalizeHistoryLimit(nextLimit)
    setSettings((current) => ({ ...current, historyLimit: limit }))
    setHistoryItems((current) => {
      const nextItems = trimHistoryItems(current, limit)
      historyItemsRef.current = nextItems
      return nextItems
    })
    setSelectedHistoryId('')
    setToast({ tone: 'success', text: `Keeping ${limit} clipboard items` })
  }

  function toggleHistoryStar(itemId: string) {
    setHistoryItems((current) => {
      const nextItems = current.map((item) =>
        item.id === itemId ? { ...item, pinned: !item.pinned } : item,
      )
      historyItemsRef.current = nextItems
      return nextItems
    })
  }

  function updateHistoryItemContent(item: ClipboardHistoryItem, nextContent: string) {
    const timestamp = now()
    let updatedItem: ClipboardHistoryItem

    if (item.kind === 'file') {
      const files = nextContent
        .split(/\r?\n/)
        .map((file) => stripQuotes(file.trim()))
        .filter(Boolean)

      if (!files.length) {
        setToast({ tone: 'warning', text: 'File history needs at least one path' })
        return false
      }

      updatedItem = draftToHistoryItem(
        {
          kind: 'file',
          content: files.join('\n'),
          files,
          sourceApp: item.sourceApp,
          createdAt: item.createdAt,
        },
        timestamp,
      )
    } else if (item.kind === 'text') {
      if (!nextContent.trim()) {
        setToast({ tone: 'warning', text: 'Content cannot be empty' })
        return false
      }

      updatedItem = draftToHistoryItem(
        {
          kind: 'text',
          content: nextContent,
          sourceApp: item.sourceApp,
          createdAt: item.createdAt,
        },
        timestamp,
      )
    } else {
      setToast({ tone: 'warning', text: 'Image history is preview-only' })
      return false
    }

    const mergedItem = {
      ...updatedItem,
      id: item.id,
      pinned: item.pinned,
      copyCount: item.copyCount,
      sourceApp: item.sourceApp,
      createdAt: item.createdAt,
      updatedAt: timestamp,
    }
    const result = replaceHistoryItem(
      historyItemsRef.current,
      item.id,
      mergedItem,
      settings.historyLimit,
    )
    historyItemsRef.current = result.items
    setHistoryItems(result.items)
    setSelectedHistoryId(result.selectedId)
    setToast({ tone: 'success', text: 'History item updated' })
    return true
  }

  async function handleCopyHistoryItem(
    item: ClipboardHistoryItem,
    options: CopyActionOptions = {},
  ) {
    const started = performance.now()
    try {
      if (item.kind === 'file' && item.files?.length) {
        try {
          await writeClipboardFiles(item.files)
        } catch {
          await copyToClipboard(itemToClipboardText(item))
        }
      } else if (item.kind === 'image' && item.image) {
        const originalImage = item.image.rgbaBase64 || item.image.rgbaBytes
          ? item.image
          : await readOriginalImageFromIndexedDb(item.signature)
        const bytes = originalImage ? originalImageBytes(originalImage) : undefined
        if (!originalImage || !bytes) {
          throw new Error('Original image data is unavailable in this older history item')
        }
        const image = await TauriImage.new(
          bytes,
          originalImage.width ?? item.image.width,
          originalImage.height ?? item.image.height,
        )
        await writeImage(image)
      } else if (item.html) {
        try {
          await writeClipboardHtml(item.html, itemToClipboardText(item))
        } catch {
          await copyToClipboard(itemToClipboardText(item))
        }
      } else {
        await copyToClipboard(itemToClipboardText(item))
      }

      latestClipboardSignature.current = item.signature
      setHistoryItems((current) => {
        const nextItems = trimHistoryItems(
          recordHistoryItemCopied(current, item.id, now()),
          settings.historyLimit,
        )
        historyItemsRef.current = nextItems
        return nextItems
      })
      recordHistoryUsageLog(item, {
        durationMs: Math.round(performance.now() - started),
        metadata: {
          copy_kind: item.kind,
          content_type: item.contentType,
          has_html: Boolean(item.html),
          has_original_image: Boolean(
            item.image?.rgbaBase64 || item.image?.rgbaBytes || item.image?.originalByteLength,
          ),
          source_app: item.sourceApp,
        },
      })
      setToast({ tone: 'success', text: `Copied ${item.kind}` })
      if (options.pasteAfterCopy) {
        await pasteAfterLauncherHides()
      } else {
        await hideLauncherWindow()
      }
    } catch (error) {
      setToast({
        tone: 'warning',
        text: error instanceof Error ? error.message : 'Copy failed',
      })
    }
  }

  function startPanelDrag(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, select, a')) return
    event.preventDefault()
    void invoke('start_launcher_panel_drag')
      .catch(() => getCurrentWindow().startDragging())
      .catch(() => undefined)
  }

  const commandInputValue = surface === 'ask' ? askQuestion : query
  const commandInputPlaceholder =
    surface === 'history'
      ? 'Search clipboard history'
      : surface === 'ask'
        ? 'Ask LLM'
        : 'Ask for a command'

  return (
    <main className="app-shell">
      <section className="launcher">
        <div
          className="window-drag-strip window-drag-strip-top"
          onMouseDown={startPanelDrag}
        />
        <div
          className="window-drag-strip window-drag-strip-left"
          onMouseDown={startPanelDrag}
        />
        <div
          className="window-drag-strip window-drag-strip-right"
          onMouseDown={startPanelDrag}
        />
        <section className="command-row" data-tauri-drag-region onMouseDown={startPanelDrag}>
          <div className="search-box">
            {surface === 'ask' ? <MessageSquareText size={18} /> : <Search size={18} />}
            <input
              ref={searchRef}
              value={commandInputValue}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) =>
                surface === 'ask'
                  ? setAskQuestion(event.target.value)
                  : updateSearchQuery(event.target.value)
              }
              onCompositionEnd={() => {
                window.setTimeout(() => {
                  isComposingRef.current = false
                }, 0)
              }}
              onCompositionStart={() => {
                isComposingRef.current = true
              }}
              placeholder={commandInputPlaceholder}
            />
          </div>
          <div className="command-actions">
            <div className="surface-switch" role="tablist" aria-label="Clipboard mode">
              <button
                className={surface === 'history' ? 'active' : ''}
                type="button"
                onClick={() => setSurface('history')}
                title="Clipboard history"
              >
                <History size={17} />
              </button>
              <button
                className={surface === 'snippets' ? 'active' : ''}
                type="button"
                onClick={() => setSurface('snippets')}
                title="Smart snippets"
              >
                <Braces className="surface-switch-braces" size={17} />
              </button>
              <button
                className={surface === 'ask' ? 'active' : ''}
                type="button"
                onClick={() => setSurface('ask')}
                title="Ask LLM"
              >
                <MessageSquareText size={17} />
              </button>
            </div>
            {surface === 'ask' ? (
              <button
                className="ai-button"
                type="button"
                onClick={handleAskLlm}
                disabled={askBusy || !askQuestion.trim()}
                title="Ask LLM"
              >
                {askBusy ? <Sparkles size={17} /> : <MessageSquareText size={17} />}
                {askBusy ? 'Asking' : 'Ask'}
              </button>
            ) : surface === 'history' ? (
              <button
                className="ai-button"
                type="button"
                onClick={() =>
                  selectedHistoryItem && selectedHistoryCopyable
                    ? void handleCopyHistoryItem(selectedHistoryItem)
                    : undefined
                }
                disabled={!selectedHistoryItem || !selectedHistoryCopyable}
                title="Copy matched history item"
              >
                <Wand2 size={17} />
                Match
              </button>
            ) : (
              <button
                className="ai-button"
                type="button"
                onClick={() => void handleSmartMatch()}
                disabled={aiBusy}
                title="Match the best snippet"
              >
                {aiBusy ? <Sparkles size={17} /> : <Wand2 size={17} />}
                {aiBusy ? 'Matching' : 'Match'}
              </button>
            )}
            <button
              className="icon-button"
              type="button"
              onClick={() => {
                setLlmLogs(loadLlmLogs())
                setMode(mode === 'settings' ? 'render' : 'settings')
              }}
              title="Settings"
            >
              <SlidersHorizontal size={17} />
            </button>
            {surface === 'ask' ? (
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setAskMessages([])
                  setAskQuestion('')
                  setAskAnswer('')
                  setAskError('')
                  searchRef.current?.focus()
                }}
                title="New chat"
              >
                <RotateCcw size={17} />
              </button>
            ) : (
              <button
                className="icon-button"
                type="button"
                onClick={createDraft}
                title="Generate snippet from search"
              >
                <Plus size={18} />
              </button>
            )}
          </div>
        </section>

        {mode === 'settings' ? (
          <section className="single-panel">
            <SettingsPanel
              clipboardStorageUsage={clipboardStorageUsage}
              llmLogs={llmLogs}
              settings={settings}
              setSettings={setSettings}
              usageLogs={usageLogs}
              onClearHistory={clearUnstarredHistory}
              onClearLlmLogs={handleClearLlmLogs}
              onClearUsageLogs={handleClearUsageLogs}
              onHistoryLimitChange={updateHistoryLimit}
            />
          </section>
        ) : mode === 'edit' && draft ? (
          <section className="single-panel">
            <EditorPanel draft={draft} setDraft={setDraft} onSave={handleSaveDraft} />
          </section>
        ) : surface === 'ask' ? (
          <section className="single-panel ask-panel">
            <div className="ask-answer" ref={askScrollRef} aria-live="polite">
              {askMessages.length || askAnswer || askError ? (
                <div className="ask-transcript">
                  {askMessages.map((message) => (
                    <article className={`ask-message ${message.role}`} key={message.id}>
                      <span>{message.role === 'user' ? 'You' : 'LLM'}</span>
                      <MarkdownMessage content={message.content} />
                    </article>
                  ))}
                  {askAnswer ? (
                    <article className="ask-message assistant streaming">
                      <span>LLM</span>
                      <MarkdownMessage content={askAnswer} />
                    </article>
                  ) : null}
                  {askError ? <div className="ask-error">{askError}</div> : null}
                </div>
              ) : (
                <div className="empty-state">
                  {askBusy ? 'Waiting for the model...' : 'Ask a quick question, then follow up'}
                </div>
              )}
            </div>
          </section>
        ) : surface === 'history' ? (
          <div className="launcher-grid">
            <section className="snippet-list" aria-label="Clipboard history">
              <div className="list-scroll">
                {rankedHistoryItems.map((item) => (
                  <div
                    className={
                      [
                        'snippet-row',
                        'history-row',
                        item.kind === 'text' ? 'history-row-text' : '',
                        item.pinned ? 'starred' : '',
                        item.id === selectedHistoryItem?.id ? 'active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                    }
                    key={item.id}
                    ref={(element) => {
                      if (element) historyRowRefs.current.set(item.id, element)
                      else historyRowRefs.current.delete(item.id)
                    }}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedHistoryId(item.id)}
                    onDoubleClick={() => void handleCopyHistoryItem(item)}
                  >
                    <span
                      className={[
                        'snippet-icon',
                        'history-icon',
                        item.kind === 'image' ? 'history-icon-image' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {item.kind === 'image' && item.image?.previewDataUrl ? (
                        <img alt="" className="history-thumb" src={item.image.previewDataUrl} />
                      ) : item.kind === 'image' ? (
                        <ImageIcon size={16} />
                      ) : item.kind === 'file' ? (
                        <FileText size={16} />
                      ) : item.contentType === 'json' ? (
                        <Braces size={16} />
                      ) : item.contentType === 'code' ? (
                        <TerminalSquare size={16} />
                      ) : item.contentType === 'api-key' || item.contentType === 'jwt' ? (
                        <KeyRound size={16} />
                      ) : (
                        <Clipboard size={16} />
                      )}
                    </span>
                    <span className="snippet-main">
                      <span className="snippet-title">{item.title}</span>
                      {historyListMeta(item) ? (
                        <span className="snippet-meta">{historyListMeta(item)}</span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="detail-pane">
              {selectedHistoryItem ? (
                <HistoryPanel
                  key={selectedHistoryItem.id}
                  item={selectedHistoryItem}
                  onCreateSnippet={createSnippetFromHistory}
                  onCopy={handleCopyHistoryItem}
                  onDelete={deleteHistoryItem}
                  onToggleStar={toggleHistoryStar}
                  onUpdateContent={updateHistoryItemContent}
                />
              ) : (
                <div className="empty-state">Copy text, images, or file paths to build history</div>
              )}
            </section>
          </div>
        ) : (
          <div className="launcher-grid">
            <section className="snippet-list" aria-label="Snippets">
              <div className="list-scroll">
                {rankedSnippets.map((snippet) => (
                  <div
                    className={
                      [
                        'snippet-row',
                        'snippet-row-snippet',
                        snippet.favorite ? 'starred' : '',
                        snippet.id === selectedSnippet?.id ? 'active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                    }
                    key={snippet.id}
                    ref={(element) => {
                      if (element) snippetRowRefs.current.set(snippet.id, element)
                      else snippetRowRefs.current.delete(snippet.id)
                    }}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectSnippet(snippet.id)}
                  >
                    <span className="snippet-icon">
                      {snippet.path.startsWith('Shell') ? (
                        <TerminalSquare size={16} />
                      ) : snippet.path.startsWith('SQL') ? (
                        <Database size={16} />
                      ) : snippet.path.startsWith('Prompts') ? (
                        <Braces size={16} />
                      ) : (
                        <MessageSquareText size={16} />
                      )}
                    </span>
                    <span className="snippet-main">
                      <span className="snippet-title">{snippet.title}</span>
                      <span className="snippet-meta">
                        {snippet.path} · {snippet.tags.slice(0, 3).join(', ')}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="detail-pane">
              {selectedSnippet ? (
                <RenderPanel
                  paramValues={paramValues}
                  rendered={finalRendered}
                  selectedParams={selectedParams}
                  snippet={selectedSnippet}
                  setParamValues={setParamValues}
                  setAiRenderedOutput={setAiRenderedOutput}
                  onCopy={handleCopy}
                  onDelete={deleteSnippet}
                  onEdit={editSelected}
                  onToggleFavorite={toggleFavorite}
                />
              ) : (
                <div className="empty-state">No snippet selected</div>
              )}
            </section>
          </div>
        )}

        {toast.tone !== 'neutral' ? (
          <div className={`toast ${toast.tone}`} role="status">
            {toast.tone === 'success' ? <Check size={15} /> : <Clipboard size={15} />}
            <span>{toast.text}</span>
          </div>
        ) : null}
      </section>
    </main>
  )
}

type SettingsPanelProps = {
  clipboardStorageUsage: ClipboardStorageUsage
  llmLogs: LlmLogEntry[]
  settings: SettingsState
  setSettings: Dispatch<SetStateAction<SettingsState>>
  usageLogs: UsageLogEntry[]
  onClearHistory: () => void
  onClearLlmLogs: () => void
  onClearUsageLogs: () => void
  onHistoryLimitChange: (limit: number) => void
}

type HistoryPanelProps = {
  item: ClipboardHistoryItem
  onCreateSnippet: (item: ClipboardHistoryItem) => void
  onCopy: (item: ClipboardHistoryItem) => void
  onDelete: (id: string) => void
  onToggleStar: (id: string) => void
  onUpdateContent: (item: ClipboardHistoryItem, nextContent: string) => boolean
}

function HistoryPanel({
  item,
  onCreateSnippet,
  onCopy,
  onDelete,
  onToggleStar,
  onUpdateContent,
}: HistoryPanelProps) {
  const [draftContent, setDraftContent] = useState(() => itemToClipboardText(item))
  const [isEditing, setIsEditing] = useState(false)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const saveEditingRef = useRef<() => boolean>(() => false)
  const canCopy = item.kind !== 'image' || Boolean(item.image)
  const canCreateSnippet = Boolean(itemToClipboardText(item).trim())
  const canEdit = item.kind === 'text' || item.kind === 'file'

  function startEditing() {
    if (!canEdit) return
    setDraftContent(itemToClipboardText(item))
    setIsEditing(true)
  }

  function cancelEditing() {
    setDraftContent(itemToClipboardText(item))
    setIsEditing(false)
  }

  const saveEditing = useCallback(() => {
    if (onUpdateContent(item, draftContent)) {
      setIsEditing(false)
      return true
    }
    return false
  }, [draftContent, item, onUpdateContent])

  useEffect(() => {
    saveEditingRef.current = saveEditing
  }, [saveEditing])

  useEffect(() => {
    if (!isEditing) return undefined

    const finishOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && editorRef.current?.contains(target)) return
      if (!saveEditingRef.current()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    document.addEventListener('pointerdown', finishOnOutsideClick, true)
    return () => document.removeEventListener('pointerdown', finishOnOutsideClick, true)
  }, [isEditing])

  return (
    <div className="panel render-panel history-render-panel">
      <div className="history-panel-head">
        {item.kind === 'text' ? null : (
          <div className="history-panel-title">
            <span>{historyTypeLabel(item).toUpperCase()}</span>
            <h2>{item.title}</h2>
          </div>
        )}
        <div className="panel-actions history-panel-actions">
          {item.kind === 'image' ? null : (
            <button
              type="button"
              onClick={() => onCreateSnippet(item)}
              disabled={!canCreateSnippet}
              title={
                canCreateSnippet
                  ? 'Add as snippet'
                  : 'Only text or file history can become a snippet'
              }
            >
              <Plus size={16} />
            </button>
          )}
          <button
            className="primary-icon"
            type="button"
            onClick={() => onCopy(item)}
            disabled={!canCopy}
            title={canCopy ? 'Copy' : 'Original unavailable'}
          >
            <Copy size={16} />
          </button>
          <button
            type="button"
            onClick={() => onToggleStar(item.id)}
            title={item.pinned ? 'Unstar' : 'Star'}
          >
            <Star size={16} fill={item.pinned ? 'currentColor' : 'none'} />
          </button>
          <button type="button" onClick={() => onDelete(item.id)} title="Delete">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <section className="preview-section history-preview">
        {isEditing ? (
          <div className="history-editor" ref={editorRef}>
            <textarea
              aria-label="Edit clipboard history content"
              autoFocus
              className="history-edit-textarea"
              spellCheck={false}
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  event.stopPropagation()
                  saveEditing()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelEditing()
                }
              }}
            />
            <div className="history-edit-actions">
              <span className="history-edit-hint">Cmd+Enter to save</span>
              <button type="button" onClick={cancelEditing}>
                Cancel
              </button>
              <button className="primary-icon" type="button" onClick={saveEditing}>
                <Save size={15} />
                Save
              </button>
            </div>
          </div>
        ) : item.kind === 'image' && item.image ? (
          <div className="image-preview">
            {item.image.previewDataUrl ? (
              <img alt={item.title} src={item.image.previewDataUrl} />
            ) : (
              <ImageIcon size={44} />
            )}
            <span>
              {item.image.width} × {item.image.height}
            </span>
          </div>
        ) : item.kind === 'file' ? (
          <div
            className="file-preview editable-history-preview"
            role="button"
            tabIndex={0}
            onClick={startEditing}
            onKeyDown={(event) => {
              if (event.key === 'Enter') startEditing()
            }}
          >
            {(item.files ?? []).map((file) => (
              <code key={file}>{file}</code>
            ))}
          </div>
        ) : (
          <pre
            className="editable-history-preview"
            role="button"
            tabIndex={0}
            onClick={startEditing}
            onKeyDown={(event) => {
              if (event.key === 'Enter') startEditing()
            }}
          >
            {item.content}
          </pre>
        )}
      </section>
    </div>
  )
}

function SettingsPanel({
  clipboardStorageUsage,
  llmLogs,
  settings,
  setSettings,
  usageLogs,
  onClearHistory,
  onClearLlmLogs,
  onClearUsageLogs,
  onHistoryLimitChange,
}: SettingsPanelProps) {
  const activeProvider = providerOption(settings)
  const isDevBuild = import.meta.env.DEV
  const [historyLimitDraft, setHistoryLimitDraft] = useState<string | null>(null)
  const skipNextHistoryLimitBlurRef = useRef(false)
  const historyLimitInputValue = historyLimitDraft ?? String(settings.historyLimit)

  function commitHistoryLimit() {
    const nextLimit = commitHistoryLimitDraft(historyLimitInputValue, settings.historyLimit)
    setHistoryLimitDraft(null)
    if (nextLimit !== settings.historyLimit) {
      onHistoryLimitChange(nextLimit)
    }
  }

  return (
    <div className="panel settings-panel">
      <div className="panel-head">
        <div>
          <span>Settings</span>
          <h2>LLM settings</h2>
        </div>
      </div>

      <div className="provider-url-grid">
        <label className="field">
          <span>Provider</span>
          <select
            value={activeProvider}
            onChange={(event) => {
              const value = event.target.value as ProviderOption
              if (value === 'custom') {
                setSettings((current) => ({
                  ...current,
                  baseUrl: '',
                  model: '',
                }))
                return
              }
              setSettings((current) => ({
                ...current,
                ...providerPresets[value],
                apiKey: current.apiKey,
              }))
            }}
          >
            {providerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            value={settings.baseUrl}
            onChange={(event) =>
              setSettings((current) => ({ ...current, baseUrl: event.target.value }))
            }
          />
        </label>
      </div>

      <label className="field">
        <span>API key</span>
        <input
          type="password"
          value={settings.apiKey}
          onChange={(event) =>
            setSettings((current) => ({ ...current, apiKey: event.target.value }))
          }
          placeholder="Stored locally on this device"
        />
      </label>

      <label className="field">
        <span>Model</span>
        <input
          value={settings.model}
          onChange={(event) =>
            setSettings((current) => ({ ...current, model: event.target.value }))
          }
        />
      </label>

      <label className="toggle-line">
        <input
          type="checkbox"
          checked={settings.llmEnabled}
          onChange={(event) =>
            setSettings((current) => ({ ...current, llmEnabled: event.target.checked }))
          }
        />
        <span>Enable LLM for Ask and smart snippet generation</span>
      </label>

      <label className="toggle-line">
        <input
          type="checkbox"
          checked={settings.llmMatchEnabled}
          onChange={(event) =>
            setSettings((current) => ({ ...current, llmMatchEnabled: event.target.checked }))
          }
        />
        <span>Use LLM for Match</span>
      </label>

      <div className="segmented-field">
        <span>LLM 速度</span>
        <div className="speed-options" role="radiogroup" aria-label="LLM speed">
          {matchModeOptions.map((option) => (
            <button
              aria-checked={settings.matchMode === option.value}
              className={settings.matchMode === option.value ? 'active' : ''}
              key={option.value}
              onClick={() =>
                setSettings((current) => ({
                  ...current,
                  matchMode: option.value,
                }))
              }
              role="radio"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-note compact">
        <Sparkles size={16} />
        <p>
          {settings.llmMatchEnabled
            ? 'Match 会调用模型；从左到右通常更稳，但会更慢。'
            : settings.llmEnabled
              ? 'Match 默认使用本地搜索；Ask 仍可使用 LLM。'
              : 'LLM 功能已关闭；Match 使用本地搜索。'}
        </p>
      </div>

      <label className="toggle-line">
        <input
          type="checkbox"
          checked={settings.thinkingMode === 'enabled'}
          onChange={(event) =>
            setSettings((current) => ({
              ...current,
              thinkingMode: event.target.checked ? 'enabled' : 'disabled',
            }))
          }
        />
        <span>Thinking / reasoning mode</span>
      </label>

      <label className="toggle-line">
        <input
          type="checkbox"
          checked={settings.autoCopy}
          onChange={(event) =>
            setSettings((current) => ({ ...current, autoCopy: event.target.checked }))
          }
        />
        <span>Copy rendered output after confirmation</span>
      </label>

      <div className="settings-note">
        <Sparkles size={16} />
        <p>
          Typing always uses local lightweight search. Match uses local results unless
          LLM Match is enabled above.
        </p>
      </div>

      <section className="llm-log-section">
        <div className="section-title">
          <span>Clipboard history</span>
          <button type="button" onClick={onClearHistory}>
            Clear unstarred
          </button>
        </div>
        <div className="clipboard-storage-card">
          <label className="history-limit-control">
            <span>Keep</span>
            <input
              type="number"
              min={MIN_HISTORY_LIMIT}
              max={MAX_HISTORY_LIMIT}
              step={10}
              value={historyLimitInputValue}
              onChange={(event) => setHistoryLimitDraft(event.target.value)}
              onBlur={() => {
                if (skipNextHistoryLimitBlurRef.current) {
                  skipNextHistoryLimitBlurRef.current = false
                  return
                }
                commitHistoryLimit()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  skipNextHistoryLimitBlurRef.current = true
                  commitHistoryLimit()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  skipNextHistoryLimitBlurRef.current = true
                  setHistoryLimitDraft(null)
                  event.currentTarget.blur()
                }
              }}
            />
            <span>items</span>
          </label>
          <div className="storage-usage">
            <strong>{formatBytes(clipboardStorageUsage.totalBytes)}</strong>
            <span>
              {clipboardStorageUsage.itemCount} saved
              {clipboardStorageUsage.itemCount > settings.historyLimit
                ? ` · ${clipboardStorageUsage.itemCount - settings.historyLimit} starred over limit`
                : ''}
            </span>
            <span>
              {formatBytes(clipboardStorageUsage.metadataBytes)} metadata
              {clipboardStorageUsage.imageBytes
                ? ` · ${clipboardStorageUsage.originalImageCount} originals ${formatBytes(clipboardStorageUsage.imageBytes)}`
                : ''}
            </span>
          </div>
        </div>
      </section>

      <section className="llm-log-section">
        <div className="section-title">
          <span>App</span>
          <button type="button" onClick={() => void invoke('quit_app')}>
            Quit Cliboard
          </button>
        </div>
      </section>

      {isDevBuild ? (
        <>
          <section className="llm-log-section">
            <div className="section-title">
              <span>Usage tuning log</span>
              <button type="button" onClick={onClearUsageLogs} disabled={!usageLogs.length}>
                Clear
              </button>
            </div>
            {usageLogs.length ? (
              <div className="llm-log-list">
                {usageLogs.slice(0, 30).map((entry) => (
                  <details className="llm-log-entry" key={entry.id}>
                    <summary>
                      <span>
                        {entry.surface}/{entry.action}
                      </span>
                      <time>
                        {entry.durationMs !== undefined ? `${entry.durationMs}ms · ` : ''}
                        {entry.llm.used ? 'LLM · ' : 'local · '}
                        {entry.ranks.initialRank ? `initial #${entry.ranks.initialRank} · ` : ''}
                        {entry.ranks.finalRank ? `final #${entry.ranks.finalRank} · ` : ''}
                        {new Date(entry.createdAt).toLocaleTimeString()}
                      </time>
                    </summary>
                    <div className="llm-log-block">
                      <strong>Query and selected</strong>
                      <pre>
                        {JSON.stringify({
                          query: entry.query,
                          selected: entry.selected,
                          ranks: entry.ranks,
                          llm: entry.llm,
                          target_app: entry.targetApp,
                        }, null, 2)}
                      </pre>
                    </div>
                    <div className="llm-log-block">
                      <strong>Candidate order</strong>
                      <pre>{JSON.stringify(entry.candidates, null, 2)}</pre>
                    </div>
                    {entry.metadata ? (
                      <div className="llm-log-block">
                        <strong>Metadata</strong>
                        <pre>{JSON.stringify(entry.metadata, null, 2)}</pre>
                      </div>
                    ) : null}
                  </details>
                ))}
              </div>
            ) : (
              <div className="llm-log-empty">No usage events yet</div>
            )}
          </section>

          <section className="llm-log-section">
            <div className="section-title">
              <span>LLM request log</span>
              <button type="button" onClick={onClearLlmLogs} disabled={!llmLogs.length}>
                Clear
              </button>
            </div>
            {llmLogs.length ? (
              <div className="llm-log-list">
                {llmLogs.map((entry) => (
                  <details className="llm-log-entry" key={entry.id}>
                    <summary>
                      <span>{entry.operation}</span>
                      <time>
                        {entry.durationMs !== undefined ? `${entry.durationMs}ms · ` : ''}
                        {formatTokenUsage(entry.usage) ? `${formatTokenUsage(entry.usage)} · ` : ''}
                        {new Date(entry.createdAt).toLocaleTimeString()}
                      </time>
                    </summary>
                    <div className="llm-log-block">
                      <strong>Input</strong>
                      <pre>{JSON.stringify(entry.input, null, 2)}</pre>
                    </div>
                    <div className="llm-log-block">
                      <strong>{entry.error ? 'Error' : 'Output'}</strong>
                      <pre>
                        {JSON.stringify(
                          entry.error ? { error: entry.error } : entry.output,
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  </details>
                ))}
              </div>
            ) : (
              <div className="llm-log-empty">No LLM requests yet</div>
            )}
          </section>
        </>
      ) : null}
    </div>
  )
}

type EditorPanelProps = {
  draft: Snippet
  setDraft: Dispatch<SetStateAction<Snippet | null>>
  onSave: () => void
}

function EditorPanel({ draft, setDraft, onSave }: EditorPanelProps) {
  const params = extractParams(draft.template)

  function patch(value: Partial<Snippet>) {
    setDraft((current) => (current ? { ...current, ...value } : current))
  }

  return (
    <div className="panel editor-panel">
      <div className="panel-head">
        <div>
          <span>Snippet</span>
          <h2>Edit template</h2>
        </div>
        <button className="primary-icon" type="button" onClick={onSave} title="Save">
          <Save size={16} />
        </button>
      </div>

      <div className="two-fields">
        <label className="field">
          <span>Title</span>
          <input value={draft.title} onChange={(event) => patch({ title: event.target.value })} />
        </label>
        <label className="field">
          <span>Path</span>
          <input value={draft.path} onChange={(event) => patch({ path: event.target.value })} />
        </label>
      </div>

      <label className="field">
        <span>Description</span>
        <input
          value={draft.description}
          onChange={(event) => patch({ description: event.target.value })}
          placeholder="What this snippet does"
        />
      </label>

      <label className="field">
        <span>Template</span>
        <textarea
          className="template-edit"
          value={draft.template}
          onChange={(event) => patch({ template: event.target.value })}
          placeholder="Use {{param_name}} for dynamic fields"
        />
      </label>

      <div className="two-fields">
        <label className="field">
          <span>Tags</span>
          <input
            value={draft.tags.join(', ')}
            onChange={(event) =>
              patch({ tags: event.target.value.split(',').map((tag) => tag.trim()) })
            }
            placeholder="git, debug, shell"
          />
        </label>
        <label className="field">
          <span>Intents</span>
          <input
            value={draft.intents.join(', ')}
            onChange={(event) =>
              patch({ intents: event.target.value.split(',').map((intent) => intent.trim()) })
            }
            placeholder="natural language aliases"
          />
        </label>
      </div>

      <div className="param-detection">
        <strong>Detected params</strong>
        <span>{params.length ? params.join(', ') : 'None yet'}</span>
      </div>
    </div>
  )
}

type RenderPanelProps = {
  snippet: Snippet
  selectedParams: Record<string, ParamDef>
  paramValues: Record<string, string>
  rendered: string
  setParamValues: Dispatch<SetStateAction<Record<string, string>>>
  setAiRenderedOutput: Dispatch<SetStateAction<string>>
  onCopy: () => void
  onDelete: (id: string) => void
  onEdit: () => void
  onToggleFavorite: (id: string) => void
}

function RenderPanel({
  snippet,
  selectedParams,
  paramValues,
  rendered,
  setParamValues,
  setAiRenderedOutput,
  onCopy,
  onDelete,
  onEdit,
  onToggleFavorite,
}: RenderPanelProps) {
  return (
    <div className="panel render-panel">
      <div className="panel-head">
        <div>
          <span>{snippet.path}</span>
          <h2>{snippet.title}</h2>
        </div>
        <div className="panel-actions">
          <button className="primary-icon" type="button" onClick={onCopy} title="Copy output">
            <Copy size={16} />
          </button>
          <button type="button" onClick={onEdit} title="Edit snippet">
            <Pencil size={16} />
          </button>
          <button
            type="button"
            onClick={() => onToggleFavorite(snippet.id)}
            title={snippet.favorite ? 'Unstar' : 'Star'}
          >
            <Star size={16} fill={snippet.favorite ? 'currentColor' : 'none'} />
          </button>
          <button type="button" onClick={() => onDelete(snippet.id)} title="Delete snippet">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <section className="param-section">
        <div className="param-grid">
          {Object.entries(selectedParams).map(([key, def]) => (
            <label className="field" key={key}>
              <span>
                {def.label ?? key}
                {def.required ? <em>*</em> : null}
              </span>
              <input
                value={paramValues[key] ?? ''}
                onChange={(event) =>
                  setParamValues((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
                onInput={() => setAiRenderedOutput('')}
                placeholder={def.placeholder ?? def.default ?? key}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="preview-section">
        <div className="section-title">
          <span>Rendered output</span>
        </div>
        <pre>{rendered || 'Fill the required parameters to preview output.'}</pre>
      </section>

    </div>
  )
}

export default App
