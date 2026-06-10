import { describe, expect, it } from 'vitest'
import {
  contextTreeBoost,
  domainIntentBoost,
  hybridScore,
  keywordScore,
  localSimilarityScore,
  type SearchableSnippet,
} from './snippetSearch'

type ScoreFn = (snippet: SearchableSnippet, query: string) => number

function snippet(
  id: string,
  title: string,
  path: string,
  description: string,
  template: string,
  tags: string[],
  intents: string[],
  useCount = 0,
): SearchableSnippet {
  return { id, title, path, description, template, tags, intents, useCount }
}

const coreSnippets = [
  snippet(
    'hf-download',
    'Download from Hugging Face',
    'Shell/HuggingFace',
    'Download a model checkpoint to a local directory, optionally with resume.',
    'huggingface-cli download {{model_id}} --local-dir {{local_dir}} {{resume_download_flag}}',
    ['huggingface', 'hf', 'download', 'model', 'checkpoint'],
    ['download huggingface model', 'download model weights', '恢复下载', 'resume download'],
    4,
  ),
  snippet(
    'hf-upload',
    'Upload model to Hugging Face',
    'Shell/HuggingFace',
    'Upload a local model directory to a Hugging Face repository.',
    'huggingface-cli upload {{repo_id}} {{local_path}}',
    ['huggingface', 'hf', 'upload', 'model'],
    ['upload huggingface model', 'push model weights'],
    2,
  ),
  snippet(
    'hf-login',
    'Log in to Hugging Face CLI',
    'Shell/HuggingFace',
    'Authenticate huggingface-cli before download or upload.',
    'huggingface-cli login --token {{token}}',
    ['huggingface', 'hf', 'login', 'auth'],
    ['huggingface auth login', 'set hf token'],
    1,
  ),
  snippet(
    'curl-download',
    'Download URL with curl',
    'Shell/Network',
    'Download a URL to a local file with retry and resume.',
    'curl -L -C - -o {{output}} {{url}}',
    ['curl', 'download', 'url', 'resume'],
    ['download url', 'resume file download'],
    3,
  ),
  snippet(
    'model-list',
    'List local model cache',
    'Shell/Models',
    'Show locally cached model directories and disk usage.',
    'du -sh ~/models/* | sort -h',
    ['model', 'cache', 'disk'],
    ['list local models', 'inspect model cache'],
  ),
  snippet(
    'merlin-fork',
    'Fork a Merlin job run',
    'Shell/Merlin',
    'Fork a Merlin job run from a source run id and optional caption.',
    'bytedcli merlin job fork-run --source-job-run-id {{source_job_run_id}} --caption "{{caption}}"',
    ['bytedcli', 'merlin', 'fork-run', 'job'],
    ['fork merlin job', 'rerun merlin job', 'copy merlin task', '在 merlin 上 fork job'],
    8,
  ),
  snippet(
    'merlin-list',
    'List Merlin job runs',
    'Shell/Merlin',
    'List recent Merlin job runs and their ids.',
    'bytedcli merlin job list --limit {{limit}}',
    ['bytedcli', 'merlin', 'job', 'list'],
    ['list merlin jobs', 'show merlin runs'],
    5,
  ),
  snippet(
    'merlin-cancel',
    'Cancel Merlin job run',
    'Shell/Merlin',
    'Cancel a running Merlin job by run id.',
    'bytedcli merlin job cancel --job-run-id {{job_run_id}}',
    ['bytedcli', 'merlin', 'job', 'cancel'],
    ['stop merlin job', 'kill merlin run'],
    2,
  ),
  snippet(
    'kubectl-exec',
    'Exec into a Kubernetes pod',
    'Shell/Kubernetes',
    'Open an interactive shell in a Kubernetes pod.',
    'kubectl exec -it {{pod}} -n {{namespace}} -- {{shell}}',
    ['kubectl', 'k8s', 'pod', 'exec', 'debug'],
    ['enter pod', 'debug container shell', '进入 pod', 'attach to pod'],
    10,
  ),
  snippet(
    'kubectl-logs',
    'Tail Kubernetes pod logs',
    'Shell/Kubernetes',
    'Follow logs for a Kubernetes pod or container.',
    'kubectl logs -f {{pod}} -n {{namespace}} --tail={{tail}}',
    ['kubectl', 'k8s', 'pod', 'logs', 'debug'],
    ['tail pod logs', '查看 pod 日志', 'debug k8s logs'],
    7,
  ),
  snippet(
    'kubectl-port-forward',
    'Port-forward a Kubernetes service',
    'Shell/Kubernetes',
    'Forward a Kubernetes service port to localhost.',
    'kubectl port-forward svc/{{service}} {{local_port}}:{{remote_port}} -n {{namespace}}',
    ['kubectl', 'k8s', 'port-forward', 'service'],
    ['forward service', 'open k8s service locally', '端口转发 service'],
    6,
  ),
  snippet(
    'ssh-port-forward',
    'Open SSH tunnel',
    'Shell/SSH',
    'Forward a remote TCP port through SSH.',
    'ssh -N -L {{local_port}}:{{host}}:{{remote_port}} {{user}}@{{bastion}}',
    ['ssh', 'port-forward', 'tunnel'],
    ['ssh tunnel', 'forward remote port'],
    4,
  ),
  snippet(
    'docker-logs',
    'Tail Docker Compose logs',
    'Shell/Docker',
    'Tail recent Docker Compose service logs.',
    'docker compose logs -f --tail {{tail}} {{service}}',
    ['docker', 'compose', 'logs', 'debug'],
    ['watch service logs', '查看容器日志', 'tail compose service output'],
    6,
  ),
  snippet(
    'git-amend',
    'Amend latest commit',
    'Shell/Git',
    'Amend staged changes into the latest commit without editing message.',
    'git add {{files}} && git commit --amend --no-edit',
    ['git', 'commit', 'amend'],
    ['fix latest commit', '修改最后一次提交', 'previous commit unchanged message'],
    7,
  ),
  snippet(
    'git-commit',
    'Create git commit',
    'Shell/Git',
    'Create a normal git commit with a message.',
    'git add {{files}} && git commit -m "{{message}}"',
    ['git', 'commit'],
    ['new commit', 'commit with message'],
    5,
  ),
  snippet(
    'git-rebase',
    'Interactive rebase from main',
    'Shell/Git',
    'Clean up branch history with interactive rebase.',
    'git fetch origin && git rebase -i origin/{{base_branch}}',
    ['git', 'rebase', 'history', 'squash'],
    ['squash commits', '整理提交历史', 'clean branch history'],
    4,
  ),
  snippet(
    'review-prompt',
    'Focused code review prompt',
    'Prompts/Code Review',
    'Ask an LLM to review code by risk priority.',
    'Please review this patch for correctness, regressions, and missing tests. Context: {{context}} Patch: {{patch}}',
    ['prompt', 'review', 'code', 'patch'],
    ['review code', 'find bugs in diff', '代码变更风险检查'],
    5,
  ),
  snippet(
    'pr-follow-up',
    'Polite PR follow-up',
    'Writing/PR',
    'Ask for PR review politely.',
    'Hi {{name}}, gentle ping on this PR when you have a moment. The main thing I need eyes on is {{focus}}. Thanks!',
    ['writing', 'review', 'follow-up', 'pr'],
    ['polite reminder', '催 review', 'ask teammate for review'],
    3,
  ),
  snippet(
    'release-notes',
    'Draft release notes',
    'Writing/Release',
    'Turn merged changes into concise release notes.',
    'Draft release notes from these changes: {{changes}}',
    ['writing', 'release', 'notes'],
    ['summarize release', 'write changelog'],
  ),
]

function confusableDistractors(count: number) {
  const domains = [
    'Shell/HuggingFace',
    'Shell/Merlin',
    'Shell/Kubernetes',
    'Shell/Git',
    'Writing/PR',
    'Prompts/Code Review',
  ]
  const nouns = ['model', 'job', 'pod', 'commit', 'review', 'service', 'logs', 'caption']
  const verbs = ['inspect', 'copy', 'resume', 'tail', 'rename', 'summarize', 'open', 'sync']
  return Array.from({ length: count }, (_, index) => {
    const domain = domains[index % domains.length]
    const verb = verbs[index % verbs.length]
    const noun = nouns[(index * 3) % nouns.length]
    return snippet(
      `confuser-${index}`,
      `${verb} ${noun} helper ${index}`,
      domain,
      `Confusing helper about ${noun}, ${verb}, review, logs, model, job, and service.`,
      `${verb}-helper --${noun} item-${index} --mode dry-run`,
      [verb, noun, 'helper', `tag-${index % 23}`],
      [`${verb} ${noun}`, `generic ${domain} task`, 'review model job logs'],
      index % 4,
    )
  })
}

const hardCases = [
  ['下载 deepseek 权重到 ~/models', 'hf-download'],
  ['恢复下载 Qwen checkpoint，不要上传', 'hf-download'],
  ['hf token 登录', 'hf-login'],
  ['把本地模型推到 huggingface repo', 'hf-upload'],
  ['列一下本地模型缓存大小', 'model-list'],
  ['用 curl 断点续传一个 URL 文件', 'curl-download'],
  ['fork merlin run 123 并改 caption', 'merlin-fork'],
  ['merlin 最近的 job run id 列出来', 'merlin-list'],
  ['停止 merlin 运行中的任务', 'merlin-cancel'],
  ['进入 k8s pod 里开 shell', 'kubectl-exec'],
  ['看 pod 最新日志，不是 docker compose', 'kubectl-logs'],
  ['把 k8s service 端口映射到本地', 'kubectl-port-forward'],
  ['ssh 隧道转发远端端口', 'ssh-port-forward'],
  ['docker compose 某个服务持续日志', 'docker-logs'],
  ['把 staged 变更塞进上一个 commit，不改 message', 'git-amend'],
  ['创建一个新的 git commit message', 'git-commit'],
  ['整理分支提交历史 squash', 'git-rebase'],
  ['让 LLM 检查 diff 里的 bug 和回归', 'review-prompt'],
  ['温和催同事看 PR，不要做代码审查', 'pr-follow-up'],
  ['根据 merged changes 写 release notes', 'release-notes'],
  ['caption 是 vllm_123 的 merlin fork', 'merlin-fork'],
  ['reviewer reminder for pull request', 'pr-follow-up'],
  ['debug container shell in namespace', 'kubectl-exec'],
  ['tail compose logs for api service', 'docker-logs'],
  ['port forward svc but via kubectl', 'kubectl-port-forward'],
] as const

const scoreVariants: Array<{ name: string; score: ScoreFn }> = [
  { name: 'keyword-only', score: keywordScore },
  { name: 'local-similarity-only', score: localSimilarityScore },
  { name: 'tree-only', score: contextTreeBoost },
  { name: 'intent-only', score: domainIntentBoost },
  {
    name: 'keyword+tree',
    score: (snippet, query) => keywordScore(snippet, query) + contextTreeBoost(snippet, query),
  },
  {
    name: 'no-keyword',
    score: (snippet, query) =>
      localSimilarityScore(snippet, query) + contextTreeBoost(snippet, query) + domainIntentBoost(snippet, query),
  },
  {
    name: 'no-local-similarity',
    score: (snippet, query) =>
      keywordScore(snippet, query) + contextTreeBoost(snippet, query) + domainIntentBoost(snippet, query),
  },
  {
    name: 'no-tree',
    score: (snippet, query) =>
      keywordScore(snippet, query) + localSimilarityScore(snippet, query) + domainIntentBoost(snippet, query),
  },
  {
    name: 'no-intent',
    score: (snippet, query) =>
      keywordScore(snippet, query) + localSimilarityScore(snippet, query) + contextTreeBoost(snippet, query),
  },
  { name: 'full-hybrid', score: hybridScore },
]

function rankWithScore<T extends SearchableSnippet>(snippets: T[], query: string, score: ScoreFn) {
  return snippets
    .map((snippet) => ({ snippet, score: score(snippet, query) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return left.snippet.id.localeCompare(right.snippet.id)
    })
    .map((item) => item.snippet)
}

function summarize(results: Array<{ top1: boolean; top3: boolean; top10: boolean; ms: number }>) {
  const sorted = [...results].sort((left, right) => left.ms - right.ms)
  return {
    top1: results.filter((item) => item.top1).length,
    top3: results.filter((item) => item.top3).length,
    top10: results.filter((item) => item.top10).length,
    total: results.length,
    avgMs: results.reduce((sum, item) => sum + item.ms, 0) / results.length,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)]?.ms ?? 0,
  }
}

function misses(
  results: Array<{ query: string; expected: string; top10Ids: string[]; top1: boolean }>,
) {
  return results
    .filter((item) => !item.top1)
    .map(({ query, expected, top10Ids }) => ({
      query,
      expected,
      top1: top10Ids[0],
      rank: top10Ids.indexOf(expected) + 1 || 'miss',
      top10: top10Ids.join(', '),
    }))
}

describe('hard local search evaluation', () => {
  it('measures component ablations on confusable snippets', () => {
    const snippets = [...coreSnippets, ...confusableDistractors(600)]
    const rows = scoreVariants.map((variant) => {
      const results = hardCases.map(([query, expected]) => {
        const started = performance.now()
        const ranked = rankWithScore(snippets, query, variant.score)
        const ms = performance.now() - started
        const top3Ids = ranked.slice(0, 3).map((snippet) => snippet.id)
        const top10Ids = ranked.slice(0, 10).map((snippet) => snippet.id)
        return {
          query,
          expected,
          top1: top3Ids[0] === expected,
          top3: top3Ids.includes(expected),
          top10: top10Ids.includes(expected),
          top3Ids,
          top10Ids,
          ms,
        }
      })
      if (variant.name === 'full-hybrid') console.table(misses(results))
      return { method: variant.name, ...summarize(results) }
    })

    console.table(rows)

    const byMethod = new Map(rows.map((row) => [row.method, row]))
    expect(byMethod.get('full-hybrid')?.top1).toBeGreaterThanOrEqual(18)
    expect(byMethod.get('full-hybrid')?.top3).toBeGreaterThanOrEqual(23)
    expect(byMethod.get('full-hybrid')?.top10).toBe(hardCases.length)
    expect(byMethod.get('full-hybrid')?.avgMs).toBeLessThan(50)
    expect(byMethod.get('no-keyword')?.top1).toBeLessThan(byMethod.get('full-hybrid')?.top1 ?? 0)
    expect(byMethod.get('local-similarity-only')?.top1).toBeLessThan(byMethod.get('full-hybrid')?.top1 ?? 0)
    expect(byMethod.get('tree-only')?.top1).toBeLessThan(10)
    expect(byMethod.get('intent-only')?.top1).toBeLessThan(10)
  }, 15_000)
})
