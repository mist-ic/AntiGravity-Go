// lib/snapshot.js — HTML/CSS snapshot capture and cleanup
// Captures chat content from Antigravity via CDP, cleans up artifacts

const cdp = require('./cdp');

/** Multi-selector support: tries several selectors to find the chat panel.
 *  #conversation is preferred — it contains only messages, not the input area */
const CHAT_SELECTORS = [
  '#conversation',
  '#cascade',
  '[class*="chat-panel"]',
  '[class*="chat-container"]',
  '[class*="aichat"]',
  '[class*="ai-chat"]',
  '[class*="conversation-"]',
  '#chat',  // last resort — includes input area, model selector, etc.
];

/** Extract metadata about the active page: chat elements, title, window info */
async function extractMetadata(conn) {
  return cdp.evaluate(conn, `
    (() => {
      const selectors = ${JSON.stringify(CHAT_SELECTORS)};
      let chatEl = null;
      let matchedSelector = null;

      for (const sel of selectors) {
        try {
          chatEl = document.querySelector(sel);
          if (chatEl) { matchedSelector = sel; break; }
        } catch(_) {}
      }

      if (!chatEl) return null;

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

/** Discover DOM structure — used to find the right selector */
async function discoverDOM(conn) {
  return cdp.evaluate(conn, `
    (() => {
      // Find ALL elements with 'cascade' in class
      const cascadeEls = [...document.querySelectorAll('[class*="cascade"]')];
      const cascadeInfo = cascadeEls.slice(0, 30).map(el => ({
        tag: el.tagName,
        id: el.id || '',
        class: (el.className || '').substring(0, 120),
        children: el.children.length,
        textLen: el.innerText?.length || 0,
        rect: (() => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()
      }));

      // Find all elements with 'message' or 'chat' in class 
      const messageEls = [...document.querySelectorAll('[class*="message"], [class*="chat"], [class*="thread"]')];
      const messageInfo = messageEls.slice(0, 20).map(el => ({
        tag: el.tagName,
        id: el.id || '',
        class: (el.className || '').substring(0, 120),
        children: el.children.length,
        textLen: el.innerText?.length || 0
      }));

      // All IDs on the page
      const allIds = [...document.querySelectorAll('[id]')].slice(0, 50).map(e => e.id);

      return { cascadeEls: cascadeInfo, messageEls: messageInfo, ids: allIds };
    })()
  `);
}

/** Capture the chat HTML with aggressive cleanup */
async function captureHTML(conn) {
  return cdp.evaluate(conn, `
    (() => {
      const selectors = ${JSON.stringify(CHAT_SELECTORS)};
      let chatEl = null;
      let matchedSelector = null;

      for (const sel of selectors) {
        try {
          chatEl = document.querySelector(sel);
          if (chatEl) { matchedSelector = sel; break; }
        } catch(_) {}
      }

      if (!chatEl) {
        return { html: '', bodyBg: '#1a1a1a' };
      }

      // Clone to avoid mutating the live DOM
      const clone = chatEl.cloneNode(true);

      // === CLEANUP PASS ===

      // 1. Remove Monaco editor artifacts
      clone.querySelectorAll([
        '.minimap', '.minimap-shadow',
        '.scrollbar', '.invisible-scrollbar',
        '.slider', '.scroll-decoration',
        '.overflowingContentWidgets',
        '.overlayWidgets', '.view-overlays',
        '.margin-view-overlays',
        '.decorationsOverviewRuler',
        '.lines-content .view-line[style*="top"]',
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
        clickCount: clickIndex,
        matchedSelector
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
          const rules = [...sheet.cssRules];
          for (const rule of rules) {
            // Skip @font-face with local file URLs (won't load on phone)
            if (rule.type === CSSRule.FONT_FACE_RULE) {
              const cssText = rule.cssText;
              if (cssText.includes('vscode-file:') || cssText.includes('file:')) continue;
              sheets.push(cssText);
              continue;
            }

            // Skip @import rules
            if (rule.type === CSSRule.IMPORT_RULE) continue;

            // Handle @keyframes — keep as-is (no scoping needed)
            if (rule.type === CSSRule.KEYFRAMES_RULE) {
              sheets.push(rule.cssText);
              continue;
            }

            // Handle @media — scope rules inside
            if (rule.type === CSSRule.MEDIA_RULE) {
              const innerRules = [...rule.cssRules].map(r => {
                if (r.selectorText) {
                  const scoped = r.selectorText.split(',').map(s => {
                    s = s.trim();
                    if (s === 'body' || s === 'html' || s === ':root') return '#chat-viewport .rc';
                    if (s.startsWith('body ') || s.startsWith('html ')) return '#chat-viewport .rc ' + s.substring(s.indexOf(' ') + 1);
                    return '#chat-viewport .rc ' + s;
                  }).join(', ');
                  return scoped + ' { ' + r.style.cssText + ' }';
                }
                return r.cssText;
              }).join('\\n');
              sheets.push('@media ' + rule.conditionText + ' { ' + innerRules + ' }');
              continue;
            }

            // Regular style rules — scope the selector
            if (rule.selectorText) {
              const scoped = rule.selectorText.split(',').map(s => {
                s = s.trim();
                if (s === 'body' || s === 'html' || s === ':root') return '#chat-viewport .rc';
                if (s.startsWith('body ') || s.startsWith('html ')) return '#chat-viewport .rc ' + s.substring(s.indexOf(' ') + 1);
                if (s.startsWith(':root ')) return '#chat-viewport .rc ' + s.substring(6);
                return '#chat-viewport .rc ' + s;
              }).join(', ');
              sheets.push(scoped + ' { ' + rule.style.cssText + ' }');
              continue;
            }

            // Fallback — keep as-is
            sheets.push(rule.cssText);
          }
        } catch (_) {
          // Cross-origin sheet — skip (can't scope it properly)
        }
      }

      return sheets.join('\\n');
    })()
  `);
}

/** Extract quota data from the Antigravity quota-watcher extension */
async function extractQuota(conn) {
  return cdp.evaluate(conn, `
    (() => {
      const quotaEl = document.querySelector('wusimpl.antigravity-quota-watcher') ||
                      document.querySelector('[class*="quota"]') ||
                      document.querySelector('[data-quota]');

      if (!quotaEl) return null;

      try {
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
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

  return cdp.evaluate(conn, `
    (() => {
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

      input.focus();

      if (input.classList.contains('ProseMirror') || input.contentEditable === 'true') {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, '${escaped}');
      } else {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;
        if (nativeSetter) nativeSetter.call(input, '${escaped}');
        else input.value = '${escaped}';

        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

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
/** Scroll the desktop chat to the bottom via CDP.
 *  Forces Antigravity's virtualized list to render the latest messages. */
async function scrollChatToBottom(conn) {
  return cdp.evaluate(conn, `
    (() => {
      // Try different scrollable containers
      const scrollable = document.querySelector('#conversation') ||
                         document.querySelector('[class*="conversation"]') ||
                         document.querySelector('#chat');
      if (!scrollable) return false;
      scrollable.scrollTop = scrollable.scrollHeight;
      return true;
    })()
  `);
}

/** Scroll the desktop chat to a specific ratio (0=top, 1=bottom).
 *  Used when the phone user scrolls — syncs position to desktop so
 *  the virtualized renderer loads that section. */
async function scrollChat(conn, ratio) {
  return cdp.evaluate(conn, `
    (() => {
      const scrollable = document.querySelector('#conversation') ||
                         document.querySelector('[class*="conversation"]') ||
                         document.querySelector('#chat');
      if (!scrollable) return false;
      const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
      scrollable.scrollTop = Math.round(maxScroll * ${Math.max(0, Math.min(1, ratio))});
      return true;
    })()
  `);
}

/** Get scroll info from the desktop chat (for sync feedback). */
async function getScrollInfo(conn) {
  return cdp.evaluate(conn, `
    (() => {
      const scrollable = document.querySelector('#conversation') ||
                         document.querySelector('[class*="conversation"]') ||
                         document.querySelector('#chat');
      if (!scrollable) return null;
      return {
        scrollTop: scrollable.scrollTop,
        scrollHeight: scrollable.scrollHeight,
        clientHeight: scrollable.clientHeight
      };
    })()
  `);
}

module.exports = { extractMetadata, captureHTML, captureCSS, extractQuota, clickElement, injectMessage, newConversation, discoverDOM, scrollChatToBottom, scrollChat, getScrollInfo };
