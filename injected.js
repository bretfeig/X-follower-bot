// Runs in page context. Uses the logged-in session to resolve usernames and follow them.
// Notes:
// - This uses the public web app's endpoints (1.1) the browser already calls.
// - It sets headers similarly to the site and lets the browser include cookies.
// - Includes basic pacing and error handling. Use responsibly; may violate platform ToS.

(function () {
  if (window.__x_bf_injected) return; // idempotent inject
  window.__x_bf_injected = true;

  const ORIGIN = location.origin.replace('twitter.com', 'x.com'); // normalize
  const AUTH_BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const state = {
    running: false,
    stopFlag: false,
    current: null,
    pacing: { baseMs: 2000, jitterRatio: 0.5, longTailProb: 0.05, longTailMinMs: 5000, longTailMaxMs: 12000 },
  };

  function emitStatus(obj) {
    window.postMessage({ __x_bf: true, kind: 'STATUS', payload: obj }, '*');
  }

  function parseCt0() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function politeDelay(baseMs = state.pacing.baseMs) {
    const p = state.pacing || {};
    const jr = typeof p.jitterRatio === 'number' ? p.jitterRatio : 0.5;
    const ltP = typeof p.longTailProb === 'number' ? p.longTailProb : 0.05;
    const ltMin = typeof p.longTailMinMs === 'number' ? p.longTailMinMs : 5000;
    const ltMax = typeof p.longTailMaxMs === 'number' ? p.longTailMaxMs : 12000;
    const jitter = randInt(-Math.floor(baseMs * jr), Math.floor(baseMs * jr));
    const longTail = Math.random() < ltP ? randInt(ltMin, ltMax) : 0;
    return baseMs + jitter + longTail;
  }

  function sanitizeUsernames(list) {
    return list
      .map((s) => (s || '').trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('@') ? s.slice(1) : s))
      .map((s) => s.replace(/[^A-Za-z0-9_]/g, ''));
  }

  function headersCommon() {
    const ct0 = parseCt0();
    return {
      'accept': '*/*',
      'authorization': AUTH_BEARER,
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': ct0 || '',
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': navigator.language || 'en',
    };
  }

  async function resolveUserIdViaShow(username) {
    const url = `${ORIGIN}/i/api/1.1/users/show.json?screen_name=${encodeURIComponent(username)}`;
    const res = await fetch(url, { method: 'GET', credentials: 'include', headers: headersCommon() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: text.slice(0, 240) };
    }
    const data = await res.json();
    const id = data && (data.id_str || data.id);
    if (!id) return { ok: false, status: 200, body: 'no id in response' };
    return { ok: true, id: String(id) };
  }

  async function resolveUserIdViaLookup(username) {
    const url = `${ORIGIN}/i/api/1.1/users/lookup.json?screen_name=${encodeURIComponent(username)}`;
    const res = await fetch(url, { method: 'GET', credentials: 'include', headers: headersCommon() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: text.slice(0, 240) };
    }
    const data = await res.json().catch(() => null);
    const first = Array.isArray(data) && data.length ? data[0] : null;
    const id = first && (first.id_str || first.id);
    if (!id) return { ok: false, status: 200, body: 'no id in array' };
    return { ok: true, id: String(id) };
  }

  async function resolveUser(username) {
    // Try /users/show first
    let r = await resolveUserIdViaShow(username);
    if (r.ok) return { id: r.id, screen_name: username, method: 'show' };
    emitStatus({ phase: 'resolve_fallback', username, hint: 'show_failed', status: r.status, body: r.body });
    // Fallback to /users/lookup
    r = await resolveUserIdViaLookup(username);
    if (r.ok) return { id: r.id, screen_name: username, method: 'lookup' };
    emitStatus({ phase: 'resolve_fallback', username, hint: 'lookup_failed', status: r.status, body: r.body });
    // Try GraphQL if path discovered
    r = await resolveUserIdViaGraphQL(username);
    if (r.ok) return { id: r.id, screen_name: username, method: 'graphql' };
    emitStatus({ phase: 'resolve_fallback', username, hint: 'graphql_failed', status: r.status, body: r.body });
    // Last resort: profile HTML scrape
    r = await resolveUserIdViaProfileHtml(username);
    if (r.ok) return { id: r.id, screen_name: username, method: 'html' };
    emitStatus({ phase: 'resolve_fallback', username, hint: 'html_failed', status: r.status, body: r.body });
    return null;
  }

  async function followUser(target) {
    const url = `${ORIGIN}/i/api/1.1/friendships/create.json`;
    const params = {
      include_profile_interstitial_type: '1',
      include_blocking: '1',
      include_blocked_by: '1',
      include_followed_by: '1',
      include_want_retweets: '1',
      include_mute_edge: '1',
      include_can_dm: '1',
      include_can_media_tag: '1',
      include_ext_is_blue_verified: '1',
      include_ext_verified_type: '1',
      include_ext_profile_image_shape: '1',
      skip_status: '1',
    };
    if (target && target.id) params.user_id = String(target.id);
    else if (target && target.screen_name) params.screen_name = String(target.screen_name);
    const body = new URLSearchParams(params).toString();
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: headersCommon(),
      body,
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const waitMs = retryAfter ? (retryAfter * 1000) : randInt(60_000, 180_000);
      return { ok: false, rateLimited: true, waitMs };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: text.slice(0, 240) };
    }

    // The API returns relationship info; we don't strictly need to parse
    return { ok: true };
  }

  async function runBatch(usernames) {
    state.running = true;
    state.stopFlag = false;
    const total = usernames.length;
    let succeeded = 0;
    let failed = 0;
    let processed = 0;
    emitStatus({ phase: 'starting', total, succeeded, failed, processed });
    for (let i = 0; i < usernames.length; i++) {
      if (state.stopFlag) break;
      const username = usernames[i];
      const index = i + 1;
      // First, attempt to follow directly by screen_name (web endpoint supports this)
      emitStatus({ phase: 'following', username, index, total, userId: undefined, succeeded, failed, processed, note: 'direct_by_screen_name' });
      let target = { screen_name: username };
      let result = await followUser(target);
      if (result.rateLimited) {
        emitStatus({ phase: 'rate_limited', username, index, total, waitMs: result.waitMs, succeeded, failed, processed });
        await sleep(result.waitMs);
        // try follow again after wait
        const retry = await followUser(target);
        if (!retry.ok) {
          // Fallback to resolving user id then retry
          emitStatus({ phase: 'resolving', username, index, total, succeeded, failed, processed, note: 'fallback_after_rate_limit_retry_failed' });
          try {
            const resolved = await resolveUser(username);
            if (resolved) {
              target = resolved;
              const retry2 = await followUser(target);
              if (!retry2.ok) {
                failed += 1;
                processed += 1;
                emitStatus({ phase: 'follow_error', username, index, total, status: retry2.status, body: retry2.body, succeeded, failed, processed });
              } else {
                succeeded += 1;
                processed += 1;
                emitStatus({ phase: 'followed', username, index, total, succeeded, failed, processed });
              }
            } else {
              failed += 1;
              processed += 1;
              emitStatus({ phase: 'resolve_error', username, index, total, error: 'resolution returned null', succeeded, failed, processed });
            }
          } catch (e) {
            failed += 1;
            processed += 1;
            emitStatus({ phase: 'resolve_error', username, index, total, error: String(e), succeeded, failed, processed });
          }
        } else {
          succeeded += 1;
          processed += 1;
          emitStatus({ phase: 'followed', username, index, total, succeeded, failed, processed });
        }
      } else if (!result.ok) {
        // Try to resolve user id and follow again
        emitStatus({ phase: 'resolving', username, index, total, succeeded, failed, processed, note: 'fallback_after_direct_failed' });
        try {
          const resolved = await resolveUser(username);
          if (!resolved) {
            failed += 1;
            processed += 1;
            emitStatus({ phase: 'resolve_error', username, index, total, error: 'resolution returned null', succeeded, failed, processed });
          } else {
            target = resolved;
            emitStatus({ phase: 'following', username, index, total, userId: target.id, succeeded, failed, processed, note: 'by_id_after_resolve' });
            const res2 = await followUser(target);
            if (!res2.ok) {
              failed += 1;
              processed += 1;
              emitStatus({ phase: 'follow_error', username, index, total, status: res2.status, body: res2.body, succeeded, failed, processed });
            } else {
              succeeded += 1;
              processed += 1;
              emitStatus({ phase: 'followed', username, index, total, succeeded, failed, processed });
            }
          }
        } catch (e) {
          failed += 1;
          processed += 1;
          emitStatus({ phase: 'resolve_error', username, index, total, error: String(e), succeeded, failed, processed });
        }
      } else {
        succeeded += 1;
        processed += 1;
        emitStatus({ phase: 'followed', username, index, total, succeeded, failed, processed });
      }

      if (state.stopFlag) break;
      await sleep(politeDelay(3000));
    }

    state.running = false;
    emitStatus({ phase: 'done', total, succeeded, failed, processed });
  }

  window.addEventListener('message', (evt) => {
    const data = evt.data;
    if (!data || data.__x_bf !== true || data.kind !== 'CMD') return;
    const msg = data.payload || {};
    if (msg.type === 'START') {
      if (state.running) {
        emitStatus({ phase: 'already_running' });
        return;
      }
      const usernames = sanitizeUsernames(Array.isArray(msg.usernames) ? msg.usernames : []);
      if (msg.settings && typeof msg.settings === 'object') {
        state.pacing = Object.assign({}, state.pacing, msg.settings);
      }
      if (!usernames.length) {
        emitStatus({ phase: 'empty_list' });
        return;
      }
      emitStatus({ phase: 'starting', total: usernames.length, succeeded: 0, failed: 0, processed: 0 });
      runBatch(usernames).catch((e) => emitStatus({ phase: 'fatal_error', error: String(e) }));
    } else if (msg.type === 'STOP') {
      state.stopFlag = true;
      emitStatus({ phase: 'stopping' });
    }
  });
})();
  // GraphQL discovery (non-invasive): capture seen /i/api/graphql/* endpoints
  const discovery = { userByScreenNamePath: null };
  try {
    const origFetch = window.fetch;
    window.fetch = function(resource, init) {
      const res = origFetch.apply(this, arguments);
      try {
        res.then((r) => {
          const url = (typeof resource === 'string') ? resource : (resource && resource.url) || '';
          if (url.includes('/i/api/graphql/') && url.includes('/UserByScreenName')) {
            try {
              const u = new URL(url);
              discovery.userByScreenNamePath = u.pathname; // /i/api/graphql/<id>/UserByScreenName
            } catch { /* ignore */ }
          }
          return r;
        }).catch(() => {});
      } catch { /* ignore */ }
      return res;
    };
  } catch { /* ignore */ }

  async function resolveUserIdViaGraphQL(username) {
    if (!discovery.userByScreenNamePath) return { ok: false, status: 0, body: 'no gql path discovered' };
    const variables = {
      screen_name: username,
      withSafetyModeUserFields: true,
      withHighlightedLabel: true,
    };
    const url = `${ORIGIN}${discovery.userByScreenNamePath}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
    const res = await fetch(url, { method: 'GET', credentials: 'include', headers: headersCommon() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: text.slice(0, 240) };
    }
    const data = await res.json().catch(() => null);
    const id = data && data.data && data.data.user && data.data.user.result && (data.data.user.result.rest_id || data.data.user.result.legacy && data.data.user.result.legacy.id_str);
    if (!id) return { ok: false, status: 200, body: 'no rest_id in gql' };
    return { ok: true, id: String(id) };
  }

  async function resolveUserIdViaProfileHtml(username) {
    const url = `${ORIGIN}/${encodeURIComponent(username)}`;
    const res = await fetch(url, { method: 'GET', credentials: 'include', headers: { 'accept': 'text/html,*/*' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: text.slice(0, 240) };
    }
    const html = await res.text();
    // Try to find a rest_id near the screen_name occurrence or any rest_id
    let m = html.match(/\"rest_id\":\"(\d{3,})\"/);
    if (!m) {
      // Alternate embedding
      m = html.match(/\"id_str\":\"(\d{3,})\"/);
    }
    if (!m) return { ok: false, status: 200, body: 'no rest_id in html' };
    return { ok: true, id: String(m[1]) };
  }
