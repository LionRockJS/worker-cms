// Admin session keepalive. Loaded by both admin shells — the bootstrap in
// core/render/layout.ts and layout/default.liquid — so it is guarded to bind
// only once per page.
(function() {
  if (window.__cmsSessionKeepaliveBound) return;
  window.__cmsSessionKeepaliveBound = true;
  var INTERVAL = 5 * 60 * 1000;
  // Interaction after this long without a report is sent at once, so the
  // server's view of activity lags the person by at most this much.
  var REPORT_AFTER = 5 * 60 * 1000;
  var RETRY_AFTER = 30 * 1000;
  var inFlight = false;
  // Loading the page was itself a request the server counted.
  var lastInteraction = Date.now();
  var lastReported = lastInteraction;
  var lastAttempt = 0;

  // A visible page counts as reading, even when its window is inactive.
  // Hidden tabs only report actual interaction, so they still go idle.
  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    lastAttempt = Date.now();
    var interaction = lastInteraction;
    var headers = { Accept: 'application/json' };
    if (interaction > lastReported) {
      var age = String(Math.max(0, Math.floor((Date.now() - interaction) / 1000)));
      headers['X-CMS-Interaction-Age'] = age;
      headers['X-CMS-Idle-For'] = age;
    }
    if (document.visibilityState === 'visible') {
      // Ordinary deployments count reading. Regulated deployments use only
      // the separately reported time of an actual input event.
      headers['X-CMS-Idle-For'] = '0';
    } else if (interaction <= lastReported) {
      headers['X-CMS-Background'] = '1';
    }
    try {
      var res = await fetch('/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: headers
      });
      if (res.status === 401) window.location.href = '/auth/login?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
      else if (res.ok) lastReported = Math.max(lastReported, interaction);
    } catch (error) {
      /* retry on the next tick */
    } finally {
      inFlight = false;
    }
  }

  function noteInteraction() {
    lastInteraction = Date.now();
    if (lastInteraction - lastReported > REPORT_AFTER && lastInteraction - lastAttempt > RETRY_AFTER) refresh();
  }

  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function(type) {
    window.addEventListener(type, noteInteraction, { capture: true, passive: true });
  });
  window.setInterval(refresh, INTERVAL);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') refresh();
  });
})();
