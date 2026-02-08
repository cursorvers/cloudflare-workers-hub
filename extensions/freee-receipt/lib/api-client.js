const DEFAULT_CONFIG = {
  apiUrl: "https://orchestrator-hub.masa-stage1.workers.dev",
  apiToken: ""
};

const RETRY_DELAY_MS = 500;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStoredConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_CONFIG, (items) => resolve(items));
  });
}

async function fetchWithRetry(url, options, retries = 1) {
  const response = await fetch(url, options);
  if (response.status >= 500 && retries > 0) {
    await sleep(RETRY_DELAY_MS);
    return fetchWithRetry(url, options, retries - 1);
  }
  return response;
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function buildEndpoint(baseUrl, path) {
  const normalized = baseUrl.replace(/\/$/, "");
  return `${normalized}/${path}`;
}

function toIsoDate(date) {
  try {
    return new Date(date).toISOString().slice(0, 10);
  } catch (error) {
    return new Date().toISOString().slice(0, 10);
  }
}

function safeVendorName(metadata) {
  const site = (metadata?.site || "").toString().trim();
  if (site) return site.slice(0, 255);

  const pageUrl = (metadata?.pageUrl || "").toString().trim();
  try {
    const host = new URL(pageUrl).hostname;
    return (host || "unknown").slice(0, 255);
  } catch (error) {
    return "unknown";
  }
}

/**
 * Check if running in Service Worker context (background.js).
 * Service Worker has host_permissions and bypasses CORS.
 */
function isServiceWorker() {
  return typeof ServiceWorkerGlobalScope !== "undefined";
}

/**
 * Send a message to background.js and get a response.
 * Used by popup/options to proxy requests through the Service Worker.
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Upload a receipt file to the Workers API.
 * @param {File|Blob} file
 * @param {Record<string, string>} metadata
 * @returns {Promise<object>} API response.
 */
export async function uploadReceipt(file, metadata) {
  const { apiUrl, apiToken } = await getStoredConfig();

  if (!apiToken) {
    throw new Error("APIトークンが未設定です。設定画面で入力してください。");
  }

  const endpoint = buildEndpoint(apiUrl, "api/receipts/upload");
  const formData = new FormData();
  const fileName = file.name || "receipt.pdf";

  formData.append("file", file, fileName);
  // Worker expects manual-upload fields. The extension can't reliably extract
  // vendor/amount/date, so we send safe defaults:
  // - amount=0 forces "evidence-only" (skip deal creation)
  // - vendor_name derived from hostname/site
  // - transaction_date = today (ISO)
  formData.append("transaction_date", toIsoDate(Date.now()));
  formData.append("vendor_name", safeVendorName(metadata));
  formData.append("amount", "0");
  formData.append("currency", "JPY");
  formData.append("document_type", "invoice");
  // Preserve original metadata for debugging/future use (server may ignore it)
  formData.append("metadata", JSON.stringify(metadata || {}));

  const response = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`
    },
    body: formData
  });

  const payload = await readJsonSafe(response);

  if (response.status === 409) {
    return {
      duplicate: true,
      ...(payload || {})
    };
  }

  if (!response.ok) {
    const message = payload?.message || `アップロードに失敗しました (${response.status})`;
    throw new Error(message);
  }

  return payload || { ok: true };
}

/**
 * Check Workers API health endpoint.
 * When called from popup/options, proxies through background.js (Service Worker)
 * to bypass CORS restrictions.
 * @returns {Promise<{ok: boolean, status: number, message?: string}>}
 */
export async function checkHealth() {
  // If not in Service Worker, proxy through background.js
  if (!isServiceWorker()) {
    try {
      const response = await sendToBackground({ type: "checkHealth" });
      return response || { ok: false, status: 0, message: "No response" };
    } catch (error) {
      return { ok: false, status: 0, message: error.message };
    }
  }

  // Direct fetch from Service Worker (CORS bypassed via host_permissions)
  return checkHealthDirect();
}

/**
 * Direct health check (called from Service Worker context).
 * @returns {Promise<{ok: boolean, status: number, message?: string}>}
 */
export async function checkHealthDirect() {
  const { apiUrl } = await getStoredConfig();
  const endpoint = buildEndpoint(apiUrl, "health");

  try {
    const response = await fetchWithRetry(endpoint, { method: "GET" });
    const payload = await readJsonSafe(response);
    return {
      ok: response.ok,
      status: response.status,
      message: payload?.message
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error.message
    };
  }
}
