"use strict";
/*
 * Swipe Markets — trie les offres de la veille d'un geste.
 * Lit app_data/offres.json dans le dépôt privé (API GitHub, jeton stocké sur ce téléphone)
 * et envoie les choix par lots (événement repository_dispatch « decisions ») :
 * le workflow « Appli — choix du swipe » les écrit dans la colonne Statut du Google Sheet.
 */

const DEFAULTS = { owner: "ThomasMrtnz", repo: "veille-emploi-markets", path: "app_data/offres.json" };
const API = "https://api.github.com";
const YES = "À postuler";
const NO = "Pas intéressé";
const FLUSH_DELAY = 8000;
const BATCH = 50;
const KEEP_MS = 60 * 864e5;

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
  decided: store.get("decided", {}),   // id -> {statut, at, sent, lien, employeur, intitule, ville, type}
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

/* Oublie les choix déjà envoyés quand la liste du serveur les a pris en compte. */
function prune() {
  const pending = new Set((S.data?.a_trier || []).map((o) => o.id));
  const old = Date.now() - KEEP_MS;
  for (const [id, d] of Object.entries(S.decided)) {
    if (d.sent && (!pending.has(id) || d.at < old)) delete S.decided[id];
  }
  S.later = S.later.filter((id) => pending.has(id));
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
        client_payload: { decisions: chunk.map(([id, d]) => ({ id, lien: d.lien || "", statut: d.statut })) },
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
    renderApply();
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
  if (o.remarque) c.append(el("p", "note", o.remarque));
  c.append(el("div", "spacer"));
  const url = safeUrl(o.lien);
  if (url) {
    const a = el("a", "open", "Voir l'offre ↗");
    a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
    c.append(a);
  }
  c.append(el("div", "stamp yes", "POSTULER"), el("div", "stamp no", "PASSER"), el("div", "stamp later", "PLUS TARD"));
  return c;
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

function decide(o, statut, c, dy = 0) {
  if (S.animating) return;
  flyOut(c, statut === YES ? "right" : "left", dy, () => {
    S.decided[o.id] = {
      statut, at: Date.now(), sent: 0,
      lien: o.lien || "", employeur: o.employeur || "", intitule: o.intitule || "", ville: o.ville || "", type: o.type || "",
    };
    S.later = S.later.filter((x) => x !== o.id);
    S.history.push({ id: o.id, kind: "decide" });
    store.set("hinted", true);
    save();
    render();
    toast(statut === YES ? `À postuler : ${o.employeur}` : `Passée : ${o.employeur}`, true);
    scheduleFlush();
  });
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

function applyItems() {
  const server = (S.data?.a_postuler || []).filter((o) => o && o.id);
  const known = new Set(server.map((o) => o.id));
  const local = Object.entries(S.decided)
    .filter(([id, d]) => d.statut === YES && !known.has(id))
    .sort((a, b) => b[1].at - a[1].at)
    .map(([id, d]) => ({ id, ...d, etat: d.sent ? "Envoyé, mise à jour du Sheet en cours" : "En attente d'envoi" }));
  return [...local, ...server];
}

function renderApply() {
  const items = applyItems();
  $("#count-postuler").textContent = S.data || items.length ? String(items.length) : "";
  const links = $("#apply-links");
  links.replaceChildren();
  for (const [key, label] of [["dossier_candidatures", "Dossier Drive des candidatures ↗"], ["sheet", "Google Sheet ↗"]]) {
    const url = safeUrl(S.data?.[key] || "");
    if (!url) continue;
    const a = el("a", "", label);
    a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
    links.append(a);
  }
  const list = $("#apply-list");
  list.replaceChildren();
  if (!items.length) {
    list.append(el("li", "apply-empty", "Aucune offre à postuler pour l'instant. Glisse une carte à droite pour en ajouter."));
    return;
  }
  for (const o of items) {
    const li = el("li");
    li.append(el("p", "a-emp", o.employeur || "Employeur inconnu"), el("p", "a-title", o.intitule || "(sans intitulé)"));
    const meta = [o.ville, o.type, o.date && `détectée le ${fmtDay(o.date)}`].filter(Boolean).join(" · ");
    if (meta) li.append(el("p", "a-meta", meta));
    if (o.etat) li.append(el("p", "a-state", o.etat));
    const url = safeUrl(o.lien);
    if (url) {
      const a = el("a", "", "Voir l'offre ↗");
      a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
      li.append(a);
    }
    list.append(li);
  }
}

function render() {
  renderStatus();
  renderStack();
  renderApply();
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

  document.addEventListener("keydown", (e) => {
    if (S.view !== "trier" || e.target.closest("input, textarea")) return;
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
    }
  });
  window.addEventListener("online", () => flush());

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  render();
  if (!S.token) show("reglages");
  else { refresh(); flush(); }
}

init();
