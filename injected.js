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

  function politeDelay(baseMs = 3000) {
    // 1.5x jitter around base, occasional long tail
    const jitter = randInt(-Math.floor(baseMs * 0.5), Math.floor(baseMs * 0.5));
    const longTail = Math.random() < 0.07 ? randInt(5000, 12000) : 0; // ~7% longer pause
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
    };
  }

  async function resolveUserId(username) {
    const url = `${ORIGIN}/i/api/1.1/users/show.json?screen_name=${encodeURIComponent(username)}`;
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: headersCommon(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`resolve ${username} failed ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    const id = data && (data.id_str || data.id);
    if (!id) throw new Error(`resolve ${username} returned no id`);
    return String(id);
  }

  async function followUserId(userId) {
    const url = `${ORIGIN}/i/api/1.1/friendships/create.json`;
    const body = new URLSearchParams({
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
      user_id: userId,
    }).toString();
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
      emitStatus({ phase: 'resolving', username, index, total, succeeded, failed, processed });
      let userId;
      try {
        userId = await resolveUserId(username);
      } catch (e) {
        failed += 1;
        processed += 1;
        emitStatus({ phase: 'resolve_error', username, index, total, error: String(e), succeeded, failed, processed });
        await sleep(politeDelay(4000));
        continue;
      }

      if (state.stopFlag) break;
      emitStatus({ phase: 'following', username, index, total, userId, succeeded, failed, processed });
      const result = await followUserId(userId);
      if (result.rateLimited) {
        emitStatus({ phase: 'rate_limited', username, index, total, waitMs: result.waitMs, succeeded, failed, processed });
        await sleep(result.waitMs);
        // try follow again after wait
        const retry = await followUserId(userId);
        if (!retry.ok) {
          failed += 1;
          processed += 1;
          emitStatus({ phase: 'follow_error', username, index, total, status: retry.status, body: retry.body, succeeded, failed, processed });
        } else {
          succeeded += 1;
          processed += 1;
          emitStatus({ phase: 'followed', username, index, total, succeeded, failed, processed });
        }
      } else if (!result.ok) {
        failed += 1;
        processed += 1;
        emitStatus({ phase: 'follow_error', username, index, total, status: result.status, body: result.body, succeeded, failed, processed });
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
