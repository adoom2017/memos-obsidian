const DEFAULT_OPTIONS = {
  bridgeUrl: "http://127.0.0.1:27124",
  token: "",
  visibility: "PRIVATE",
};

const bridgeUrlInput = document.getElementById("bridge-url");
const tokenInput = document.getElementById("token");
const visibilitySelect = document.getElementById("visibility");
const saveButton = document.getElementById("save");
const statusEl = document.getElementById("status");

async function loadOptions() {
  const options = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  bridgeUrlInput.value = options.bridgeUrl;
  tokenInput.value = options.token;
  visibilitySelect.value = normalizeVisibility(options.visibility);
}

async function saveOptions() {
  const bridgeUrl = normalizeBridgeUrl(bridgeUrlInput.value);
  if (!bridgeUrl) {
    setStatus("Bridge URL is required.", true);
    return;
  }

  await chrome.storage.sync.set({
    bridgeUrl,
    token: tokenInput.value.trim(),
    visibility: normalizeVisibility(visibilitySelect.value),
  });
  setStatus("Saved.");
}

function normalizeBridgeUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeVisibility(value) {
  return value === "PUBLIC" ? "PUBLIC" : "PRIVATE";
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", isError);
}

saveButton.addEventListener("click", () => {
  void saveOptions();
});

void loadOptions();
