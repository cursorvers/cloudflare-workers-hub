import { checkHealth } from "../lib/api-client.js";

const DEFAULT_API_URL = "https://orchestrator-hub.masa-stage1.workers.dev";
const CANARY_API_URL = "https://orchestrator-hub-canary.masa-stage1.workers.dev";

const apiUrlInput = document.getElementById("api-url");
const apiTokenInput = document.getElementById("api-token");
const saveButton = document.getElementById("save-button");
const saveStatus = document.getElementById("save-status");
const canaryWarning = document.getElementById("canary-warning");
const genericModeCheckbox = document.getElementById("generic-mode");
const customRulesList = document.getElementById("custom-rules-list");
const addRuleButton = document.getElementById("add-rule-button");
const newRuleSite = document.getElementById("new-rule-site");
const newRuleHost = document.getElementById("new-rule-host");
const newRulePattern = document.getElementById("new-rule-pattern");

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

function renderCustomRules(rules) {
  customRulesList.innerHTML = "";

  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "hint muted";
    empty.textContent = "カスタムサイトはまだ登録されていません。";
    customRulesList.appendChild(empty);
    return;
  }

  rules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "rule-row";

    const info = document.createElement("span");
    info.className = "rule-info";
    info.textContent = `${rule.site} (${rule.host})`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "link-button danger";
    removeBtn.textContent = "削除";
    removeBtn.addEventListener("click", () => removeCustomRule(index));

    row.appendChild(info);
    row.appendChild(removeBtn);
    customRulesList.appendChild(row);
  });
}

async function loadSettings() {
  const settings = await new Promise((resolve) => {
    chrome.storage.local.get(
      {
        apiUrl: DEFAULT_API_URL,
        apiToken: "",
        genericMode: false,
        customBillingRules: []
      },
      (items) => resolve(items)
    );
  });

  apiUrlInput.value = settings.apiUrl || DEFAULT_API_URL;
  apiTokenInput.value = settings.apiToken || "";
  genericModeCheckbox.checked = settings.genericMode;
  maybeShowCanaryWarning(apiUrlInput.value);
  renderCustomRules(settings.customBillingRules);
}

async function saveSettings() {
  const apiUrl = apiUrlInput.value.trim() || DEFAULT_API_URL;
  const apiToken = apiTokenInput.value.trim();
  const genericMode = genericModeCheckbox.checked;

  await new Promise((resolve) => {
    chrome.storage.local.set({ apiUrl, apiToken, genericMode }, () => resolve());
  });

  const health = await checkHealth();
  if (health.ok) {
    setStatus("接続に成功しました。", false);
  } else {
    setStatus(health.message || "接続に失敗しました。", true);
  }
}

async function addCustomRule() {
  const site = newRuleSite.value.trim();
  const host = newRuleHost.value.trim();
  const pattern = newRulePattern.value.trim() || "\\/billing(\\/|$)";

  if (!site || !host) {
    return;
  }

  // Validate pattern is valid regex
  try {
    new RegExp(pattern);
  } catch (error) {
    setStatus(`無効な正規表現: ${error.message}`, true);
    return;
  }

  const { customBillingRules = [] } = await new Promise((resolve) => {
    chrome.storage.local.get({ customBillingRules: [] }, (items) => resolve(items));
  });

  // Prevent duplicate hosts
  if (customBillingRules.some((r) => r.host === host)) {
    setStatus(`${host} は既に登録されています。`, true);
    return;
  }

  const updatedRules = [
    ...customBillingRules,
    { site, host, patterns: [pattern] }
  ];

  await new Promise((resolve) => {
    chrome.storage.local.set({ customBillingRules: updatedRules }, () => resolve());
  });

  newRuleSite.value = "";
  newRuleHost.value = "";
  newRulePattern.value = "";
  renderCustomRules(updatedRules);
  setStatus(`${site} を追加しました。`, false);
}

async function removeCustomRule(index) {
  const { customBillingRules = [] } = await new Promise((resolve) => {
    chrome.storage.local.get({ customBillingRules: [] }, (items) => resolve(items));
  });

  const removed = customBillingRules[index];
  const updatedRules = customBillingRules.filter((_, i) => i !== index);

  await new Promise((resolve) => {
    chrome.storage.local.set({ customBillingRules: updatedRules }, () => resolve());
  });

  renderCustomRules(updatedRules);
  if (removed) {
    setStatus(`${removed.site} を削除しました。`, false);
  }
}

// Generic mode toggle - save immediately
genericModeCheckbox.addEventListener("change", async () => {
  const genericMode = genericModeCheckbox.checked;
  await new Promise((resolve) => {
    chrome.storage.local.set({ genericMode }, () => resolve());
  });

  if (genericMode) {
    // Request optional host permission for all HTTPS sites
    chrome.permissions.request(
      { origins: ["https://*/*"] },
      (granted) => {
        if (!granted) {
          genericModeCheckbox.checked = false;
          chrome.storage.local.set({ genericMode: false });
          setStatus("権限が付与されませんでした。汎用モードを無効にしました。", true);
        } else {
          setStatus("汎用モードを有効にしました。", false);
        }
      }
    );
  } else {
    setStatus("汎用モードを無効にしました。", false);
  }
});

apiUrlInput.addEventListener("input", () => {
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

addRuleButton.addEventListener("click", async () => {
  addRuleButton.disabled = true;
  try {
    await addCustomRule();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    addRuleButton.disabled = false;
  }
});

loadSettings();
