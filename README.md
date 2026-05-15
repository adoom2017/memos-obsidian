# Memos Card View

Obsidian plugin that connects to a Memos instance and shows memos as editable cards.

## Features

* Configure Memos base URL, PAT, and page size in Obsidian settings.
* Open a dedicated card view from the ribbon or command palette.
* Refresh, page through, create, edit, and delete memos.
* Create and edit memos with live Markdown preview.
* Upload files as Memos attachments when creating or editing memos.
* Clip web pages by URL, summarize them with a local OpenAI-compatible LLM, and save the summary plus source link to Memos.
* Render memo Markdown content and show tags, visibility, pinned state, timestamps, and attachment links.

## Install Locally

1. Run `npm install`.
2. Run `npm run build`.
3. Create `<vault>/.obsidian/plugins/memos-card-view`.
4. Copy the generated files from `dist/` into that folder.
5. Enable the plugin in Obsidian community plugin settings.
6. Open plugin settings and enter your Memos personal access token.
7. For web clipping, configure a local OpenAI-compatible LLM base URL and model name.

The default server URL is `https://memos.adoom-cloud.top:1443`, but it can be changed in settings.

## Development

* `npm run dev` starts esbuild watch mode and writes generated files into `dist/`.
* `npm run build` runs TypeScript checking and writes production plugin files into `dist/`.

Do not commit personal access tokens or Obsidian `data.json`.
