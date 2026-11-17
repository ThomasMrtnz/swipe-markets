"use strict";
/*
 * Swipe Markets — trie les offres de la veille d'un geste.
 * Lit app_data/offres.json dans le dépôt privé (API GitHub, jeton stocké sur ce téléphone)
 * et envoie les choix par lots (événement repository_dispatch « decisions ») :
 * le workflow « Appli — choix du swipe » les écrit dans la colonne Statut du Google Sheet.
 * Le détail de chaque offre (description, infos, lien direct) est lu à la demande dans app_data/details/.
 */

const DEFAULTS = { owner: "ThomasMrtnz", repo: "veille-emploi-markets", path: "app_data/offres.json" };
const API = "https://api.github.com";
const YES = "À postuler";
const NO = "Pas intéressé";
const FLUSH_DELAY = 20000;
const BATCH = 50;
const KEEP_MS = 60 * 864e5;
const STATUTS = ["À postuler", "Postulé", "Entretien", "Offre", "Refus"];
const STATUT_CLASS = {
  "À postuler": "s-todo", "Postulé": "s-sent", "Entretien": "s-int", "Offre": "s-offer", "Refus": "s-ko",
  "Pas intéressé": "s-off", "Expirée": "s-off",
};
const RAW = "application/vnd.github.raw+json";

/* ---------- stockage local (peut être indisponible : navigation privée, aperçus) ---------- */
const store = {
  get(k, d) {
    try { const v = localStorage.getItem("swipe." + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem("swipe." + k, JSON.stringify(v)); } catch { /* sans stockage */ } },
  clear() {
    try { Object.keys(localStorage).filter((k) => k.startsWith("swipe.")).forEach((k) => localStorage.removeItem(k)); } catch { /* idem */ }
  },
};

const S = {
  cfg: { ...DEFAULTS, ...store.get("cfg", {}) },
  token: store.get("token", ""),
  data: store.get("data", null),
  decided: store.get("decided", {}),   // id -> {statut, force?, at, sent, lien, employeur, intitule, ville, type}
  details: new Map(),                   // clé de détail -> promesse du détail
  robots: store.get("robots", {}),      // id -> {cle, at, employeur, intitule, live?, fin?} : robots lancés
  robotTimer: null,
  sheet: null,                          // fiche ouverte : {o, from}
  later: store.get("later", []),       // ids repoussés en fin de pile
  history: [],                          // pour « Annuler » : {id, kind: "decide" | "later"}
  inflight: new Set(),
  view: "trier",
  flushing: false,
  flushTimer: null,
  lastRefresh: 0,
  animating: false,
  error: "",
  sentOk: 0,
};

/* ---------- utilitaires ---------- */
const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : ""; } catch { return ""; }
}
function slug(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]+/g, "");
}
function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}` : (iso || "");
}
function fmtStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} à ${p(d.getHours())}h${p(d.getMinutes())}`;
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function plural(n, one, many) { return `${n} ${n > 1 ? many : one}`; }

function save() {
  store.set("decided", S.decided);
  store.set("later", S.later);
}

/* ---------- API GitHub ---------- */
function repoPath(suffix) {
  return `/repos/${encodeURIComponent(S.cfg.owner)}/${encodeURIComponent(S.cfg.repo)}${suffix}`;
}
function gh(path, { method = "GET", body, accept = "application/vnd.github+json", keepalive = false } = {}) {
  const headers = { Authorization: `Bearer ${S.token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  if (body) headers["Content-Type"] = "application/json";
  return fetch(API + path, { method, headers, body, keepalive, cache: "no-store" });
}

async function refresh() {
  if (!S.token) { render(); return; }
  const btn = $("#btn-refresh");
  btn.classList.add("spin");
  S.error = "";
  try {
    const path = S.cfg.path.split("/").map(encodeURIComponent).join("/");
    const r = await gh(repoPath(`/contents/${path}`), { accept: "application/vnd.github.raw+json" });
    if (r.status === 401) throw new Error("Jeton refusé ou expiré : remplace-le dans Réglages.");
    if (r.status === 404) throw new Error("Liste introuvable : elle apparaît après la prochaine veille (vers 16h), ou le jeton n'a pas accès au dépôt.");
    if (!r.ok) throw new Error(`GitHub a répondu ${r.status}.`);
    const data = await r.json();
    if (!data || !Array.isArray(data.a_trier)) throw new Error("Fichier de liste illisible.");
    S.data = data;
    S.lastRefresh = Date.now();
    store.set("data", data);
    prune();
  } catch (e) {
    S.error = e instanceof TypeError ? "Pas de réseau : dernière liste connue affichée." : e.message;
  } finally {
    btn.classList.remove("spin");
    render();
  }
}

/* Statut de chaque offre selon la dernière liste du serveur. */
function serverStatus() {
  const m = new Map();
  for (const o of S.data?.a_trier || []) m.set(o.id, "À étudier");
  for (const o of serverCandidatures()) m.set(o.id, o.statut);
  return m;
}
function serverCandidatures() {
  if (Array.isArray(S.data?.candidatures)) return S.data.candidatures.filter((o) => o && o.id);
  return (S.data?.a_postuler || []).filter((o) => o && o.id).map((o) => ({ ...o, statut: YES }));
}

/* Oublie les choix déjà envoyés quand la liste du serveur les a pris en compte. */
function prune() {
  const srv = serverStatus();
  const old = Date.now() - KEEP_MS;
  for (const [id, d] of Object.entries(S.decided)) {
    if (!d.sent) continue;
    const now = srv.get(id);
    if (now === d.statut || now === undefined || d.at < old) delete S.decided[id];
  }
  S.later = S.later.filter((id) => srv.get(id) === "À étudier");
  save();
}

function unsent() {
  return Object.entries(S.decided).filter(([id, d]) => !d.sent && !S.inflight.has(id));
}

function scheduleFlush(delay = FLUSH_DELAY) {
  clearTimeout(S.flushTimer);
  S.flushTimer = setTimeout(() => flush(), delay);
}

async function flush({ keepalive = false } = {}) {
  if (S.flushing || !S.token) { renderStatus(); return; }
  const todo = unsent();
  if (!todo.length) return;
  clearTimeout(S.flushTimer);
  S.flushing = true;
  renderStatus();
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      chunk.forEach(([id]) => S.inflight.add(id));
      const body = JSON.stringify({
        event_type: "decisions",
        client_payload: {
          decisions: chunk.map(([id, d]) => ({ id, lien: d.lien || "", statut: d.statut, ...(d.force ? { force: true } : {}) })),
        },
      });
      let r;
      try {
        r = await gh(repoPath("/dispatches"), { method: "POST", body, keepalive });
      } finally {
        chunk.forEach(([id]) => S.inflight.delete(id));
      }
      if (r.status === 401) throw new Error("Jeton refusé ou expiré : remplace-le dans Réglages.");
      if (r.status === 403 || r.status === 404) throw new Error("Le jeton ne peut pas écrire : donne-lui « Contents : Read and write ».");
      if (r.status !== 204) throw new Error(`Envoi refusé par GitHub (${r.status}).`);
      const now = Date.now();
      chunk.forEach(([id]) => { if (S.decided[id]) S.decided[id].sent = now; });
      save();
    }
    S.error = "";
    S.sentOk = Date.now();
  } catch (e) {
    S.error = e instanceof TypeError ? "Pas de réseau : tes choix partiront dès que possible." : e.message;
    scheduleFlush(60000);
  } finally {
    S.flushing = false;
    renderStatus();
    renderCandidatures();
  }
}

/* ---------- pile de cartes ---------- */
function queue() {
  const list = (S.data?.a_trier || []).filter((o) => o && o.id && !S.decided[o.id]);
  const later = new Set(S.later);
  const byId = new Map(list.map((o) => [o.id, o]));
  return [...list.filter((o) => !later.has(o.id)), ...S.later.map((id) => byId.get(id)).filter(Boolean)];
}

function scoreEl(score) {
  const s = Math.max(0, Math.min(5, Number(score) || 0));
  const box = el("span", "score");
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", `Score ${s} sur 5`);
  for (let i = 1; i <= 5; i++) box.append(el("i", i <= s ? "on" : ""));
  return box;
}

function card(o) {
  const c = el("article", "card");
  c.dataset.id = o.id;
  const top = el("div", "card-top");
  top.append(el("span", `badge t-${slug(o.type)}`, o.type || "Offre"), scoreEl(o.score));
  c.append(top, el("p", "emp", o.employeur || "Employeur inconnu"), el("h2", "title", o.intitule || "(sans intitulé)"));
  const meta = [o.ville, o.source && `via ${o.source}`].filter(Boolean).join(" · ");
  if (meta) c.append(el("p", "meta", meta));
  const dates = [o.date && `Détectée le ${fmtDay(o.date)}`, o.publication && `publiée le ${fmtDay(o.publication)}`]
    .filter(Boolean).join(" · ");
  if (dates) c.append(el("p", "dates", dates));
  if (o.ferme) c.append(el("p", "note", "Annonce probablement fermée"));
  if (o.debut) c.append(el("p", "debut", `Début : ${o.debut}`));
  else if (o.remarque) c.append(el("p", "note", o.remarque));
  if (o.extrait) c.append(el("p", "extrait", o.extrait));
  c.append(el("div", "spacer"));
  const row = el("div", "card-actions");
  const more = el("button", "open", "Détails");
  more.type = "button";
  more.addEventListener("click", () => openDetail(o, "trier"));
  row.append(more);
  const url = safeUrl(o.lien);
  if (url) row.append(link("open", "Site ↗", url));
  c.append(row);
  c.append(el("div", "stamp yes", "POSTULER"), el("div", "stamp no", "PASSER"), el("div", "stamp later", "PLUS TARD"));
  return c;
}

function link(cls, text, url) {
  const a = el("a", cls, text);
  a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
  return a;
}

function setStamps(c, yes, no, later) {
  c.style.setProperty("--yes-o", yes);
  c.style.setProperty("--no-o", no);
  c.style.setProperty("--later-o", later);
}

function attachDrag(c, o) {
  let active = false, pid = null, x0 = 0, y0 = 0, dx = 0, dy = 0, t0 = 0;
  c.addEventListener("pointerdown", (e) => {
    if (S.animating || e.target.closest("a, button")) return;
    active = true; pid = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = dy = 0; t0 = performance.now();
    c.setPointerCapture(pid);
    c.classList.add("dragging");
  });
  c.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== pid) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    c.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    const vertical = dy < 0 && Math.abs(dy) > Math.abs(dx);
    setStamps(c, clamp01(dx / 110), clamp01(-dx / 110), vertical ? clamp01(-dy / 130) : 0);
  });
  const end = (e) => {
    if (!active || e.pointerId !== pid) return;
    active = false;
    c.classList.remove("dragging");
    const dt = Math.max(1, performance.now() - t0);
    const vx = dx / dt;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && dt < 400) {   // simple toucher : ouvre la fiche
      c.style.transform = ""; setStamps(c, 0, 0, 0);
      openDetail(o, "trier");
      return;
    }
    if (dx > 110 || (dx > 45 && vx > 0.6)) decide(o, YES, c, dy);
    else if (dx < -110 || (dx < -45 && vx < -0.6)) decide(o, NO, c, dy);
    else if (dy < -130 && Math.abs(dy) > Math.abs(dx)) postpone(o, c);
    else { c.style.transform = ""; setStamps(c, 0, 0, 0); }
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
}

function flyOut(c, dir, dy, then) {
  S.animating = true;
  c.classList.remove("dragging");
  const w = window.innerWidth, h = window.innerHeight;
  const tx = dir === "up" ? 0 : (dir === "right" ? 1.4 : -1.4) * w;
  const ty = dir === "up" ? -1.2 * h : dy;
  const rot = dir === "right" ? 22 : dir === "left" ? -22 : 0;
  setStamps(c, dir === "right" ? 1 : 0, dir === "left" ? 1 : 0, dir === "up" ? 1 : 0);
  c.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
  let done = false;
  const finish = () => { if (done) return; done = true; S.animating = false; then(); };
  c.addEventListener("transitionend", finish, { once: true });
  setTimeout(finish, 380);
}

function topCard() {
  const c = $("#stack .card.front");
  const o = c && queue().find((x) => x.id === c.dataset.id);
  return o ? [o, c] : [null, null];
}

function snapshot(o) {
  return {
    lien: o.lien || "", employeur: o.employeur || "", intitule: o.intitule || "", ville: o.ville || "",
    type: o.type || "", date: o.date || "", d: o.d || "", debut: o.debut || "", ats: o.ats || "",
  };
}

function commitDecision(o, statut) {
  S.decided[o.id] = { statut, at: Date.now(), sent: 0, ...snapshot(o) };
  S.later = S.later.filter((x) => x !== o.id);
  S.history.push({ id: o.id, kind: "decide" });
  store.set("hinted", true);
  save();
  render();
  toast(statut === YES ? `À postuler : ${o.employeur}` : `Passée : ${o.employeur}`, true);
  scheduleFlush();
}

function decide(o, statut, c, dy = 0) {
  if (S.animating) return;
  if (!c) { commitDecision(o, statut); return; }
  flyOut(c, statut === YES ? "right" : "left", dy, () => commitDecision(o, statut));
}

/* Changement de statut explicite (onglet Candidatures) : écrase le statut du Sheet. */
function setStatus(o, statut) {
  S.decided[o.id] = { statut, force: true, at: Date.now(), sent: 0, ...snapshot(o) };
  save();
  closeDetail();
  render();
  toast(`${o.employeur || "Offre"} : ${statut}`);
  scheduleFlush(3000);
}

function postpone(o, c) {
  if (S.animating) return;
  flyOut(c, "up", 0, () => {
    S.later = [...S.later.filter((x) => x !== o.id), o.id];
    S.history.push({ id: o.id, kind: "later" });
    save();
    render();
    toast(`Plus tard : ${o.employeur}`, true);
  });
}

function undo() {
  if (S.animating) return;
  const last = S.history.pop();
  if (!last || !S.data) { toast("Rien à annuler."); return; }
  if (last.kind === "later") {
    S.later = S.later.filter((x) => x !== last.id);
    // remet la carte en tête de pile
    S.data.a_trier = [...S.data.a_trier.filter((o) => o.id === last.id), ...S.data.a_trier.filter((o) => o.id !== last.id)];
  } else {
    const d = S.decided[last.id];
    if (!d) { toast("Rien à annuler."); return; }
    if (d.sent || S.inflight.has(last.id)) {
      S.history.push(last);
      toast("Déjà envoyé au Sheet : change le statut directement dans le Sheet.");
      return;
    }
    delete S.decided[last.id];
    S.data.a_trier = [...S.data.a_trier.filter((o) => o.id === last.id), ...S.data.a_trier.filter((o) => o.id !== last.id)];
  }
  save();
  render();
  hideToast();
}

/* ---------- rendu ---------- */
function renderStatus() {
  const s = $("#status");
  s.className = "status";
  const waiting = Object.values(S.decided).filter((d) => !d.sent).length;
  if (!S.token) { s.textContent = "Ajoute ton jeton GitHub dans Réglages."; s.classList.add("warn"); return; }
  if (S.error) { s.textContent = S.error; s.classList.add("err"); return; }
  if (S.flushing) { s.textContent = `Envoi de ${plural(waiting, "choix", "choix")}…`; return; }
  if (waiting) { s.textContent = `${plural(waiting, "choix", "choix")} en attente d'envoi`; s.classList.add("warn"); return; }
  if (S.sentOk && Date.now() - S.sentOk < 120000) { s.textContent = "Choix envoyés ✓ Le Sheet se met à jour d'ici 1 min."; return; }
  s.textContent = S.data?.maj ? `Liste du ${fmtStamp(S.data.maj)}` : "Liste pas encore chargée";
}

function renderStack() {
  const stack = $("#stack");
  stack.replaceChildren();
  const q = queue();
  $("#count-trier").textContent = S.data ? String(q.length) : "";
  const disabled = !q.length;
  ["#btn-no", "#btn-yes", "#btn-later"].forEach((b) => { $(b).disabled = disabled; });
  $("#btn-undo").disabled = !S.history.length;
  $("#hint").hidden = disabled || store.get("hinted", false);
  if (!q.length) {
    const box = el("div", "empty");
    if (!S.token) {
      box.append(el("strong", "", "Bienvenue"), el("p", "", "Ajoute ton jeton GitHub pour charger les offres de ta veille."));
      const b = el("button", "ghost", "Ouvrir les réglages");
      b.type = "button"; b.addEventListener("click", () => show("reglages"));
      box.append(b);
    } else if (!S.data) {
      box.append(el("strong", "", "Aucune liste"), el("p", "", S.error || "Appuie sur ⟳ pour charger la liste."));
    } else {
      box.append(el("strong", "", "Tout est trié"), el("p", "", "Nouvelles offres après la veille de chaque jour, vers 16h."));
      const b = el("button", "ghost", "Voir mes candidatures");
      b.type = "button"; b.addEventListener("click", () => show("postuler"));
      box.append(b);
    }
    stack.append(box);
    return;
  }
  if (q[1]) { const b = card(q[1]); b.classList.add("back"); b.setAttribute("aria-hidden", "true"); stack.append(b); }
  const t = card(q[0]);
  t.classList.add("front");
  attachDrag(t, q[0]);
  stack.append(t);
}

function candidatures() {
  const items = [];
  const seen = new Set();
  for (const o of serverCandidatures()) {
    seen.add(o.id);
    const d = S.decided[o.id];
    if (d && !STATUTS.includes(d.statut)) continue;           // passée en « Pas intéressé » depuis l'appli
    items.push(d ? { ...o, statut: d.statut, attente: true } : o);
  }
  for (const [id, d] of Object.entries(S.decided)) {          // swipes et changements pas encore dans la liste
    if (seen.has(id) || !STATUTS.includes(d.statut)) continue;
    items.push({ id, ...d, attente: true });
  }
  return items;
}

function renderCandidatures() {
  const items = candidatures();
  const todo = items.filter((o) => o.statut === YES).length;
  $("#count-postuler").textContent = S.data || items.length ? String(todo) : "";
  const links = $("#apply-links");
  links.replaceChildren();
  for (const [key, label] of [["dossier_candidatures", "Dossiers Drive ↗"], ["sheet", "Google Sheet ↗"]]) {
    const url = safeUrl(S.data?.[key] || "");
    if (url) links.append(link("", label, url));
  }
  const list = $("#apply-list");
  list.replaceChildren();
  if (!items.length) {
    list.append(el("li", "apply-empty", "Aucune candidature pour l'instant. Glisse une carte à droite pour en ajouter."));
    return;
  }
  for (const statut of STATUTS) {
    const group = items.filter((o) => o.statut === statut);
    if (!group.length) continue;
    list.append(el("li", "group", `${statut} · ${group.length}`));
    for (const o of group) {
      const li = el("li", "item");
      const b = el("button", "item-btn");
      b.type = "button";
      b.addEventListener("click", () => openDetail(o, "candidatures"));
      const head = el("div", "a-head");
      head.append(el("p", "a-emp", o.employeur || "Employeur inconnu"), el("span", `chip ${STATUT_CLASS[o.statut] || ""}`, o.statut));
      b.append(head, el("p", "a-title", o.intitule || "(sans intitulé)"));
      const meta = [o.ville, o.type, o.date && `détectée le ${fmtDay(o.date)}`].filter(Boolean).join(" · ");
      if (meta) b.append(el("p", "a-meta", meta));
      if (o.debut) b.append(el("p", "a-debut", `Début : ${o.debut}`));
      if (o.attente) b.append(el("p", "a-state", "Mise à jour du Sheet en cours…"));
      li.append(b);
      list.append(li);
    }
  }
}

/* ---------- robot de candidature ---------- */
async function cleDe(id) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(id));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function lireJson(chemin) {
  const r = await gh(repoPath(`/contents/${chemin}`), { accept: RAW });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub a répondu ${r.status}.`);
  return r.json();
}

function quand(iso) { const t = Date.parse(iso || ""); return isNaN(t) ? 0 : t; }

async function lancerRobot(o) {
  if (!confirm("Le robot va remplir cette candidature dans le cloud.\n\nGarde ton téléphone à portée : il t'appellera "
    + "(e-mail + bannière dans l'appli) pour un captcha ou une question, puis pour que tu valides l'envoi. Rien ne part sans ton « Envoyer ».\n\nLancer ?")) return;
  try {
    const r = await gh(repoPath("/dispatches"), {
      method: "POST",
      body: JSON.stringify({ event_type: "postuler", client_payload: { id: o.id, mode: "direct" } }),
    });
    if (r.status !== 204) throw new Error(r.status === 401 ? "Jeton refusé ou expiré." : `GitHub a répondu ${r.status}.`);
  } catch (e) {
    toast(e instanceof TypeError ? "Pas de réseau : réessaie." : e.message);
    return;
  }
  S.robots[o.id] = { cle: await cleDe(o.id), at: Date.now(), employeur: o.employeur || "", intitule: o.intitule || "" };
  store.set("robots", S.robots);
  closeDetail();
  toast("Robot lancé : il démarre dans 1 à 2 minutes.");
  suivreRobots();
}

async function suivreRobots() {
  clearTimeout(S.robotTimer);
  const actifs = Object.entries(S.robots).filter(([, r]) => !r.fin && Date.now() - r.at < 50 * 60000);
  for (const [id, r] of actifs) {
    try {
      const live = await lireJson(`app_data/live/${r.cle}.json`);
      const recent = live && quand(live.depuis) >= r.at - 60000;
      const avant = r.live?.url;
      r.live = recent && live.etat === "attente" && safeUrl(live.url) ? { url: live.url, raison: live.raison || "" } : null;
      if (r.live && r.live.url !== avant && navigator.vibrate) navigator.vibrate([200, 100, 200]);
      const res = await lireJson(`app_data/candidatures/${r.cle}.json`);
      if (res && quand(res.maj) >= r.at - 60000) {
        r.fin = { statut: res.statut, message: res.message };
        r.live = null;
        toast(`${r.employeur} : ${res.message}`);
        if (res.statut === "envoye") refresh();
      }
    } catch { /* réseau : on réessaie au prochain tour */ }
  }
  for (const [id, r] of Object.entries(S.robots)) if (Date.now() - r.at > 3 * 864e5) delete S.robots[id];
  store.set("robots", S.robots);
  renderRobots();
  if (Object.values(S.robots).some((r) => !r.fin && Date.now() - r.at < 50 * 60000)) {
    S.robotTimer = setTimeout(suivreRobots, 5000);
  }
}

function renderRobots() {
  const box = $("#robot-banner");
  box.replaceChildren();
  const actifs = Object.values(S.robots).filter((r) => !r.fin && Date.now() - r.at < 50 * 60000);
  const attente = actifs.find((r) => r.live);
  if (attente) {
    box.className = "robot-banner urgent";
    box.append(el("span", "", `🤖 ${attente.employeur} : le robot t'attend (${attente.live.raison || "action requise"})`));
    box.append(link("robot-open", "Ouvrir la vue en direct", attente.live.url));
  } else if (actifs.length) {
    box.className = "robot-banner";
    box.append(el("span", "", `🤖 Robot en cours : ${actifs.map((r) => r.employeur).join(", ")}…`));
  }
  box.hidden = !box.childElementCount;
}

async function blocRobot(o, conteneur) {
  try {
    const cle = await cleDe(o.id);
    const res = await lireJson(`app_data/candidatures/${cle}.json`);
    if (!res || S.sheet?.o !== o) return;
    const libelle = { envoye: "Envoyée", pret: "Remplie, non envoyée", manuel: "À finir toi-même", action_requise: "Action requise", erreur: "Erreur" }[res.statut] || res.statut;
    const bloc = el("div", "robot-res");
    bloc.append(el("strong", "", `Robot · ${libelle}`), el("p", "", res.message || ""));
    for (const q of res.questions || []) bloc.append(el("p", "small", `• ${q}`));
    if (res.maj) bloc.append(el("p", "small", `Dernier passage : ${fmtStamp(res.maj)}`));
    conteneur.append(bloc);
  } catch { /* pas de résultat */ }
}

/* ---------- fiche détail ---------- */
function loadDetail(o) {
  if (!o.d) return Promise.reject(new Error("Le détail de cette offre n'a pas encore été récupéré. Il le sera au prochain passage."));
  if (!S.details.has(o.d)) {
    const p = gh(repoPath(`/contents/app_data/details/${encodeURIComponent(o.d)}.json`), { accept: RAW }).then((r) => {
      if (r.status === 404) throw new Error("Le détail de cette offre n'a pas encore été récupéré.");
      if (!r.ok) throw new Error(`GitHub a répondu ${r.status}.`);
      return r.json();
    });
    S.details.set(o.d, p);
    p.catch(() => S.details.delete(o.d));
  }
  return S.details.get(o.d);
}

function openDetail(o, from) {
  if (S.animating) return;
  S.sheet = { o, from };
  const body = $("#sheet-body");
  body.replaceChildren();
  const top = el("div", "card-top");
  top.append(el("span", `badge t-${slug(o.type)}`, o.type || "Offre"), scoreEl(o.score));
  body.append(top, el("p", "emp", o.employeur || "Employeur inconnu"));
  const h = el("h2", "title full", o.intitule || "(sans intitulé)");
  h.id = "sheet-title";
  body.append(h);
  const meta = [o.ville, o.source && `via ${o.source}`].filter(Boolean).join(" · ");
  if (meta) body.append(el("p", "meta", meta));
  const dates = [o.date && `Détectée le ${fmtDay(o.date)}`, o.publication && `publiée le ${fmtDay(o.publication)}`].filter(Boolean).join(" · ");
  if (dates) body.append(el("p", "dates", dates));
  if (from === "candidatures" && o.statut) {
    const line = el("p", "status-line");
    line.append(el("span", `chip ${STATUT_CLASS[o.statut] || ""}`, o.statut));
    body.append(line);
  }
  if (o.ferme) body.append(el("p", "note", "Annonce probablement fermée : vérifie sur le site."));
  if (o.debut) body.append(el("p", "debut", `Début : ${o.debut}`));
  else if (o.remarque) body.append(el("p", "note", o.remarque));
  const links = el("div", "sheet-links");
  const first = safeUrl(o.lien);
  if (first) links.append(link("open primary-link", "Voir l'offre sur le site ↗", first));
  body.append(links);
  const infos = el("dl", "infos");
  const desc = el("div", "desc", "Chargement du détail…");
  desc.classList.add("muted");
  body.append(infos, el("h3", "desc-title", "Description"), desc);

  const actions = $("#sheet-actions");
  actions.replaceChildren();
  if (from === "trier") {
    const no = el("button", "act-wide no", "✕  Passer");
    const yes = el("button", "act-wide yes", "✓  Postuler");
    no.type = yes.type = "button";
    const pick = (statut) => {
      closeDetail();
      const [t, c] = topCard();
      decide(o, statut, t && t.id === o.id ? c : null);
    };
    no.addEventListener("click", () => pick(NO));
    yes.addEventListener("click", () => pick(YES));
    actions.append(no, yes);
  } else {
    if (o.statut === YES) {
      const go = el("button", "act-wide yes robot-go", "🤖  Postuler pour moi");
      go.type = "button";
      go.addEventListener("click", () => lancerRobot(o));
      actions.append(go);
      blocRobot(o, links);
    }
    const label = el("p", "chips-label", "Changer le statut :");
    const chips = el("div", "chips");
    for (const st of [...STATUTS, "Pas intéressé"]) {
      const b = el("button", `chip ${STATUT_CLASS[st]}`, st);
      b.type = "button";
      b.setAttribute("aria-pressed", String(st === o.statut));
      if (st !== o.statut) b.addEventListener("click", () => setStatus(o, st));
      chips.append(b);
    }
    actions.append(label, chips);
  }

  $("#sheet").hidden = false;
  document.body.classList.add("sheet-open");
  body.scrollTop = 0;
  try { history.pushState({ sheet: true }, ""); } catch { /* sans historique */ }
  $("#sheet-close").focus({ preventScroll: true });

  loadDetail(o).then((d) => {
    if (S.sheet?.o !== o) return;
    desc.classList.remove("muted");
    desc.textContent = d.description || "Pas de description lisible automatiquement : ouvre l'offre sur le site.";
    for (const [k, v] of Object.entries(d.infos || {})) {
      infos.append(el("dt", "", k), el("dd", "", String(v)));
    }
    const direct = safeUrl(d.postuler || "");
    if (direct && direct !== first) {
      links.replaceChildren(link("open primary-link", "Postuler sur le site de l'employeur ↗", direct));
      if (first) links.append(link("open", "Annonce d'origine ↗", first));
    }
    if (d.ferme && !o.ferme) desc.before(el("p", "note", "Annonce probablement fermée : vérifie sur le site."));
  }).catch((e) => {
    if (S.sheet?.o !== o) return;
    desc.textContent = e instanceof TypeError ? "Pas de réseau : réessaie plus tard." : e.message;
  });
}

function closeDetail(fromHistory = false) {
  if ($("#sheet").hidden) return;
  $("#sheet").hidden = true;
  S.sheet = null;
  document.body.classList.remove("sheet-open");
  if (!fromHistory && history.state?.sheet) { try { history.back(); } catch { /* idem */ } }
}

/* Précharge le détail des deux prochaines cartes pour une ouverture instantanée. */
function prefetch() {
  for (const o of queue().slice(0, 2)) if (o.d) loadDetail(o).catch(() => {});
}

function render() {
  renderStatus();
  renderStack();
  renderCandidatures();
  if (S.token && S.data) prefetch();
}

function show(view) {
  S.view = view;
  for (const v of ["trier", "postuler", "reglages"]) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.view === view)));
  if (view === "reglages") fillSettings();
}

/* ---------- message temporaire ---------- */
let toastTimer = null;
function toast(text, withUndo = false) {
  $("#toast-text").textContent = text;
  $("#toast-undo").hidden = !withUndo;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, withUndo ? 4000 : 3500);
}
function hideToast() { $("#toast").hidden = true; }

/* ---------- réglages ---------- */
function fillSettings() {
  $("#token").value = S.token;
  $("#owner").value = S.cfg.owner;
  $("#repo").value = S.cfg.repo;
  $("#settings-result").textContent = "";
}

async function saveSettings(e) {
  e.preventDefault();
  const res = $("#settings-result");
  const token = $("#token").value.trim();
  const owner = $("#owner").value.trim() || DEFAULTS.owner;
  const repo = $("#repo").value.trim() || DEFAULTS.repo;
  res.className = "result";
  if (!token) { res.textContent = "Colle d'abord ton jeton."; res.classList.add("err"); return; }
  S.token = token;
  S.cfg = { ...S.cfg, owner, repo };
  store.set("token", token);
  store.set("cfg", { owner, repo });
  res.textContent = "Test en cours…";
  try {
    const r = await gh(repoPath(""));
    if (r.status === 401) throw new Error("Jeton refusé : vérifie qu'il est complet et pas expiré.");
    if (r.status === 404) throw new Error("Dépôt introuvable avec ce jeton : vérifie qu'il donne accès à veille-emploi-markets.");
    if (!r.ok) throw new Error(`GitHub a répondu ${r.status}.`);
    res.textContent = "✓ Accès au dépôt OK. Chargement des offres…";
    res.classList.add("ok");
    await refresh();
    if (S.data) { res.textContent = "✓ Tout est prêt."; show("trier"); }
    else { res.textContent = S.error || "Accès OK, mais la liste n'existe pas encore."; }
    flush();
  } catch (err) {
    res.textContent = err instanceof TypeError ? "Pas de réseau." : err.message;
    res.classList.add("err");
  }
}

function resetAll() {
  if (!confirm("Effacer le jeton et les données de l'appli sur ce téléphone ?")) return;
  store.clear();
  S.token = ""; S.data = null; S.decided = {}; S.later = []; S.history = []; S.cfg = { ...DEFAULTS }; S.error = "";
  S.details.clear();
  fillSettings();
  render();
}

/* ---------- démarrage ---------- */
function init() {
  $("#btn-yes").addEventListener("click", () => { const [o, c] = topCard(); if (o) decide(o, YES, c); });
  $("#btn-no").addEventListener("click", () => { const [o, c] = topCard(); if (o) decide(o, NO, c); });
  $("#btn-later").addEventListener("click", () => { const [o, c] = topCard(); if (o) postpone(o, c); });
  $("#btn-undo").addEventListener("click", undo);
  $("#toast-undo").addEventListener("click", undo);
  $("#btn-refresh").addEventListener("click", () => { refresh(); flush(); });
  $("#btn-settings").addEventListener("click", () => show(S.view === "reglages" ? "trier" : "reglages"));
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#btn-reset").addEventListener("click", resetAll);

  $("#sheet-close").addEventListener("click", () => closeDetail());
  window.addEventListener("popstate", () => closeDetail(true));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeDetail(); return; }
    if (S.sheet || S.view !== "trier" || e.target.closest("input, textarea")) return;
    const [o, c] = topCard();
    if (e.key === "ArrowRight" && o) decide(o, YES, c);
    else if (e.key === "ArrowLeft" && o) decide(o, NO, c);
    else if (e.key === "ArrowUp" && o) postpone(o, c);
    else if (e.key === "Backspace" || e.key === "z") undo();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush({ keepalive: true });
    else {
      if (Date.now() - S.lastRefresh > 5 * 60000) refresh();
      flush();
      suivreRobots();
    }
  });
  window.addEventListener("online", () => flush());

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  render();
  if (!S.token) show("reglages");
  else { refresh(); flush(); suivreRobots(); }
}

init();
