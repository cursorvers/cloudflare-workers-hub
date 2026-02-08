import { uploadReceipt, checkHealthDirect } from "./lib/api-client.js";
import { calculateSHA256 } from "./lib/hash.js";

const DEFAULT_TARGET_HOSTS = new Set([
  "dash.cloudflare.com",
  "vercel.com",
  "dashboard.heroku.com"
]);

const ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+0xGXNwAAAABJRU5ErkJggg==";

const STORAGE_KEYS = {
  recentUploads: "recentUploads",
  hashCache: "hashCache"
};

let genericModeEnabled = false;
let customTargetHosts = new Set();

/**
 * Load settings from chrome.storage.
 */
async function loadSettings() {
  const settings = await new Promise((resolve) => {
    chrome.storage.local.get(
      { genericMode: false, customBillingRules: [] },
      (items) => resolve(items)
    );
  });

  genericModeEnabled = settings.genericMode;

  // Build custom host set from user-defined rules
  customTargetHosts = new Set(
    (settings.customBillingRules || [])
      .filter((r) => r.host)
      .map((r) => r.host)
  );
}

// Load on startup
loadSettings();

// Reload when settings change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.genericMode || changes.customBillingRules) {
    loadSettings();
  }
});

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => resolve(items));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

function createNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: ICON_DATA_URL,
    title,
    message
  });
}

function isTargetUrl(url) {
  try {
    const parsed = new URL(url);
    if (DEFAULT_TARGET_HOSTS.has(parsed.hostname)) return true;
    if (customTargetHosts.has(parsed.hostname)) return true;
    if (genericModeEnabled) return true;
    return false;
  } catch (error) {
    return false;
  }
}

function isPdfCandidate(url, filename = "") {
  const lowerUrl = url.toLowerCase();
  const lowerName = filename.toLowerCase();
  return (
    lowerUrl.includes(".pdf") ||
    lowerName.endsWith(".pdf") ||
    lowerUrl.includes("invoice") ||
    lowerUrl.includes("receipt")
  );
}

function buildFileNameFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    const lastSegment = pathname.split("/").filter(Boolean).pop();
    if (lastSegment && lastSegment.toLowerCase().endsWith(".pdf")) {
      return lastSegment;
    }
  } catch (error) {
    // fall through
  }
  return "receipt.pdf";
}

async function updateRecentUploads(entry) {
  const { recentUploads = [] } = await storageGet(STORAGE_KEYS.recentUploads);
  const updated = [entry, ...recentUploads].slice(0, 10);
  await storageSet({ [STORAGE_KEYS.recentUploads]: updated });
}

async function isHashCached(hash) {
  const { hashCache = [] } = await storageGet(STORAGE_KEYS.hashCache);
  return hashCache.includes(hash);
}

async function storeHash(hash) {
  const { hashCache = [] } = await storageGet(STORAGE_KEYS.hashCache);
  if (hashCache.includes(hash)) {
    return;
  }
  const updated = [hash, ...hashCache].slice(0, 50);
  await storageSet({ [STORAGE_KEYS.hashCache]: updated });
}

/**
 * Validate that a URL is safe to fetch (HTTPS only, no internal/private).
 * @param {string} url
 * @returns {boolean}
 */
function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    // Block localhost and private IPs
    const host = parsed.hostname;
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.startsWith("10.") ||
      host.startsWith("172.") ||
      host.startsWith("192.168.")
    ) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Upload a file with SHA-256 dedup check.
 * @param {File} file
 * @param {object} metadata
 */
async function uploadFile(file, metadata) {
  const arrayBuffer = await file.arrayBuffer();
  const sha256 = await calculateSHA256(arrayBuffer);
  const duplicated = await isHashCached(sha256);
  const enrichedMetadata = {
    ...metadata,
    sha256,
    detectedAt: new Date().toISOString()
  };

  if (duplicated) {
    createNotification("重複を検出", "同じ領収書が既に送信されています。");
    await updateRecentUploads({
      fileName: file.name || "receipt.pdf",
      status: "duplicate",
      date: new Date().toISOString(),
      sha256
    });
    return { duplicate: true };
  }

  const result = await uploadReceipt(file, enrichedMetadata);

  if (result?.duplicate) {
    createNotification("重複を検出", "同じ領収書が既に送信されています。");
    await storeHash(sha256);
    await updateRecentUploads({
      fileName: file.name || "receipt.pdf",
      status: "duplicate",
      date: new Date().toISOString(),
      sha256
    });
    return result;
  }

  await storeHash(sha256);
  createNotification("アップロード成功", `${file.name || "receipt.pdf"} を送信しました。`);
  await updateRecentUploads({
    fileName: file.name || "receipt.pdf",
    status: "success",
    date: new Date().toISOString(),
    sha256
  });
  return result;
}

/**
 * Fetch a PDF from URL using the user's session cookies, then upload.
 * Validates URL safety and response Content-Type before upload.
 * @param {string} url
 * @param {object} metadata
 */
async function uploadFromUrl(url, metadata) {
  if (!isSafeUrl(url)) {
    throw new Error(`安全でないURLです: ${url}`);
  }

  const response = await fetch(url, {
    credentials: "include",
    redirect: "manual"
  });

  // Block redirects to different hosts
  if (response.type === "opaqueredirect") {
    throw new Error("リダイレクト先が検証できないためスキップしました。");
  }

  if (!response.ok) {
    throw new Error(`ダウンロードに失敗しました (${response.status})`);
  }

  // Validate Content-Type
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  const allowedTypes = [
    "application/pdf",
    "application/octet-stream",
    "binary/octet-stream"
  ];
  const isAllowedType = allowedTypes.some((t) => contentType.includes(t));
  const urlLooksLikePdf = url.toLowerCase().includes(".pdf");

  if (!isAllowedType && !urlLooksLikePdf) {
    throw new Error(`PDF以外のコンテンツです (${contentType})`);
  }

  // Size check (10MB max)
  const contentLength = parseInt(response.headers.get("Content-Length") || "0", 10);
  if (contentLength > 10 * 1024 * 1024) {
    throw new Error(`ファイルサイズが大きすぎます (${Math.round(contentLength / 1024 / 1024)}MB)`);
  }

  const arrayBuffer = await response.arrayBuffer();

  // Double-check actual size
  if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
    throw new Error(`ファイルサイズが大きすぎます (${Math.round(arrayBuffer.byteLength / 1024 / 1024)}MB)`);
  }

  const fileName = metadata.fileName || buildFileNameFromUrl(url);
  const file = new File([arrayBuffer], fileName, { type: "application/pdf" });
  return uploadFile(file, metadata);
}

async function handleDetectedLinks(message) {
  const { links = [], pageUrl, site } = message;
  if (!links.length) {
    return { uploaded: 0 };
  }

  let uploaded = 0;
  for (const link of links) {
    try {
      await uploadFromUrl(link, {
        source: "content-script",
        sourceUrl: link,
        pageUrl,
        site
      });
      uploaded += 1;
    } catch (error) {
      createNotification("アップロード失敗", error.message);
    }
  }

  return { uploaded };
}

/**
 * Inject content script into the active tab for generic mode scanning.
 * @param {number} tabId
 */
async function injectAndScan(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-scripts/detector.js"]
    });
    // After injection, send scan message
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "scanCurrentPage"
    });
    return response;
  } catch (error) {
    return { links: [], site: "Unknown", error: error.message };
  }
}

// Message handler from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "checkHealth") {
        const result = await checkHealthDirect();
        sendResponse(result);
        return;
      }

      if (message.type === "detectedLinks") {
        const result = await handleDetectedLinks(message);
        sendResponse({ ok: true, result });
        return;
      }

      if (message.type === "noPdfFound") {
        createNotification(
          "PDFが見つかりません",
          `${message.site} のページにPDFリンクが検出されませんでした。`
        );
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "manualUpload") {
        const { file, metadata = {} } = message;
        const result = await uploadFile(file, {
          ...metadata,
          source: "manual"
        });
        sendResponse({ ok: true, result });
        return;
      }

      if (message.type === "scanTab") {
        const result = await injectAndScan(message.tabId);
        sendResponse({ ok: true, result });
        return;
      }

      sendResponse({ ok: false, error: "未対応のメッセージです。" });
    } catch (error) {
      createNotification("アップロード失敗", error.message);
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});

// Monitor downloads from target domains
function searchDownloadItem(id) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id }, (items) => resolve(items?.[0]));
  });
}

async function handleDownloadComplete(downloadId) {
  const item = await searchDownloadItem(downloadId);
  if (!item || !item.url) {
    return;
  }

  if (!isTargetUrl(item.url)) {
    return;
  }

  if (!isPdfCandidate(item.url, item.filename)) {
    return;
  }

  try {
    await uploadFromUrl(item.url, {
      source: "download",
      sourceUrl: item.url,
      fileName: item.filename ? item.filename.split("/").pop() : undefined,
      pageUrl: item.referrer || "",
      site: new URL(item.url).hostname
    });
  } catch (error) {
    createNotification("アップロード失敗", error.message);
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === "complete") {
    handleDownloadComplete(delta.id);
  }
});
