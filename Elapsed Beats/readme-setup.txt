ELAPSED BEATS PREMIUM — STRIPE + NETLIFY SETUP
==============================================

WHAT IS INCLUDED
----------------
- index.html
- netlify/functions/elapsed-beats-checkout.js
- netlify/functions/elapsed-beats-verify.js
- package.json
- netlify.toml

PURCHASE FLOW
-------------
1. Premium $14.99 opens the Premium window.
2. Buy Premium $14.99 opens Stripe Checkout.
3. Stripe returns the buyer to Elapsed Beats.
4. The verify function confirms payment, product, price, currency, and browser installation directly with Stripe.
5. Premium 4D Audio and CSV downloads unlock on that browser.

NETLIFY DEPLOYMENT
------------------
1. Put these files at the root of the Netlify project. The included index.html is ready to be
   the site's main page.
2. In Netlify: Site configuration > Environment variables, add:
     STRIPE_SECRET_KEY = your Stripe secret key
3. If the widget later moves away from the root index page, also add its exact public page URL:
     ELAPSED_BEATS_SITE_URL = https://your-site.netlify.app/player.html
   If omitted, the function uses Netlify's automatic root URL environment variable.
4. Deploy. Netlify installs package.json dependencies and publishes the two functions.
5. Rehearse with a Stripe test secret key, then replace it with the live key when ready.

STRIPE PRICE
------------
The one-time USD $14.99 price is created server-side in elapsed-beats-checkout.js. The browser
cannot submit or change the amount. The verification function independently requires exactly
$14.99 USD before granting Premium.

SECURITY NOTE
-------------
The supplied board-game example contains a live-format Stripe secret key in a source-code
comment. Do not reuse or publish that copy. Rotate the exposed key in Stripe, then store the
replacement only in Netlify's environment variables.

ENTITLEMENT NOTE
----------------
This intentionally follows the supplied no-account purchase model. Premium is stored on the
browser that completed checkout. Clearing that browser's site data removes local access. A
future multi-device purchase restore would require customer accounts or emailed license links.

PROXIMITY SENSOR — SONG RECOGNITION (ACRCloud)
----------------------------------------------
1. In Netlify: Site configuration > Environment variables, add these three
   (values from the ACRCloud console, Audio & Video Recognition project):
     ACR_HOST          = the project's Host, e.g. identify-us-west-2.acrcloud.com
     ACR_ACCESS_KEY    = the project's Access Key
     ACR_ACCESS_SECRET = the project's Access Secret
   (ACR_SECRET_KEY also works for the secret.) Scope must include Functions.
2. Deploys > Trigger deploy > Deploy site. Functions only see variables that
   existed when they were deployed.
3. Setup check: open
     https://YOUR-SITE/.netlify/functions/elapsed-beats-recognize?check=1
   It lists which of the three it can see (names only, never values) and
   whether ACRCloud accepts them.
