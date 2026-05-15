const DEFAULT_OPTIONS = {
  bridgeUrl: "http://127.0.0.1:27124",
  token: "",
  visibility: "PRIVATE",
};

const clipButton = document.getElementById("clip");
const visibilitySelect = document.getElementById("visibility");
const statusEl = document.getElementById("status");
const optionsButton = document.getElementById("open-options");

let options = DEFAULT_OPTIONS;

async function loadOptions() {
  options = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  visibilitySelect.value = normalizeVisibility(options.visibility);
}

async function clipCurrentPage() {
  if (!options.token.trim()) {
    setStatus("Configure the bridge token first.", true);
    chrome.runtime.openOptionsPage();
    return;
  }

  clipButton.disabled = true;
  setStatus("Extracting page...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    const [{ result: page }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractCurrentPage,
    });

    if (!page?.text && !page?.description) {
      throw new Error("No readable page content found.");
    }

    setStatus("Sending to Obsidian...");
    const response = await fetch(`${normalizeBridgeUrl(options.bridgeUrl)}/clip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: options.token.trim(),
        visibility: normalizeVisibility(visibilitySelect.value),
        page,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Bridge request failed (${response.status}).`);
    }

    await chrome.storage.sync.set({ visibility: normalizeVisibility(visibilitySelect.value) });
    setStatus("Saved to Memos.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Clip failed.", true);
  } finally {
    clipButton.disabled = false;
  }
}

function extractCurrentPage() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function resolveImageUrl(image) {
    const src = image.getAttribute("data-src")
      || image.getAttribute("data-original")
      || image.getAttribute("data-backsrc")
      || image.currentSrc
      || image.src;
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) {
      return "";
    }

    try {
      return new URL(src, location.href).toString();
    } catch {
      return "";
    }
  }

  function collectVisibleImageUrls() {
    const urls = [];
    for (const image of Array.from(document.images)) {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      const visible = rect.width >= 40
        && rect.height >= 40
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0";
      if (!visible) {
        continue;
      }

      const src = resolveImageUrl(image);
      if (src) {
        urls.push(src);
      }
    }

    return Array.from(new Set(urls));
  }

  const clone = document.documentElement.cloneNode(true);
  for (const element of Array.from(clone.querySelectorAll(
    "script, style, noscript, nav, header, footer, aside, form, button, svg, canvas, iframe",
  ))) {
    element.remove();
  }

  const description = normalizeText(
    document.querySelector("meta[name='description']")?.content
      || document.querySelector("meta[property='og:description']")?.content
      || document.querySelector("meta[name='twitter:description']")?.content,
  );
  const canonical = document.querySelector("link[rel='canonical']")?.href || location.href;
  const title = normalizeText(
    document.querySelector("meta[property='og:title']")?.content
      || document.querySelector("meta[name='twitter:title']")?.content
      || document.title
      || canonical,
  );
  const liveRoot = document.querySelector("article, main, [role='main'], #js_content, .rich_media_content")
    || document.body
    || document.documentElement;
  const cloneRoot = clone.querySelector("article, main, [role='main'], #js_content, .rich_media_content")
    || clone;
  const text = normalizeText(
    liveRoot?.innerText
      || liveRoot?.textContent
      || cloneRoot?.textContent
      || description,
  ).slice(0, 50000);

  return {
    url: canonical,
    title,
    description,
    text,
    imageCandidates: collectVisibleImageUrls().slice(0, 12),
  };
}

function normalizeBridgeUrl(value) {
  return String(value || DEFAULT_OPTIONS.bridgeUrl).trim().replace(/\/+$/, "");
}

function normalizeVisibility(value) {
  return value === "PUBLIC" ? "PUBLIC" : "PRIVATE";
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", isError);
}

clipButton.addEventListener("click", () => {
  void clipCurrentPage();
});
visibilitySelect.addEventListener("change", () => {
  options.visibility = normalizeVisibility(visibilitySelect.value);
});
optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

void loadOptions();
