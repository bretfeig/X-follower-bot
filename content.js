// Content script: injects page-context runner and relays messages between popup <-> injected runner.

// Inject page-context script so fetch() runs with page origin (cookies included)
(function inject() {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.dataset.source = 'x-batch-follow';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (e) {
    // no-op
  }
})();

// Popup -> Content -> Page: forward commands
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Expect {type: 'START'|'STOP', usernames?: string[]}
  window.postMessage({ __x_bf: true, kind: 'CMD', payload: msg }, '*');
  sendResponse({ ok: true });
  return true;
});

// Page -> Content -> Popup: forward status updates
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || d.__x_bf !== true || d.kind !== 'STATUS') return;
  chrome.runtime.sendMessage(d);
});

