<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Cliboard icon">
</p>

# Cliboard

*A smart clipboard for CLI commands.*

[中文说明](README.zh-CN.md)

**There are too many CLI commands to keep in your head, and that is normal.**
The annoying part is not just remembering them: the same command keeps moving
between local shells, remote machines, clusters, model downloads, and deploy
tools. This time you change a job id, next time a model name, then one more flag.

Cliboard is a keyboard-first command clipboard. Put your usual commands,
prompts, URLs, files, images, and notes in one place, then find them with
keywords or natural language. It tries to match the right item, rewrite the
parameters, fill missing defaults, and paste the result back into the current
app.

## Quick Start

Download the latest macOS build from
[GitHub Releases](https://github.com/kang-0909/cliboard/releases/latest). The
ZIP archive provides a direct app download; the DMG provides the standard
drag-to-Applications installer.

The first time you use auto-paste, macOS may ask for Accessibility permission.
macOS may also require approval from System Settings > Privacy & Security >
Open Anyway before the first launch.

Default shortcuts:

- **`Shift + Cmd + V`**: open clipboard history
- **`Shift + Option + Cmd + V`**: open smart snippets
- **`Option + Space`**: open Ask
- `Esc`: hide the panel
- `Enter`: copy or paste the selected item

Cliboard runs as a panel app without a Dock icon. To quit, open Settings and
click `Quit Cliboard`.

## Screenshots

<img src="docs/screenshots/clipboard-history.png" width="760" alt="Clipboard history">

Search recent clips, files, URLs, and commands, then paste the selected item
back into the app you were using.

<img src="docs/screenshots/smart-snippets.png" width="760" alt="Smart snippets">

Keep reusable command snippets, fill parameters, and render the final command
without rebuilding it from scratch.

<img src="docs/screenshots/ask-mode.png" width="760" alt="Ask mode">

Ask a quick question without leaving the keyboard-first panel.

## What You Can Do

- **Search clipboard history** and paste previous text, URLs, files, and images.
- **Keep repeated commands and prompts** as snippets with editable parameters.
- Turn a clipboard item into a snippet, then adjust its title, path, tags, and
  template.
- Use filters such as `type:image`, `app:chrome`, `path:Shell/HuggingFace`,
  `starred`, and `today`.
- Keep copied files and images available so they can be pasted again later.
- Ask the built-in **LLM panel** to explain commands, draft replies, or format
  notes with Markdown and math.

## Smart Snippet Example

Save this once:

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [{"role": "user", "content": "Reply with only OK."}],
    "temperature": 0.2,
    "top_p": 0.9,
    "max_tokens": 128,
    "stream": false
  }'
```

Then ask:

```text
Send a request to v4flash, tell me a joke, and turn on thinking.
```

Cliboard generates:

```bash
curl https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Tell me a joke."}],
    "temperature": 0.2,
    "top_p": 0.9,
    "max_tokens": 128,
    "stream": false,
    "thinking": {"type": "enabled"}
  }'
```

It matched the saved curl snippet, changed the provider URL, API key variable,
model, prompt, and thinking mode, then kept untouched settings such as
temperature, `top_p`, `max_tokens`, and `stream` unchanged.

## LLM Setup

**LLM features are optional.** Clipboard history, snippets, filters, and local
search work without an API key. LLM Match is off by default, so pressing Match
uses local search unless you explicitly enable it.

For the smart match flow, **DeepSeek v4 flash** is the recommended default: it is
fast enough for command lookup and parameter rewriting, while keeping API cost
low.

To enable LLM features, open Settings, turn on LLM, choose a provider preset
or a custom OpenAI-compatible endpoint, then enter your own API key.

**No API key is bundled with this project.** Do not commit `.env` or local
config files containing secrets.

## Build And Test

```bash
npm install
npm run tauri:dev
npm run build
npm test
npm run tauri:build
```

Cliboard is still an early preview, but the main clipboard, snippet, smart
match, and Ask flows are usable.
