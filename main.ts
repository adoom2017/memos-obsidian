import {
  App,
  Component,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Platform,
  RequestUrlParam,
  Setting,
  WorkspaceLeaf,
  requestUrl,
  setIcon,
} from "obsidian";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const MEMOS_VIEW_TYPE = "memos-card-view";
type MemosViewLocation = "main" | "right";
declare const require: (module: string) => unknown;

interface ElectronBrowserWindow {
  loadURL(url: string, options?: { userAgent?: string; httpReferrer?: string }): Promise<void>;
  destroy(): void;
  webContents: {
    executeJavaScript<T>(code: string): Promise<T>;
    session: {
      cookies: {
        set(details: {
          url: string;
          name: string;
          value: string;
          domain?: string;
          path?: string;
          secure?: boolean;
          httpOnly?: boolean;
        }): Promise<void>;
      };
    };
  };
}

interface ElectronModule {
  BrowserWindow: new (options: Record<string, unknown>) => ElectronBrowserWindow;
}

interface ChromeDebugTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface ChromeEvalResponse<T> {
  id: number;
  result?: {
    result?: {
      value?: T;
    };
    exceptionDetails?: unknown;
  };
  error?: {
    message?: string;
  };
}

interface ChromeClipSnapshot {
  html?: string;
  title?: string;
  text?: string;
  url?: string;
  readyState?: string;
  hasReadableContainer?: boolean;
}

interface MemosPluginSettings {
  baseUrl: string;
  token: string;
  pageSize: number;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  webClipCookie: string;
  webClipChromePath: string;
}

interface MemosAttachment {
  name: string;
  filename?: string;
  externalLink?: string;
  type?: string;
  size?: string | number;
}

interface MemoEditorSubmit {
  content: string;
  files: File[];
}

interface MemosMemo {
  name: string;
  state?: string;
  creator?: string;
  createTime?: string;
  updateTime?: string;
  content?: string;
  visibility?: string;
  tags?: string[];
  pinned?: boolean;
  attachments?: MemosAttachment[];
  snippet?: string;
}

interface ListMemosResponse {
  memos?: MemosMemo[];
  nextPageToken?: string;
}

interface WebClipPage {
  url: string;
  title: string;
  description: string;
  text: string;
  imageCandidates: string[];
}

interface DownloadedImage {
  filename: string;
  type: string;
  content: ArrayBuffer;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface WebClipSummary {
  summary: string;
  imageUrl: string;
}

const DEFAULT_SETTINGS: MemosPluginSettings = {
  baseUrl: "https://memos.adoom-cloud.top:1443",
  token: "",
  pageSize: 20,
  llmBaseUrl: "http://127.0.0.1:8080/v1",
  llmModel: "",
  llmApiKey: "",
  webClipCookie: "",
  webClipChromePath: "",
};
const WEB_CLIP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const WEB_CLIP_CHROME_DEBUG_PORT = 9224;
const WEB_CLIP_CHROME_READINESS_TIMEOUT_MS = 25000;
const WEB_CLIP_CHROME_READINESS_POLL_MS = 750;

export default class MemosCardPlugin extends Plugin {
  settings: MemosPluginSettings;
  api: MemosApiClient;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.api = new MemosApiClient(() => this.settings);

    this.registerView(
      MEMOS_VIEW_TYPE,
      (leaf) => new MemosCardView(leaf, this),
    );

    this.addRibbonIcon("sticky-note", "Open Memos", () => {
      void this.activateView("main");
    });

    this.addCommand({
      id: "open-memos-card-view",
      name: "Open Memos card view in main area",
      callback: () => {
        void this.activateView("main");
      },
    });

    this.addCommand({
      id: "open-memos-card-view-sidebar",
      name: "Open Memos card view in right sidebar",
      callback: () => {
        void this.activateView("right");
      },
    });

    this.addCommand({
      id: "refresh-memos",
      name: "Refresh Memos card view",
      callback: () => {
        this.refreshOpenViews();
      },
    });

    this.addCommand({
      id: "clip-web-page-to-memos",
      name: "Clip web page to Memos",
      callback: () => {
        void this.activateView("main").then(() => {
          for (const leaf of this.app.workspace.getLeavesOfType(MEMOS_VIEW_TYPE)) {
            if (leaf.view instanceof MemosCardView) {
              leaf.view.openWebClipModal();
              break;
            }
          }
        });
      },
    });

    this.addSettingTab(new MemosSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(MEMOS_VIEW_TYPE);
  }

  async activateView(location: MemosViewLocation = "main"): Promise<void> {
    this.app.workspace.detachLeavesOfType(MEMOS_VIEW_TYPE);
    const leaf = location === "right"
      ? this.app.workspace.getRightLeaf(false)
      : this.app.workspace.getLeaf("tab");

    if (!leaf) {
      new Notice("Unable to open Memos view.");
      return;
    }

    await leaf.setViewState({ type: MEMOS_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MEMOS_VIEW_TYPE)) {
      if (leaf.view instanceof MemosCardView) {
        void leaf.view.reloadFromSettings();
      }
    }
  }
}

class MemosApiClient {
  constructor(private readonly getSettings: () => MemosPluginSettings) {}

  async listMemos(pageToken?: string): Promise<ListMemosResponse> {
    const settings = this.getSettings();
    const query = new URLSearchParams({
      pageSize: String(settings.pageSize),
    });

    if (pageToken) {
      query.set("pageToken", pageToken);
    }

    return this.request<ListMemosResponse>({
      url: this.url(`/memos?${query.toString()}`),
      method: "GET",
    });
  }

  async createMemo(content: string, attachments: MemosAttachment[] = []): Promise<MemosMemo> {
    return this.request<MemosMemo>({
      url: this.url("/memos"),
      method: "POST",
      body: JSON.stringify({
        content,
        visibility: "PRIVATE",
        attachments,
      }),
    });
  }

  async updateMemoContent(name: string, content: string): Promise<MemosMemo> {
    return this.request<MemosMemo>({
      url: this.url(`/${name}?updateMask=content`),
      method: "PATCH",
      body: JSON.stringify({ content }),
    });
  }

  async deleteMemo(name: string): Promise<void> {
    await this.request<Record<string, never>>({
      url: this.url(`/${name}`),
      method: "DELETE",
    });
  }

  async createAttachment(file: File): Promise<MemosAttachment> {
    return this.createAttachmentFromArrayBuffer(
      file.name,
      file.type || "application/octet-stream",
      await file.arrayBuffer(),
    );
  }

  async createAttachmentFromArrayBuffer(
    filename: string,
    type: string,
    content: ArrayBuffer,
  ): Promise<MemosAttachment> {
    return this.request<MemosAttachment>({
      url: this.url("/attachments"),
      method: "POST",
      body: JSON.stringify({
        filename,
        type,
        content: arrayBufferToBase64(content),
      }),
    });
  }

  async setMemoAttachments(name: string, attachments: MemosAttachment[]): Promise<void> {
    await this.request<Record<string, never>>({
      url: this.url(`/${name}/attachments`),
      method: "PATCH",
      body: JSON.stringify({
        name,
        attachments,
      }),
    });
  }

  private async request<T>(options: RequestUrlParam): Promise<T> {
    const settings = this.getSettings();

    if (!settings.baseUrl.trim()) {
      throw new Error("Memos server URL is not configured.");
    }

    if (!settings.token.trim()) {
      throw new Error("Memos access token is not configured.");
    }

    const response = await requestUrl({
      ...options,
      headers: {
        Authorization: `Bearer ${settings.token.trim()}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });

    if (response.status < 200 || response.status >= 300) {
      const body = response.text ? `: ${response.text.slice(0, 200)}` : "";
      throw new Error(`Memos request failed (${response.status})${body}`);
    }

    return response.json as T;
  }

  private url(path: string): string {
    const baseUrl = this.getSettings().baseUrl.trim().replace(/\/+$/, "");
    const safePath = path.startsWith("/") ? path : `/${path}`;
    return `${baseUrl}/api/v1${safePath}`;
  }
}

class MemosCardView extends ItemView {
  private listEl: HTMLElement;
  private statusEl: HTMLElement;
  private loadMoreEl: HTMLElement;
  private memos: MemosMemo[] = [];
  private nextPageToken = "";
  private isLoading = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: MemosCardPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return MEMOS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Memos";
  }

  getIcon(): string {
    return "sticky-note";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
    await this.loadMemos(true);
  }

  async reloadFromSettings(): Promise<void> {
    await this.loadMemos(true);
  }

  private renderShell(): void {
    this.contentEl.empty();
    this.contentEl.addClass("memos-view");

    const toolbar = this.contentEl.createDiv({ cls: "memos-toolbar" });
    const titleGroup = toolbar.createDiv({ cls: "memos-title-group" });
    const titleIcon = titleGroup.createSpan({ cls: "memos-title-icon" });
    setIcon(titleIcon, "sticky-note");
    titleGroup.createEl("h2", { text: "Memos" });

    const actions = toolbar.createDiv({ cls: "memos-toolbar-actions" });
    this.createActionButton(actions, "plus", "New memo", () => {
      this.openCreateModal();
    }, "New");
    this.createActionButton(actions, "scissors", "Clip web page", () => {
      this.openWebClipModal();
    }, "Clip");
    this.createActionButton(actions, "refresh-cw", "Refresh", () => {
      void this.loadMemos(true);
    });

    this.statusEl = this.contentEl.createDiv({ cls: "memos-status" });
    this.listEl = this.contentEl.createDiv({ cls: "memos-card-list" });
    this.loadMoreEl = this.contentEl.createDiv({ cls: "memos-load-more" });
  }

  private async loadMemos(reset: boolean): Promise<void> {
    if (this.isLoading) {
      return;
    }

    this.isLoading = true;
    this.setStatus(reset ? "Loading memos..." : "Loading more memos...");
    this.renderLoadMore();

    try {
      const response = await this.plugin.api.listMemos(
        reset ? undefined : this.nextPageToken,
      );
      const incoming = response.memos ?? [];
      this.memos = reset ? incoming : [...this.memos, ...incoming];
      this.nextPageToken = response.nextPageToken ?? "";
      this.renderCards();
      this.setStatus(this.memos.length ? "" : "No memos found.");
    } catch (error) {
      const message = getErrorMessage(error);
      this.setStatus(message, true);
      new Notice(message);
    } finally {
      this.isLoading = false;
      this.renderLoadMore();
    }
  }

  private renderCards(): void {
    this.listEl.empty();

    for (const memo of this.memos) {
      const card = this.listEl.createDiv({ cls: "memos-card" });
      const header = card.createDiv({ cls: "memos-card-header" });
      const meta = header.createDiv({ cls: "memos-card-meta" });

      if (memo.pinned) {
        meta.createEl("span", { cls: "memos-pill memos-pill-pin", text: "Pinned" });
      }

      if (memo.visibility) {
        meta.createEl("span", { cls: "memos-pill", text: memo.visibility });
      }

      meta.createEl("span", {
        cls: "memos-card-date",
        text: formatDate(memo.updateTime ?? memo.createTime),
      });

      const actions = header.createDiv({ cls: "memos-card-actions" });
      this.createActionButton(actions, "pencil", "Edit memo", () => {
        this.openEditModal(memo);
      });
      this.createActionButton(actions, "trash-2", "Delete memo", () => {
        this.openDeleteModal(memo);
      });

      const content = card.createDiv({ cls: "memos-card-content" });
      const body = (memo.content ?? "").trim();
      if (body) {
        void MarkdownRenderer.render(
          this.app,
          body,
          content,
          "",
          this,
        );
      } else {
        content.createEl("em", { text: "No text content" });
      }

      this.renderTags(card, memo.tags ?? []);
      this.renderAttachments(card, memo.attachments ?? []);
    }
  }

  private renderTags(parent: HTMLElement, tags: string[]): void {
    if (!tags.length) {
      return;
    }

    const tagList = parent.createDiv({ cls: "memos-tag-list" });
    for (const tag of tags) {
      tagList.createEl("span", { cls: "memos-tag", text: `#${tag}` });
    }
  }

  private renderAttachments(parent: HTMLElement, attachments: MemosAttachment[]): void {
    if (!attachments.length) {
      return;
    }

    const attachmentList = parent.createDiv({ cls: "memos-attachment-list" });
    for (const attachment of attachments) {
      if (isImageAttachment(attachment) && attachment.externalLink) {
        const imageLink = attachmentList.createEl("a", {
          cls: "memos-image-attachment",
          attr: {
            href: attachment.externalLink,
            target: "_blank",
            rel: "noopener",
          },
        });
        imageLink.createEl("img", {
          attr: {
            src: attachment.externalLink,
            alt: attachment.filename ?? attachment.name,
            loading: "lazy",
          },
        });
        continue;
      }

      const link = attachmentList.createEl("a", {
        cls: "memos-attachment",
        text: attachment.filename ?? attachment.name,
      });
      link.href = attachment.externalLink ?? "#";
      link.target = "_blank";
      link.rel = "noopener";

      if (!attachment.externalLink) {
        link.addClass("is-disabled");
        link.removeAttribute("href");
      }
    }
  }

  private renderLoadMore(): void {
    this.loadMoreEl.empty();

    if (!this.nextPageToken) {
      return;
    }

    const button = this.loadMoreEl.createEl("button", {
      cls: "memos-load-more-button",
      attr: { type: "button" },
    });
    setIcon(button, "chevron-down");
    button.createSpan({ text: this.isLoading ? "Loading..." : "Load more" });
    button.disabled = this.isLoading;
    button.onclick = () => {
      void this.loadMemos(false);
    };
  }

  private openCreateModal(): void {
    new MemoEditorModal(this.app, {
      title: "New memo",
      buttonText: "Create",
      initialContent: "",
      existingAttachments: [],
      owner: this,
      onSubmit: async ({ content, files }) => {
        const attachments = await this.uploadAttachments(files);
        const created = await this.plugin.api.createMemo(content, attachments);
        this.memos = [created, ...this.memos];
        this.renderCards();
        this.setStatus("");
        new Notice("Memo created.");
      },
    }).open();
  }

  openWebClipModal(): void {
    new WebClipModal(this.app, {
      onClip: async (url, setStatus) => {
        const created = await this.clipWebPage(url, setStatus);
        this.memos = [created, ...this.memos];
        this.renderCards();
        this.setStatus("");
        new Notice("Web page clipped to Memos.");
      },
    }).open();
  }

  private openEditModal(memo: MemosMemo): void {
    new MemoEditorModal(this.app, {
      title: "Edit memo",
      buttonText: "Save",
      initialContent: memo.content ?? "",
      existingAttachments: memo.attachments ?? [],
      owner: this,
      onSubmit: async ({ content, files }) => {
        const newAttachments = await this.uploadAttachments(files);
        const updated = await this.plugin.api.updateMemoContent(memo.name, content);
        if (newAttachments.length) {
          const attachments = [...(memo.attachments ?? []), ...newAttachments];
          await this.plugin.api.setMemoAttachments(updated.name, attachments);
          updated.attachments = attachments;
        }
        this.memos = this.memos.map((item) =>
          item.name === updated.name ? updated : item,
        );
        this.renderCards();
        new Notice("Memo updated.");
      },
    }).open();
  }

  private async uploadAttachments(files: File[]): Promise<MemosAttachment[]> {
    const attachments: MemosAttachment[] = [];

    for (const file of files) {
      attachments.push(await this.plugin.api.createAttachment(file));
    }

    return attachments;
  }

  private async clipWebPage(
    inputUrl: string,
    setStatus: (message: string) => void,
  ): Promise<MemosMemo> {
    setStatus("Fetching web page...");
    const page = await fetchWebClipPage(inputUrl, this.plugin.settings);

    setStatus("Generating summary...");
    const result = await summarizeWebClipPage(page, this.plugin.settings);
    const content = buildWebClipMemoContent(page, result.summary);
    const attachments: MemosAttachment[] = [];

    if (result.imageUrl) {
      try {
        setStatus("Saving hero image...");
        const image = await downloadWebClipImage(result.imageUrl, page.url, this.plugin.settings);
        attachments.push(
          await this.plugin.api.createAttachmentFromArrayBuffer(
            image.filename,
            image.type,
            image.content,
          ),
        );
      } catch (error) {
        new Notice(`Hero image failed: ${getErrorMessage(error)}`);
      }
    }

    setStatus("Saving memo...");
    return this.plugin.api.createMemo(content, attachments);
  }

  private openDeleteModal(memo: MemosMemo): void {
    new ConfirmModal(this.app, {
      title: "Delete memo",
      message: "This memo will be deleted from Memos.",
      confirmText: "Delete",
      onConfirm: async () => {
        await this.plugin.api.deleteMemo(memo.name);
        this.memos = this.memos.filter((item) => item.name !== memo.name);
        this.renderCards();
        this.setStatus(this.memos.length ? "" : "No memos found.");
        new Notice("Memo deleted.");
      },
    }).open();
  }

  private setStatus(message: string, isError = false): void {
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }

  private createActionButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    text?: string,
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: text ? "memos-button" : "memos-icon-button",
      attr: {
        type: "button",
        "aria-label": label,
        title: label,
      },
    });
    setIcon(button, icon);

    if (text) {
      button.createSpan({ text });
    }

    button.onclick = onClick;
    return button;
  }
}

class WebClipModal extends Modal {
  constructor(
    app: App,
    private readonly options: {
      onClip: (url: string, setStatus: (message: string) => void) => Promise<void>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("memos-modal");
    this.titleEl.setText("Clip web page");

    const input = this.contentEl.createEl("input", {
      cls: "memos-url-input",
      attr: {
        type: "url",
        placeholder: "https://example.com/article",
      },
    });

    const statusEl = this.contentEl.createDiv({ cls: "memos-clip-status" });
    const setStatus = (message: string) => {
      statusEl.setText(message);
    };

    const actions = this.contentEl.createDiv({ cls: "memos-modal-actions" });
    const cancelButton = actions.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    cancelButton.onclick = () => {
      this.close();
    };

    const submitButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "Clip",
      attr: { type: "button" },
    });

    const submit = async () => {
      const url = input.value.trim();
      if (!url) {
        new Notice("Web page URL is required.");
        return;
      }

      submitButton.disabled = true;
      cancelButton.disabled = true;
      try {
        await this.options.onClip(url, setStatus);
        this.close();
      } catch (error) {
        setStatus(getErrorMessage(error));
        new Notice(getErrorMessage(error));
      } finally {
        submitButton.disabled = false;
        cancelButton.disabled = false;
      }
    };

    submitButton.onclick = () => {
      void submit();
    };
    input.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    };
    input.focus();
  }
}

class MemoEditorModal extends Modal {
  constructor(
    app: App,
    private readonly options: {
      title: string;
      buttonText: string;
      initialContent: string;
      existingAttachments: MemosAttachment[];
      owner: Component;
      onSubmit: (payload: MemoEditorSubmit) => Promise<void>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("memos-modal");
    this.titleEl.setText(this.options.title);

    let selectedFiles: File[] = [];

    const editorShell = this.contentEl.createDiv({ cls: "memos-editor-shell" });
    const textarea = this.contentEl.createEl("textarea", {
      cls: "memos-editor",
      attr: {
        rows: "12",
        placeholder: "Write a memo...",
      },
    });
    textarea.value = this.options.initialContent;
    editorShell.appendChild(textarea);

    const preview = editorShell.createDiv({ cls: "memos-editor-preview" });
    const renderPreview = () => {
      preview.empty();
      const content = textarea.value.trim();

      if (!content) {
        preview.createEl("span", {
          cls: "memos-editor-preview-empty",
          text: "Preview",
        });
        return;
      }

      void MarkdownRenderer.render(this.app, content, preview, "", this.options.owner);
    };
    renderPreview();
    textarea.oninput = renderPreview;

    const attachmentSection = this.contentEl.createDiv({ cls: "memos-editor-attachments" });
    const attachmentHeader = attachmentSection.createDiv({ cls: "memos-editor-attachment-header" });
    attachmentHeader.createEl("span", { text: "Attachments" });

    const fileInput = attachmentHeader.createEl("input", {
      cls: "memos-file-input",
      attr: {
        type: "file",
        multiple: "true",
      },
    });

    const addFileButton = attachmentHeader.createEl("button", {
      cls: "memos-button",
      attr: { type: "button" },
    });
    setIcon(addFileButton, "paperclip");
    addFileButton.createSpan({ text: "Add files" });
    addFileButton.onclick = () => {
      fileInput.click();
    };

    const attachmentList = attachmentSection.createDiv({ cls: "memos-editor-attachment-list" });
    const renderSelectedFiles = () => {
      attachmentList.empty();

      for (const attachment of this.options.existingAttachments) {
        attachmentList.createEl("span", {
          cls: "memos-editor-attachment-chip",
          text: attachment.filename ?? attachment.name,
        });
      }

      for (const [index, file] of selectedFiles.entries()) {
        const chip = attachmentList.createDiv({ cls: "memos-editor-attachment-chip" });
        chip.createSpan({ text: `${file.name} (${formatFileSize(file.size)})` });
        const removeButton = chip.createEl("button", {
          cls: "memos-attachment-remove",
          attr: {
            type: "button",
            "aria-label": `Remove ${file.name}`,
            title: `Remove ${file.name}`,
          },
        });
        setIcon(removeButton, "x");
        removeButton.onclick = () => {
          selectedFiles = selectedFiles.filter((_, fileIndex) => fileIndex !== index);
          renderSelectedFiles();
        };
      }

      if (!this.options.existingAttachments.length && !selectedFiles.length) {
        attachmentList.createEl("span", {
          cls: "memos-editor-preview-empty",
          text: "No attachments",
        });
      }
    };

    fileInput.onchange = () => {
      selectedFiles = [...selectedFiles, ...Array.from(fileInput.files ?? [])];
      fileInput.value = "";
      renderSelectedFiles();
    };
    renderSelectedFiles();

    const actions = this.contentEl.createDiv({ cls: "memos-modal-actions" });
    const cancelButton = actions.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    cancelButton.onclick = () => {
      this.close();
    };

    const submitButton = actions.createEl("button", {
      cls: "mod-cta",
      text: this.options.buttonText,
      attr: { type: "button" },
    });

    const submit = async () => {
      const content = textarea.value.trim();
      if (!content && !selectedFiles.length && !this.options.existingAttachments.length) {
        new Notice("Memo content or attachment is required.");
        return;
      }

      submitButton.disabled = true;
      addFileButton.disabled = true;
      try {
        await this.options.onSubmit({
          content,
          files: selectedFiles,
        });
        this.close();
      } catch (error) {
        new Notice(getErrorMessage(error));
      } finally {
        submitButton.disabled = false;
        addFileButton.disabled = false;
      }
    };

    submitButton.onclick = () => {
      void submit();
    };
    textarea.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    };
    textarea.focus();
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly options: {
      title: string;
      message: string;
      confirmText: string;
      onConfirm: () => Promise<void>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("memos-modal");
    this.titleEl.setText(this.options.title);
    this.contentEl.createEl("p", { text: this.options.message });

    const actions = this.contentEl.createDiv({ cls: "memos-modal-actions" });
    const cancelButton = actions.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    cancelButton.onclick = () => {
      this.close();
    };

    const confirmButton = actions.createEl("button", {
      cls: "mod-warning",
      text: this.options.confirmText,
      attr: { type: "button" },
    });
    confirmButton.onclick = async () => {
      confirmButton.disabled = true;
      try {
        await this.options.onConfirm();
        this.close();
      } catch (error) {
        new Notice(getErrorMessage(error));
      } finally {
        confirmButton.disabled = false;
      }
    };
  }
}

class MemosSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: MemosCardPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Memos Card View" });

    new Setting(containerEl)
      .setName("Memos server URL")
      .setDesc("Base URL of your Memos instance.")
      .addText((text) => {
        text
          .setPlaceholder("https://memos.example.com")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Personal access token")
      .setDesc("Stored in Obsidian plugin data and sent as a Bearer token.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Paste your personal access token")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Page size")
      .setDesc("Number of memos to request per page.")
      .addSlider((slider) => {
        slider
          .setLimits(5, 100, 5)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.pageSize)
          .onChange(async (value) => {
            this.plugin.settings.pageSize = value;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          });
      });

    new Setting(containerEl)
      .setName("Local LLM base URL")
      .setDesc("OpenAI-compatible endpoint base URL used for web clipping.")
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:8080/v1")
          .setValue(this.plugin.settings.llmBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.llmBaseUrl = value.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Local LLM model")
      .setDesc("Model name sent to the OpenAI-compatible chat completions API.")
      .addText((text) => {
        text
          .setPlaceholder("qwen-local")
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            this.plugin.settings.llmModel = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Local LLM API key")
      .setDesc("Optional. Leave empty when the local model server does not require a key.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Optional")
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async (value) => {
            this.plugin.settings.llmApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Web clip cookie")
      .setDesc("Optional. Paste browser cookies for sites that reject anonymous clipping, such as Zhihu.")
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text
          .setPlaceholder("Optional Cookie header")
          .setValue(this.plugin.settings.webClipCookie)
          .onChange(async (value) => {
            this.plugin.settings.webClipCookie = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("System Chrome path")
      .setDesc("Optional. Used as a lightweight real-browser fallback for sites that block embedded/headless browsers.")
      .addText((text) => {
        text
          .setPlaceholder("Auto-detect Google Chrome")
          .setValue(this.plugin.settings.webClipChromePath)
          .onChange(async (value) => {
            this.plugin.settings.webClipChromePath = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }
}

async function fetchWebClipPage(
  inputUrl: string,
  settings: MemosPluginSettings,
): Promise<WebClipPage> {
  const url = normalizeWebUrl(inputUrl);
  const browserHtml = await fetchWebClipPageWithBrowser(url, settings);
  if (browserHtml) {
    return parseWebClipHtml(url, browserHtml);
  }

  const systemChromeHtml = await fetchWebClipPageWithSystemChrome(url, settings);
  if (systemChromeHtml) {
    return parseWebClipHtml(url, systemChromeHtml);
  }

  const response = await requestUrl({
    url,
    method: "GET",
    headers: webClipRequestHeaders(settings, url),
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    if (response.status === 403 && isZhihuUrl(url) && !settings.webClipCookie.trim()) {
      throw new Error("Zhihu returned 403. Configure Web clip cookie in plugin settings, then retry.");
    }

    throw new Error(`Web page request failed (${response.status}).`);
  }

  return parseWebClipHtml(url, response.text);
}

async function fetchWebClipPageWithBrowser(
  url: string,
  settings: MemosPluginSettings,
): Promise<string> {
  if (!Platform.isDesktopApp) {
    return "";
  }

  let win: ElectronBrowserWindow | null = null;
  try {
    const electron = require("electron") as ElectronModule;
    win = new electron.BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        images: true,
        javascript: true,
      },
    });

    await applyBrowserCookies(win, url, settings.webClipCookie);
    await win.loadURL(url, {
      userAgent: WEB_CLIP_USER_AGENT,
      httpReferrer: siteOrigin(url),
    });
    await delay(2500);

    const html = await win.webContents.executeJavaScript<string>(
      "document.documentElement ? document.documentElement.outerHTML : ''",
    );
    if (!html || isBlockedWebClipHtml(html)) {
      return "";
    }

    return html;
  } catch {
    return "";
  } finally {
    win?.destroy();
  }
}

async function fetchWebClipPageWithSystemChrome(
  url: string,
  settings: MemosPluginSettings,
): Promise<string> {
  if (!Platform.isDesktopApp) {
    return "";
  }

  const chromePath = findSystemChromePath(settings.webClipChromePath);
  if (!chromePath) {
    return "";
  }

  let target: ChromeDebugTarget | null = null;
  try {
    await ensureChromeDebugServer(chromePath);
    target = await openChromeDebugTarget(url);
    if (!target.webSocketDebuggerUrl) {
      return "";
    }

    return await waitForChromeReadablePage(target.webSocketDebuggerUrl);
  } catch {
    return "";
  } finally {
    if (target) {
      void closeChromeDebugTarget(target.id);
    }
  }
}

async function waitForChromeReadablePage(webSocketDebuggerUrl: string): Promise<string> {
  const deadline = Date.now() + WEB_CLIP_CHROME_READINESS_TIMEOUT_MS;
  let lastReadableHtml = "";

  while (Date.now() < deadline) {
    try {
      const snapshot = await evaluateChromeTarget<ChromeClipSnapshot>(
        webSocketDebuggerUrl,
        `(() => {
          const selectors = [
            "article",
            "main",
            "[role='main']",
            ".Post-RichTextContainer",
            ".RichContent-inner",
            ".RichText",
            ".Post-content"
          ];
          const readableContainer = selectors
            .map((selector) => document.querySelector(selector))
            .find(Boolean);
          const source = readableContainer || document.body || document.documentElement;
          const text = source
            ? ("innerText" in source ? source.innerText : source.textContent || "")
            : "";
          return {
            html: document.documentElement ? document.documentElement.outerHTML : "",
            title: document.title || "",
            text: text.slice(0, 6000),
            url: location.href,
            readyState: document.readyState,
            hasReadableContainer: !!readableContainer
          };
        })()`,
      );

      if (snapshot?.html && !isBlockedWebClipHtml(snapshot.html)) {
        lastReadableHtml = snapshot.html;
        if (isReadableChromeSnapshot(snapshot)) {
          return snapshot.html;
        }
      }
    } catch {
      // Navigation can briefly invalidate the debugging context; keep polling.
    }

    await delay(WEB_CLIP_CHROME_READINESS_POLL_MS);
  }

  return lastReadableHtml;
}

function isReadableChromeSnapshot(snapshot: ChromeClipSnapshot): boolean {
  const title = normalizeWhitespace(snapshot.title ?? "").toLowerCase();
  const text = normalizeWhitespace(snapshot.text ?? "");
  const ready = snapshot.readyState === "interactive" || snapshot.readyState === "complete";

  if (title.includes("403") || title.includes("forbidden")) {
    return false;
  }

  if (snapshot.hasReadableContainer && text.length >= 120) {
    return true;
  }

  if (text.length >= 800) {
    return true;
  }

  return ready && text.length >= 300;
}

async function ensureChromeDebugServer(chromePath: string): Promise<void> {
  if (await canReachChromeDebugServer()) {
    return;
  }

  launchChromeDebugServer(chromePath);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await canReachChromeDebugServer()) {
      return;
    }
    await delay(250);
  }

  throw new Error("System Chrome debugging server did not start.");
}

async function canReachChromeDebugServer(): Promise<boolean> {
  try {
    await chromeDebugJson<Record<string, unknown>>("/json/version");
    return true;
  } catch {
    return false;
  }
}

function launchChromeDebugServer(chromePath: string): void {
  const child = spawn(chromePath, [
    `--remote-debugging-port=${WEB_CLIP_CHROME_DEBUG_PORT}`,
    `--user-data-dir=${join(tmpdir(), "memos-card-view-headless-chrome")}`,
    "--headless=new",
    "--disable-gpu",
    "--window-size=1280,900",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function openChromeDebugTarget(url: string): Promise<ChromeDebugTarget> {
  return chromeDebugJson<ChromeDebugTarget>(`/json/new?${encodeURIComponent(url)}`, "PUT");
}

async function closeChromeDebugTarget(targetId: string): Promise<void> {
  await chromeDebugJson<Record<string, unknown>>(`/json/close/${targetId}`);
}

async function chromeDebugJson<T>(path: string, method = "GET"): Promise<T> {
  const response = await requestUrl({
    url: `http://127.0.0.1:${WEB_CLIP_CHROME_DEBUG_PORT}${path}`,
    method,
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Chrome debug request failed (${response.status}).`);
  }

  return response.json as T;
}

function evaluateChromeTarget<T>(webSocketUrl: string, expression: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = 1;
    const socket = new WebSocket(webSocketUrl);
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error("Chrome target evaluation timed out."));
    }, 10000);

    socket.onopen = () => {
      socket.send(JSON.stringify({
        id: requestId,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
      }));
    };

    socket.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Chrome target websocket failed."));
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ChromeEvalResponse<T>;
      if (message.id !== requestId) {
        return;
      }

      window.clearTimeout(timeout);
      socket.close();
      if (message.error?.message || message.result?.exceptionDetails) {
        reject(new Error(message.error?.message ?? "Chrome target evaluation failed."));
        return;
      }

      resolve(message.result?.result?.value as T);
    };
  });
}

function findSystemChromePath(configuredPath: string): string {
  if (configuredPath && existsSync(configuredPath)) {
    return configuredPath;
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

function isBlockedWebClipHtml(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = normalizeWhitespace(doc.title).toLowerCase();
  const body = normalizeWhitespace(doc.body?.textContent ?? "").toLowerCase();
  return title.includes("403")
    || title.includes("forbidden")
    || body.startsWith("403 forbidden")
    || body.includes("access denied")
    || body.includes('"code":40362')
    || body.includes("请求存在异常")
    || body.includes("暂时限制本次访问");
}

function parseWebClipHtml(url: string, html: string): WebClipPage {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = normalizeWhitespace(
    getMetaContent(doc, "meta[property='og:title']")
      || getMetaContent(doc, "meta[name='twitter:title']")
      || doc.title
      || url,
  );
  const description = normalizeWhitespace(
    getMetaContent(doc, "meta[name='description']")
      || getMetaContent(doc, "meta[property='og:description']")
      || getMetaContent(doc, "meta[name='twitter:description']"),
  );
  const imageCandidates = findImageCandidates(doc, url);
  const text = extractReadableText(doc, description);

  if (!text && !description) {
    throw new Error("No readable page content found.");
  }

  return {
    url: findCanonicalUrl(doc, url),
    title,
    description,
    text,
    imageCandidates,
  };
}

async function summarizeWebClipPage(
  page: WebClipPage,
  settings: MemosPluginSettings,
): Promise<WebClipSummary> {
  const baseUrl = settings.llmBaseUrl.trim().replace(/\/+$/, "");
  const model = settings.llmModel.trim();

  if (!baseUrl) {
    throw new Error("Local LLM base URL is not configured.");
  }

  if (!model) {
    throw new Error("Local LLM model is not configured.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.llmApiKey.trim()) {
    headers.Authorization = `Bearer ${settings.llmApiKey.trim()}`;
  }

  const response = await requestUrl({
    url: `${baseUrl}/chat/completions`,
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "你是一个网页剪藏助手。只根据用户提供的网页内容生成中文摘要，不要编造原文没有的信息。",
            "你还需要从用户提供的候选图片 URL 中选择最适合作为头图的一张。",
            "如果候选图片为空，或者没有合适图片，imageUrl 必须返回空字符串。",
            "只输出 JSON，格式为 {\"summary\":\"...\",\"imageUrl\":\"...\"}。",
          ].join(""),
        },
        {
          role: "user",
          content: [
            `标题：${page.title}`,
            page.description ? `网页描述：${page.description}` : "",
            `原文链接：${page.url}`,
            `候选图片URL：${page.imageCandidates.length ? page.imageCandidates.join("\n") : "无"}`,
            "",
            "请用 3-5 句话总结下面网页的核心内容，保留关键信息和结论：",
            truncateText(page.text, 12000),
          ].filter(Boolean).join("\n"),
        },
      ],
    }),
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    const body = response.text ? `: ${response.text.slice(0, 200)}` : "";
    throw new Error(`Local LLM request failed (${response.status})${body}`);
  }

  const data = response.json as OpenAiChatResponse;
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  const parsed = parseWebClipSummary(content);
  const summary = parsed.summary || page.description;
  const imageUrl = page.imageCandidates.includes(parsed.imageUrl) ? parsed.imageUrl : "";

  if (summary) {
    return {
      summary,
      imageUrl,
    };
  }

  throw new Error("Local LLM returned an empty summary.");
}

async function downloadWebClipImage(
  imageUrl: string,
  pageUrl: string,
  settings: MemosPluginSettings,
): Promise<DownloadedImage> {
  const url = resolveHttpUrl(imageUrl, pageUrl);
  const response = await requestUrl({
    url,
    method: "GET",
    headers: webClipRequestHeaders(settings, pageUrl),
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Image request failed (${response.status}).`);
  }

  const type = getResponseHeader(response.headers, "content-type")?.split(";")[0]?.trim()
    || guessImageType(url)
    || "application/octet-stream";

  if (!type.startsWith("image/")) {
    throw new Error(`Hero image is not an image (${type}).`);
  }

  return {
    filename: filenameFromUrl(url, type),
    type,
    content: response.arrayBuffer,
  };
}

function buildWebClipMemoContent(page: WebClipPage, summary: string): string {
  return [
    `## ${page.title || "Web clip"}`,
    "",
    summary.trim(),
    "",
    `原文：<${page.url}>`,
  ].join("\n");
}

function normalizeWebUrl(inputUrl: string): string {
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(inputUrl)
    ? inputUrl
    : `https://${inputUrl}`;
  const url = new URL(withProtocol);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }

  return url.toString();
}

function webClipRequestHeaders(
  settings: MemosPluginSettings,
  refererUrl: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": WEB_CLIP_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: siteOrigin(refererUrl),
  };

  if (settings.webClipCookie.trim()) {
    headers.Cookie = settings.webClipCookie.trim();
  }

  return headers;
}

async function applyBrowserCookies(
  win: ElectronBrowserWindow,
  url: string,
  cookieHeader: string,
): Promise<void> {
  const cookies = parseCookieHeader(cookieHeader);
  if (!cookies.length) {
    return;
  }

  const target = new URL(url);
  for (const cookie of cookies) {
    await win.webContents.session.cookies.set({
      url: target.origin,
      name: cookie.name,
      value: cookie.value,
      domain: target.hostname,
      path: "/",
      secure: target.protocol === "https:",
    });
  }
}

function parseCookieHeader(cookieHeader: string): Array<{ name: string; value: string }> {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) {
        return null;
      }

      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
      };
    })
    .filter((cookie): cookie is { name: string; value: string } => cookie !== null);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function siteOrigin(url: string): string {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return "";
  }
}

function isZhihuUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("zhihu.com");
  } catch {
    return false;
  }
}

function findCanonicalUrl(doc: Document, fallbackUrl: string): string {
  const canonical = doc.querySelector("link[rel='canonical']")?.getAttribute("href")?.trim();
  if (!canonical) {
    return fallbackUrl;
  }

  try {
    return resolveHttpUrl(canonical, fallbackUrl);
  } catch {
    return fallbackUrl;
  }
}

function getMetaContent(doc: Document, selector: string): string {
  return doc.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
}

function parseWebClipSummary(content: string): WebClipSummary {
  const fallback: WebClipSummary = {
    summary: content.trim(),
    imageUrl: "",
  };

  if (!content) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(extractJsonObject(content)) as Partial<WebClipSummary>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : fallback.summary,
      imageUrl: typeof parsed.imageUrl === "string" ? parsed.imageUrl.trim() : "",
    };
  } catch {
    return fallback;
  }
}

function extractJsonObject(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return content.slice(start, end + 1);
  }

  return content;
}

function findImageCandidates(doc: Document, pageUrl: string): string[] {
  const candidates: string[] = [];
  const metaImage = getMetaContent(doc, "meta[property='og:image']")
    || getMetaContent(doc, "meta[name='twitter:image']");

  if (metaImage) {
    try {
      candidates.push(resolveHttpUrl(metaImage, pageUrl));
    } catch {
      // Continue to regular image candidates.
    }
  }

  for (const image of Array.from(doc.querySelectorAll("img[src]"))) {
    const src = image.getAttribute("src")?.trim();
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) {
      continue;
    }

    try {
      candidates.push(resolveHttpUrl(src, pageUrl));
    } catch {
      continue;
    }
  }

  return Array.from(new Set(candidates)).slice(0, 12);
}

function extractReadableText(doc: Document, description: string): string {
  for (const element of Array.from(doc.querySelectorAll(
    "script, style, noscript, nav, header, footer, aside, form, button, svg, canvas, iframe",
  ))) {
    element.remove();
  }

  const root = doc.querySelector("article")
    || doc.querySelector("main")
    || doc.querySelector("[role='main']")
    || doc.querySelector(".post")
    || doc.querySelector(".article")
    || doc.querySelector(".content")
    || doc.body;
  const text = normalizeWhitespace(root?.textContent ?? "");
  return truncateText([description, text].filter(Boolean).join("\n\n"), 20000);
}

function resolveHttpUrl(inputUrl: string, baseUrl: string): string {
  const url = new URL(inputUrl, baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }

  return url.toString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n\n[Content truncated]`;
}

function filenameFromUrl(url: string, type: string): string {
  const pathname = new URL(url).pathname;
  const rawName = safeDecodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
  const extension = extensionFromType(type);

  if (!rawName) {
    return `web-clip-hero${extension}`;
  }

  if (/\.[a-z0-9]{2,5}$/i.test(rawName)) {
    return rawName;
  }

  return `${rawName}${extension}`;
}

function getResponseHeader(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return "";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function guessImageType(url: string): string {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".avif")) return "image/avif";
  return "";
}

function extensionFromType(type: string): string {
  if (type === "image/png") return ".png";
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/gif") return ".gif";
  if (type === "image/webp") return ".webp";
  if (type === "image/avif") return ".avif";
  return "";
}

function isImageAttachment(attachment: MemosAttachment): boolean {
  return (attachment.type ?? "").toLowerCase().startsWith("image/");
}

function formatDate(value?: string): string {
  if (!value) {
    return "Unknown date";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function arrayBufferToBase64(content: ArrayBuffer): string {
  const bytes = new Uint8Array(content);
  let binary = "";
  const chunkSize = 8192;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unexpected error.";
}
