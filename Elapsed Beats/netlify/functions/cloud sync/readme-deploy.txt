Elapsed Beats — Version 17 cloud sync + complete Song Database metrics

1. Use "Elapsed Beats Web Widget(17).html" as the app HTML.
2. Keep BOTH Netlify Functions in the same Netlify project that hosts the app:
   - netlify/functions/elapsed-beats-bpm-sync.mjs
   - netlify/functions/elapsed-beats-track-metrics.mjs
3. Keep @netlify/blobs in the project dependencies. If your project already has package.json, merge this dependency instead of replacing the existing file:

   "@netlify/blobs": "^11.0.3"

4. Deploy the Netlify project normally.

Version 17 behavior retained:
- BPM corrections save locally immediately, so the app still works offline.
- Corrected database BPMs sync across devices through the BPM sync function and Netlify Blobs.
- Other devices pull corrections on startup, reconnect, refocus, and the regular visible-app sync interval.
- A newer correction from another device can replace the previous correction.

Database cleanup added in this build:
- Song identity is canonicalized before storage and display, so duplicate entries caused by Artist - Title tags, feat./ft. variants, common version labels, and filename-style title differences collapse into one row.
- Existing local database records are automatically consolidated the next time the app opens.
- The visible database only admits rows when BPM and Time are valid, so Ë can always be calculated; BPM, Time and Ë no longer show dash placeholders.
- Online catalogue rows are enriched through elapsed-beats-track-metrics before they enter the visible table. The helper caches successful full-metric lookups in Netlify Blobs to reduce repeat requests.

The cloud store is shared by the deployed app, not tied to one browser's localStorage.
