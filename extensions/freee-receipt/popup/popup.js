import { checkHealth } from "../lib/api-client.js";

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const recentList = document.getElementById("recent-list");
const manualFile = document.getElementById("manual-file");
const uploadButton = document.getElementById("upload-button");
const uploadStatus = document.getElementById("upload-status");
const optionsLink = document.getElementById("options-link");

function setStatus(ok, message) {
  statusDot.classList.toggle("ok", ok);
  statusDot.classList.toggle("ng", !ok);
  statusText.textContent = message;
}

function setUploadStatus(message, isError = false) {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle("error", isError);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

async function loadRecentUploads() {
  const { recentUploads = [] } = await new Promise((resolve) => {
    chrome.storage.local.get({ recentUploads: [] }, (items) => resolve(items));
  });

  recentList.innerHTML = "";

  if (!recentUploads.length) {
    const empty = document.createElement("li");
    empty.textContent = "まだアップロード履歴がありません。";
    empty.className = "muted";
    recentList.appendChild(empty);
    return;
  }

  recentUploads.forEach((entry) => {
    const item = document.createElement("li");
    const date = new Date(entry.date).toLocaleString("ja-JP");
    item.innerHTML = `
      <div class="recent-name">${entry.fileName}</div>
      <div class="recent-meta">${date} ・ ${entry.status}</div>
    `;
    recentList.appendChild(item);
  });
}

async function refreshStatus() {
  const result = await checkHealth();
  if (result.ok) {
    setStatus(true, "接続OK");
  } else {
    setStatus(false, result.message || "接続NG");
  }
}

uploadButton.addEventListener("click", async () => {
  const file = manualFile.files?.[0];
  if (!file) {
    setUploadStatus("PDFファイルを選択してください。", true);
    return;
  }

  uploadButton.disabled = true;
  setUploadStatus("アップロード中...", false);

  const response = await sendMessage({
    type: "manualUpload",
    file,
    metadata: {
      fileName: file.name
    }
  });

  if (response?.ok) {
    setUploadStatus("アップロード完了しました。", false);
    manualFile.value = "";
    await loadRecentUploads();
  } else {
    setUploadStatus(response?.error || "アップロードに失敗しました。", true);
  }

  uploadButton.disabled = false;
});

optionsLink.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refreshStatus();
loadRecentUploads();
