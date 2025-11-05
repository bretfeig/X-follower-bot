// Popup script: collect usernames, send to active X tab, and show status updates + progress.

function parseUsernames(text) {
  return (text || '')
    .split(/\r?\n/) 
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('@') ? s.slice(1) : s))
    .map((s) => s.replace(/[^A-Za-z0-9_]/g, ''));
}

async function getActiveXTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab');
  const url = (tab.url || '');
  if (!/https?:\/\/(x\.com|twitter\.com)\//.test(url)) {
    throw new Error('Open an X/Twitter tab and try again.');
  }
  return tab.id;
}

function updateStatus(s) {
  const el = document.getElementById('status');
  el.textContent = s;
}

const ui = {
  total: document.getElementById('total'),
  processed: document.getElementById('processed'),
  succeeded: document.getElementById('succeeded'),
  failed: document.getElementById('failed'),
  bar: document.getElementById('bar'),
  failList: document.getElementById('failList'),
};

const state = { total: 0, processed: 0, succeeded: 0, failed: 0, failures: [] };

function resetProgress(total = 0) {
  state.total = total;
  state.processed = 0;
  state.succeeded = 0;
  state.failed = 0;
  state.failures = [];
  renderProgress();
}

function renderProgress() {
  ui.total.textContent = String(state.total);
  ui.processed.textContent = String(state.processed);
  ui.succeeded.textContent = String(state.succeeded);
  ui.failed.textContent = String(state.failed);
  const pct = state.total > 0 ? Math.min(100, Math.round((state.processed / state.total) * 100)) : 0;
  ui.bar.style.width = pct + '%';
  // failures list
  ui.failList.innerHTML = '';
  for (const f of state.failures) {
    const li = document.createElement('li');
    li.textContent = `${f.username}: ${f.reason}`;
    ui.failList.appendChild(li);
  }
}

document.getElementById('start').addEventListener('click', async () => {
  const usernames = parseUsernames(document.getElementById('usernames').value);
  if (!usernames.length) {
    updateStatus('Provide at least one username.');
    return;
  }
  try {
    const tabId = await getActiveXTab();
    await chrome.tabs.sendMessage(tabId, { type: 'START', usernames });
    resetProgress(usernames.length);
    updateStatus(`Sent ${usernames.length} usernames…`);
  } catch (e) {
    updateStatus(String(e.message || e));
  }
});

document.getElementById('stop').addEventListener('click', async () => {
  try {
    const tabId = await getActiveXTab();
    await chrome.tabs.sendMessage(tabId, { type: 'STOP' });
    updateStatus('Stop requested…');
  } catch (e) {
    updateStatus(String(e.message || e));
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.__x_bf !== true || msg.kind !== 'STATUS') return;
  const p = msg.payload || {};
  const base = `[${p.phase || 'status'}]`;
  if (p.phase === 'starting') {
    state.total = p.total || 0; state.processed = p.processed || 0; state.succeeded = p.succeeded || 0; state.failed = p.failed || 0; renderProgress();
    updateStatus(`${base} total=${state.total}`);
  } else if (p.phase === 'resolving') {
    state.total = p.total || state.total; state.processed = p.processed ?? state.processed; renderProgress();
    updateStatus(`${base} ${p.username} (${p.index || '?'} / ${p.total || state.total})`);
  } else if (p.phase === 'resolve_error') {
    state.total = p.total || state.total; state.processed = p.processed || state.processed; state.failed = p.failed || state.failed; renderProgress();
    const reason = (p.error || '').toString().slice(0, 120);
    state.failures.push({ username: p.username, reason });
    renderProgress();
    updateStatus(`${base} ${p.username} err=${reason}`);
  } else if (p.phase === 'following') {
    state.total = p.total || state.total; renderProgress();
    updateStatus(`${base} ${p.username} id=${p.userId} (${p.index || '?'} / ${p.total || state.total})`);
  } else if (p.phase === 'follow_error') {
    state.total = p.total || state.total; state.processed = p.processed || state.processed; state.failed = p.failed || state.failed; renderProgress();
    const reason = ((p.status ? `status ${p.status}` : '') + (p.body ? ` ${String(p.body).slice(0, 80)}` : '')).trim();
    state.failures.push({ username: p.username, reason });
    renderProgress();
    updateStatus(`${base} ${p.username} ${reason}`);
  } else if (p.phase === 'followed') {
    state.total = p.total || state.total; state.processed = p.processed || state.processed; state.succeeded = p.succeeded || state.succeeded; renderProgress();
    updateStatus(`${base} ${p.username} ✓ (${state.succeeded}/${state.processed})`);
  } else if (p.phase === 'rate_limited') {
    updateStatus(`${base} waiting ${(Math.round((p.waitMs||0)/1000))}s`);
  } else if (p.phase === 'done') {
    state.total = p.total || state.total; state.processed = p.processed || state.processed; state.succeeded = p.succeeded || state.succeeded; state.failed = p.failed || state.failed; renderProgress();
    updateStatus(`${base} success=${state.succeeded} fail=${state.failed}`);
  } else if (p.phase === 'already_running') {
    updateStatus(`${base} already running`);
  } else if (p.phase === 'empty_list') {
    updateStatus(`${base} provide usernames`);
  } else if (p.phase === 'fatal_error') {
    updateStatus(`${base} ${p.error}`);
  } else if (p.phase === 'stopping') {
    updateStatus(`${base} stopping…`);
  }
});
