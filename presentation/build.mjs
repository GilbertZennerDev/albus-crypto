import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { T } from "./texts.mjs";
import { D, CMD } from "./dl.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const langs = ["de", "en", "fr"];
const design = "poster";

const typo = (lang, s) =>
  lang === "fr"
    ? s.replace(/«\s/g, "« ").replace(/\s»/g, " »").replace(/ ([:;?!])/g, " $1")
    : s;

const arrow = `<svg viewBox="0 0 54 42" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6c14 -2 30 4 38 28"/><path d="M30 28l12 8 4 -14"/></svg>`;
const aside = (text) => `<p class="aside">${arrow}<span>${text}</span></p>`;
const paper = (cls, body) => `<section class="paper ${cls}">${body}</section>`;

function head(ctx, title, desc) {
  const alt = langs.map((l) => `<link rel="alternate" hreflang="${l}" href="/${design}/${l}/${ctx.page}">`).join("");
  return `<!doctype html><html lang="${ctx.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><meta name="description" content="${desc}">${alt}<link rel="stylesheet" href="/assets/fonts.css"><link rel="stylesheet" href="/assets/poster.css"></head>`;
}

function topbar(ctx) {
  const sw = langs.map((l) => `<a href="/${design}/${l}/${ctx.page}"${l === ctx.lang ? ' aria-current="page"' : ""} hreflang="${l}">${l.toUpperCase()}</a>`).join("");
  return `<header class="top wrap"><a class="mark" href="/${design}/${ctx.lang}/">Albus<b>.</b></a><nav class="lang" aria-label="Language">${sw}</nav></header>`;
}

function book(i) {
  const rows = [["Anna", "Ben", 5, 41, "0000c92e"], ["Ben", "Cleo", 2, 42, "0000a3f1"], ["Cleo", "Anna", 1, 43, "00007de0"]];
  return `<div class="book" role="img" aria-label="${i.page} 41–43">${rows
    .map((r) => `<div class="row"><span class="n">${r[3]}</span><span>${r[0]} ${i.to} ${r[1]} ${r[2]}</span><span class="h">${i.fp} ${r[4]}…</span></div>`)
    .join("")}</div>`;
}

function puzzle(p) {
  const L = JSON.stringify({ start: p.start, stop: p.stop, again: p.again, done: p.done }).replace(/"/g, "&quot;");
  return `<div class="puzzle" id="puzzle" data-l="${L}"><div class="hd"><strong>${p.h}</strong><div class="ctl"><select id="lvl" aria-label="${p.level}"><option value="3">3 ${p.level}</option><option value="4" selected>4 ${p.level}</option><option value="5">5 ${p.level}</option></select><button type="button">${p.start}</button></div></div><div class="hash" aria-live="off">0000…</div><p class="in">&nbsp;</p><p class="hint">${p.hint}</p><div class="stat"><div><b data-n>0</b><span>${p.tries}</span></div><div><b data-t>0.0 s</b><span>${p.time}</span></div><div><b data-r>0</b><span>${p.rate}</span></div></div><p class="res" aria-live="polite"></p></div>`;
}

function download(d) {
  return `<section class="dl" id="download"><p class="kick">${d.kicker}</p><h2>${d.h}</h2><p class="lead">${d.p}</p><a class="dlbtn" href="/releases/install-albus.ps1" download><span aria-hidden="true">⬇</span> ${d.btn}</a><ol class="dlsteps">${d.steps.map((x) => `<li>${x}</li>`).join("")}</ol><p class="fast">${d.fast}</p><div class="cmd"><code>${CMD}</code><button type="button" data-copy="${CMD}" data-done="${d.copied}">${d.copy}</button></div><ul class="dlnotes">${d.notes.map((x) => `<li>${x}</li>`).join("")}</ul></section>`;
}

function stickBox(h, items, extra) {
  return `<section class="stick"><h2>${h}</h2><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>${extra ? `<p>${extra}</p>` : ""}</section>`;
}

function simple(ctx, t) {
  const s = t.s;
  return (
    head(ctx, s.title, s.desc) +
    `<body>${topbar(ctx)}<main class="wrap">
<section class="hero"><span class="sticker">${s.sticker}</span><h1 class="giant">Albus</h1><p class="sub">${s.sub}</p>
${paper("note tilt-a", s.hi.map((x) => `<p>${x}</p>`).join("") + (s.sig ? `<p class="sig">${s.sig}</p>` : ""))}</section>
${download(D[ctx.lang])}
${paper("tilt-b", `<h2>${s.idea.h}</h2>${s.idea.p.map((x) => `<p>${x}</p>`).join("")}${book(s.idea)}${aside(s.idea.aside)}`)}
${paper("tilt-a", `<h2>${s.mining.h}</h2>${s.mining.p.map((x) => `<p>${x}</p>`).join("")}${puzzle(s.puzzle)}${aside(s.mining.aside)}`)}
<section><div class="head2"><h2>${s.numbers.h}</h2></div><div class="figs">${s.numbers.figs.map((f) => `<div class="fig"><b>${f[0]}${f[1] ? `<em>${f[1]}</em>` : ""}</b><span class="lbl">${f[2]}</span><p>${f[3]}</p></div>`).join("")}</div></section>
${stickBox(s.honest.h, s.honest.li)}
<p><a class="more" href="/${design}/${ctx.lang}/details.html">${s.more}</a></p>
</main><footer class="wrap"><span>${s.foot}</span></footer><script src="/assets/app.js"></script></body></html>`
  );
}

function details(ctx, t) {
  const d = t.d;
  const cards = (arr, withNum) => `<div class="cards">${arr.map((c) => (withNum ? `<div>${c[0] ? `<div class="num">${c[0]}</div>` : ""}<h3>${c[1]}</h3><p>${c[2]}</p></div>` : `<div><h3>${c[0]}</h3><p>${c[1]}</p></div>`)).join("")}</div>`;
  return (
    head(ctx, d.title, d.desc) +
    `<body>${topbar(ctx)}<main class="wrap">
<section class="hero"><h1 class="giant">Albus</h1><p class="sub">${d.sub}</p><p>${d.lead} <a href="/${design}/${ctx.lang}/">${d.short}</a></p></section>
<section><div class="head2"><h2>${d.numbers.h}</h2></div>${cards(d.numbers.cards, true)}</section>
${paper("tilt-b", `<h2>${d.flow.h}</h2><ol class="steps">${d.flow.steps.map((x) => `<li><span>${x}</span></li>`).join("")}</ol>`)}
<section><div class="head2"><h2>${d.rules.h}</h2></div>${cards(d.rules.cards, false)}</section>
<section><div class="head2"><h2>${d.worker.h}</h2><p style="margin-top:14px">${d.worker.p}</p></div>${cards(d.worker.cards, true)}</section>
${stickBox(d.honest.h, d.honest.li, d.honest.incl)}
<p><a class="more" href="/${design}/${ctx.lang}/">${d.back}</a></p>
</main><footer class="wrap"><span>${d.foot}</span></footer></body></html>`
  );
}

for (const l of langs) {
  const dir = path.join(root, design, l);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), typo(l, simple({ lang: l, page: "" }, T[l])));
  fs.writeFileSync(path.join(dir, "details.html"), typo(l, details({ lang: l, page: "details.html" }, T[l])));
}
console.log("ok");
