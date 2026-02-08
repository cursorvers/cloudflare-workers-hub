const BILLING_RULES = [
  {
    site: "Cloudflare",
    host: "dash.cloudflare.com",
    patterns: [/\/billing(\/|$)/]
  },
  {
    site: "Vercel",
    host: "vercel.com",
    patterns: [/\/invoices(\/|$)/, /\/settings\/billing(\/|$)/]
  },
  {
    site: "Heroku",
    host: "dashboard.heroku.com",
    patterns: [/\/account\/billing(\/|$)/]
  }
];

/**
 * Check if the current URL matches a billing page.
 * @param {string} url
 * @returns {string|null} Site name or null.
 */
function matchBillingPage(url) {
  try {
    const parsed = new URL(url);
    const rule = BILLING_RULES.find((item) => item.host === parsed.hostname);
    if (!rule) {
      return null;
    }
    const matched = rule.patterns.some((pattern) => pattern.test(parsed.pathname));
    return matched ? rule.site : null;
  } catch (error) {
    return null;
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
      [".pdf", "invoice", "receipt"].some((keyword) =>
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
  const site = matchBillingPage(window.location.href);
  if (!site) {
    return;
  }
  const links = extractPdfLinks();
  if (!links.length) {
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
  button.innerHTML = `
    <span class="receipt-fab-icon" aria-hidden="true">📄</span>
    <span class="receipt-fab-text">freee に送信</span>
  `;
  button.addEventListener("click", () => sendDetectedLinks("manual-click"));

  document.body.appendChild(button);
}

function handlePage() {
  if (!matchBillingPage(window.location.href)) {
    return;
  }
  ensureFab();
  sendDetectedLinks("auto");
}

// SPA navigation detection (URL polling)
let lastUrl = window.location.href;
setInterval(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    handlePage();
  }
}, 1000);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", handlePage, { once: true });
} else {
  handlePage();
}
