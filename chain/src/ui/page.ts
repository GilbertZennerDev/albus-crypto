export const indexHtml = (token: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Albus miner</title><meta name="albus-token" content="${token.replace(/[^0-9a-f]/gi, "")}">
<link rel="stylesheet" href="/app.css"></head>
<body><main>
<header><h1>Albus miner</h1><div id="status" class="muted">Loading…</div></header>

<section id="update"><h2>Updates</h2>
<p id="update-text" class="muted">Not checked yet.</p>
<label class="check"><input type="checkbox" id="auto-update"> Install updates automatically</label>
<p id="update-last" class="muted small"></p>
<button id="update-check">Check for updates</button> <button id="update-apply" hidden>Install update</button>
<p class="muted small">Updates are signed and checked every few hours. Your wallet, friends and settings are never touched. If the new version does not start, the old one comes back by itself.</p></section>

<section id="wallet"><h2>Your wallet</h2><div id="wallet-body"></div></section>

<section id="friends"><h2>Friends</h2>
<p class="muted">Share a part of everything you earn from now on. The network fee comes out of the shared part. Percentages are of your <em>new</em> income.</p>
<table><thead><tr><th>Name</th><th>Address</th><th>%</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<form id="add"><input id="f-name" placeholder="Name" maxlength="40" required>
<input id="f-addr" placeholder="albus1…" required spellcheck="false" autocomplete="off">
<input id="f-pct" type="number" min="0" max="100" step="0.01" value="10" required>
<button>Add</button></form>
<label class="check"><input type="checkbox" id="share-on"> Share automatically</label>
<p><button id="save" class="primary">Review and save</button></p>
<div id="review" hidden></div><p id="friends-msg" class="small"></p></section>

<section id="invite" hidden><h2>Who invited you</h2>
<p class="muted">This test network has <b>Friends with Benefits</b>: 10&nbsp;% of the block reward of your mining goes to the friend who invited you. Nothing is added, your reward is split. Only you can make this invitation, it is signed with your own key.</p>
<select id="inviter"></select> <button id="inviter-save">Save inviter</button>
<p><button id="invite-make">Create invitation</button></p><pre id="invite-out" hidden></pre><p id="invite-msg" class="small"></p></section>
</main><script src="/app.js"></script></body></html>`;

export const APP_CSS = `
:root{color-scheme:dark light}
body{margin:0;background:#0b0d12;color:#e6e8ee;font-family:system-ui,"Segoe UI",Roboto,sans-serif;line-height:1.5}
main{max-width:760px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px}
h1{font-size:1.5rem;margin:.4em 0}h2{font-size:1.1rem;margin:0 0 .5em}
section{background:#141824;border:1px solid #232a3b;border-radius:10px;padding:16px;margin:14px 0}
.muted{color:#9aa3b8}.small{font-size:.85rem}.mono,pre,td.a{font-family:ui-monospace,Consolas,monospace}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #232a3b;vertical-align:top}
td.a{font-size:.78rem;word-break:break-all}
input,select{background:#0b0d12;color:inherit;border:1px solid #2f3850;border-radius:6px;padding:7px;margin:3px 0;max-width:100%}
#f-addr{width:22em}#f-pct{width:5em}
button{background:#232a3b;color:inherit;border:1px solid #2f3850;border-radius:6px;padding:7px 12px;cursor:pointer}
button:hover{background:#2c3550}button.primary{background:#3b5bdb;border-color:#3b5bdb}button:disabled{opacity:.5;cursor:default}
.check{display:block;margin:.6em 0}.err{color:#ff8787}.ok{color:#69db7c}
pre{background:#0b0d12;padding:10px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:.8rem}
#review{background:#0b0d12;border:1px solid #3b5bdb;border-radius:8px;padding:12px;margin:8px 0}
[hidden]{display:none!important}
@media(max-width:560px){#f-addr{width:100%}}`;

export const APP_JS = `(() => {
const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="albus-token"]').content;
let state = null, friends = [];
async function api(path, method = "GET", body) {
  const r = await fetch("/api" + path, { method, headers: { "x-albus-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  return j;
}
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const say = (id, text, bad) => { const e = $(id); e.textContent = text; e.className = "small " + (bad ? "err" : "ok"); };
const coins = (u, per) => (u / per).toFixed(2);

function renderWallet() {
  const b = $("wallet-body"); b.replaceChildren();
  if (!state.address) {
    b.append(el("p", "You have no wallet yet. Creating one makes a key file on this PC. The key never leaves it.", "muted"));
    const btn = el("button", "Create wallet"); btn.className = "primary";
    btn.onclick = async () => { try { const r = await api("/wallet/create", "POST", {}); alert("Wallet created. Back up this file, without it the coins are gone:\\n" + r.file); load(); } catch (e) { alert(e.message); } };
    b.append(btn); return;
  }
  b.append(el("div", state.address, "mono"));
  if (state.account) b.append(el("p", "Spendable: " + coins(state.account.spendable, state.account.unitsPerCoin) + " ALB, maturing: " + coins(state.account.immature, state.account.unitsPerCoin) + " ALB", "muted"));
  b.append(el("p", "Keep your wallet.json safe. Anyone with it can spend your coins.", "muted small"));
}

function renderRows() {
  const tb = $("rows"); tb.replaceChildren();
  friends.forEach((f, i) => {
    const tr = el("tr"); tr.append(el("td", f.name), el("td", f.address, "a"), el("td", String(f.percent)));
    const td = el("td"); const rm = el("button", "Remove"); rm.onclick = () => { friends.splice(i, 1); renderRows(); renderInviter(); }; td.append(rm); tr.append(td); tb.append(tr);
  });
}

function renderInviter() {
  const box = $("invite");
  box.hidden = !(state.node && state.node.referralBps);
  if (box.hidden) return;
  const sel = $("inviter"); sel.replaceChildren();
  const none = el("option", "(nobody)"); none.value = ""; sel.append(none);
  friends.forEach((f) => { const o = el("option", f.name + " – " + f.address.slice(0, 14) + "…"); o.value = f.address; sel.append(o); });
  sel.value = state.inviter || "";
}

function payload() { return { friends, inviter: $("invite").hidden ? state.inviter : ($("inviter").value || null), shareEnabled: $("share-on").checked }; }

async function load() {
  try {
    state = await api("/state");
    friends = state.friends; $("share-on").checked = state.shareEnabled;
    const n = state.node;
    $("status").textContent = "Version " + state.version + " · " + (n ? "node online, height " + n.height + ", network " + n.networkId : "node not reachable");
    $("update").hidden = !state.updatesAvailable;
    $("auto-update").checked = state.autoUpdate; $("update-last").textContent = state.lastUpdate || "";
    renderWallet(); renderRows(); renderInviter();
  } catch (e) { $("status").textContent = "Cannot talk to the miner: " + e.message; }
}

$("add").onsubmit = (ev) => {
  ev.preventDefault();
  friends.push({ name: $("f-name").value.trim(), address: $("f-addr").value.trim().toLowerCase(), percent: Number($("f-pct").value) });
  $("f-name").value = ""; $("f-addr").value = ""; renderRows(); renderInviter();
};

$("save").onclick = () => {
  const rv = $("review"); rv.replaceChildren(); rv.hidden = false;
  const p = payload();
  rv.append(el("p", p.shareEnabled ? "Please check every address. A wrong character sends coins into the void, nobody can get them back." : "Sharing is switched off. The list is only saved."));
  friends.forEach((f) => { rv.append(el("div", f.percent + " % to " + f.name)); rv.append(el("div", f.address, "mono small muted")); });
  const ok = el("button", "Confirm and save"); ok.className = "primary";
  ok.onclick = async () => { try { await api("/friends", "PUT", p); rv.hidden = true; say("friends-msg", "Saved."); load(); } catch (e) { say("friends-msg", e.message, true); } };
  const no = el("button", "Cancel"); no.onclick = () => { rv.hidden = true; };
  rv.append(ok, " ", no);
};

$("inviter-save").onclick = async () => { try { await api("/friends", "PUT", payload()); say("invite-msg", "Saved."); load(); } catch (e) { say("invite-msg", e.message, true); } };
$("invite-make").onclick = async () => {
  try { const r = await api("/invitation", "POST", {}); const o = $("invite-out"); o.hidden = false; o.textContent = r.invitation; say("invite-msg", "Saved to " + r.file + ". Give it to your miner as MINER_INVITATION."); }
  catch (e) { say("invite-msg", e.message, true); }
};

$("auto-update").onchange = async () => { try { await api("/settings", "PUT", { autoUpdate: $("auto-update").checked }); } catch (e) { $("update-text").textContent = e.message; } };
$("update-check").onclick = async () => {
  try {
    const r = await api("/update/check", "POST", {});
    $("update-text").textContent = r.error ? r.error : r.available ? "Version " + r.version + " is available. " + (r.notes || "") : "You have the newest version.";
    $("update-apply").hidden = !r.available;
  } catch (e) { $("update-text").textContent = e.message; }
};
$("update-apply").onclick = async () => {
  $("update-apply").disabled = true; $("update-text").textContent = "Installing…";
  try { const r = await api("/update/apply", "POST", {}); $("update-text").textContent = r.message; } catch (e) { $("update-text").textContent = e.message; }
  $("update-apply").disabled = false; load();
};
load();
})();`;
