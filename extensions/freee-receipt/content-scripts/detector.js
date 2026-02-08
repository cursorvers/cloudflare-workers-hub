/**
 * Receipt Detector - Content Script
 *
 * Detects PDF invoice/receipt links on billing pages.
 * Supports:
 *   1. Built-in rules (Cloudflare, Vercel, Heroku)
 *   2. User-defined custom rules (via options page)
 *   3. Generic mode (any site, user-triggered)
 */

const DEFAULT_BILLING_RULES = [
  {
    site: "Cloudflare",
    host: "dash.cloudflare.com",
    patterns: ["\\/billing(\\/|$)"]
  },
  {
    site: "Vercel",
    host: "vercel.com",
    patterns: ["\\/invoices(\\/|$)", "\\/settings\\/billing(\\/|$)"]
  },
  {
    site: "Heroku",
    host: "dashboard.heroku.com",
    patterns: ["\\/account\\/billing(\\/|$)"]
  }
];

let billingRules = [...DEFAULT_BILLING_RULES];
let genericModeEnabled = false;

/**
 * Load rules and settings from chrome.storage.
 */
async function loadSettings() {
  const settings = await new Promise((resolve) => {
    chrome.storage.local.get(
      { customBillingRules: [], genericMode: false },
      (items) => resolve(items)
    );
  });

  genericModeEnabled = settings.genericMode;

  // Merge default + custom rules
  const customRules = (settings.customBillingRules || []).filter(
    (r) => r.host && r.site
  );
  billingRules = [...DEFAULT_BILLING_RULES, ...customRules];
}

/**
 * Check if the current URL matches a billing page.
 * @param {string} url
 * @returns {string|null} Site name or null.
 */
function matchBillingPage(url) {
  try {
    const parsed = new URL(url);
    const rule = billingRules.find((item) => item.host === parsed.hostname);
    if (!rule) {
      return null;
    }
    const matched = rule.patterns.some((pattern) =>
      new RegExp(pattern).test(parsed.pathname)
    );
    return matched ? rule.site : null;
  } catch (error) {
    return null;
  }
}

/**
 * Derive a site name from a URL hostname.
 * @param {string} url
 * @returns {string}
 */
function siteNameFromUrl(url) {
  try {
    const { hostname } = new URL(url);
    // Strip common prefixes: dash., dashboard., console., app., www.
    const cleaned = hostname.replace(
      /^(dash\.|dashboard\.|console\.|app\.|www\.)/,
      ""
    );
    // Capitalize first letter of domain
    const domain = cleaned.split(".")[0];
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  } catch (error) {
    return "Unknown";
  }
}

/**
 * Extract PDF-like links from the page DOM.
 * @returns {string[]} Unique PDF link URLs.
 */
function extractPdfLinks() {
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const links = anchors
    .map((anchor) => anchor.href)
    .filter((href) =>
      [".pdf", "invoice", "receipt", "billing", "statement"].some((keyword) =>
        href.toLowerCase().includes(keyword)
      )
    );
  return Array.from(new Set(links));
}

/**
 * Send detected PDF links to the background service worker.
 * @param {string} reason - "auto" or "manual-click"
 */
function sendDetectedLinks(reason = "auto") {
  const site =
    matchBillingPage(window.location.href) ||
    (genericModeEnabled ? siteNameFromUrl(window.location.href) : null);

  if (!site) {
    return;
  }

  const links = extractPdfLinks();
  if (!links.length) {
    if (reason === "manual-click") {
      // Notify user that no PDFs were found
      chrome.runtime.sendMessage({
        type: "noPdfFound",
        pageUrl: window.location.href,
        site
      });
    }
    return;
  }

  chrome.runtime.sendMessage({
    type: "detectedLinks",
    site,
    pageUrl: window.location.href,
    links,
    reason
  });
}

/**
 * Inject the floating action button (FAB) into the page.
 */
function ensureFab() {
  if (document.getElementById("receipt-uploader-fab")) {
    return;
  }

  const button = document.createElement("button");
  button.id = "receipt-uploader-fab";
  button.type = "button";
  button.className = "receipt-fab";

  const icon = document.createElement("span");
  icon.className = "receipt-fab-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "\uD83D\uDCC4";

  const text = document.createElement("span");
  text.className = "receipt-fab-text";
  text.textContent = "freee に送信";

  button.appendChild(icon);
  button.appendChild(text);
  button.addEventListener("click", () => sendDetectedLinks("manual-click"));

  document.body.appendChild(button);
}

function handlePage() {
  const isKnownBillingPage = matchBillingPage(window.location.href);

  if (isKnownBillingPage) {
    ensureFab();
    sendDetectedLinks("auto");
    return;
  }

  // Generic mode: show FAB on any page that has PDF links
  if (genericModeEnabled) {
    const links = extractPdfLinks();
    if (links.length > 0) {
      ensureFab();
    }
  }
}

// Listen for messages from popup/background to trigger scan on current page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "scanCurrentPage") {
    const links = extractPdfLinks();
    const site =
      matchBillingPage(window.location.href) ||
      siteNameFromUrl(window.location.href);
    sendResponse({ links, site, pageUrl: window.location.href });
    return true;
  }
});

// SPA navigation detection (URL polling)
let lastUrl = window.location.href;
setInterval(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    handlePage();
  }
}, 1000);

// Initialize
loadSettings().then(() => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handlePage, { once: true });
  } else {
    handlePage();
  }
});
