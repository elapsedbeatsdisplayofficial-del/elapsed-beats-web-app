ELAPSED BEATS - Smart Proximity Sensor
======================================

WHAT THIS PACKAGE CONTAINS
index.html                           Updated app with dark/off and orange/on proximity icons.
netlify/functions/eb-proximity-recognize.mjs  HTTPS microphone-clip recognition proxy.
netlify.toml                         Netlify hosting/function configuration.

HOW TO ENABLE LIVE SONG IDENTIFICATION
1. Get an API token for AudD Music Recognition: https://dashboard.audd.io/
2. Deploy the contents of this folder as a Netlify site (Git deploy recommended for functions).
3. In Netlify: Site configuration > Environment variables, set AUDD_API_TOKEN
   to the AudD API token. Never put it in HTML or client JavaScript.
4. Redeploy. Open the site using HTTPS and grant microphone permission when
   you tap the dark proximity icon. The sensor should turn orange.
5. Tap the orange icon to stop. Microphone recording stops; the previously
   loaded track remains unchanged.

NOTE: A standalone HTML file opened locally cannot call a Netlify function
without a configured server. The sensor UI still works, but will correctly
show no recognized song and report recognition-service unavailability.

HOW IT WORKS
- Opt-in: microphone permission requested only when switched ON.
- Records about nine seconds and sends the short recording to the secure
  same-origin Netlify function, which sends it to AudD for fingerprint match.
- Checks again after a pause to correct the position / detect song changes.
- The browser does not cache or save the recorded clips.
- The provider may retain/process clips according to its own policy;
  consult https://audd.io/ and its privacy terms before deploying.
- Song position is an *estimate* derived from recognition timecode and
  elapsed wall clock time; it is not sample-accurate synchronization.
- BPM is drawn from the app's existing curated/corrected/known reference
  sources. If there is no trustworthy BPM, BPM and elapsed Ë stay 0;
  the app does not manufacture a BPM from a title.
- Song duration/remaining time require provider metadata. If duration is
  unavailable, remaining metrics stay zero.
- Song recognition incurs third-party service usage/charges. This is not an
  offline fingerprinting engine and will not identify every recording.

BROWSER REQUIREMENTS
HTTPS or localhost for microphone access, MediaRecorder support, permission
for microphone recording, and network access to the same-origin function.
Some iOS browsers suspend microphone capture when put in the background.
