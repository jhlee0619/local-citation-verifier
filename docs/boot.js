// Classic (non-module) boot guard, loaded before the main.js module graph.
// It shows a plain notice when the app cannot start: the page was opened from
// file://, or the module graph never finished (stale cached modules, a failed
// import, an initialisation error). main.js sets data-app-ready="1" when done.
(function () {
  "use strict";

  var READY_TIMEOUT_MS = 8000;
  var doc = document;
  var root = doc.documentElement;

  function showNotice(message) {
    if (doc.getElementById("boot-notice")) return;
    var notice = doc.createElement("div");
    notice.id = "boot-notice";
    notice.setAttribute("role", "alert");
    notice.textContent = message;
    var style = notice.style;
    style.position = "fixed";
    style.top = "0";
    style.left = "0";
    style.right = "0";
    style.zIndex = "2147483647";
    style.padding = "12px 16px";
    style.font = "14px/1.4 system-ui, sans-serif";
    style.textAlign = "center";
    style.background = "#7f1d1d";
    style.color = "#ffffff";
    (doc.body || root).appendChild(notice);
  }

  if (location.protocol === "file:") {
    showNotice("This app must be served over http, not opened as a file. Start run-local.cmd (or the local proxy server) and open the http:// address it prints.");
    return;
  }

  function check() {
    if (root.dataset.appReady === "1") return;
    // Module scripts always finish before the load event. A fake or fast clock
    // can fire the timer earlier, so only report once the page has loaded.
    if (doc.readyState !== "complete") {
      window.addEventListener("load", check, { once: true });
      return;
    }
    showNotice("The app did not finish loading — press Ctrl+Shift+R to reload.");
  }

  setTimeout(check, READY_TIMEOUT_MS);
})();
