// lib/snapshot.js — HTML/CSS snapshot capture and cleanup
// Captures chat content from Antigravity via CDP, cleans up artifacts

const cdp = require('./cdp');

/** Multi-selector support: tries #cascade, #chat, #conversation in order */
const CHAT_SELECTORS = ['#cascade', '#chat', '#conversation'];

/** Extract metadata about the active page: chat elements, title, window info */
async function extractMetadata(conn) {
    return cdp.evaluate(conn, `
    (() => {
      const selectors = ${JSON.stringify(CHAT_SELECTORS)};
      let chatEl = null;
      let matchedSelector = null;

      for (const sel of selectors) {
        chatEl = document.querySelector(sel);
        if (chatEl) { matchedSelector = sel; break; }
      }

      if (!chatEl) return null;

      // Find the active/visible chat tab for title
      const titleEl = document.querySelector('[class*="title"]') ||
                      document.querySelector('.tab.active') ||
                      document.querySelector('[aria-selected="true"]');

      return {
        selector: matchedSelector,
        title: titleEl?.textContent?.trim() || document.title || 'Chat',
        hasChat: true
      };
    })()
  `);
}

/** Capture the chat HTML with aggressive cleanup */
async function captureHTML(conn) {
    return cdp.evaluate(conn, `
    (() => {
      const selectors = ${JSON.stringify(CHAT_SELECTORS)};
      let chatEl = null;

      for (const sel of selectors) {
        chatEl = document.querySelector(sel);
        if (chatEl) break;
      }

      if (!chatEl) return { html: '', bodyBg: '#1a1a1a' };

      // Clone to avoid mutating the live DOM
      const clone = chatEl.cloneNode(true);

      // === CLEANUP PASS ===

      // 1. Remove Monaco editor artifacts (scrollbars, minimap, overlays)
      clone.querySelectorAll([
        '.monaco-scrollable-element',
        '.minimap', '.minimap-shadow',
        '.scrollbar', '.invisible-scrollbar',
        '.slider', '.scroll-decoration',
        '.overflowingContentWidgets',
        '.overlayWidgets', '.view-overlays',
        '.margin-view-overlays',
        '.decorationsOverviewRuler',
        '.lines-content .view-line[style*="top"]', // Virtual scroll spacers
        '[class*="cursor-line"]',
        '[class*="selected-text"]'
      ].join(',')).forEach(el => el.remove());

      // 2. Remove input containers, footers, and floating menus
      clone.querySelectorAll([
        '[class*="input-container"]',
        '[class*="composer"]',
        '[class*="footer"]',
        '[class*="context-menu"]',
        '[class*="quick-input"]'
      ].join(',')).forEach(el => el.remove());

      // 3. Neutralize massive height spacers from virtualized lists
      clone.querySelectorAll('div[style]').forEach(el => {
        const h = parseInt(el.style.height);
        if (h > 5000) el.style.height = 'auto';
      });

      // 4. Strip inline styles that break mobile rendering
      clone.querySelectorAll('[style*="position: absolute"]').forEach(el => {
        if (!el.closest('pre') && !el.closest('code')) {
          el.style.position = '';
        }
      });

      // 5. Annotate clickable buttons for click passthrough
      let clickIndex = 0;
      const clickMap = {};
      clone.querySelectorAll([
        'button',
        'div[role="button"]',
        'div.cursor-pointer',
        '[class*="btn"]',
        '[class*="action"]'
      ].join(',')).forEach(btn => {
        const text = btn.textContent?.trim();
        if (!text || text.length > 80) return;

        const idx = clickIndex++;
        btn.setAttribute('data-cdp-click', idx);
        clickMap[idx] = {
          text: text.substring(0, 50),
          tag: btn.tagName,
          classes: btn.className?.substring?.(0, 100) || ''
        };
      });

      const bodyBg = getComputedStyle(document.body).backgroundColor || '#1a1a1a';

      return {
        html: clone.innerHTML,
        bodyBg,
        clickMap,
        clickCount: clickIndex
      };
    })()
  `);
}

/** Capture relevant CSS stylesheets, scoped for our viewport */
async function captureCSS(conn) {
    return cdp.evaluate(conn, `
    (async () => {
      const sheets = [];

      for (const sheet of document.styleSheets) {
        try {
          // Same-origin sheets: read rules directly
          const rules = [...sheet.cssRules].map(r => r.cssText);
          sheets.push(rules.join('\\n'));
        } catch (_) {
          // Cross-origin sheets: fetch the href if available
          if (sheet.href) {
            try {
              const res = await fetch(sheet.href);
              if (res.ok) sheets.push(await res.text());
            } catch (__) {}
          }
        }
      }

      // Scope all CSS under #chat-viewport to prevent style leaks
      let combined = sheets.join('\\n');

      // Basic scoping: wrap body/html selectors
      combined = combined
        .replace(/\\bbody\\b/g, '#chat-viewport')
        .replace(/\\bhtml\\b/g, '#chat-viewport');

      return combined;
    })()
  `);
}

/** Extract quota data from the Antigravity quota-watcher extension */
async function extractQuota(conn) {
    return cdp.evaluate(conn, `
    (() => {
      // Look for the quota watcher custom element
      const quotaEl = document.querySelector('wusimpl.antigravity-quota-watcher') ||
                      document.querySelector('[class*="quota"]') ||
                      document.querySelector('[data-quota]');

      if (!quotaEl) return null;

      try {
        // Try parsing JSON data attribute first
        const raw = quotaEl.getAttribute('data-quota') || quotaEl.textContent;
        const data = JSON.parse(raw);

        return {
          statusText: data.statusText || null,
          models: (data.models || []).map(m => ({
            label: m.label || m.name || 'Unknown',
            percentage: m.percentage ?? null,
            resetTime: m.resetTime || m.reset_time || ''
          }))
        };
      } catch (_) {
        return null;
      }
    })()
  `);
}

/** Click a button in the remote page by its click-map index */
async function clickElement(conn, clickIndex) {
    return cdp.evaluate(conn, `
    (() => {
      // Re-discover clickable elements in the same order as captureHTML
      const buttons = document.querySelectorAll(
        'button, div[role="button"], div.cursor-pointer, [class*="btn"], [class*="action"]'
      );

      let idx = 0;
      for (const btn of buttons) {
        const text = btn.textContent?.trim();
        if (!text || text.length > 80) continue;
        if (idx === ${clickIndex}) {
          btn.click();
          return { success: true, text: text.substring(0, 50) };
        }
        idx++;
      }

      return { success: false, error: 'Button not found at index ${clickIndex}' };
    })()
  `);
}

/** Inject a message into the chat input and submit it */
async function injectMessage(conn, text) {
    // Escape the text for safe JS string embedding
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

    return cdp.evaluate(conn, `
    (() => {
      // Try multiple input selectors (Antigravity evolves its UI)
      const selectors = [
        '.ProseMirror[contenteditable="true"]',
        'textarea[class*="input"]',
        'div[contenteditable="true"]',
        'textarea'
      ];

      let input = null;
      for (const sel of selectors) {
        input = document.querySelector(sel);
        if (input) break;
      }

      if (!input) return { success: false, error: 'No input element found' };

      // Focus the input
      input.focus();

      if (input.classList.contains('ProseMirror') || input.contentEditable === 'true') {
        // ProseMirror / contenteditable: use execCommand for proper event dispatch
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, '${escaped}');
      } else {
        // Standard textarea
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;
        if (nativeSetter) nativeSetter.call(input, '${escaped}');
        else input.value = '${escaped}';

        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Simulate Enter key to submit
      setTimeout(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        }));
      }, 100);

      return { success: true };
    })()
  `, { timeout: 5000 });
}

/** Click the "new conversation" button */
async function newConversation(conn) {
    return cdp.evaluate(conn, `
    (() => {
      // Common new-chat button selectors
      const selectors = [
        'button[aria-label*="new"]',
        'button[title*="new"]',
        'button[title*="New"]',
        '[class*="new-chat"]',
        '[class*="newChat"]',
        '[class*="new-conversation"]'
      ];

      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          return { success: true };
        }
      }
      return { success: false, error: 'New conversation button not found' };
    })()
  `);
}

module.exports = { extractMetadata, captureHTML, captureCSS, extractQuota, clickElement, injectMessage, newConversation };
