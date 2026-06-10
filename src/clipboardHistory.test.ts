import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  classifyRichTextClipboard,
  classifyTextClipboard,
  detectFilePaths,
  detectTextContentType,
  draftToHistoryItem,
  hashBytes,
  historyItemToSearchable,
  itemToClipboardText,
  mergeHistoryItem,
  rankHistoryItems,
  recordHistoryItemCopied,
  replaceHistoryItem,
  sameSourceApp,
  scoreHistoryItem,
  trimHistoryItems,
} from './clipboardHistory'

describe('clipboard history classification', () => {
  it('keeps multiline shell text as text, not a file', () => {
    const draft = classifyTextClipboard('git add .\ngit commit --amend --no-edit')
    expect(draft?.kind).toBe('text')
  })

  it('detects POSIX file paths copied as newline text', () => {
    expect(detectFilePaths('/tmp/a.txt\n/Users/me/Project/file with spaces.md')).toEqual([
      '/tmp/a.txt',
      '/Users/me/Project/file with spaces.md',
    ])
  })

  it('detects file URLs and decodes spaces', () => {
    expect(detectFilePaths('file:///Users/me/My%20Doc.pdf')).toEqual([
      '/Users/me/My Doc.pdf',
    ])
  })

  it('detects Windows paths without confusing normal prose', () => {
    expect(detectFilePaths('C:\\Users\\me\\note.txt')).toEqual([
      'C:\\Users\\me\\note.txt',
    ])
    expect(detectFilePaths('copy this command please')).toEqual([])
  })

  it('keeps quoted file paths and file URLs grouped as files', () => {
    expect(
      detectFilePaths('"/tmp/report final.pdf"\nfile:///Users/me/Desktop/demo%20image.png'),
    ).toEqual(['/tmp/report final.pdf', '/Users/me/Desktop/demo image.png'])
  })

  it('does not classify mixed prose and paths as a file list', () => {
    expect(detectFilePaths('please inspect /tmp/a.txt')).toEqual([])
  })

  it('drops empty clipboard text', () => {
    expect(classifyTextClipboard(' \n\t ')).toBeNull()
  })

  it('detects common developer clipboard text subtypes', () => {
    expect(detectTextContentType('https://example.com/docs')).toBe('url')
    expect(detectTextContentType('{"model":"deepseek","enabled":true}')).toBe('json')
    expect(detectTextContentType('export API_BASE=https://api.example.com\nTOKEN=abc')).toBe('env')
    expect(detectTextContentType('sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('api-key')
    expect(detectTextContentType('kubectl get pods -n prod --watch')).toBe('code')
  })

  it('preserves HTML as rich text history', () => {
    const draft = classifyRichTextClipboard('Hello world', '<b>Hello</b> world')
    expect(draft?.kind).toBe('text')
    const item = draftToHistoryItem(draft!)
    expect(item.contentType).toBe('rich-text')
    expect(item.html).toContain('<b>Hello</b>')
    expect(item.subtitle).toBe('Formatted text')
  })
})

describe('clipboard history item lifecycle', () => {
  it('creates concise text titles and preserves full content for copying', () => {
    const draft = classifyTextClipboard(
      'bytedcli merlin job fork-run --source-job-run-id 737b598b9b06ca1b --caption "vllm_019_ascend_fork_8"',
    )
    expect(draft?.kind).toBe('text')
    const item = draftToHistoryItem(draft!, '2026-05-09T00:00:00.000Z')

    expect(item.title).toContain('bytedcli merlin job')
    expect(item.subtitle).toBe('Code')
    expect(itemToClipboardText(item)).toContain('--source-job-run-id')
  })

  it('shows useful environment variable previews without exposing secrets', () => {
    const draft = classifyTextClipboard(
      'export API_BASE=https://api.example.com\nTOKEN=super-secret-token\nDEBUG=true',
    )
    expect(draft?.kind).toBe('text')
    const item = draftToHistoryItem(draft!, '2026-05-09T00:00:00.000Z')

    expect(item.contentType).toBe('env')
    expect(item.title).toContain('API_BASE=https://api.example.com')
    expect(item.title).toContain('TOKEN=••••')
    expect(item.title).toContain('DEBUG=true')
    expect(item.title).not.toContain('super-secret-token')
    expect(item.subtitle).toBe('Environment variables · 3 variables')
  })

  it('creates file items with file-name summaries and newline copy text', () => {
    const item = draftToHistoryItem({
      kind: 'file',
      content: '/tmp/a.txt\n/tmp/b.png',
      files: ['/tmp/a.txt', '/tmp/b.png'],
    })

    expect(item.kind).toBe('file')
    expect(item.contentType).toBe('file')
    expect(item.title).toBe('2 files')
    expect(item.subtitle).toBe('a.txt, b.png')
    expect(itemToClipboardText(item)).toBe('/tmp/a.txt\n/tmp/b.png')
  })

  it('summarizes Windows file names without leaking the whole path into title', () => {
    const item = draftToHistoryItem({
      kind: 'file',
      content: 'C:\\Users\\me\\Desktop\\note.txt',
      files: ['C:\\Users\\me\\Desktop\\note.txt'],
    })

    expect(item.title).toBe('note.txt')
    expect(item.subtitle).toBe('note.txt')
  })

  it('creates image items with stable signatures', () => {
    const item = draftToHistoryItem({
      kind: 'image',
      hash: 'abc123',
      image: {
        width: 2,
        height: 2,
        rgbaBase64: 'AAECAwQFBgcICQoLDA0ODw==',
        previewDataUrl: 'data:image/png;base64,preview',
      },
    })

    expect(item.kind).toBe('image')
    expect(item.contentType).toBe('image')
    expect(item.title).toBe('Image 2×2')
    expect(item.signature).toBe('image:2x2:abc123')
  })

  it('uses image captions as image titles', () => {
    const item = draftToHistoryItem({
      kind: 'image',
      hash: 'captioned',
      image: {
        width: 2,
        height: 2,
        caption: 'Settings dialog screenshot',
      },
    })

    expect(item.title).toBe('Settings dialog screenshot')
  })

  it('moves duplicate clipboard content to the top without losing pin state', () => {
    const first = {
      ...draftToHistoryItem({ kind: 'text', content: 'alpha' }, '2026-05-09T00:00:00.000Z'),
      pinned: true,
    }
    const second = draftToHistoryItem(
      { kind: 'text', content: 'beta' },
      '2026-05-09T00:00:01.000Z',
    )
    const duplicate = draftToHistoryItem(
      { kind: 'text', content: 'alpha' },
      '2026-05-09T00:00:02.000Z',
    )

    const items = mergeHistoryItem([first, second], duplicate)
    expect(items).toHaveLength(2)
    expect(items[0].content).toBe('alpha')
    expect(items[0].pinned).toBe(true)
  })

  it('keeps pinned items while trimming old history', () => {
    const pinned = {
      ...draftToHistoryItem({ kind: 'text', content: 'keep me' }),
      pinned: true,
    }
    const items = [
      pinned,
      draftToHistoryItem({ kind: 'text', content: 'one' }),
      draftToHistoryItem({ kind: 'text', content: 'two' }),
      draftToHistoryItem({ kind: 'text', content: 'three' }),
    ]

    expect(trimHistoryItems(items, 2).map((item) => item.content)).toEqual([
      'keep me',
      'one',
    ])
  })

  it('does not promote pinned items while trimming history', () => {
    const items = [
      draftToHistoryItem({ kind: 'text', content: 'newest' }, '2026-05-09T00:00:03.000Z'),
      draftToHistoryItem({ kind: 'text', content: 'middle' }, '2026-05-09T00:00:02.000Z'),
      {
        ...draftToHistoryItem({ kind: 'text', content: 'old starred' }, '2026-05-09T00:00:01.000Z'),
        pinned: true,
      },
      draftToHistoryItem({ kind: 'text', content: 'old unstarred' }, '2026-05-09T00:00:00.000Z'),
    ]

    expect(trimHistoryItems(items, 2).map((item) => item.content)).toEqual([
      'newest',
      'middle',
      'old starred',
    ])
  })

  it('deduplicates repeated images by dimensions and sampled byte hash', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255])
    const first = draftToHistoryItem({
      kind: 'image',
      hash: hashBytes(rgba),
      image: { width: 2, height: 1, rgbaBase64: bytesToBase64(rgba) },
    })
    const second = draftToHistoryItem({
      kind: 'image',
      hash: hashBytes(rgba),
      image: { width: 2, height: 1, rgbaBase64: bytesToBase64(rgba) },
    })

    const items = mergeHistoryItem([first], second)
    expect(items).toHaveLength(1)
    expect(base64ToBytes(items[0].image!.rgbaBase64!)).toEqual(rgba)
  })

  it('moves copied history items to the top', () => {
    const first = draftToHistoryItem({ kind: 'text', content: 'first' })
    const second = draftToHistoryItem({ kind: 'text', content: 'second' })
    const items = recordHistoryItemCopied(
      [first, second],
      second.id,
      '2026-05-10T00:00:00.000Z',
    )

    expect(items[0].content).toBe('second')
    expect(items[0].copyCount).toBe(1)
    expect(items[0].updatedAt).toBe('2026-05-10T00:00:00.000Z')
  })

  it('replaces edited items and selects an existing duplicate when signatures collide', () => {
    const alpha = draftToHistoryItem({ kind: 'text', content: 'alpha' }, '2026-05-09T00:00:00.000Z')
    const beta = draftToHistoryItem({ kind: 'text', content: 'beta' }, '2026-05-09T00:00:01.000Z')
    const editedBeta = {
      ...draftToHistoryItem({ kind: 'text', content: 'alpha' }, '2026-05-09T00:00:02.000Z'),
      id: beta.id,
      createdAt: beta.createdAt,
    }

    const result = replaceHistoryItem([alpha, beta], beta.id, editedBeta)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe(alpha.id)
    expect(result.selectedId).toBe(alpha.id)
  })
})

describe('clipboard history search', () => {
  const items = [
    draftToHistoryItem({
      kind: 'text',
      content: 'kubectl exec -it api -n prod -- /bin/sh',
      sourceApp: { name: 'Terminal', bundleId: 'com.apple.Terminal' },
    }),
    draftToHistoryItem({
      kind: 'file',
      content: '/Users/me/Reports/expense.pdf',
      files: ['/Users/me/Reports/expense.pdf'],
      sourceApp: { name: 'Finder', bundleId: 'com.apple.finder' },
    }),
    draftToHistoryItem({
      kind: 'image',
      hash: 'imagehash',
      image: {
        width: 640,
        height: 480,
        rgbaBase64: 'AAAA',
        caption: 'terminal screenshot showing a failed rollout',
      },
      sourceApp: { name: 'Preview', bundleId: 'com.apple.Preview' },
    }),
    {
      ...draftToHistoryItem({ kind: 'text', content: 'pinned launch command' }),
      pinned: true,
    },
  ]

  it('finds by command fragments', () => {
    expect(rankHistoryItems(items, 'prod shell')[0].content).toContain('kubectl')
  })

  it('uses shared hybrid search for natural-language command lookup', () => {
    expect(rankHistoryItems(items, '进入 prod 容器 shell')[0].content).toContain('kubectl')
  })

  it('finds files by file name', () => {
    expect(rankHistoryItems(items, 'expense')[0].kind).toBe('file')
  })

  it('finds files by extension-style metadata', () => {
    expect(rankHistoryItems(items, 'pdf report')[0].kind).toBe('file')
  })

  it('does not expose image dimensions as search text', () => {
    const searchable = historyItemToSearchable(items[2])
    expect([
      searchable.title,
      searchable.description,
      searchable.template,
      ...searchable.tags,
      ...searchable.intents,
    ].join(' ')).not.toMatch(/640|480/)
  })

  it('finds images by generated captions', () => {
    expect(rankHistoryItems(items, 'failed rollout screenshot')[0].kind).toBe('image')
  })

  it('puts exact clipboard content matches ahead of app and usage noise', () => {
    const envItem = draftToHistoryItem(
      classifyTextClipboard(
        [
          'export http_proxy=http://sys-proxy-rd-relay.byted.org:8118',
          'export https_proxy=http://sys-proxy-rd-relay.byted.org:8118',
          'export no_proxy=localhost,127.0.0.1,.byted.org,.bytedance.net',
        ].join('\n'),
      )!,
      '2026-05-09T00:00:00.000Z',
    )
    const noisyItems = Array.from({ length: 20 }, (_, index) => ({
      ...draftToHistoryItem(
        classifyTextClipboard(`daily note ${index} proxy config terminal clipboard`)!,
        `2026-05-09T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
      ),
      copyCount: 200,
      sourceApp: { name: 'Terminal', bundleId: 'com.apple.Terminal' },
    }))

    const ranked = rankHistoryItems([...noisyItems, envItem], '8118', {
      name: 'Terminal',
      bundleId: 'com.apple.Terminal',
    })

    expect(ranked[0].content).toContain('http_proxy')
    expect(ranked[0].content).toContain('8118')
  })

  it('filters by type, app, path, starred, and today', () => {
    const today = new Date()
    const todayIso = today.toISOString()
    const filtered = [
      {
        ...items[0],
        createdAt: todayIso,
      },
      {
        ...items[1],
        createdAt: '2020-01-01T00:00:00.000Z',
      },
      {
        ...items[2],
        contentType: 'screenshot' as const,
        createdAt: todayIso,
      },
      {
        ...items[3],
        createdAt: todayIso,
      },
    ]

    expect(rankHistoryItems(filtered, 'type:screenshot')[0].contentType).toBe('screenshot')
    expect(rankHistoryItems(filtered, 'app:finder')[0].kind).toBe('file')
    expect(rankHistoryItems(filtered, 'path:Clipboard/Screenshot')[0].contentType).toBe('screenshot')
    expect(rankHistoryItems(filtered, 'starred')[0].pinned).toBe(true)
    expect(rankHistoryItems(filtered, 'today')).toHaveLength(3)
  })

  it('keeps current order for empty history view', () => {
    expect(rankHistoryItems(items, '')[0].content).toContain('kubectl')
  })

  it('keeps current order for equally relevant history results', () => {
    const newest = {
      ...draftToHistoryItem({ kind: 'text', content: 'same query' }),
      id: 'newest-same-query',
      copyCount: 1,
    }
    const starredOlder = {
      ...draftToHistoryItem({ kind: 'text', content: 'same query' }),
      id: 'older-same-query',
      copyCount: 100,
      pinned: true,
    }

    expect(rankHistoryItems([newest, starredOlder], 'same query').map((item) => item.id)).toEqual([
      'newest-same-query',
      'older-same-query',
    ])
  })

  it('uses source application as a weak ranking signal', () => {
    const terminalRanked = rankHistoryItems(items, 'terminal', {
      name: 'Terminal',
      bundleId: 'com.apple.Terminal',
    })
    expect(terminalRanked[0].content).toContain('kubectl')
    expect(scoreHistoryItem(items[0], 'terminal', {
      bundleId: 'com.apple.Terminal',
    })).toBeGreaterThan(scoreHistoryItem(items[0], 'terminal', {
      bundleId: 'com.apple.finder',
    }))
  })

  it('matches source apps by bundle id before display name', () => {
    expect(sameSourceApp(
      { name: 'Terminal', bundleId: 'com.apple.Terminal' },
      { name: 'Different Name', bundleId: 'com.apple.Terminal' },
    )).toBe(true)
    expect(sameSourceApp({ name: 'Terminal' }, { name: 'terminal' })).toBe(true)
  })

  it('projects history items into the reusable snippet search shape', () => {
    const searchable = historyItemToSearchable(items[0])
    expect(searchable.path).toBe('Clipboard/Code')
    expect(searchable.template).toContain('kubectl exec')
    expect(searchable.template).toContain('terminal')
    expect(searchable.tags).toContain('clipboard')
  })
})
