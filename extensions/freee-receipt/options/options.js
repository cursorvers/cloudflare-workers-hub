import { checkHealth } from "../lib/api-client.js";

const DEFAULT_API_URL = "https://orchestrator-hub.masa-stage1.workers.dev";
const CANARY_API_URL = "https://orchestrator-hub-canary.masa-stage1.workers.dev";

const apiUrlInput = document.getElementById("api-url");
const apiTokenInput = document.getElementById("api-token");
const saveButton = document.getElementById("save-button");
const saveStatus = document.getElementById("save-status");
const canaryWarning = document.getElementById("canary-warning");

function setStatus(message, isError = false) {
  saveStatus.textContent = message;
  saveStatus.classList.toggle("error", isError);
}

function setCanaryWarning(message) {
  if (!canaryWarning) return;
  const msg = (message || "").trim();
  canaryWarning.textContent = msg;
  canaryWarning.hidden = !msg;
}

function maybeShowCanaryWarning(apiUrl) {
  const normalized = (apiUrl || "").trim().replace(/\/$/, "");
  if (!normalized) {
    setCanaryWarning("");
    return;
  }
  if (normalized === CANARY_API_URL) {
    setCanaryWarning(
      "注意: canaryは設定によってread-onlyです。アップロード等(POST)が403になる場合は、Workers側で CANARY_WRITE_ENABLED=true を有効化してください。",
    );
    return;
  }
  setCanaryWarning("");
}

async function loadSettings() {
  const { apiUrl, apiToken } = await new Promise((resolve) => {
    chrome.storage.local.get(
      {
        apiUrl: DEFAULT_API_URL,
        apiToken: ""
      },
      (items) => resolve(items)
    );
  });

  apiUrlInput.value = apiUrl || DEFAULT_API_URL;
  apiTokenInput.value = apiToken || "";
  maybeShowCanaryWarning(apiUrlInput.value);
}

async function saveSettings() {
  const apiUrl = apiUrlInput.value.trim() || DEFAULT_API_URL;
  const apiToken = apiTokenInput.value.trim();

  await new Promise((resolve) => {
    chrome.storage.local.set({ apiUrl, apiToken }, () => resolve());
  });

  const health = await checkHealth();
  if (health.ok) {
    setStatus("接続に成功しました。", false);
  } else {
    setStatus(health.message || "接続に失敗しました。", true);
  }
}

apiUrlInput.addEventListener("input", () => {
  // Non-blocking UX hint only.
  maybeShowCanaryWarning(apiUrlInput.value);
});

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  setStatus("保存中...", false);
  try {
    await saveSettings();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    saveButton.disabled = false;
  }
});

loadSettings();
