import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const STEPFUN_API_KEY = process.env.STEPFUN_API_KEY ?? ''
const GLM_API_KEY = process.env.GLM_API_KEY ?? ''
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY ?? ''
const XIAOMI_API_KEY = process.env.XIAOMI_API_KEY ?? ''

const now = () => new Date().toISOString()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const requestTimeoutMs = Number(process.env.LLM_EVAL_TIMEOUT_MS ?? 120_000)

const providers = {
  deepseek: {
    name: 'DeepSeek',
    apiKey: DEEPSEEK_API_KEY,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    responseFormat: true,
    requestExtras: { thinking: { type: 'disabled' } },
  },
  stepfun: {
    name: 'StepFun',
    apiKey: STEPFUN_API_KEY,
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-3.5-flash',
    responseFormat: false,
    requestExtras: {},
    minIntervalMs: 6500,
    systemPrefix:
      'Do not reason step by step. Answer directly with the requested JSON only. ',
  },
  glm: {
    name: 'GLM-4.7-Flash',
    apiKey: GLM_API_KEY,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    responseFormat: true,
    requestExtras: { thinking: { type: 'disabled' } },
  },
  qwen: {
    name: 'Qwen3.6-Flash',
    apiKey: DASHSCOPE_API_KEY,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.6-flash',
    responseFormat: true,
    requestExtras: { enable_thinking: false },
  },
  xiaomi: {
    name: 'Xiaomi-MiMo-V2-Flash',
    apiKey: XIAOMI_API_KEY,
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'xiaomi/mimo-v2-flash',
    responseFormat: true,
    requestExtras: { thinking: { type: 'disabled' } },
  },
}

const providerLimiters = new Map()

const modes = ['local', 'turbo', 'direct', 'direct-vote', 'candidate-vote', 'batch']

function seedSnippets() {
  const stamp = now()
  return [
    {
      id: 'git-amend-no-edit',
      title: 'Amend latest commit',
      path: 'Shell/Git',
      description: '把当前暂存区合并到最后一次 commit，不改 commit message。',
      template: 'git add {{files}}\ngit commit --amend --no-edit',
      tags: ['git', 'commit', 'amend'],
      intents: ['fix latest commit', 'amend commit', 'add files to previous commit'],
      params: {
        files: { default: '.', required: true },
      },
      favorite: true,
      useCount: 6,
      createdAt: stamp,
      updatedAt: stamp,
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
        base_branch: { default: 'main', required: true },
      },
      useCount: 4,
      createdAt: stamp,
      updatedAt: stamp,
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
        pod: { required: true },
        namespace: { default: 'default', required: true },
        shell: { default: '/bin/sh', required: true },
      },
      favorite: true,
      useCount: 12,
      createdAt: stamp,
      updatedAt: stamp,
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
        service: { required: true },
        local_port: { default: '8080', required: true },
        remote_port: { default: '80', required: true },
        namespace: { default: 'default', required: true },
      },
      useCount: 7,
      createdAt: stamp,
      updatedAt: stamp,
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
        tail: { default: '200', required: true },
        service: { required: true },
      },
      useCount: 9,
      createdAt: stamp,
      updatedAt: stamp,
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
        source_job_run_id: { required: true },
        caption: { default: 'vllm_019_ascend_fork_8', required: true },
      },
      favorite: true,
      useCount: 8,
      createdAt: stamp,
      updatedAt: stamp,
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
        model_id: { required: true },
        local_dir: { default: '~/models', required: true },
        resume_download_flag: { default: '', required: false },
      },
      useCount: 2,
      createdAt: stamp,
      updatedAt: stamp,
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
        minutes: { default: '5', required: true },
      },
      useCount: 3,
      createdAt: stamp,
      updatedAt: stamp,
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
        context: { default: 'This is a focused implementation patch.', required: true },
        patch: { required: true },
      },
      useCount: 5,
      createdAt: stamp,
      updatedAt: stamp,
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
        name: { required: true },
        focus: { default: 'the behavior and test coverage', required: true },
      },
      useCount: 2,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]
}

function makeDistractors(count = 360) {
  const stamp = now()
  const domains = [
    ['Shell/Git', 'git', ['commit', 'branch', 'stash', 'bisect', 'tag', 'diff']],
    ['Shell/Kubernetes', 'kubectl', ['logs', 'describe', 'rollout', 'scale', 'top', 'cp']],
    ['Shell/Docker', 'docker', ['build', 'push', 'prune', 'inspect', 'network', 'volume']],
    ['Shell/HuggingFace', 'huggingface', ['upload', 'scan-cache', 'login', 'repo create', 'whoami']],
    ['Shell/Merlin', 'bytedcli merlin', ['job list', 'job stop', 'job logs', 'job status']],
    ['SQL/Postgres', 'postgres', ['vacuum', 'index size', 'connections', 'locks']],
    ['Writing/PR', 'writing', ['release note', 'standup', 'handoff', 'review reply']],
    ['Prompts/Agents', 'prompt', ['planner', 'debugger', 'summarizer', 'critic']],
  ]

  const distractors = []
  for (let i = 0; i < count; i += 1) {
    const [pathName, prefix, actions] = domains[i % domains.length]
    const action = actions[i % actions.length]
    const nearMiss =
      i % 29 === 0
        ? {
            path: 'Shell/HuggingFace',
            title: 'Download model from ModelScope',
            template: 'modelscope download --model {{model_id}} --local_dir {{local_dir}}',
            tags: ['modelscope', 'download', 'model'],
            intents: ['download model', '下载模型', 'model download'],
          }
        : i % 31 === 0
          ? {
              path: 'Shell/Merlin',
              title: 'Inspect Merlin job run',
              template: 'bytedcli merlin job describe --job-run-id {{job_run_id}}',
              tags: ['bytedcli', 'merlin', 'job'],
              intents: ['merlin job', '查看 merlin job', 'job run details'],
            }
          : null
    const title = nearMiss?.title ?? `${titleCase(action)} helper ${i}`
    const template = nearMiss?.template ?? `${prefix} ${action} {{target_${i % 5}}}`
    distractors.push({
      id: `distractor-${String(i).padStart(3, '0')}`,
      title,
      path: nearMiss?.path ?? pathName,
      description: `Synthetic distractor ${i} for ${pathName}; similar metadata but not the expected answer.`,
      template,
      tags: nearMiss?.tags ?? [prefix.split(' ')[0], action.split(' ')[0], `noise-${i % 17}`],
      intents: nearMiss?.intents ?? [
        `${prefix} ${action}`,
        `${action} command`,
        i % 9 === 0 ? 'download model' : 'routine helper',
      ],
      params: inferParamsFromTemplate(template),
      favorite: i % 53 === 0,
      useCount: i % 23,
      createdAt: stamp,
      updatedAt: stamp,
    })
  }
  return distractors
}

function titleCase(text) {
  return text.replace(/\b\w/g, (char) => char.toUpperCase())
}

function inferParamsFromTemplate(template) {
  return Object.fromEntries(
    Array.from(template.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)).map((match) => [
      match[1],
      { required: true },
    ]),
  )
}

const cases = [
  {
    id: 'hf-deepseek-resume',
    query: '下载deepseek-merlin模型，增加恢复下载功能',
    expectedId: 'huggingface-download',
    mustInclude: ['huggingface-cli download', 'deepseek', '--resume-download'],
  },
  {
    id: 'hf-qwen-command',
    query:
      'huggingface-cli download Qwen/Qwen2-7B-Instruct --local-dir ~/models/models--Qwen--Qwen2-7B-Instruct',
    expectedId: 'huggingface-download',
    mustInclude: ['Qwen/Qwen2-7B-Instruct', '--local-dir'],
  },
  {
    id: 'hf-qwen-resume-natural',
    query: '下载 Qwen/Qwen2-7B-Instruct 到 ~/models/qwen2 并开启断点续传',
    expectedId: 'huggingface-download',
    mustInclude: ['Qwen/Qwen2-7B-Instruct', '~/models/qwen2', '--resume-download'],
  },
  {
    id: 'merlin-default-caption',
    query: '在 merlin 上 fork abcde 这个 job',
    expectedId: 'bytedcli-merlin-job-fork-run',
    mustInclude: ['bytedcli merlin job fork-run', 'abcde', 'vllm_019_ascend_fork_8'],
  },
  {
    id: 'merlin-custom-caption',
    query: 'fork 一个merlin job，12321322，命名为vllm_1233',
    expectedId: 'bytedcli-merlin-job-fork-run',
    mustInclude: ['12321322', 'vllm_1233'],
  },
  {
    id: 'kubectl-exec',
    query: '进入 prod namespace 里的 api-7d96f9 pod，用 bash',
    expectedId: 'kubectl-exec-pod',
    mustInclude: ['kubectl exec', 'api-7d96f9', 'prod'],
  },
  {
    id: 'kubectl-port-forward',
    query: '把 k8s service api 在 prod 里映射到本地 18080，远端 8080',
    expectedId: 'kubectl-port-forward',
    mustInclude: ['kubectl port-forward', 'api', '18080:8080', 'prod'],
  },
  {
    id: 'docker-tail',
    query: '看 docker compose 里 worker 服务最近 500 行日志并持续 follow',
    expectedId: 'docker-tail-service',
    mustInclude: ['docker compose logs', 'worker', '500'],
  },
  {
    id: 'git-amend',
    query: '把 src/App.tsx 加到上一个 commit，不改 message',
    expectedId: 'git-amend-no-edit',
    mustInclude: ['git add', 'src/App.tsx', 'git commit --amend --no-edit'],
  },
  {
    id: 'git-rebase',
    query: '我想相对 develop 交互式整理当前分支提交',
    expectedId: 'git-rebase-main',
    mustInclude: ['git rebase -i', 'develop'],
  },
  {
    id: 'sql-slow',
    query: '查 postgres 里超过 15 分钟还在跑的 SQL',
    expectedId: 'sql-find-long-running',
    mustInclude: ['pg_stat_activity', '15 minutes'],
  },
  {
    id: 'pr-followup',
    query: '礼貌催 Alex review，重点看行为和测试覆盖',
    expectedId: 'writing-pr-followup',
    mustInclude: ['Alex', 'behavior and test coverage'],
  },
  {
    id: 'code-review-prompt',
    query: '给我一个 focused code review prompt，关注回归风险和 missing tests',
    expectedId: 'prompt-code-review',
    mustInclude: ['Review this change', 'missing tests'],
  },
]

function extractParams(template) {
  return Array.from(new Set(Array.from(template.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)).map((m) => m[1])))
}

function ensureParamDefs(snippet) {
  const params = { ...snippet.params }
  for (const name of extractParams(snippet.template)) {
    params[name] ??= { required: true }
  }
  return params
}

function renderTemplate(template, values) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => values[key] ?? '')
}

function snippetFullCandidateCard(snippet) {
  return {
    id: snippet.id,
    title: snippet.title,
    path: snippet.path,
    description: snippet.description,
    tags: snippet.tags,
    intents: snippet.intents,
    params: ensureParamDefs(snippet),
    favorite: Boolean(snippet.favorite),
    useCount: snippet.useCount,
    template: snippet.template,
  }
}

function snippetCandidateCard(snippet) {
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

function sortSnippetsForCandidateOrder(snippets, order = 'forward') {
  const sorted = [...snippets].sort((left, right) => {
    if (order === 'popular') {
      const usage = right.useCount - left.useCount
      if (usage !== 0) return usage
      if (Boolean(right.favorite) !== Boolean(left.favorite)) return right.favorite ? 1 : -1
    }
    const pathOrder = left.path.localeCompare(right.path)
    if (pathOrder !== 0) return pathOrder
    return left.title.localeCompare(right.title)
  })
  if (order === 'reverse') sorted.reverse()
  return sorted
}

function buildFullCandidateTree(snippets, order = 'forward') {
  const groups = []
  for (const snippet of sortSnippetsForCandidateOrder(snippets, order)) {
    const last = groups[groups.length - 1]
    const card = snippetFullCandidateCard(snippet)
    if (last?.path === snippet.path) last.candidates.push(card)
    else groups.push({ path: snippet.path, candidates: [card] })
  }
  return groups
}

function buildTreeCandidateBatches(snippets, batchSize = 50, order = 'forward') {
  const sorted = sortSnippetsForCandidateOrder(snippets, order)
  const batches = []
  let currentGroups = []
  let currentCount = 0
  for (const snippet of sorted) {
    if (currentCount >= batchSize) {
      batches.push({ groups: currentGroups })
      currentGroups = []
      currentCount = 0
    }
    const card = snippetCandidateCard(snippet)
    const last = currentGroups[currentGroups.length - 1]
    if (last?.path === snippet.path && currentCount < batchSize) last.candidates.push(card)
    else currentGroups.push({ path: snippet.path, candidates: [card] })
    currentCount += 1
  }
  if (currentGroups.length) batches.push({ groups: currentGroups })
  return batches
}

function normalizeResponse(response, fallbackReason) {
  const selected = response.selected ?? {
    id: response.id ?? '',
    parameter_values: response.parameter_values,
  }
  return {
    id: selected.id ?? '',
    parameter_values: selected.parameter_values ?? {},
    reason: response.reason ?? fallbackReason,
    output: response.output ?? response.final_output ?? response.text ?? selected.output ?? '',
    raw: response,
  }
}

function parseJsonFromModel(content) {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return JSON.parse(fenced[1])
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error(`Model response was not JSON: ${trimmed.slice(0, 500)}`)
  }
}

async function requestModelJson(provider, operation, messages) {
  return withProviderLimit(provider, () => requestModelJsonNow(provider, operation, messages))
}

async function withProviderLimit(provider, task) {
  const minIntervalMs = provider.minIntervalMs ?? 0
  if (!minIntervalMs) return task()

  const previous = providerLimiters.get(provider.name) ?? Promise.resolve()
  let release
  const current = new Promise((resolve) => {
    release = resolve
  })
  providerLimiters.set(provider.name, previous.then(() => current))

  await previous
  try {
    return await task()
  } finally {
    setTimeout(release, minIntervalMs)
  }
}

async function requestModelJsonNow(provider, operation, messages) {
  const finalMessages = provider.systemPrefix
    ? messages.map((message, index) =>
        index === 0 && message.role === 'system'
          ? { ...message, content: `${provider.systemPrefix}${message.content}` }
          : message,
      )
    : messages
  const body = {
    model: provider.model,
    ...(provider.responseFormat ? { response_format: { type: 'json_object' } } : {}),
    ...provider.requestExtras,
    messages: finalMessages,
    max_tokens: 4096,
    temperature: 0.1,
  }
  let response
  let payload
  let responseText = ''
  let start = performance.now()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    start = performance.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      responseText = await response.text()
      try {
        payload = JSON.parse(responseText)
      } catch {
        payload = { raw: responseText }
      }
    } finally {
      clearTimeout(timeout)
    }
    if (response.status !== 429) break
    const waitMs = 30_000 * (attempt + 1)
    console.log(`rate limited by ${provider.name}; waiting ${waitMs}ms before retry`)
    await delay(waitMs)
  }
  const durationMs = Math.round(performance.now() - start)
  if (!response.ok) {
    throw new Error(`${provider.name} ${operation} failed ${response.status}: ${JSON.stringify(payload.error ?? payload).slice(0, 500)}`)
  }
  const message = payload.choices?.[0]?.message ?? {}
  const content = message.content ?? ''
  if (!content) throw new Error(`${provider.name} ${operation} returned empty content`)
  return {
    parsed: parseJsonFromModel(content),
    content,
    reasoning: message.reasoning ?? message.reasoning_content,
    usage: payload.usage,
    durationMs,
    operation,
    promptTokens: payload.usage?.prompt_tokens,
    completionTokens: payload.usage?.completion_tokens,
    totalTokens: payload.usage?.total_tokens,
  }
}

async function askTurbo(query, snippets, provider) {
  const response = await requestModelJson(provider, 'turbo-direct-match', [
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
  return { match: normalizeResponse(response.parsed, 'Turbo match'), calls: [response] }
}

async function askDirect(query, snippets, provider, order = 'forward', operation = 'direct-match') {
  const response = await requestModelJson(provider, operation, [
    {
      role: 'system',
      content:
        'Directly choose and render one reusable clipboard snippet. Inspect all tree-grouped candidates in order, choose exactly one final snippet, extract parameter values, and produce the exact final clipboard output. Do not list plausible candidates. Return exactly one JSON object with this schema: {"reason":string,"selected":{"id":string,"parameter_values":object},"output":string}. Put reason before answer fields. Do not put reason inside selected. Use only provided candidate ids. The output must be exact text to copy. Apply requested command modifications such as adding flags or changing options even when the template has no placeholder. Do not include markdown or extra keys.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        raw_query: query,
        candidate_order: order,
        candidate_tree: buildFullCandidateTree(snippets, order),
      }),
    },
  ])
  return { match: normalizeResponse(response.parsed, `Direct ${order}`), calls: [response] }
}

async function askAllInOne(query, snippets, provider, order = 'forward', operation = 'all-in-one-match') {
  const response = await requestModelJson(provider, operation, [
    {
      role: 'system',
      content:
        'You are selecting and rendering one reusable clipboard snippet. Inspect all tree-grouped candidates in order. First identify up to 10 plausible candidates, then choose exactly one final snippet, extract parameter values, and produce the exact final clipboard output. Return exactly one JSON object with this schema: {"reason":string,"candidates":[{"reason":string,"id":string,"parameter_values":object}],"selected":{"id":string,"parameter_values":object},"output":string}. Put reason before answer fields. Do not put reason inside selected. Use only provided candidate ids. The output must be exact text to copy. Apply requested command modifications such as adding flags or changing options even when the template has no placeholder. Do not include markdown or extra keys.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        raw_query: query,
        candidate_order: order,
        candidate_tree: buildFullCandidateTree(snippets, order),
      }),
    },
  ])
  return { match: normalizeResponse(response.parsed, `Candidate ${order}`), calls: [response] }
}

function chooseVotedMatch(results) {
  const byId = new Map()
  for (const result of results) {
    if (!result.match.id) continue
    byId.set(result.match.id, [...(byId.get(result.match.id) ?? []), result.match])
  }
  const ranked = Array.from(byId.entries()).sort(([, left], [, right]) => right.length - left.length)
  const [winnerId, winnerMatches] = ranked[0] ?? []
  if (!winnerId || !winnerMatches?.length) throw new Error('vote returned no match')
  return {
    ...winnerMatches[0],
    voteCount: winnerMatches.length,
    alternatives: ranked.slice(1).map(([id, matches]) => ({ id, votes: matches.length })),
  }
}

async function askDirectVote(query, snippets, provider) {
  const results = await Promise.all(
    ['forward', 'reverse', 'popular'].map((order) =>
      askDirect(query, snippets, provider, order, `direct-vote-${order}`),
    ),
  )
  return { match: chooseVotedMatch(results), calls: results.flatMap((result) => result.calls) }
}

async function askCandidateVote(query, snippets, provider) {
  const results = await Promise.all(
    ['forward', 'reverse', 'popular'].map((order) =>
      askAllInOne(query, snippets, provider, order, `candidate-vote-${order}`),
    ),
  )
  return { match: chooseVotedMatch(results), calls: results.flatMap((result) => result.calls) }
}

async function askBatch(query, snippets, provider) {
  const batchCalls = []
  const batchRequests = ['forward', 'reverse'].flatMap((order) =>
    buildTreeCandidateBatches(snippets, 50, order).map(async (batch) => {
      const response = await requestModelJson(provider, 'batch-match-candidates', [
        {
          role: 'system',
          content:
            'Select reusable clipboard snippet candidates from a tree-structured candidate list. Use only the provided ids. Return exactly one JSON object with this schema: {"matches":[{"reason":string,"id":string,"parameter_values":object}]}. Return up to 5 matches. Put reason before the answer id. Extract parameters directly from the user request with the LLM. If no candidate is plausible, return {"matches":[]}. Do not include markdown or extra keys.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            raw_query: query,
            candidate_order: order,
            candidate_tree: batch.groups,
          }),
        },
      ])
      batchCalls.push(response)
      return response.parsed.matches ?? response.parsed.candidates ?? []
    }),
  )
  const matches = (await Promise.all(batchRequests)).flat()
  const finalistIds = new Set(matches.map((match) => match.id).filter(Boolean))
  if (!finalistIds.size) throw new Error('batch returned no finalist')
  const finalists = snippets
    .filter((snippet) => finalistIds.has(snippet.id))
    .map((snippet) => ({
      ...snippetFullCandidateCard(snippet),
      batch_notes: matches
        .filter((match) => match.id === snippet.id)
        .map((match) => ({
          reason: match.reason,
          parameter_values: match.parameter_values,
        })),
    }))
  const final = await requestModelJson(provider, 'choose-and-finalize-snippet', [
    {
      role: 'system',
      content:
        'Choose the single best reusable clipboard snippet from the finalists and produce the final clipboard output in the same response. Use only a provided id. Return exactly one JSON object with this schema: {"reason":string,"selected":{"id":string,"parameter_values":object},"output":string}. Put reason before answer fields. Do not put reason inside selected. Extract parameter_values directly from the user request. For CLI-style flags, return full flag tokens when the template expects a flag value. The output must be exact text to copy and may include requested flags or option changes even when the template did not have a placeholder. Do not include markdown or extra keys.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        raw_query: query,
        finalists,
      }),
    },
  ])
  return { match: normalizeResponse(final.parsed, 'Batch finalist'), calls: [...batchCalls, final] }
}

function tokenize(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}_/-]+/gu) ?? []
}

function localScore(snippet, query) {
  const tokens = tokenize(query)
  const title = snippet.title.toLowerCase()
  const pathName = snippet.path.toLowerCase()
  const haystack = [
    snippet.title,
    snippet.path,
    snippet.description,
    snippet.template,
    ...snippet.tags,
    ...snippet.intents,
  ]
    .join(' ')
    .toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (title.includes(token)) score += 30
    if (pathName.includes(token)) score += 18
    if (haystack.includes(token)) score += 8
  }
  score += Math.min(snippet.useCount, 10)
  if (snippet.favorite) score += 6
  return score
}

function inferLocalValues(query, snippet) {
  const values = Object.fromEntries(
    Object.entries(ensureParamDefs(snippet)).map(([key, param]) => [key, param.default ?? '']),
  )
  if (snippet.id === 'bytedcli-merlin-job-fork-run') {
    const id =
      query.match(/--source-job-run-id\s+([^\s"']+)/i)?.[1] ??
      query.match(/(?:job|run|任务)[^\w-]+([a-zA-Z0-9][a-zA-Z0-9_-]{3,})/i)?.[1] ??
      query.match(/([a-zA-Z0-9][a-zA-Z0-9_-]{3,})\s*(?:这个|的)?\s*(?:job|run|任务)/i)?.[1]
    const caption = query.match(/(?:命名为|命名成|caption\s*(?:为|是)?|named)\s*["']?([a-zA-Z0-9_.-]+)/i)?.[1]
    if (id) values.source_job_run_id = id
    if (caption) values.caption = caption
  }
  if (snippet.id === 'huggingface-download') {
    const model = query.match(/huggingface[-\s]?cli\s+download\s+(".*?"|'.*?'|\S+)/i)?.[1] ??
      query.match(/(?:下载|download)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)?.[1]
    const localDir = query.match(/--local-dir\s+([^\s"']+)/i)?.[1] ??
      query.match(/(?:到|to)\s+(~?\/[^\s]+)/i)?.[1]
    if (model) values.model_id = model.replace(/^["']|["']$/g, '')
    if (localDir) values.local_dir = localDir
    if (/(恢复下载|断点续传|resume)/i.test(query)) values.resume_download_flag = '--resume-download'
  }
  return values
}

function askLocal(query, snippets) {
  const start = performance.now()
  const ranked = [...snippets]
    .map((snippet) => ({ snippet, score: localScore(snippet, query) }))
    .sort((left, right) => right.score - left.score)
  const winner = ranked[0]?.snippet
  if (!winner) throw new Error('no snippets')
  const values = inferLocalValues(query, winner)
  return {
    match: {
      id: winner.id,
      parameter_values: values,
      output: renderTemplate(winner.template, values),
      score: ranked[0].score,
    },
    calls: [{ durationMs: Math.round(performance.now() - start), usage: {} }],
  }
}

async function evaluateCase({ provider, mode, testCase, snippets }) {
  const start = performance.now()
  try {
    let result
    if (mode === 'local') result = askLocal(testCase.query, snippets)
    else if (mode === 'turbo') result = await askTurbo(testCase.query, snippets, provider)
    else if (mode === 'direct') result = await askDirect(testCase.query, snippets, provider)
    else if (mode === 'direct-vote') result = await askDirectVote(testCase.query, snippets, provider)
    else if (mode === 'candidate-vote') result = await askCandidateVote(testCase.query, snippets, provider)
    else if (mode === 'batch') result = await askBatch(testCase.query, snippets, provider)
    else throw new Error(`unknown mode ${mode}`)

    const output = result.match.output ?? ''
    const idCorrect = result.match.id === testCase.expectedId
    const outputCorrect = (testCase.mustInclude ?? []).every((needle) =>
      output.toLowerCase().includes(needle.toLowerCase()),
    )
    const calls = result.calls ?? []
    const usage = sumUsage(calls)
    return {
      caseId: testCase.id,
      query: testCase.query,
      expectedId: testCase.expectedId,
      selectedId: result.match.id,
      idCorrect,
      outputCorrect,
      correct: idCorrect && outputCorrect,
      output,
      raw: result.match.raw,
      durationMs: Math.round(performance.now() - start),
      callCount: calls.length,
      usage,
      callDurationMs: calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0),
      error: null,
    }
  } catch (error) {
    return {
      caseId: testCase.id,
      query: testCase.query,
      expectedId: testCase.expectedId,
      selectedId: '',
      idCorrect: false,
      outputCorrect: false,
      correct: false,
      output: '',
      raw: null,
      durationMs: Math.round(performance.now() - start),
      callCount: 0,
      usage: {},
      callDurationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function sumUsage(calls) {
  return calls.reduce(
    (acc, call) => ({
      prompt_tokens: acc.prompt_tokens + (call.usage?.prompt_tokens ?? 0),
      completion_tokens: acc.completion_tokens + (call.usage?.completion_tokens ?? 0),
      total_tokens: acc.total_tokens + (call.usage?.total_tokens ?? 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  )
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function summarize(results) {
  const groups = new Map()
  for (const result of results) {
    const key = `${result.provider}/${result.mode}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  return Array.from(groups.entries()).map(([key, items]) => {
    const [provider, mode] = key.split('/')
    const durations = items.map((item) => item.durationMs)
    const callDurations = items.map((item) => item.callDurationMs ?? 0)
    const totalTokens = items.reduce((sum, item) => sum + (item.usage.total_tokens ?? 0), 0)
    const promptTokens = items.reduce((sum, item) => sum + (item.usage.prompt_tokens ?? 0), 0)
    const completionTokens = items.reduce((sum, item) => sum + (item.usage.completion_tokens ?? 0), 0)
    return {
      provider,
      mode,
      cases: items.length,
      correct: items.filter((item) => item.correct).length,
      idCorrect: items.filter((item) => item.idCorrect).length,
      outputCorrect: items.filter((item) => item.outputCorrect).length,
      accuracy: round(items.filter((item) => item.correct).length / items.length),
      idAccuracy: round(items.filter((item) => item.idCorrect).length / items.length),
      outputAccuracy: round(items.filter((item) => item.outputCorrect).length / items.length),
      avgMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      avgCallMs: Math.round(callDurations.reduce((sum, value) => sum + value, 0) / callDurations.length),
      p95CallMs: percentile(callDurations, 95),
      avgCalls: round(items.reduce((sum, item) => sum + item.callCount, 0) / items.length),
      totalTokens,
      avgTokens: Math.round(totalTokens / items.length),
      promptTokens,
      completionTokens,
      errors: items.filter((item) => item.error).length,
    }
  })
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function markdownReport({ summary, results, meta }) {
  const lines = [
    '# Cliboard LLM Match Evaluation',
    '',
    `- Generated at: ${meta.generatedAt}`,
    `- Snippets: ${meta.snippetCount} total (${meta.distractorCount} synthetic distractors)`,
    `- Cases: ${meta.caseCount}`,
    `- Batch cases per provider: ${meta.batchCaseCount}`,
    '- Avg ms/P95 ms are case wall-clock times; Avg call ms/P95 call ms sum per-request durations inside a case, so vote/batch concurrency is visible.',
    '',
    '## Summary',
    '',
    '| Provider | Mode | Cases | Accuracy | ID Acc | Output Acc | Avg ms | P95 ms | Avg call ms | P95 call ms | Avg calls | Avg tokens | Errors |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...summary.map((item) =>
      [
        item.provider,
        item.mode,
        item.cases,
        item.accuracy,
        item.idAccuracy,
        item.outputAccuracy,
        item.avgMs,
        item.p95Ms,
        item.avgCallMs,
        item.p95CallMs,
        item.avgCalls,
        item.avgTokens,
        item.errors,
      ].join(' | '),
    ).map((row) => `| ${row} |`),
    '',
    '## Failures',
    '',
  ]
  const failures = results.filter((item) => !item.correct)
  if (!failures.length) {
    lines.push('No failures.')
  } else {
    for (const failure of failures.slice(0, 60)) {
      lines.push(
        `- ${failure.provider}/${failure.mode}/${failure.caseId}: expected ${failure.expectedId}, got ${failure.selectedId || 'none'}, id=${failure.idCorrect}, output=${failure.outputCorrect}, ${failure.durationMs}ms${failure.error ? `, error=${failure.error}` : ''}`,
      )
      if (failure.output) lines.push(`  - output: \`${failure.output.replaceAll('\n', '\\n').slice(0, 260)}\``)
    }
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const full = process.argv.includes('--full')
  const quick = process.argv.includes('--quick')
  const providersArg = process.argv.find((arg) => arg.startsWith('--providers='))
  const modesArg = process.argv.find((arg) => arg.startsWith('--modes='))
  const providerNames = providersArg
    ? providersArg.split('=')[1].split(',').map((item) => item.trim()).filter(Boolean)
    : process.argv.includes('--deepseek-only')
    ? ['deepseek']
    : process.argv.includes('--stepfun-only')
      ? ['stepfun']
      : ['deepseek', 'stepfun']
  const modeNames = modesArg
    ? modesArg.split('=')[1].split(',').map((item) => item.trim()).filter(Boolean)
    : quick
      ? ['local', 'turbo', 'direct']
      : modes
  const snippets = [...seedSnippets(), ...makeDistractors(full ? 520 : 360)]
  const batchCases = full ? cases : cases.slice(0, quick ? 2 : 5)
  const results = []

  console.log(`Eval snippets=${snippets.length}, cases=${cases.length}, modes=${modeNames.join(',')}`)
  for (const mode of modeNames) {
    const providerLoop = mode === 'local' ? ['local'] : providerNames
    for (const providerName of providerLoop) {
      const provider = providers[providerName]
      const selectedCases =
        mode === 'batch' && providerName === 'stepfun' && !full
          ? batchCases.slice(0, quick ? 1 : 2)
          : mode === 'batch'
            ? batchCases
            : cases
      for (const testCase of selectedCases) {
        const label = `${provider?.name ?? 'Local'}/${mode}/${testCase.id}`
        process.stdout.write(`${label} ... `)
        const result = await evaluateCase({
          provider,
          mode,
          testCase,
          snippets,
        })
        const row = {
          provider: provider?.name ?? 'Local',
          mode,
          ...result,
        }
        results.push(row)
        console.log(`${row.correct ? 'ok' : 'fail'} ${row.durationMs}ms ${row.selectedId || row.error}`)
        if (mode !== 'local') await delay(150)
      }
    }
  }

  const summary = summarize(results)
  const meta = {
    generatedAt: now(),
    snippetCount: snippets.length,
    distractorCount: snippets.length - seedSnippets().length,
    caseCount: cases.length,
    batchCaseCount: batchCases.length,
  }
  const outDir = path.resolve('eval-results')
  await fs.mkdir(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = path.join(outDir, `llm-match-${stamp}.json`)
  const mdPath = path.join(outDir, `llm-match-${stamp}.md`)
  await fs.writeFile(jsonPath, JSON.stringify({ meta, summary, results }, null, 2))
  await fs.writeFile(mdPath, markdownReport({ meta, summary, results }))
  console.table(summary)
  console.log(`Wrote ${jsonPath}`)
  console.log(`Wrote ${mdPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
