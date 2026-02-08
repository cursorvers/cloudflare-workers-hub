import { checkHealth } from "../lib/api-client.js";

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const recentList = document.getElementById("recent-list");
const manualFile = document.getElementById("manual-file");
const uploadButton = document.getElementById("upload-button");
const uploadStatus = document.getElementById("upload-status");
const optionsLink = document.getElementById("options-link");
const scanButton = document.getElementById("scan-button");
const scanStatus = document.getElementById("scan-status");

function setStatus(ok, message) {
  statusDot.classList.toggle("ok", ok);
  statusDot.classList.toggle("ng", !ok);
  statusText.textContent = message;
}

function setUploadStatus(message, isError = false) {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle("error", isError);
}

function setScanStatus(message, isError = false) {
  scanStatus.textContent = message;
  scanStatus.classList.toggle("error", isError);
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

    const nameDiv = document.createElement("div");
    nameDiv.className = "recent-name";
    nameDiv.textContent = entry.fileName || "receipt.pdf";

    const metaDiv = document.createElement("div");
    metaDiv.className = "recent-meta";
    metaDiv.textContent = `${date} ・ ${entry.status}`;

    item.appendChild(nameDiv);
    item.appendChild(metaDiv);
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

async function scanCurrentPage() {
  scanButton.disabled = true;
  setScanStatus("スキャン中...", false);

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setScanStatus("タブが取得できません。", true);
      return;
    }

    // Inject content script and scan
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-scripts/detector.js"]
      });
    } catch (error) {
      // Script may already be injected, continue
    }

    // Small delay to let the script initialize
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Request scan results
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "scanCurrentPage"
    });

    if (!response || !response.links || response.links.length === 0) {
      setScanStatus("PDFリンクが見つかりませんでした。", true);
      return;
    }

    setScanStatus(`${response.links.length}件のPDFを検出中...`, false);

    // Send links to background for upload
    const uploadResult = await sendMessage({
      type: "detectedLinks",
      site: response.site,
      pageUrl: response.pageUrl,
      links: response.links,
      reason: "popup-scan"
    });

    if (uploadResult?.ok) {
      const count = uploadResult.result?.uploaded || 0;
      setScanStatus(`${count}件アップロードしました。`, false);
      await loadRecentUploads();
    } else {
      setScanStatus(uploadResult?.error || "アップロードに失敗しました。", true);
    }
  } catch (error) {
    setScanStatus(error.message || "スキャンに失敗しました。", true);
  } finally {
    scanButton.disabled = false;
  }
}

scanButton.addEventListener("click", scanCurrentPage);

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
