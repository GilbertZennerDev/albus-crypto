(function () {
  var hex = "0123456789abcdef";
  function rnd(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  }
  var tk = document.getElementById("tk");
  if (tk) {
    var html = "";
    for (var i = 0; i < 40; i++) {
      var z = Math.random() < 0.18 ? 4 + Math.floor(Math.random() * 2) : Math.floor(Math.random() * 2);
      html += "<span>" + (z ? "<i>" + "0".repeat(z) + "</i>" : "") + rnd(18 - z) + "</span>";
    }
    tk.innerHTML = html + html;
  }

  var box = document.getElementById("puzzle");
  if (!box || !window.crypto || !crypto.subtle) return;
  var L = JSON.parse(box.getAttribute("data-l"));
  var btn = box.querySelector("button");
  var sel = box.querySelector("select");
  var hashEl = box.querySelector(".hash");
  var inEl = box.querySelector(".in");
  var nEl = box.querySelector("[data-n]");
  var tEl = box.querySelector("[data-t]");
  var rEl = box.querySelector("[data-r]");
  var res = box.querySelector(".res");
  var seed = "albus-demo";
  var addr = "alb1demo";
  var running = false;
  var enc = new TextEncoder();

  function fmt(n) {
    return Math.round(n).toLocaleString(document.documentElement.lang);
  }
  function show(h, z) {
    hashEl.innerHTML = (z ? "<i>" + h.slice(0, z) + "</i>" : "") + h.slice(z);
  }
  function lead(h) {
    var c = 0;
    while (c < h.length && h[c] === "0") c++;
    return c;
  }

  async function run() {
    var need = parseInt(sel.value, 10);
    var nonce = Math.floor(Math.random() * 1e6);
    var tries = 0;
    var t0 = performance.now();
    running = true;
    btn.textContent = L.stop;
    res.textContent = "";
    while (running) {
      for (var k = 0; k < 400 && running; k++) {
        var hx = nonce.toString(16).padStart(8, "0");
        var buf = await crypto.subtle.digest("SHA-256", enc.encode(seed + "|" + addr + "|" + hx));
        var h = Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
        nonce++;
        tries++;
        var z = lead(h);
        if (z >= need) {
          var sec = (performance.now() - t0) / 1000;
          show(h, z);
          inEl.textContent = seed + "|" + addr + "|" + hx;
          nEl.textContent = fmt(tries);
          tEl.textContent = sec.toFixed(1) + " s";
          var rate = tries / Math.max(sec, 0.001);
          rEl.textContent = fmt(rate);
          res.textContent = L.done.replace("{n}", fmt(tries)).replace("{x}", fmt(6.4e9 / rate));
          running = false;
          btn.textContent = L.again;
          return;
        }
        if (k === 0 || k === 399) {
          show(h, z);
          inEl.textContent = seed + "|" + addr + "|" + hx;
        }
      }
      var s2 = (performance.now() - t0) / 1000;
      nEl.textContent = fmt(tries);
      tEl.textContent = s2.toFixed(1) + " s";
      rEl.textContent = fmt(tries / Math.max(s2, 0.001));
      await new Promise(function (r) { setTimeout(r, 0); });
    }
    btn.textContent = L.start;
  }

  btn.addEventListener("click", function () {
    if (running) {
      running = false;
    } else {
      run();
    }
  });
})();
