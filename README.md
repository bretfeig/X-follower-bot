X Batch Follow (Local-only)
===========================

Summary
-------
- Batch-follow a list of X (Twitter) usernames from your logged-in browser session.
- Uses page-context fetch with cookies so requests look like normal web app calls.
- Adds polite, randomized delays and simple rate-limit handling.

Important
---------
- Use at your own risk. Automating follows may violate platform Terms; accounts can be rate-limited or penalized.
- This extension does not exfiltrate tokens. It runs entirely in your browser context and never sends data elsewhere.

Files
-----
- extension/manifest.json
- extension/content.js
- extension/injected.js
- extension/popup.html
- extension/popup.js
- extension/tests/delay.test.js

Load the Extension
------------------
1) Open Chrome → chrome://extensions
2) Enable "Developer mode"
3) Click "Load unpacked" and select the `extension/` directory in this repo
4) Open an X/Twitter tab (x.com) and click the extension’s icon

Usage
-----
- Paste one username per line (with or without @)
- Click Start. Keep the x.com tab focused/active during operation
- Click Stop to request a graceful stop

Test (optional)
---------------
- Quick distribution sanity check for delay jitter:
  - node extension/tests/delay.test.js

Zip for sideloading
-------------------
- From repo root, create a zip:
  - cd extension && zip -r ../x-batch-follow.zip . && cd -

Troubleshooting
---------------
- If you see "Open an X/Twitter tab and try again.", make sure an x.com page is the active tab.
- If rate limited (429), the runner sleeps and resumes automatically.
- Ensure you are logged in to X in that tab; otherwise requests will fail (401/403).

