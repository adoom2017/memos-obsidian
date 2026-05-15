import {
  App,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  RequestUrlParam,
  Setting,
  WorkspaceLeaf,
  requestUrl,
  setIcon,
} from "obsidian";

const MEMOS_VIEW_TYPE = "memos-card-view";
type MemosViewLocation = "main" | "right";

interface MemosPluginSettings {
  baseUrl: string;
  token: string;
  pageSize: number;
}

interface MemosAttachment {
  name: string;
  filename?: string;
  externalLink?: string;
  type?: string;
  size?: string | number;
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

const DEFAULT_SETTINGS: MemosPluginSettings = {
  baseUrl: "https://memos.adoom-cloud.top:1443",
  token: "",
  pageSize: 20,
};

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

  async createMemo(content: string): Promise<MemosMemo> {
    return this.request<MemosMemo>({
      url: this.url("/memos"),
      method: "POST",
      body: JSON.stringify({
        content,
        visibility: "PRIVATE",
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
      onSubmit: async (content) => {
        const created = await this.plugin.api.createMemo(content);
        this.memos = [created, ...this.memos];
        this.renderCards();
        this.setStatus("");
        new Notice("Memo created.");
      },
    }).open();
  }

  private openEditModal(memo: MemosMemo): void {
    new MemoEditorModal(this.app, {
      title: "Edit memo",
      buttonText: "Save",
      initialContent: memo.content ?? "",
      onSubmit: async (content) => {
        const updated = await this.plugin.api.updateMemoContent(memo.name, content);
        this.memos = this.memos.map((item) =>
          item.name === updated.name ? updated : item,
        );
        this.renderCards();
        new Notice("Memo updated.");
      },
    }).open();
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

class MemoEditorModal extends Modal {
  constructor(
    app: App,
    private readonly options: {
      title: string;
      buttonText: string;
      initialContent: string;
      onSubmit: (content: string) => Promise<void>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("memos-modal");
    this.titleEl.setText(this.options.title);

    const textarea = this.contentEl.createEl("textarea", {
      cls: "memos-editor",
      attr: {
        rows: "12",
        placeholder: "Write a memo...",
      },
    });
    textarea.value = this.options.initialContent;

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
      if (!content) {
        new Notice("Memo content is required.");
        return;
      }

      submitButton.disabled = true;
      try {
        await this.options.onSubmit(content);
        this.close();
      } catch (error) {
        new Notice(getErrorMessage(error));
      } finally {
        submitButton.disabled = false;
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
  }
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unexpected error.";
}
