# Memos Card View

Desktop Obsidian plugin that connects to a Memos instance and shows memos as editable cards.

## Features

* Configure Memos base URL, PAT, page size, and default publish visibility in Obsidian settings.
* Open a dedicated card view from the ribbon or command palette.
* Refresh, page through, create, edit, delete, and choose private/public visibility for memos.
* Create and edit memos with live Markdown preview.
* Upload files as Memos attachments when creating or editing memos.
* Clip web pages by URL, using Obsidian desktop's embedded browser or headless Chrome fallback when available, summarize them with a local OpenAI-compatible LLM, and save the summary plus source link to Memos.
* Clip the current browser page with the companion Chromium extension, sending extracted page text and visible images directly to Obsidian.
* Render memo Markdown content and show tags, visibility, pinned state, timestamps, and attachment links.

## Install Locally

1. Run `npm install`.
2. Run `npm run build`.
3. Create `<vault>/.obsidian/plugins/memos-card-view`.
4. Copy the generated files from `dist/` into that folder.
5. Enable the plugin in Obsidian community plugin settings.
6. Open plugin settings and enter your Memos personal access token.
7. For web clipping, configure a local OpenAI-compatible LLM base URL and model name.
8. If a site rejects anonymous clipping, paste the site's browser Cookie header into `Web clip cookie`.
9. Optionally set `System Chrome path` when the plugin cannot auto-detect Chrome for protected pages.

The default server URL is `https://memos.adoom-cloud.top:1443`, but it can be changed in settings.

This plugin is desktop-only because browser clipping and protected-page fallbacks use local Node/Electron APIs.

## Browser Extension

1. In Obsidian plugin settings, enable `Browser clip bridge`.
2. Copy the `Browser clip bridge token`.
3. Open Chrome or Edge extension management, enable developer mode, and load `browser-extension/` as an unpacked extension.
4. Open the extension options, confirm the bridge URL is `http://127.0.0.1:27124`, paste the token, and save.
5. On any page, click the extension and choose `Clip current page`.

The extension sends extracted title, URL, readable text, description, and visible page images to Obsidian. Obsidian still performs the local LLM summary, optional hero-image selection from those candidates, and Memos creation.

## Development

* `npm run dev` starts esbuild watch mode and writes generated files into `dist/`.
* `npm run build` runs TypeScript checking and writes production plugin files into `dist/`.
* `npm run package` builds the Obsidian plugin and writes release artifacts into `release/`; for local testing, you can copy the three files from `release/obsidian/` into your vault plugin folder.

## Release Packaging

Run:

```bash
npm run package
```

The script validates version consistency across `package.json`, the Obsidian
manifest, the browser extension manifest, and `versions.json`. It then creates:

* `release/obsidian/main.js`
* `release/obsidian/manifest.json`
* `release/obsidian/styles.css`
* `release/memos-card-view-<version>-obsidian.zip`
* `release/memos-obsidian-clipper-<version>-chrome.zip`
* `release/README-release.md`

For Obsidian Community Plugin GitHub releases, upload the three files under
`release/obsidian/` as release assets. For Chrome or Edge extension stores,
upload `release/memos-obsidian-clipper-<version>-chrome.zip`.

Do not commit personal access tokens or Obsidian `data.json`.
