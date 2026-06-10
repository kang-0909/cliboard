import { describe, expect, it } from 'vitest'
import {
  rankSnippets,
  type SearchableSnippet,
  type SnippetIndexMethod,
} from './snippetSearch'

function snippet(
  id: string,
  title: string,
  path: string,
  description: string,
  template: string,
  tags: string[],
  intents: string[],
): SearchableSnippet {
  return {
    id,
    title,
    path,
    description,
    template,
    tags,
    intents,
    useCount: 0,
  }
}

const targetSnippets = [
  snippet(
    'hf-download',
    'Download from Hugging Face',
    'Shell/HuggingFace',
    'Download a Hugging Face model to a local directory, optionally with resume.',
    'huggingface-cli download {{model_id}} --local-dir {{local_dir}} {{resume_download_flag}}',
    ['huggingface', 'download', 'model', 'ai'],
    ['download huggingface model', '下载模型', 'resume download'],
  ),
  snippet(
    'merlin-fork',
    'Fork a Merlin job run',
    'Shell/Merlin',
    'Fork a Merlin job run from a source run id and optional caption.',
    'bytedcli merlin job fork-run --source-job-run-id {{source_job_run_id}} --caption "{{caption}}"',
    ['bytedcli', 'merlin', 'fork-run', 'job'],
    ['fork merlin job', 'rerun merlin job', '在 merlin 上 fork job'],
  ),
  snippet(
    'kubectl-exec',
    'Exec into a Kubernetes pod',
    'Shell/Kubernetes',
    'Open an interactive shell in a Kubernetes pod.',
    'kubectl exec -it {{pod}} -n {{namespace}} -- {{shell}}',
    ['kubectl', 'k8s', 'pod', 'debug'],
    ['enter pod', 'debug container shell', '进入 pod'],
  ),
  snippet(
    'kubectl-port-forward',
    'Port-forward a service',
    'Shell/Kubernetes',
    'Forward a Kubernetes service port to localhost.',
    'kubectl port-forward svc/{{service}} {{local_port}}:{{remote_port}} -n {{namespace}}',
    ['kubectl', 'k8s', 'port-forward', 'service'],
    ['forward service', 'open service locally', '端口转发'],
  ),
  snippet(
    'git-amend',
    'Amend latest commit',
    'Shell/Git',
    'Amend staged changes into the latest commit without editing message.',
    'git add {{files}} && git commit --amend --no-edit',
    ['git', 'commit', 'amend'],
    ['fix latest commit', '修改最后一次提交'],
  ),
  snippet(
    'git-rebase',
    'Interactive rebase from main',
    'Shell/Git',
    'Clean up branch history with interactive rebase.',
    'git fetch origin && git rebase -i origin/{{base_branch}}',
    ['git', 'rebase', 'history'],
    ['squash commits', '整理提交历史'],
  ),
  snippet(
    'docker-logs',
    'Tail Docker Compose logs',
    'Shell/Docker',
    'Tail recent Docker Compose service logs.',
    'docker compose logs -f --tail {{tail}} {{service}}',
    ['docker', 'compose', 'logs'],
    ['watch service logs', '查看容器日志'],
  ),
  snippet(
    'postgres-long-running',
    'Find long running Postgres queries',
    'SQL/Postgres',
    'List Postgres queries running longer than a threshold.',
    "select pid, now() - query_start as duration, state, query from pg_stat_activity where state <> 'idle' and now() - query_start > interval '{{minutes}} minutes';",
    ['sql', 'postgres', 'debug'],
    ['find slow queries', '慢 SQL', 'running queries'],
  ),
  snippet(
    'review-prompt',
    'Focused code review prompt',
    'Prompts/Code Review',
    'Ask an LLM to review code by risk priority.',
    'Please review this patch for correctness, regressions, and missing tests. Context: {{context}} Patch: {{patch}}',
    ['prompt', 'review', 'code'],
    ['review code', '审查代码'],
  ),
  snippet(
    'pr-follow-up',
    'Polite PR follow-up',
    'Writing/PR',
    'Ask for PR review politely.',
    'Hi {{name}}, gentle ping on this PR when you have a moment. The main thing I need eyes on is {{focus}}. Thanks!',
    ['writing', 'review', 'follow-up'],
    ['polite reminder', '催 review'],
  ),
]

function distractors(count: number) {
  const domains = ['Shell/General', 'Ops/Cloud', 'Writing/Notes', 'SQL/Analytics', 'Prompts/Misc']
  const verbs = ['sync', 'inspect', 'archive', 'rotate', 'format', 'summarize', 'deploy', 'compare']
  return Array.from({ length: count }, (_, index) => {
    const domain = domains[index % domains.length]
    const verb = verbs[index % verbs.length]
    return snippet(
      `distractor-${index}`,
      `${verb} workspace item ${index}`,
      domain,
      `Generic reusable item ${index} for ${domain}.`,
      `${verb}-tool --resource item-${index} --mode dry-run`,
      [verb, 'utility', `tag-${index % 17}`],
      [`${verb} item`, `generic task ${index}`],
    )
  })
}

const testCases = [
  ['下载 qwen 模型', 'hf-download'],
  ['huggingface download deepseek model', 'hf-download'],
  ['hf 恢复下载 llama', 'hf-download'],
  ['resume huggingface checkpoint', 'hf-download'],
  ['把模型下载到本地目录', 'hf-download'],
  ['fork 一个 merlin job', 'merlin-fork'],
  ['在 merlin 上 fork abc', 'merlin-fork'],
  ['bytedcli rerun source job', 'merlin-fork'],
  ['复制一个 merlin 任务并命名', 'merlin-fork'],
  ['source job run id caption', 'merlin-fork'],
  ['进入 pod shell', 'kubectl-exec'],
  ['kubectl exec debug container', 'kubectl-exec'],
  ['打开 k8s 容器 shell', 'kubectl-exec'],
  ['debug pod in namespace', 'kubectl-exec'],
  ['attach to kubernetes pod', 'kubectl-exec'],
  ['端口转发 service', 'kubectl-port-forward'],
  ['kubectl port forward svc', 'kubectl-port-forward'],
  ['open service locally', 'kubectl-port-forward'],
  ['映射集群服务到本地', 'kubectl-port-forward'],
  ['forward remote port', 'kubectl-port-forward'],
  ['amend latest commit', 'git-amend'],
  ['修改最后一次提交', 'git-amend'],
  ['git commit no edit', 'git-amend'],
  ['把 staged 文件塞进上一个 commit', 'git-amend'],
  ['fix previous commit message unchanged', 'git-amend'],
  ['interactive rebase main', 'git-rebase'],
  ['整理 git 提交历史', 'git-rebase'],
  ['squash commits on branch', 'git-rebase'],
  ['rebase from origin main', 'git-rebase'],
  ['clean branch history', 'git-rebase'],
  ['docker compose logs', 'docker-logs'],
  ['查看容器日志', 'docker-logs'],
  ['tail service logs', 'docker-logs'],
  ['follow compose service output', 'docker-logs'],
  ['debug docker logs tail', 'docker-logs'],
  ['查慢 SQL', 'postgres-long-running'],
  ['postgres running queries', 'postgres-long-running'],
  ['find long database query', 'postgres-long-running'],
  ['pg_stat_activity duration', 'postgres-long-running'],
  ['database investigation slow query', 'postgres-long-running'],
  ['审查代码 patch', 'review-prompt'],
  ['focused code review', 'review-prompt'],
  ['ask llm find bugs in diff', 'review-prompt'],
  ['review regressions missing tests', 'review-prompt'],
  ['代码变更风险检查', 'review-prompt'],
  ['催一下 PR review', 'pr-follow-up'],
  ['polite reviewer reminder', 'pr-follow-up'],
  ['follow up on pull request', 'pr-follow-up'],
  ['温和提醒看一下 PR', 'pr-follow-up'],
  ['ask teammate for review', 'pr-follow-up'],
] as const

describe('local snippet indexes', () => {
  it('compares keyword and hybrid accuracy with 400 distractors and 50 cases', async () => {
    const snippets = [...targetSnippets, ...distractors(400)]
    const methods: SnippetIndexMethod[] = ['keyword', 'hybrid']

    const rows = await Promise.all(
      methods.map(async (method) => {
        const started = performance.now()
        const results = await Promise.all(
          testCases.map(async ([query, expected]) => {
            const ranked = rankSnippets(snippets, query, method)
            const ids = ranked.slice(0, 3).map((item) => item.id)
            return {
              top1: ids[0] === expected,
              top3: ids.includes(expected),
            }
          }),
        )
        const durationMs = performance.now() - started
        return {
          method,
          top1: results.filter((item) => item.top1).length,
          top3: results.filter((item) => item.top3).length,
          total: results.length,
          avgMs: durationMs / results.length,
        }
      }),
    )

    console.table(rows)
    const hybrid = rows.find((row) => row.method === 'hybrid')!
    expect(hybrid.top1).toBeGreaterThanOrEqual(45)
    expect(hybrid.top3).toBe(50)
  })
})
