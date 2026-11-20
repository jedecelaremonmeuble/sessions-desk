const LABEL = { waiting:'bloquée sur une question', ask:'attend ta décision', done:'terminé, à relire', busy:'travaille', shell:'attend sa commande en arrière-plan', idle:'inactive', auto:'automate sans terminal (claude -p)', teams:'attend un retour Teams', closed:'fermée' };
const GROUPS = [
  { key:'todo',   title:'À traiter',  states:['waiting','ask','done'], asc:true },
  { key:'work',   title:'Au travail', states:['busy','shell'] },
  // Sessions dont le tour est fini (ou fermées) et qui attendent la réponse d'un collègue sur Teams : rien à faire tant
  // qu'il n'a pas répondu (le veilleur injecte la réponse et la session repart seule). Voir teamsHeld.
  { key:'teams',  title:'⏳ Attente Teams', states:['teams'] },
  { key:'idle',   title:'Inactives',  states:['idle'] },
  // Runs du lanceur du jour (+ en cours) et autres claude -p lancés par un script : suivis ici, pas pilotables d'ici.
  // Replié, le groupe garde visibles les runs en cours, en échec et ceux qui attendent l'utilisateur.
  { key:'auto',   title:'🤖 Lanceur', states:['auto'] },
  { key:'closed', title:'Fermées, reprenables', states:['closed'] } ];
let data = null, closedData = { days:0, closed:[] }, flat = [], notice = null, lastScreen = null, detailKey = null;
let favs = new Set(), favOnly = localStorage.getItem('cc.favonly') === '1';
// Ordre dans chaque groupe : 'activity' (dernier changement d'état, par défaut) ou 'created' (création de la session, la plus
// récente d'abord). createdAt vient du serveur (1er horodatage du transcript) ; un run du lanceur n'en a pas : son début.
let sortMode = localStorage.getItem('cc.sort') === 'created' ? 'created' : 'activity';
const createdOf = it => it.createdAt || it.startedAt || it.at || it.since || 0;
let selected = new URLSearchParams(location.search).get('sel') || sessionStorage.getItem('cc.sel');   // ?sel=<sessionId> : lien direct
let collapsed = new Set(JSON.parse(localStorage.getItem('cc.collapsed') || '["closed"]'));
if (!localStorage.getItem('cc.autoGroup')) { collapsed.add('auto'); localStorage.setItem('cc.autoGroup', '1'); localStorage.setItem('cc.collapsed', JSON.stringify([...collapsed])); }   // replié par défaut
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ago = ms => { const s = Math.max(0, Math.round(ms/1000)); if (s < 60) return s + ' s'; const m = Math.floor(s/60); if (m < 60) return m + ' min'; const h = Math.floor(m/60); return h < 48 ? h + ' h ' + String(m%60).padStart(2,'0') : Math.floor(h/24) + ' j'; };
const ktok = n => n == null ? '' : n < 1000 ? String(n) : Math.round(n / 1000) + ' k';
// « claude-opus-5-5 » → « Opus 5.5 », « claude-fable-5-2[1m] » → « Fable 5.2 1M » ; un id inconnu s'affiche tel quel.
const modelName = m => { if (!m) return ''; const x = /^claude-([a-z]+)-(\d{1,2})-(\d{1,2})(?!\d)/.exec(m); return x ? x[1][0].toUpperCase() + x[1].slice(1) + ' ' + x[2] + '.' + x[3] + (m.includes('[1m]') ? ' 1M' : '') : m.replace(/^claude-/, ''); };
// Réglages d'affichage du poste (data.ui : préfixe de chemin à ne pas répéter, adresses des PR et des tickets).
const ui = () => (data && data.ui) || {};
const short = p => { const s = p || '', pre = ui().pathPrefix || ''; return (pre && s.toLowerCase().startsWith(pre.toLowerCase()) ? s.slice(pre.length).replace(/^[\\/]+/, '') : s) || s; };
const norm = t => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Lien avec le serveur (voir tick) : déclaré tôt, post() et l'envoi le lisent.
const link = { boot: null, page: null, down: null, reload: false };   // down : { since, tries, why } pendant une coupure
let ticking = false;
const say = t => { notice = t; $('live').textContent = t; setTimeout(() => { if (notice === t) notice = null; }, 5000); };
const label = it => it.title || it.name || String(it.pid || it.sessionId.slice(0, 8));
// Une session qui a fini son tour « demande » quelque chose si la fin de son dernier message est une
// question ou sollicite un accord. Simple heuristique : sinon elle est « terminé, à relire ».
const tailOf = r => (r || '').trim().split(/\n\s*\n/).slice(-2).join('\n');
// Aussi la consigne à dire entre guillemets (« Dis « envoie » et je le poste », « Réponds « go » ») : sans elle, une
// session qui attend ce mot finissait « à relire », donc rangée dans ⏳ Attente Teams quand elle avait aussi écrit à
// un collègue — invisible alors que c'est à toi de jouer.
const asks = r => { const t = tailOf(r); return /\?\s*$/m.test(t) || /\b(le go|ton go|votre go|ton accord|votre accord|feu vert|dis-moi|dites-moi|donne-moi|donnez-moi|veux-tu|voulez-vous|souhaites-tu|souhaitez-vous|à toi de|à vous de|dès que tu|j'attends ton|j'attends ta|let me know|should i)\b/i.test(t)
  || /(^|[^\p{L}])(dis|dites|réponds|répondez|tape|tapez|écris|écrivez|say|reply|type)\s*[«"“]/iu.test(t); };
const lastLine = r => { const l = (r || '').split('\n').map(x => x.trim()).filter(Boolean); return l.length ? l[l.length - 1].replace(/[*`#]/g, '') : ''; };
const TODO = ['waiting', 'ask', 'done'];

// ── Quota des comptes Claude ──
// Relevé par le collecteur du lanceur toutes les 5 min (data.quota, dates en ms). Fonction pure, testée par
// sessions-dashboard-tests.ps1 : % de la semaine, part de la semaine écoulée, écart au rythme régulier, budget par jour
// jusqu'à la remise, rythme récent (déduit de la projection du collecteur, faite sur les 30 dernières heures).
const WEEK = 7 * 864e5, DAY = 864e5;
function quotaView(q, now) {
  const v = { alias: q.alias || '', active: !!q.active, status: q.status || '', pct: q.weeklyPct ?? null, projected: q.weeklyProjectedPct ?? null, age: q.measuredAt ? now - q.measuredAt : null };
  v.ok = v.pct != null;
  v.expired = !!(q.weeklyResetsAt && q.weeklyResetsAt <= now);                 // remise passée : le relevé ne vaut plus
  v.stale = v.expired || (v.age != null && v.age > 30 * 60000) || (!!v.status && v.status !== 'ok');
  if (q.weeklyResetsAt && !v.expired) { v.reset = q.weeklyResetsAt; v.elapsed = Math.min(100, Math.max(0, 100 * (now - (v.reset - WEEK)) / WEEK)); }
  if (v.ok && v.elapsed != null && !v.expired) {
    v.pace = Math.round(v.pct - v.elapsed);                                     // > 0 : consommé plus vite qu'un rythme régulier
    const days = Math.max(1 / 24, (v.reset - now) / DAY);
    v.budgetPerDay = Math.max(0, 100 - v.pct) / days;                           // ce qu'on peut dépenser par jour sans atteindre 100 %
    if (v.projected != null && v.projected >= v.pct) v.recentPerDay = (v.projected - v.pct) / days;
  }
  v.fullAt = q.weeklyFullAt && q.weeklyFullAt > now && (!v.reset || q.weeklyFullAt < v.reset) && !v.expired ? q.weeklyFullAt : null;
  // Limite propre à un modèle (« Fable ») : même semaine que la limite globale, sa barre porte le même repère.
  v.models = (q.limits || []).filter(l => l.model && l.pct != null).map(l => {
    const reset = l.resetsAt && l.resetsAt > now ? l.resetsAt : null;
    return { name: l.model, pct: l.pct, reset, elapsed: reset ? Math.min(100, Math.max(0, 100 * (now - (reset - WEEK)) / WEEK)) : v.elapsed ?? null,
             level: v.expired ? 'idle' : l.pct >= 90 ? 'waiting' : l.pct >= 75 ? 'ask' : 'busy' };
  });
  v.fiveHour = q.fiveHourPct != null ? { pct: q.fiveHourPct, reset: q.fiveHourResetsAt || null } : null;
  v.level = !v.ok || v.expired ? 'idle' : v.pct >= 90 ? 'waiting' : v.pct >= 75 || v.fullAt ? 'ask' : 'busy';
  return v;
}
const PLAN_FR = p => { const m = /max_(\d+)x/i.exec(p || ''); return m ? 'Max ' + m[1] + 'x' : /pro/i.test(p || '') ? 'Pro' : (p || '').replace(/^default_claude_/, ''); };
const atFr = ms => new Date(ms).toLocaleString('fr-FR', { weekday:'short', hour:'2-digit', minute:'2-digit' });
const inFr = ms => { const m = Math.max(0, Math.round(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d ? d + ' j ' + h + ' h' : h ? h + ' h ' + String(m % 60).padStart(2, '0') : m + ' min'; };
const pts = n => (n > 0 ? '+' : '') + n + ' pt' + (Math.abs(n) > 1 ? 's' : '');
const quotas = () => ((data && data.quota) || []).map(q => quotaView(q, Date.now()));
function quotaBar(v) {
  const b = el('div', 'qbar ' + v.level); const f = el('i'); f.style.width = Math.min(100, v.pct || 0) + '%'; b.append(f);
  if (v.elapsed != null) { const m = el('u'); m.style.left = v.elapsed + '%'; m.title = Math.round(v.elapsed) + ' % de la semaine écoulée'; b.append(m); }
  return b;
}
// MODE DÉGRADÉ des propositions de prompt. Claude Code cesse d'en générer dès que le quota n'est plus « allowed »
// (une limite active en alerte : severity autre que normal) — sauf si CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION est forcée
// (data.promptSuggestion.forced, lue dans ~/.claude/settings.json) ; quota épuisé : plus rien dans tous les cas.
// Sans cette ligne, la ligne 💡 disparaît de la liste sans explication. Pure : (data.quota, data.promptSuggestion, now).
// Seul le compte CONNECTÉ compte : c'est son quota que voient les sessions — un autre compte à 100 % ne coupe rien.
// Compte connecté inconnu (aucun relevé marqué active) : on retombe sur tous les comptes.
function suggestionMode(quota, setting, now) {
  const ok = (quota || []).filter(q => q.status === 'ok'), mine = ok.some(q => q.active) ? ok.filter(q => q.active) : ok;
  const lims = mine.flatMap(q => (q.limits || []).map(l => ({ ...l, reset: l.resetsAt || q.weeklyResetsAt || null })))
    .filter(l => l.active && (!l.reset || l.reset > now));
  const full = lims.filter(l => l.pct != null && l.pct >= 100), warn = lims.filter(l => l.severity && l.severity !== 'normal');
  if (!full.length && !warn.length) return null;
  const back = Math.max(...(full.length ? full : warn).map(l => l.reset || 0)) || null;
  const forced = !!(setting && setting.forced);
  if (full.length) return { level: 'waiting', text: '💡 mode dégradé : quota épuisé, plus de proposition de prompt', back,
    tip: 'Une limite est à 100 % : Claude Code ne génère aucune proposition, même forcée.' };
  if (forced) return { level: 'ask', text: '💡 mode dégradé : propositions forcées', back,
    tip: 'Quota en alerte : Claude Code couperait les propositions, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION les force (elles consomment un peu de quota).'
      + (setting.since ? '\nRéglage posé ' + atFr(setting.since) + ' : une session ouverte avant ne le voit qu’après redémarrage.' : '') };
  return { level: 'waiting', text: '💡 mode dégradé : Claude Code ne propose plus de prompt', back,
    tip: 'Quota en alerte : Claude Code ne génère plus de proposition de prompt (ligne 💡 de la liste vide).\nPour les garder : CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true dans le bloc env de ~/.claude/settings.json (nouvelles sessions).' };
}
// Bandeau compact de la barre latérale : un compte par ligne (le nom seulement s'il y en a plusieurs).
function renderQuota() {
  const box = $('quota'); if (!box) return;
  const vs = quotas().filter(v => v.ok);
  const sm = suggestionMode(data && data.quota, data && data.promptSuggestion, Date.now());
  const sig = vs.map(v => [v.alias, v.pct, v.level, v.fullAt, v.stale, Math.round(v.elapsed || 0), v.models.map(m => m.name + '=' + m.pct + m.level).join(',')].join(':')).join('|') + '|' + (sm ? sm.text + sm.back : '');
  const sigA = sig + '|' + vs.map(v => v.active ? 1 : 0).join('');           // compte connecté : la mise en avant suit la bascule /login
  if (box.dataset.sig === sigA) return; box.dataset.sig = sigA; box.replaceChildren();
  for (const v of vs) {
    const d = el('div', 'qline' + (v.stale ? ' stale' : '') + (v.active && vs.length > 1 ? ' active' : ''));
    d.title = 'Quota hebdomadaire Claude' + (vs.length > 1 ? ' — ' + v.alias : '') + (v.active ? ' (compte connecté, celui que consomment les sessions)' : '') + ' · cliquer : détail dans la vue d\'ensemble';
    const txt = el('span', 'qt');
    txt.append(el('b', null, Math.round(v.pct) + ' %'), ' semaine' + (vs.length > 1 ? ' · ' + v.alias.split('@')[0] : ''));
    const info = v.expired ? 'relevé d\'avant la remise' : v.fullAt ? '100 % ' + atFr(v.fullAt) : v.reset ? 'remise ' + atFr(v.reset) : '';
    const main = el('div', 'qcell'); main.append(txt, el('span', 'qx' + (v.fullAt ? ' warn' : ''), info), quotaBar(v)); d.append(main);
    for (const m of v.models) {                                                 // même ligne : une barre par modèle limité à part
      const mc = el('div', 'qcell'), mt = el('span', 'qt'); mt.append(el('b', null, Math.round(m.pct) + ' %'), ' ' + m.name);
      mc.title = 'Quota hebdomadaire propre au modèle ' + m.name;
      mc.append(mt, el('span', 'qx'), quotaBar(m)); d.append(mc);
    }
    d.onclick = () => { findMode = newMode = bcMode = boardMode = chatsMode = false; if (launchMode) closeLauncher(); selected = null; sessionStorage.removeItem('cc.sel'); renderList(); renderDetail(true); };
    box.append(d);
  }
  if (sm) {
    const d = el('div', 'qdeg ' + sm.level); d.title = sm.tip;
    d.append(el('span', null, sm.text), el('span', 'qx', sm.back ? 'retour ' + atFr(sm.back) : ''));
    box.append(d);
  }
}
// Détail dans la vue d'ensemble.
function quotaSection() {
  const vs = quotas(); if (!vs.length) return null;
  const box = el('div', 'qcards');
  for (const v of vs) {
    const c = el('div', 'qcard ' + v.level + (v.active && vs.length > 1 ? ' active' : ''));
    const h = el('div', 'qhead'); h.append(el('b', null, v.ok ? Math.round(v.pct) + ' %' : '—'), el('span', null, v.alias + (data.quota.find(q => q.alias === v.alias)?.plan ? ' · ' + PLAN_FR(data.quota.find(q => q.alias === v.alias).plan) : '') + (v.active && vs.length > 1 ? ' · connecté' : '')));
    c.append(h);
    if (v.ok) {                                                                 // barres côte à côte : tous modèles, puis chaque modèle limité à part
      const row = el('div', 'qrow');
      const cell = (pct, label, bar) => { const x = el('div', 'qcell'), t = el('div', 'qmodel'); t.append(el('b', null, Math.round(pct) + ' %'), el('span', null, label)); x.append(t, bar); return x; };
      if (v.models.length) { row.append(cell(v.pct, 'tous modèles', quotaBar(v))); for (const m of v.models) row.append(cell(m.pct, 'modèle ' + m.name, quotaBar(m))); c.append(row); }
      else c.append(quotaBar(v));
    }
    const lines = [];
    if (!v.ok) lines.push(['pas de mesure', v.status || 'aucun relevé']);
    if (v.expired) lines.push(['remise', 'passée depuis le relevé — en attente d\'une nouvelle mesure']);
    else if (v.reset) lines.push(['remise', 'dans ' + inFr(v.reset - Date.now()) + ' (' + atFr(v.reset) + ')']);
    if (v.pace != null) lines.push(['rythme', Math.round(v.elapsed) + ' % de la semaine écoulée · ' + (v.pace === 0 ? 'pile dans le rythme régulier' : pts(v.pace) + (v.pace > 0 ? ' au-dessus' : ' sous') + ' du rythme régulier')]);
    if (v.budgetPerDay != null) lines.push(['budget', Math.round(v.budgetPerDay) + ' %/jour jusqu\'à la remise' + (v.recentPerDay != null ? ' · rythme des 30 dernières heures : ' + Math.round(v.recentPerDay) + ' %/jour' : '')]);
    if (v.projected != null && !v.expired) lines.push(['projection', Math.round(v.projected) + ' % à la remise' + (v.fullAt ? ' — 100 % atteint ' + atFr(v.fullAt) + ' (dans ' + inFr(v.fullAt - Date.now()) + ')' : '')]);
    if (v.fiveHour) lines.push(['fenêtre 5 h', Math.round(v.fiveHour.pct) + ' %' + (v.fiveHour.reset ? ' · remise ' + atFr(v.fiveHour.reset) : '')]);
    if (v.age != null) lines.push(['relevé', 'il y a ' + ago(v.age) + (v.status && v.status !== 'ok' ? ' · dernière tentative : ' + v.status : '') + (v.stale && !v.expired && v.status === 'ok' ? ' — le collecteur du lanceur tourne-t-il ?' : '')]);
    const dl = el('dl'); for (const [k, x] of lines) dl.append(el('dt', null, k), el('dd', null, x)); c.append(dl);
    box.append(c);
  }
  return box;
}
// « shell » (tour fini, commande en arrière-plan) : si son dernier message te pose une question, c'est à toi ;
// sinon elle attend sa commande et reprendra seule.
// « Attend ta décision ? » : l'heuristique OU le petit modèle (askVerdict, rendu par le serveur quelques secondes après la
// fin du tour, asks-judge.ts). L'heuristique se trompe rarement quand elle dit oui ; le modèle rattrape les formes qu'elle
// ne connaît pas (« when you give the go », « je peux regarder… », un essai à faire).
const asksOf = it => asks(it.reply) || !!(it.askVerdict && it.askVerdict.v);
const stateOf = it => it.kind === 'closed' ? 'closed' : it.kind === 'pass' ? 'auto:' + it.auto.id : it.kind === 'run' && it.cards && it.cards.length && !it.run.running ? 'ask' : it.kind === 'run' || it.headless ? 'auto' : it.status === 'idle' ? (it.done ? (asksOf(it) ? 'ask' : 'done') : 'idle')
  : it.status === 'shell' ? (asksOf(it) ? 'ask' : 'shell') : (LABEL[it.status] ? it.status : 'idle');
function prTags(it) {
  const p = it.prInfo; if (!p || !it.pr) return [];
  const out = [p.state === 'MERGED' ? el('span', 'tag merged', 'mergée') : p.state === 'CLOSED' ? el('span', 'tag closedpr', 'fermée sans merge') : el('span', 'tag ' + (p.draft ? 'draft' : 'open'), p.draft ? 'brouillon' : 'ouverte')];
  if (p.state === 'OPEN' && p.checks) out.push(el('span', 'tag ' + p.checks, p.checks === 'ok' ? 'CI verte' : p.checks === 'ko' ? 'CI rouge' : 'CI en cours'));
  return out;
}

function allItems() {
  if (!data) return [];
  const rg = runGroup();          // runs du lanceur : la session headless d'un run en cours est absorbée par lui
  const ag = autoGroup();         // passes des automates : idem pour la passe en cours
  const open = data.sessions.filter(s => !rg.absorbed.has(s.sessionId) && !ag.absorbed.has(s.sessionId)).map(s => ({ ...s, kind:'open', key:s.sessionId, since:s.statusSince }));
  const ids = new Set(data.sessions.map(s => s.sessionId));
  const runIds = new Set(rg.items.flatMap(it => it.runs || [it]).concat(ag.items).map(it => it.sessionId).filter(Boolean));     // un run « ↻ repris » n'est pas aussi une fermée
  const closed = closedData.closed.filter(c => !ids.has(c.sessionId) && !runIds.has(c.sessionId)).map(c => ({ ...c, kind:'closed', key:c.sessionId, since:c.lastActivity }));
  return open.concat(closed, rg.items, ag.items).map(it => ({ ...it, state: teamsHeld(stateOf(it), teamsWaitsOf(it)) ? 'teams' : stateOf(it), fav: favs.has(it.key), hidden: it.kind === 'closed' && hiddenSet.has(it.key),
    hay: norm([it.title, it.name, it.pr ? '#' + it.pr + ' pr ' + it.pr : '', it.sessionId, it.cwd, it.reply, it.suggestion, it.outcome, it.run ? (it.runs || [it]).map(x => x.run.phase + ' ' + (x.run.detail || '')).join(' ') : '', it.kind === 'pass' ? it.auto.label + ' ' + (it.pass ? it.pass.summary + ' ' + (PASS_FR[it.pass.status] || '') : 'en cours') : '', (it.prompts || []).map(p => p.text).join(' '), tagHay(it)].join(' ')) }));
}

// ── Tags de l'étiqueteur ──
// Puces par axe sous la ligne ; clic = filtre « axe:valeur » ajouté à la recherche (« tag:valeur » cherche tous les axes).
const TAG_AXES = ['domaine', 'outil', 'fonction', 'origine', 'hd'];
const ORIGINE_FR = { 'lanceur-diag':'lanceur · diagnostic', 'lanceur-dev':'lanceur · dev', 'lanceur-relecture':'lanceur · relecture', 'lanceur-recette':'lanceur · recette', 'lanceur-reprise':'lanceur · reprise', automate:'automate', interactive:'interactive' };
const tagSlug = v => norm(v).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tagToken = t => t.axis + ':' + tagSlug(t.v);
const isTagToken = s => /^(domaine|outil|fonction|origine|hd|tag):/i.test(s);
const tagHay = it => (it.tags || []).map(t => tagToken(t) + ' tag:' + tagSlug(t.v)).join(' ');
// Un filtre de tag vaut la valeur EXACTE (« fonction:lanceur » ne prend pas « fonction:lanceur-priorite ») ; undefined :
// ce n'est pas un filtre de tag, la recherche texte s'applique.
const tagMatch = (it, t) => isTagToken(t) ? (' ' + tagHay(it) + ' ').includes(' ' + norm(t) + ' ') : undefined;
function tagChips(it, cls) {
  // L'origine « interactive » (la majorité) et les HD (déjà dans le titre) ne prennent pas de place dans la liste.
  const ts = (it.tags || []).filter(t => TAG_AXES.includes(t.axis) && (cls === 'dtags' || (t.axis !== 'hd' && !(t.axis === 'origine' && t.v === 'interactive'))))
    .sort((a, b) => TAG_AXES.indexOf(a.axis) - TAG_AXES.indexOf(b.axis));
  // Détail : on corrige à la main (lot 3) — × retire un tag, « + tag » en ajoute un ; le manuel gagne sur l'étiqueteur.
  const edit = cls === 'dtags' && canWrite && it.sessionId;
  if (!ts.length && !edit) return null;
  const box = el('span', cls);
  for (const t of ts) {
    const c = el('span', 'chip ' + t.axis + (t.src === 'manuel' ? ' man' : ''), t.axis === 'origine' ? ORIGINE_FR[t.v] || t.v : t.v);
    c.title = t.axis + ' : ' + t.v + (t.src ? '  (source : ' + t.src + ')' : '') + '\nclic : filtrer la liste sur « ' + tagToken(t) + ' »';
    c.onclick = e => { e.stopPropagation(); filterTag(t); };
    c.ondblclick = e => e.stopPropagation();
    if (edit && TAG_EDITABLE.includes(t.axis)) {
      const x = el('span', 'x', '×'); x.title = 'Retirer ce tag (gardé retiré même si l’étiqueteur le repropose)';
      x.onclick = e => { e.stopPropagation(); postTag(it, t.axis, t.v, false); };
      c.append(x);
    }
    box.append(c);
  }
  if (edit) {
    const add = el('span', 'chip add', '+ tag'); add.title = 'Ajouter un domaine, un outil ou une fonctionnalité';
    add.onclick = e => { e.stopPropagation(); openTagEdit(it, add); };
    box.append(add);
  }
  return box;
}

// ── Correction à la main (lot 3) : POST /api/tags {id, axis, v, on} ; listes fermées par /api/tag-vocab ──
const TAG_EDITABLE = ['domaine', 'outil', 'fonction'];
let tagVocab = null;
async function loadTagVocab() {
  if (!tagVocab) { try { tagVocab = await (await fetch('/api/tag-vocab', { cache:'no-store' })).json(); } catch { return { domaines:[], outils:[] }; } }
  return tagVocab;
}
async function postTag(it, axis, v, on) {
  if (!canWrite) return;
  try {
    const r = await fetch('/api/tags', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ id: it.sessionId, axis, v, on }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { say(j.error || 'correction refusée'); return false; }
    say((on ? 'tag ajouté : ' : 'tag retiré : ') + axis + ' ' + v); tick(); return true;
  } catch { say('correction impossible'); return false; }
}
/** Fenêtre flottante attachée au document (l'en-tête du détail est redessiné toutes les 2 s : elle doit lui survivre). */
async function openTagEdit(it, anchor) {
  document.querySelector('.tagpop')?.remove();
  const vocab = await loadTagVocab();
  const fonctions = (() => {             // fonctionnalités déjà portées par des sessions, les plus fréquentes d'abord
    const n = new Map(); for (const x of allItems()) for (const t of x.tags || []) if (t.axis === 'fonction') n.set(t.v, (n.get(t.v) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  })();
  const pop = el('div', 'tagpop'); const r = anchor.getBoundingClientRect();
  pop.style.left = '8px'; pop.style.top = (r.bottom + 6) + 'px';
  const ax = el('select'); for (const a of TAG_EDITABLE) { const o = el('option', null, a); o.value = a; ax.append(o); }
  const inp = el('input'); inp.type = 'text'; inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('list', 'tagopts');
  const dl = el('datalist'); dl.id = 'tagopts';
  const fill = () => {
    dl.replaceChildren(); const list = ax.value === 'domaine' ? vocab.domaines : ax.value === 'outil' ? vocab.outils : fonctions;
    for (const v of list) { const o = el('option'); o.value = v; dl.append(o); }
    inp.placeholder = ax.value === 'fonction' ? 'ex. power-dial (minuscules, mots reliés par -)' : 'choisir dans la liste';
  };
  ax.onchange = () => { fill(); inp.value = ''; inp.focus(); };
  const ok = el('button', 'primary', 'Ajouter'), ko = el('button', null, 'Annuler');
  const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); };
  const outside = e => { if (!pop.contains(e.target)) close(); };
  const submit = async () => {
    const v = inp.value.trim(); if (!v) return;
    const closed = ax.value === 'domaine' ? vocab.domaines : ax.value === 'outil' ? vocab.outils : null;
    if (closed && !closed.includes(v)) { say(ax.value + ' hors liste : ' + v); return; }
    if (await postTag(it, ax.value, v, true)) close();
  };
  ok.onclick = submit; ko.onclick = close;
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') close(); e.stopPropagation(); };
  // Les touches tapées dans la fenêtre (y compris sur ses boutons) ne déclenchent pas les raccourcis de la page (t, f, /…).
  pop.onkeydown = e => { if (e.key === 'Escape') close(); e.stopPropagation(); };
  pop.append(ax, inp, dl, ok, ko); document.body.append(pop);
  // Placée sous « + tag », sans déborder de l'écran (largeur connue une fois affichée).
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  document.addEventListener('mousedown', outside, true);
  fill(); inp.focus();
}
// Validations métier (teams-watcher.ts, lot 5) : ce que le métier a tranché, qualifié par la session, avec sa
// preuve. Pures et autonomes. Une validation métier n'est jamais un go.
const VAL_FR = { valide:'validé', 'valide-reserve':'validé sous réserve', refuse:'refusé', 'a-preciser':'à préciser' };
const VAL_CH = { teams:'Teams', mail:'email', inbound:'demande Teams', relayed:'rapportée, sans écrit' };
function validationBadge(v) {
  if (!v || !v.total) return null;
  const ok = v.settled - v.refused, pl = (n, one, many) => n + ' ' + (n > 1 ? many : one);
  const parts = [ok ? pl(ok, 'validée', 'validées') : null, v.refused ? v.refused + ' refus' : null, v.pending ? v.pending + ' à préciser' : null,
    v.expected ? '⏳ ' + pl(v.expected, 'attendue', 'attendues') : null, v.unqualified ? '⚠️ ' + pl(v.unqualified, 'réponse non qualifiée', 'réponses non qualifiées') : null,
    v.unanswered ? pl(v.unanswered, 'sans réponse', 'sans réponse') : null].filter(Boolean);
  return (ok || v.refused || v.pending ? '✅ ' : '') + (parts.join(' · ') || pl(v.total, 'question', 'questions'));
}
// Âge court (comme teamsWaitLine) : « 40 min », « 3 h », « 2 j ».
const valAge = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + ' min' : m < 2880 ? Math.floor(m / 60) + ' h' : Math.floor(m / 1440) + ' j'; };
function validationLine(i, now) {
  const at = new Date(i.at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const since = i.expectedAt ? ' depuis ' + valAge((now || Date.now()) - i.expectedAt) : '';
  if (!i.withdrawn && (i.state === 'attendue' || i.state === 'non-qualifiee' || i.state === 'sans-reponse'))
    return i.q + ' · ' + (i.state === 'attendue' ? '⏳ attendue de ' + (i.to || '?') + since
      : i.state === 'non-qualifiee' ? '⚠️ ' + (i.to || '?') + ' a répondu, la session n’a rien enregistré'
      : 'sans réponse de ' + (i.to || '?') + ' (attente expirée)');
  return i.q + ' · ' + (i.withdrawn ? 'retirée' : VAL_FR[i.decision] || i.decision) + ' · ' + (i.validator || '?') + ' · ' + at + ' (' + (VAL_CH[i.channel] || i.channel) + ')'
    + (i.changes ? ' · modifiée ' + i.changes + ' fois' : '')
    // Recopie sur le ticket (lot 7) : rien tant que le module est éteint.
    + (!i.exported || i.withdrawn ? '' : i.exported === 'ok' ? ' · 📌 recopiée sur le ticket' : i.exported === 'echec' ? ' · ⚠️ recopie en échec'
      : i.exported === 'attente' ? ' · recopie à réessayer' : ' · non recopiée (' + i.exported.slice(5) + ')');
}
const validationsOf = it => (data && data.teams && data.teams.validations && it.sessionId && data.teams.validations[it.sessionId]) || null;

// Réponses Teams attendues (teams-watcher.ts, le cadrage) : une ligne par
// attente. Pure et autonome (testée seule par sessions-dashboard-tests.ps1).
function teamsWaitLine(w, now, remindersOn) {
  const d = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + ' min' : m < 2880 ? Math.floor(m / 60) + ' h' : Math.floor(m / 1440) + ' j'; };
  const day = t => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
  const at = t => (day(t) === day(now) ? '' : new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short' }) + ' ')
    + new Date(t).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  const who = w.chatLabel || 'le chat Teams';
  if (w.status === 'replied') return '💬 ' + (w.replyFrom || who) + ' a répondu il y a ' + d(now - (w.repliedAt ?? now)) + (w.lastError ? ' · pas encore transmise (' + w.lastError + ')' : ' · transmission en cours');
  let s = '⏳ attend ' + who + ' depuis ' + d(now - (w.firstSentAt ?? w.sentAt));
  if (w.reminders) s += ' · ' + w.reminders + (w.reminders > 1 ? ' relances faites' : ' relance faite');
  if (w.alertedAt) return '🔔 ' + who + ' n’a pas répondu depuis ' + d(now - (w.firstSentAt ?? w.sentAt)) + (w.reminders ? ' malgré ' + w.reminders + (w.reminders > 1 ? ' relances' : ' relance') : '');
  if (w.next && w.next.kind === 'remind' && remindersOn) s += ' · relance à ' + at(w.next.at);
  else if (w.next && w.next.kind === 'alert') s += ' · alerte à ' + at(w.next.at);
  if (w.lastError) s += ' (' + w.lastError + ')';
  return s;
}
// Boutons d'une attente (lot 2) : la règle est dans teams-watcher.ts, le serveur l'appelle.
async function teamsWaitAction(it, w, action) {
  if (!canWrite) return;
  try {
    const r = await fetch('/api/teams-wait', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ sessionId: it.sessionId, messageId: w.messageId, action }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { say(j.error || 'action refusée'); return; }
    say(action === 'dismiss' ? 'attente fermée' : action === 'remind' ? 'relance demandée : la session va écrire dans le chat' : 'relance repoussée au prochain jour ouvré, 10 h'); tick();
  } catch { say('action impossible'); }
}
// Rangée dans « ⏳ Attente Teams » : session terminée-à-relire, inactive ou fermée qui a au moins une attente OUVERTE
// (pas encore de réponse). Une réponse arrivée (replied), une session au travail, bloquée ou qui attend ta décision
// restent dans leur groupe : il y a quelque chose à voir. Pure (testée par sessions-dashboard-tests.ps1).
function teamsHeld(state, waits) {
  return ['done', 'idle', 'closed'].includes(state) && (waits || []).some(w => w.status === 'open');
}
const teamsWaitsOf = it => (data && data.teams && data.teams.sessions && it.sessionId && data.teams.sessions[it.sessionId]) || [];
// Demande Teams ENTRANTE (lot 3) : la session a été ouverte par le veilleur pour un message reçu en direct. Elle
// propose une réponse ; l'envoi au collègue est un geste de l'utilisateur, en deux clics (le rendu repart toutes les 2 s :
// l'armement vit ici, pas dans le bouton).
const teamsInboundOf = it => (data && data.teams && data.teams.inbound && it.sessionId && data.teams.inbound[it.sessionId]) || null;
let inboundArmed = { id: null, at: 0 };
const inboundIsArmed = it => inboundArmed.id === it.sessionId && Date.now() - inboundArmed.at < 6000;
function teamsInboundOrder(inb) {
  return 'Envoie ta réponse proposée telle quelle à ' + (inb.chatLabel || inb.from) + ' dans le chat Teams (chatId ' + inb.chatId + '), avec le pied de suivi habituel.';
}
async function teamsInboundSend(it, inb) {
  if (!canWrite) return;
  if (!inboundIsArmed(it)) { inboundArmed = { id: it.sessionId, at: Date.now() }; renderDetail(); return; }
  inboundArmed = { id: null, at: 0 };
  try {
    const r = await (await fetch('/api/send?pid=' + it.pid, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text: teamsInboundOrder(inb) }) })).json();
    say(r.error ? r.error : 'la session envoie la réponse à ' + (inb.chatLabel || inb.from)); tick();
  } catch { say('envoi impossible'); }
}
function filterTag(t) {
  const q = $('q'), tok = tagToken(t), cur = q.value.trim().split(/\s+/).filter(Boolean);
  q.value = (cur.includes(tok) ? cur.filter(x => x !== tok) : cur.concat(tok)).join(' ');   // 2e clic : retire le filtre
  renderList(); scheduleFind();
}
const byKey = key => allItems().find(it => it.key === key);

// ── Changements (git) d'une session ouverte : worktree (déduit de ses commandes), fichiers non commités, commits
// non poussés, retard sur master. « Peut se fermer » : inactive, rien à commiter ni à pousser, et PR mergée — ou
// branche poussée déjà intégrée à master.
// Sans worktree (jamais créé, ou déjà purgé), la session travaillait dans la copie principale, partagée : son
// désordre n'est pas le sien — seule la PR compte.
const prMerged = it => !!(it.prInfo && it.prInfo.state === 'MERGED');
const closable = it => {
  const g = it.git; if (it.kind !== 'open' || it.headless || it.status !== 'idle' || !g) return false;
  if (!g.worktree) return prMerged(it);
  if (g.nFiles || (g.upstream && g.ahead)) return false;
  return prMerged(it) || !!(g.upstream && g.merged);
};
const plural = (n, one, many) => n + ' ' + (n > 1 ? many : one);
const gitOpen = new Set();          // sessions dont la liste des fichiers est dépliée (survit aux rafraîchissements)
function gitBlock(it) {
  const box = el('div', 'gitbox'), g = it.git;
  const line = el('div', 'gl');
  const refresh = el('a', null, 'actualiser'); refresh.href = '#';
  refresh.onclick = async e => { e.preventDefault(); try { await post('/api/git-refresh?pid=' + it.pid); say('lecture de l\'état git…'); } catch { say('échec de la demande'); } };
  if (!g) { line.append(el('span', null, 'Changements : ' + (it.gitDir ? 'pas encore lus (' + short(it.gitDir) + ')' : 'dossier inconnu') + ' · '), refresh); box.append(line); return box; }
  if (!g.worktree) {
    line.append(el('span', 'gw', 'pas de worktree'), ' · aucun worktree existant dans ses dernières commandes (jamais créé, ou déjà purgé) : elle travaille dans la copie principale, partagée — ses changements n\'y sont pas isolables');
    if (closable(it)) { const t = el('span', 'tag merged', '✓ peut se fermer'); t.title = 'Inactive et PR mergée'; line.append(t); }
    box.append(line); return box;
  }
  const w = el('span', 'gw', 'worktree ' + g.top.split('\\').pop()); w.title = g.top + '\nDéduit des dernières commandes de la session'; line.append(w);
  line.append(' · ' + (g.branch && g.branch !== '(detached)' ? 'branche ' + g.branch : 'HEAD détaché'));
  if (closable(it)) { const t = el('span', 'tag merged', '✓ peut se fermer'); t.title = 'Inactive, rien à commiter ni à pousser, ' + (prMerged(it) ? 'PR mergée' : 'branche intégrée à ' + g.base); line.append(t); }
  line.append(el('span', 'tag ' + (g.nFiles ? 'ko' : 'ok'), g.nFiles ? plural(g.nFiles, 'fichier non commité', 'fichiers non commités') : 'rien à commiter'));
  if (g.upstream) { if (g.ahead) line.append(el('span', 'tag pending', plural(g.ahead, 'commit non poussé', 'commits non poussés'))); else line.append(el('span', 'tag ok', 'tout est poussé')); }
  else if (g.branch && g.branch !== '(detached)') line.append(el('span', 'tag pending', 'branche jamais poussée'));
  if (g.behind) line.append(el('span', 'tag pending', plural(g.behind, 'commit distant à récupérer', 'commits distants à récupérer')));
  if (g.base && g.baseBehind) { const t = el('span', 'tag draft', g.baseBehind + ' de retard sur ' + g.base.replace('origin/', '')); t.title = g.baseAhead + ' commit(s) de la branche absents de ' + g.base; line.append(t); }
  box.append(line);
  const l2 = el('div', 'gl');
  if (g.last) l2.append('dernier commit ' + g.last.h + ' « ' + g.last.s + ' » · il y a ' + ago(data.now - g.last.at) + ' · ');
  l2.append('lu il y a ' + ago(data.now - g.at) + ' · ', refresh);
  box.append(l2);
  if (g.nFiles) {
    const d = el('details'); d.open = gitOpen.has(it.key); d.ontoggle = () => d.open ? gitOpen.add(it.key) : gitOpen.delete(it.key);
    d.append(el('summary', null, g.nFiles > g.files.length ? g.files.length + ' premiers fichiers sur ' + g.nFiles : 'fichiers'));
    const ul = el('div', 'gfiles'); for (const f of g.files) { const r = el('div'); r.append(el('span', 'gk', f.k), f.p); ul.append(r); } d.append(ul); box.append(d);
  }
  return box;
}

// ── Ménage : fermer d'un coup les sessions qui peuvent se fermer (le serveur revérifie la règle) ──
const closePick = new Map();        // clé -> coché ? (absent = coché)
let closingMany = false;
async function closeMany(list, rule) {
  if (closingMany) return; if (!list.length) return say('aucune session cochée');
  if (!confirm('Fermer ' + plural(list.length, 'session', 'sessions') + ' ?\n\n' + list.map(it => '• ' + label(it)).join('\n') + '\n\nChacune reçoit /exit (arrêtée si elle ne sort pas en 10 s). Les conversations restent reprenables depuis « Fermées » ; les worktrees ne sont pas touchés.')) return;
  closingMany = true; say('fermeture de ' + plural(list.length, 'session', 'sessions') + '…');
  try {
    const r = await (await fetch('/api/close-many', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ pids: list.map(it => it.pid), rule: rule || 'closable' }) })).json();
    const forced = r.closed.filter(c => c.forced).length;
    say(plural(r.closed.length, 'session fermée', 'sessions fermées') + (forced ? ' (dont ' + forced + ' arrêtée(s) faute de réponse à /exit)' : '') + (r.skipped.length ? ' · ' + r.skipped.length + ' sautée(s)' : ''));
    if (r.skipped.length) alertSkipped(r.skipped);
  } catch { say('échec de la demande'); }
  closingMany = false; tick(); loadClosed();
}
// ── Relance groupée : fermer puis reprendre (--resume) les sessions « À traiter », « ⏳ Attente Teams » et « Inactives ».
// Le process redémarre pour de bon : compte changé, serveurs MCP à réinitialiser. Seule une session INACTIVE peut
// recevoir /exit : celle qui est bloquée sur un dialogue ou qui attend une commande en arrière-plan est annoncée, pas
// touchée. Les sessions au travail, les automates et les sessions fermées ne sont pas concernés. Pure.
function restartPlan(items) {
  const go = [], skip = [];
  for (const it of items) {
    if (it.kind !== 'open' || it.headless || !['waiting', 'ask', 'done', 'teams', 'idle'].includes(it.state)) continue;
    if (it.status === 'idle') go.push(it);
    else skip.push({ it, why: it.status === 'waiting' ? 'bloquée sur une question' : it.status === 'shell' ? 'commande en arrière-plan en cours' : 'statut ' + it.status });
  }
  return { go, skip };
}
const RESTART_GROUPS = [['À traiter', ['waiting', 'ask', 'done']], ['⏳ Attente Teams', ['teams']], ['Inactives', ['idle']]];
const restartCounts = list => RESTART_GROUPS.map(([t, st]) => [t, list.filter(it => st.includes(it.state)).length]).filter(x => x[1]).map(x => x[0] + ' ' + x[1]).join(' · ');
const restartSig = () => { const p = restartPlan(allItems()); return (canWrite ? 'w' : 'r') + (restartingMany ? '!' : '') + p.go.map(it => it.key + it.state).join(',') + '|' + p.skip.map(s => s.it.key).join(','); };
let restartingMany = false;
async function restartMany() {
  if (restartingMany || !canWrite) return;
  const { go, skip } = restartPlan(allItems());
  if (!go.length) return say('aucune session à relancer');
  if (!confirm('Relancer ' + plural(go.length, 'session', 'sessions') + ' ?\n\n' + restartCounts(go)
    + '\n\nChacune reçoit /exit puis reprend sa conversation (--resume), dans son onglet quand c’est possible, sinon dans un nouvel onglet. Le process redémarre : nouveau compte pris en compte, serveurs MCP réinitialisés. Une session dont l’invite porte un brouillon est laissée telle quelle.'
    + (skip.length ? '\n\nNon relancée' + (skip.length > 1 ? 's' : '') + ' :\n' + skip.map(s => '• ' + label(s.it) + ' — ' + s.why).join('\n') : '')
    + '\n\nDurée : environ ' + Math.round(20 + go.length * 1.5) + ' s.')) return;
  restartingMany = true; say('relance de ' + plural(go.length, 'session', 'sessions') + '…'); renderDetail(true);
  try {
    const r = await (await fetch('/api/relaunch-many', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ pids: go.map(it => it.pid) }) })).json();
    const tabs = r.relaunched.filter(x => !x.sameTab).length;
    say(plural(r.relaunched.length, 'session relancée', 'sessions relancées') + (tabs ? ' (dont ' + tabs + ' dans un nouvel onglet)' : '') + (r.skipped.length ? ' · ' + r.skipped.length + ' sautée(s)' : ''));
    if (r.skipped.length) alertSkipped(r.skipped);
  } catch { say('échec de la demande'); }
  restartingMany = false; tick(); loadClosed();
}
function restartPanel() {
  if (!canWrite) return null;
  const { go, skip } = restartPlan(allItems()); if (!go.length && !skip.length) return null;
  const wrap = el('div');
  wrap.append(el('h2', null, 'Relancer les sessions — ' + go.length));
  const act = el('div', 'actions');
  const b = el('button', 'primary', restartingMany ? 'Relance en cours…' : 'Relancer les ' + plural(go.length, 'session', 'sessions') + '…'); b.disabled = restartingMany || !go.length;
  b.title = 'Ferme (/exit) puis reprend (--resume) les sessions « À traiter », « ⏳ Attente Teams » et « Inactives » : à faire après un changement de compte, ou pour réinitialiser les serveurs MCP. Les sessions au travail ne sont pas touchées.';
  b.onclick = restartMany; act.append(b); wrap.append(act);
  wrap.append(el('div', 'empty', (restartCounts(go) || 'aucune session inactive') + (skip.length ? ' — ' + skip.length + ' laissée' + (skip.length > 1 ? 's' : '') + ' (' + skip.map(s => label(s.it) + ' : ' + s.why).join(' ; ').slice(0, 240) + ')' : '')));
  return wrap;
}
// ── Ménage large : fermer d'un coup les sessions INACTIVES, même avec du travail en cours (la conversation reste
// reprenable, le worktree n'est pas touché). Cochées par défaut : inactives depuis au moins le seuil choisi. Le
// serveur revérifie seulement « inactive » (et une invite vide) au moment de fermer. ──
const IDLE_STEPS = [[1, '≥ 1 h'], [4, '≥ 4 h'], [24, '≥ 24 h'], [0, 'toutes']];
let idleMinH = 4; try { const v = +localStorage.getItem('sd.idleMinH'); if (IDLE_STEPS.some(s => s[0] === v)) idleMinH = v; } catch {}
const idlePick = new Map();         // clé -> coché à la main (absent = selon le seuil)
const idleList = () => allItems().filter(it => it.kind === 'open' && !it.headless && it.status === 'idle').sort((a, b) => a.since - b.since);
const idleH = it => (data.now - it.since) / 3600000;
const idleChecked = it => idlePick.has(it.key) ? idlePick.get(it.key) : idleH(it) >= idleMinH;
const idleSig = () => idleMinH + ':' + idleList().map(it => it.key + (idlePick.has(it.key) ? (idlePick.get(it.key) ? '+' : '-') : '')).join(',');
function idleRisk(it) {
  const g = it.git, r = [];
  if (g && g.worktree) {
    if (g.nFiles) r.push(plural(g.nFiles, 'fichier non commité', 'fichiers non commités'));
    if (g.upstream && g.ahead) r.push(plural(g.ahead, 'commit non poussé', 'commits non poussés'));
    else if (!g.upstream && g.branch && g.branch !== '(detached)') r.push('branche jamais poussée');
  }
  if (it.prInfo && it.prInfo.state === 'OPEN') r.push('PR #' + it.pr + ' ouverte');
  return r;
}
function idlePanel() {
  const list = idleList(); if (!list.length) return null;
  const wrap = el('div');
  const picked = list.filter(idleChecked);
  wrap.append(el('h2', null, 'Inactives — ' + list.length + ' · ' + picked.length + ' cochée' + (picked.length > 1 ? 's' : '')));
  const act = el('div', 'actions');
  for (const [h, lbl] of IDLE_STEPS) {
    const b = el('button', h === idleMinH ? 'primary' : null, lbl); b.title = h ? 'Cocher les sessions inactives depuis au moins ' + h + ' h' : 'Cocher toutes les sessions inactives';
    b.onclick = () => { idleMinH = h; idlePick.clear(); try { localStorage.setItem('sd.idleMinH', String(h)); } catch {} renderDetail(true); };
    act.append(b);
  }
  const bc = el('button', 'primary', 'Fermer la sélection (' + picked.length + ')…');
  bc.title = 'Ferme les sessions cochées (/exit, arrêt si elles ne sortent pas en 10 s) ; elles restent reprenables depuis « Fermées » ; les worktrees ne sont pas touchés';
  bc.onclick = () => closeMany(idleList().filter(idleChecked), 'idle');
  const bn = el('button', null, 'Décocher tout'); bn.onclick = () => { list.forEach(it => idlePick.set(it.key, false)); renderDetail(true); };
  act.append(bc, bn); wrap.append(act);
  const box = el('div', 'notifs');
  for (const it of list) {
    const d = el('div', 'notif done pick');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = idleChecked(it); cb.onclick = e => e.stopPropagation();
    cb.onchange = () => { idlePick.set(it.key, cb.checked); renderDetail(true); };
    const risk = idleRisk(it);
    const nx = el('span', 'nx', (risk.length ? '⚠ ' + risk.join(' · ') : (closable(it) ? '✓ peut se fermer' : 'rien en cours d’isolable')));
    d.append(cb, el('span', 'when', 'inactive ' + ago(data.now - it.since)), el('span', 'nt', label(it)), nx);
    d.title = 'Sélectionner la session'; d.onclick = () => select(it.key, true); box.append(d);
  }
  wrap.append(box);
  return wrap;
}
function alertSkipped(sk) { console.log('[sessions] fermeture sautée :', sk); notice = null; setTimeout(() => say(sk.map(s => s.title + ' : ' + s.why).join(' · ').slice(0, 300)), 5200); }

// ── Tableau par projet (▦) : une carte par PR (ou ticket HD, ou session), rangée dans la colonne la plus avancée
// de ses sessions. Livré = PR mergée ; à merger = PR ouverte prête ; en recette = un dev-deploy / env de branche
// lancé par la session ; en cours = brouillon, branche ou worktree ; à cadrer = rien de tout ça. ──
const STAGES = [['cadrer', 'À cadrer'], ['cours', 'En cours'], ['recette', 'En recette'], ['merger', 'À merger'], ['livre', 'Livré · 7 j']];
// Le titre (ai-title) est figé au PREMIER sujet de la session : une session qui a enchaîné plusieurs tickets garde
// « Remise parrainage… » alors qu'elle parle de HD-111111. Le serveur donne le dernier HD cité dans ses prompts
// tapés (topicHd, absent si c'est déjà celui du 1er message) : on l'affiche « → HD-… » à côté du titre quand le titre ne le cite pas déjà.
const driftHd = it => it.topicHd && !String(it.title || '').toUpperCase().includes(it.topicHd) ? it.topicHd : null;
const driftTag = it => { const h = driftHd(it); if (!h) return null; const t = el('span', 'tag drift', '→ ' + h); t.title = 'Dernier ticket cité dans cette session : le titre décrit son premier sujet'; return t; };
const hdOf = it => { const m = [it.title, it.name, ...(it.prompts || []).map(p => p.text)].join(' ').match(/HD-\d{6}/i); return m ? m[0].toUpperCase() : null; };
function stageOf(it) {
  const p = it.pr && it.prInfo ? it.prInfo : null;
  if (p && p.state === 'MERGED') return 'livre';
  if (p && p.state === 'CLOSED') return null;               // PR fermée sans merge : abandonnée
  if (it.recette) return 'recette';
  if (p && !p.draft) return 'merger';
  if (it.pr || it.wt || (it.git && it.git.worktree)) return 'cours';
  return 'cadrer';
}
let boardMode = false;
function openBoard() { findMode = false; newMode = false; bcMode = false; launchMode = false; chatsMode = false; selected = null; sessionStorage.removeItem('cc.sel'); boardMode = true; setPane(true); renderList(); renderDetail(true); }
function closeBoard() { boardMode = false; setPane(false); renderDetail(true); }
function boardCards() {
  const week = data.now - 7 * 86400000;
  // Ouvertes (hors automates) ; fermées seulement si elles portent une PR ou une recette (sinon : vieilles conversations).
  const its = allItems().filter(it => !it.hidden && !it.headless && (it.kind === 'open' || it.pr || it.recette));
  const cards = new Map();
  for (const it of its) {
    const st = stageOf(it); if (!st) continue;
    if (st === 'livre' && it.since < week) continue;
    const hd = hdOf(it), key = it.pr ? 'pr' + it.pr : hd ? hd : it.key;
    let c = cards.get(key); if (!c) cards.set(key, c = { key, hd, pr: it.pr, prUrl: it.prUrl, items: [], stage: st });
    c.items.push(it); if (!c.hd) c.hd = hd;
    if (STAGES.findIndex(s => s[0] === st) > STAGES.findIndex(s => s[0] === c.stage)) c.stage = st;
  }
  for (const c of cards.values()) { c.items.sort((a, b) => (b.kind === 'open') - (a.kind === 'open') || b.since - a.since); c.lead = c.items[0]; c.at = Math.max(...c.items.map(i => i.since)); }
  return [...cards.values()];
}
function renderBoard(force) {
  const main = $('main'); const cards = boardCards();
  const sig = cards.map(c => c.key + ':' + c.stage + ':' + c.items.map(i => i.key + i.state).join(',')).join('|');
  if (!force && detailKey === '__board__' && main.dataset.sig === sig) return;
  detailKey = '__board__'; main.dataset.sig = sig; main.replaceChildren();
  main.append(el('div', 'dtitle', 'Tableau par projet'),
              el('div', 'meta', 'Une carte par PR (à défaut par ticket HD, sinon par session), dans la colonne la plus avancée de ses sessions. Sessions fermées : seulement celles qui ont une PR ou une recette ; livré : 7 derniers jours. Clic : ouvrir la session.'));
  const board = el('div', 'board');
  for (const [k, title] of STAGES) {
    const col = el('div', 'bcol'); const list = cards.filter(c => c.stage === k).sort((a, b) => b.at - a.at);
    col.append(el('div', 'bhead', title + ' · ' + list.length));
    for (const c of list) {
      const it = c.lead, card = el('div', 'bcard ' + it.state);
      const t = el('div', 'bt'); t.append(el('span', 'dot'), ' ', label(it)); card.append(t);
      const m = el('div', 'bm');
      if (c.hd) m.append(el('span', 'tag', c.hd));
      if (c.pr) { const a = prLink(it); if (a) m.append(a); prTags(it).forEach(x => m.append(x)); }
      if (closable(it)) m.append(el('span', 'tag merged', '✓ peut se fermer'));
      card.append(m);
      const open = c.items.filter(i => i.kind === 'open').length;
      card.append(el('div', 'bs', (open ? plural(open, 'session ouverte', 'sessions ouvertes') : 'fermée') + (c.items.length > open && open ? ' · ' + (c.items.length - open) + ' fermée(s)' : '') + ' · ' + LABEL[it.state] + ' · il y a ' + ago(data.now - c.at)));
      card.title = c.items.map(i => '• ' + label(i) + ' — ' + LABEL[i.state]).join('\n');
      card.onclick = () => select(it.key, true);
      col.append(card);
    }
    if (!list.length) col.append(el('div', 'empty', '—'));
    board.append(col);
  }
  main.append(board);
}

// ── Conversations Teams (💬, module « teams », teams-watcher.ts lot 9) : la vue TRANSVERSE, une ligne par chat et non par
// session. Le veilleur liste tous les chats actifs (qu'une session y soit abonnée ou non) ; la page les range en « à toi
// de répondre » (dernier mot au collègue, aucune session ne l'a reçu), « à voir » (il s'y est passé quelque chose depuis
// ton dernier pointage : un collègue a écrit, ou une session a écrit en ton nom) et « à jour ». L'état lu de Teams ne
// sert pas : le veilleur marque lu ce qu'une session a traité. Lue par /api/teams-conversations, relue toutes les 30 s
// et dès que le veilleur a refait sa liste ; les compteurs du bouton viennent de l'état (data.teams.conversations).
let chatsMode = false, chatsData = null, chatsTimer = null;
const chatsOff = () => !(data && data.teams && data.teams.conversations);
function chatsBadge() {
  const c = data && data.teams && data.teams.conversations, b = $('chatsbtn'); b.hidden = !c; if (!c) return;
  const n = c.reply + c.unseen; $('chatsn').textContent = n ? String(n) : '';
  if (chatsMode && chatsData && chatsData.at !== c.at) loadChats();   // le veilleur vient de refaire sa liste
}
function openChats() { if (chatsOff()) return; findMode = false; newMode = false; bcMode = false; boardMode = false; launchMode = false; selected = null; sessionStorage.removeItem('cc.sel'); chatsMode = true; setPane(true);
  clearInterval(chatsTimer); chatsTimer = setInterval(loadChats, 30000); renderList(); renderDetail(true); loadChats(); }
function closeChats() { chatsMode = false; setPane(false); clearInterval(chatsTimer); renderDetail(true); }
async function loadChats(force) {
  if (!chatsMode) { clearInterval(chatsTimer); return; }
  // Pendant qu'on tape une réponse, la liste n'est pas redessinée sous les doigts (elle l'est à l'envoi, ou à la relecture suivante).
  try { const r = await fetch('/api/teams-conversations', { cache:'no-store' }); chatsData = r.ok ? await r.json() : null; if (chatsMode && (force === true || !chatTyping())) renderChats(); } catch { say('conversations illisibles'); }
}
// chatGroups est PURE (testée par server/test/conversations-page.test.ts) : lignes du serveur → les trois groupes de la vue.
function chatGroups(rows) {
  const g = [
    { key:'reply', title:'À toi de répondre', hint:'le dernier mot est au collègue et aucune session ne l’a reçu', rows:[] },
    { key:'unseen', title:'À voir', hint:'du nouveau depuis ton dernier pointage : un collègue a écrit, ou une session a écrit en ton nom', rows:[] },
    { key:'ok', title:'À jour', hint:'', rows:[] },
  ];
  for (const r of rows || []) (r.ball === 'reply' ? g[0] : r.unseen ? g[1] : g[2]).rows.push(r);
  for (const x of g) x.rows.sort((a, b) => b.lastAt - a.lastAt);
  return g;
}
async function chatSeen(chatId, action, at) {
  if (!canWrite) return;
  try {
    const r = await (await fetch('/api/teams-seen', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ chatId, action, at }) })).json();
    if (r.error) say('refusé : ' + r.error);
  } catch { say('échec de la demande'); }
  loadChats(true);
}
const CHAT_ICON = { oneOnOne:'👤', group:'👥', meeting:'📅' };
const CHAT_ROLE = { wait:'attend leur réponse', replied:'reçoit leur réponse', inbound:'ouverte pour cette demande', past:'y a écrit' };
const CHAT_WHY = { mention:'tu es mentionné', quote:'on répond à un de tes messages', named:'on t’y nomme', question:'question qui suit ton message' };
// Lot 10 : messages en entier, fil dépliable (/api/teams-thread), réponse depuis la page (/api/teams-reply — le veilleur
// poste dans Teams en ton nom, sur ton clic). Brouillons, fils ouverts et boîtes de réponse survivent aux relectures.
const chatDrafts = new Map(), chatReplying = new Set(), chatThreads = new Map(), chatWide = new Set();
let chatSending = null;
const chatTyping = () => !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.creply'));
// chatWho est PURE (testée par server/test/conversations-page.test.ts) : l'auteur d'un message tel qu'on l'affiche.
function chatWho(m) {
  return m.by === 'me' ? 'toi' : m.by === 'session' ? '🤖 une session, en ton nom' : m.from || 'une application';
}
function chatMsg(m, when) {
  const d = el('div', 'cmsg' + (m.by === 'me' || m.by === 'session' ? ' mine' : ''));
  const h = el('span', 'who' + (m.by === 'session' ? ' ses' : ''), chatWho(m)); if (when) h.append(el('span', 'when', ' · il y a ' + ago(data.now - m.at)));
  d.append(h, el('div', 'txt', m.text)); return d;
}
async function chatToggleThread(chatId) {
  if (chatThreads.has(chatId)) { chatThreads.delete(chatId); return renderChats(); }
  chatThreads.set(chatId, null); renderChats();
  try { const r = await fetch('/api/teams-thread?chatId=' + encodeURIComponent(chatId), { cache:'no-store' }); if (chatThreads.has(chatId)) chatThreads.set(chatId, r.ok ? await r.json() : { fresh:false, messages:[] }); }
  catch { chatThreads.delete(chatId); say('fil illisible'); }
  if (chatsMode) renderChats();
}
async function chatSend(chatId) {
  const text = (chatDrafts.get(chatId) || '').trim(); if (!text || chatSending || !canWrite) return;
  chatSending = chatId; renderChats();
  try {
    const r = await (await fetch('/api/teams-reply', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ chatId, text }) })).json();
    if (r.error) say('non envoyé : ' + r.error); else { chatDrafts.delete(chatId); chatReplying.delete(chatId); chatThreads.delete(chatId); say('envoyé dans Teams'); }
  } catch { say('échec de la demande — vérifie dans Teams avant de renvoyer'); }
  chatSending = null; await loadChats(true);
}
function renderChats() {
  const main = $('main'), keep = detailKey === '__chats__' ? main.scrollTop : 0;
  const foc = chatTyping() ? document.activeElement : null, focId = foc && foc.closest('.creply').dataset.chat, sel = foc && [foc.selectionStart, foc.selectionEnd];
  detailKey = '__chats__'; main.replaceChildren();
  const D = chatsData, rows = D && D.rows;
  main.append(el('div', 'dtitle', 'Conversations Teams'));
  if (!D) { main.append(el('div', 'meta', 'Chargement…')); return; }
  if (!rows) { main.append(el('div', 'meta', 'Vue éteinte : le veilleur n’a encore rien listé ({ "conversations": { "enabled": true } } dans teams-watcher-config.json).')); return; }
  const groups = chatGroups(rows), todo = groups[0].rows.length + groups[1].rows.length;
  const canSend = canWrite && !!(data.teams && data.teams.conversations && data.teams.conversations.send);
  const meta = el('div', 'meta', rows.length + ' chats actifs sur 14 jours (1:1, groupes, réunions), qu’une session les suive ou non · liste d’il y a ' + ago(data.now - D.at) + ' · '
    + (todo ? todo + ' à traiter' : 'tu es à jour partout') + '. « Vu » pointe le dernier message affiché : ce qui arrive ensuite revient « à voir ».');
  main.append(meta);
  const box = el('div', 'chats');
  for (const g of groups) {
    if (!g.rows.length && g.key !== 'reply') continue;
    const h = el('div', 'chead', g.title + ' · ' + g.rows.length); if (g.hint) h.append(el('span', 'tx', g.hint));
    if (g.key === 'unseen' && g.rows.length > 1 && canWrite) { const b = el('button', null, 'Tout marquer vu'); b.title = 'Pointe toutes les conversations « à voir » d’un coup (celles où c’est à toi de répondre restent)'; b.onclick = () => chatSeen('*', 'seen', D.at); h.append(b); }
    box.append(h);
    if (!g.rows.length) box.append(el('div', 'meta', 'Personne n’attend ta réponse.'));
    for (const r of g.rows) {
      const row = el('div', 'crow g-' + g.key);
      const t = el('div', 'ct', (CHAT_ICON[r.type] || '') + ' ' + (r.label || '(chat sans nom)')); t.append(el('span', 'when', 'il y a ' + ago(data.now - r.lastAt))); row.append(t);
      const bs = el('div', 'cb');
      if (r.webUrl) { const l = el('a', null, 'Teams ↗'); l.href = r.webUrl; l.target = '_blank'; l.rel = 'noopener'; l.title = 'Ouvrir la conversation dans Teams'; bs.append(l); }
      { const b = el('button', null, chatThreads.has(r.chatId) ? 'Replier' : 'Fil'); b.title = 'Les derniers messages de la conversation, en entier'; b.onclick = () => chatToggleThread(r.chatId); bs.append(b); }
      if (canSend) { const b = el('button', null, 'Répondre'); b.title = 'Écrire ta réponse ici : elle part dans Teams en ton nom, sans ouvrir Teams'; b.onclick = () => { chatReplying.has(r.chatId) ? chatReplying.delete(r.chatId) : chatReplying.add(r.chatId); renderChats(); const ta = main.querySelector('.creply[data-chat="' + CSS.escape(r.chatId) + '"] textarea'); if (ta) ta.focus(); }; bs.append(b); }
      if (g.key === 'reply') { const b = el('button', null, 'Rien à répondre'); b.title = 'Tu as lu, il n’y a rien à répondre : la conversation passe « à jour » jusqu’au prochain message'; b.onclick = () => chatSeen(r.chatId, 'seen', r.lastAt); bs.append(b); }
      else if (g.key === 'unseen') { const b = el('button', null, 'Vu'); b.title = 'Tu as vu ce qui s’est passé ici : la conversation passe « à jour » jusqu’au prochain message'; b.onclick = () => chatSeen(r.chatId, 'seen', r.lastAt); bs.append(b); }
      else if (r.by !== 'me' && r.by !== 'app') { const b = el('button', null, '↺'); b.title = 'Remettre à voir'; b.onclick = () => chatSeen(r.chatId, 'unseen', r.lastAt); bs.append(b); }
      row.append(bs);
      const th = chatThreads.get(r.chatId);
      if (chatThreads.has(r.chatId)) {
        // Fil déplié : les derniers messages, du plus ancien au plus récent (il remplace les messages à lire, qu'il contient).
        const x = el('div', 'cthread');
        if (!th) x.append(el('div', 'tx', 'chargement…'));
        else { if (!th.messages.length || !th.fresh) x.append(el('div', 'tx', th.messages.length ? 'fil pas encore relu depuis le dernier message (prochaine passe du veilleur, 2 min)' : 'fil pas encore lu par le veilleur (prochaine passe, 2 min)')); for (const m of th.messages) x.append(chatMsg(m, true)); }
        row.append(x); if (th) requestAnimationFrame(() => { x.scrollTop = x.scrollHeight; });
      } else {
        const m = el('div', 'cm'), news = r.news || [];
        if (news.length > 1) m.append(el('div', 'cnt', news.length + ' messages à lire'));
        if (news.length) for (const x of news) m.append(chatMsg(x, news.length > 1));
        else {
          const last = chatMsg({ by: r.by, from: r.lastFrom, at: r.lastAt, text: r.excerpt }, false);
          // « À jour » : deux lignes suffisent, un clic donne le message entier.
          if (g.key === 'ok' && !chatWide.has(r.chatId)) { last.classList.add('clamp'); last.title = 'Clic : afficher le message en entier'; last.onclick = () => { chatWide.add(r.chatId); renderChats(); }; }
          m.append(last);
        }
        row.append(m);
      }
      const s = el('div', 'cs');
      if (r.ball === 'reply') s.append(el('span', 'tag toreply', 'à toi de répondre' + (r.why ? ' — ' + CHAT_WHY[r.why] : '')));
      else if (r.ball === 'session') s.append(el('span', 'tag ses', 'une session a reçu ce message'));
      else if (r.ball === 'waiting') s.append(el('span', 'tag wait', 'en attente de leur réponse'));
      for (const x of r.sessions) {
        const it = allItems().find(i => i.sessionId === x.sessionId && i.kind !== 'run' && i.kind !== 'pass');
        if (it) { const b = el('button', 'chip', label(it) + ' — ' + CHAT_ROLE[x.role]); b.title = 'Ouvrir la session (' + LABEL[it.state] + ')'; b.onclick = () => select(it.key, true); s.append(b); }
        else { const o = el('span', 'chip gone', 'session fermée — ' + CHAT_ROLE[x.role]); o.title = x.sessionId; s.append(o); }
      }
      if (s.childNodes.length) row.append(s);
      if (canSend && chatReplying.has(r.chatId)) {
        const f = el('div', 'creply'); f.dataset.chat = r.chatId;
        const ta = el('textarea'); ta.placeholder = 'Ta réponse à ' + (r.label || 'ce chat') + '…'; ta.value = chatDrafts.get(r.chatId) || ''; ta.spellcheck = true;
        ta.oninput = () => chatDrafts.set(r.chatId, ta.value);
        const rb = el('div', 'rb'), busy = chatSending === r.chatId;
        const ok = el('button', null, busy ? 'Envoi…' : 'Envoyer'); ok.disabled = !!chatSending; ok.title = 'Poste ce message dans Teams, en ton nom  ( Ctrl+Entrée )'; ok.onclick = () => chatSend(r.chatId);
        const no = el('button', null, 'Annuler'); no.title = 'Referme sans envoyer (le brouillon est gardé)  ( Échap )'; no.onclick = () => { chatReplying.delete(r.chatId); renderChats(); };
        rb.append(ok, no, el('span', 'tx', 'part dans Teams en ton nom, tel quel · Ctrl+Entrée pour envoyer'));
        f.append(ta, rb); row.append(f);
      }
      box.append(row);
    }
  }
  main.append(box); main.scrollTop = keep;
  if (focId) { const ta = main.querySelector('.creply[data-chat="' + CSS.escape(focId) + '"] textarea'); if (ta) { ta.focus(); try { ta.setSelectionRange(sel[0], sel[1]); } catch {} } }
}

// ── Lanceur (🤖) : supervision des claude -p du diagnostic automatique — santé, runs en cours, tickets qui attendent,
// runs récents par phase avec leurs fichiers (texte brut / captures) et la conversation à rouvrir. Rafraîchi toutes les 10 s. ──
let launchMode = false, launchData = null, launchHours = 48, launchTimer = null, launchView = null, launchViewText = null, launchFilter = '';
const STAGE_FR = { 'pr-awaiting-approval':'PR en attente de validation', 'deploying':'en déploiement', 'dev-failed':'dev en échec', 'diagnosis-held':'diagnostic posé',
  'in-production':'en production', 'diagnosis-skipped':'diagnostic écarté', 'dev-abandoned':'dev abandonné', 'pr-closed':'PR fermée' };
const PHASE_FR = { diagnostic:'diagnostic', go:'go', dev:'dev', recette:'recette', relecture:'relecture', reprise:'reprise', merge:'merge' };
function openLauncher() { if (launcherOff()) return; findMode = false; newMode = false; bcMode = false; boardMode = false; chatsMode = false; selected = null; sessionStorage.removeItem('cc.sel'); launchMode = true; setPane(true);
  clearInterval(launchTimer); launchTimer = setInterval(loadLauncher, 10000); renderList(); renderDetail(true); loadLauncher(); }
function closeLauncher() { launchMode = false; setPane(false); clearInterval(launchTimer); renderDetail(true); }
async function loadLauncher() {
  if (!launchMode) { clearInterval(launchTimer); return; }
  try { launchData = await (await fetch('/api/launcher?hours=' + launchHours, { cache:'no-store' })).json(); if (launchMode) renderLauncher(); } catch { say('lanceur illisible'); }
}
async function viewLaunchFile(dir, name) {
  const key = dir + '/' + name; if (launchView === key) { launchView = null; launchViewText = null; return renderLauncher(); }
  launchView = key; launchViewText = name.endsWith('.png') ? null : '…'; renderLauncher();
  if (!name.endsWith('.png')) { try { launchViewText = await (await fetch('/api/launcher/file?path=' + encodeURIComponent(dir + '\\' + name), { cache:'no-store' })).text(); } catch { launchViewText = '(illisible)'; } renderLauncher(); }
}
async function openRunConversation(r) {
  if (!r.sessionId) return say('identifiant de session inconnu pour ce run');
  if (!confirm('Rouvrir la conversation du run ' + (PHASE_FR[r.phase] || r.phase) + ' de HD-' + r.hd + ' dans un nouvel onglet (claude --resume) ?\n\nPour l’inspecter ou la questionner. Le lanceur ne la reprend pas : ce que tu y fais ne change pas son run.')) return;
  try { const x = await post('/api/reopen?id=' + r.sessionId); say(x.error ? 'refusé : ' + x.error : 'onglet ouvert — la session apparaît dans quelques secondes'); } catch { say('échec de la demande'); }
}
function renderLauncher() {
  const main = $('main'); const L = launchData; detailKey = '__launch__';
  const keepScroll = main.scrollTop; main.replaceChildren();
  main.append(el('div', 'dtitle', 'Lanceur — diagnostic automatique'));
  if (!L) { main.append(el('div', 'meta', 'chargement…')); return; }
  if (!L.present) { main.append(el('div', 'empty', 'Lanceur absent de ce poste.')); return; }
  main.append(el('div', 'meta', 'Modes : triage ' + L.triage + ' · dev ' + L.devMode + ' · recette ' + L.recetteMode + ' · reprise ' + L.reworkMode + ' · coût des runs affichés : ' + L.cost.toLocaleString('fr-FR') + ' $'));
  // Santé
  const hb = L.heartbeat ? L.now - L.heartbeat : null;
  const tiles = el('div', 'tiles');
  const th = el('div', 'tile ' + (hb != null && hb < 5 * 60000 ? 'busy' : 'waiting')); th.append(el('b', null, hb == null ? '?' : ago(hb)), el('span', null, 'depuis son dernier battement' + (hb != null && hb >= 5 * 60000 ? ' — arrêté ?' : ''))); tiles.append(th);
  for (const q of L.quota || []) {
    // Remise à zéro déjà passée : le relevé de ce compte n'a pas été rafraîchi par le lanceur — on le dit.
    const stale = q.weeklyResetsAt && new Date(q.weeklyResetsAt).getTime() < L.now;
    if (stale) { const t = el('div', 'tile idle'); t.append(el('b', null, (q.weeklyPct ?? '?') + ' % ?'), el('span', null, 'quota ' + (q.alias || '') + ' · relevé périmé (remise du ' + new Date(q.weeklyResetsAt).toLocaleDateString('fr-FR') + ' passée)')); tiles.append(t); continue; }
    const t = el('div', 'tile ' + (q.weeklyPct >= 90 ? 'waiting' : q.weeklyPct >= 75 ? 'ask' : 'idle')); t.append(el('b', null, (q.weeklyPct ?? '?') + ' %'), el('span', null, 'quota semaine ' + (q.alias || '') + (q.weeklyResetsAt ? ' · remise ' + new Date(q.weeklyResetsAt).toLocaleString('fr-FR', { weekday:'short', hour:'2-digit', minute:'2-digit' }) : ''))); tiles.append(t);
    // Limite propre à un modèle (« Fable ») : sa tuile, mêmes seuils.
    for (const l of (q.limits || []).filter(l => l.model && l.pct != null)) { const tm = el('div', 'tile ' + (l.pct >= 90 ? 'waiting' : l.pct >= 75 ? 'ask' : 'idle')); tm.append(el('b', null, Math.round(l.pct) + ' %'), el('span', null, 'quota semaine ' + l.model + ' ' + (q.alias || ''))); tiles.append(tm); } }
  const running = L.runs.filter(r => r.running);
  const tr = el('div', 'tile busy'); tr.append(el('b', null, running.length), el('span', null, 'run(s) en cours')); tiles.append(tr);
  const tw = el('div', 'tile ask'); tw.append(el('b', null, L.waiting.length), el('span', null, 'ticket(s) qui attendent')); tiles.append(tw);
  main.append(tiles);
  const errs = (L.errors || []).filter(e => L.now - e.at < 7 * 86400000);
  if (errs.length) {
    main.append(el('h2', null, 'Dernières erreurs du lanceur'));
    const box = el('div', 'notifs');
    for (const e of errs) { const d = el('div', 'notif ' + (L.now - e.at < 86400000 ? 'waiting' : 'idle')); d.style.cursor = 'default'; d.append(el('span', 'dot'), el('span', 'when', 'il y a ' + ago(L.now - e.at)), el('span', 'nt', e.kind), el('span', 'nx', e.message)); box.append(d); }
    main.append(box);
  }
  // En cours
  main.append(el('h2', null, 'En cours — ' + running.length));
  if (!running.length) main.append(el('div', 'empty', 'Aucun claude -p du lanceur ne tourne.'));
  for (const r of running) {
    const c = el('div', 'fhit busy'); const t = el('div', 'ft'); t.append(el('span', 'dot'), el('span', null, 'HD-' + r.hd + ' · ' + (PHASE_FR[r.phase] || r.phase) + ' — ' + (r.title || '')), el('span', 'n', 'depuis ' + ago(L.now - r.at) + (r.tokens ? ' · ' + ktok(r.tokens) : '') + ' · pid ' + r.pid)); c.append(t);
    if (r.reply) c.append(el('div', 'snip', tailOf(r.reply).slice(-400)));
    if (r.liveSessionId) { const a = el('div', 'actions'); const b = el('button', null, 'Voir la session'); b.onclick = () => select(r.liveSessionId, true); a.append(b); c.append(a); }
    main.append(c);
  }
  // Tickets qui attendent
  main.append(el('h2', null, 'Tickets qui attendent — ' + L.waiting.length));
  if (L.waiting.length) {
    const w = el('div', 'tablewrap'), tb = el('table'), hr = el('tr'); ['Depuis', 'Ticket', 'Étape', 'Attend', 'PR', 'Détail'].forEach(h => hr.append(el('th', null, h))); tb.append(hr);
    for (const x of L.waiting) { const r = el('tr'); r.append(el('td', null, x.since ? 'il y a ' + ago(L.now - x.since) : ''), el('td', null, 'HD-' + x.hd + ' ' + (x.title || '')), el('td', null, STAGE_FR[x.stage] || x.stage), el('td', null, x.waitingOn || ''));
      const pc = el('td'); if (x.prUrl && /^https:\/\/github\.com\//.test(x.prUrl)) { const a = el('a', null, '#' + x.prNumber); a.href = x.prUrl; a.target = '_blank'; a.rel = 'noopener'; pc.append(a); } r.append(pc, el('td', null, x.detail || '')); tb.append(r); }
    w.append(tb); main.append(w);
  } else main.append(el('div', 'empty', 'Aucun.'));
  // Décisions de la Tech en attente (carte ✅ sous la dernière note) : ouvrir le run pour trancher
  const decs = L.decisions || [];
  main.append(el('h2', null, 'Décisions de la Tech en attente — ' + decs.length));
  if (decs.length) {
    const w = el('div', 'tablewrap'), tb = el('table'), hr = el('tr'); ['Depuis', 'Ticket', 'Carte', 'Question', ''].forEach(h => hr.append(el('th', null, h))); tb.append(hr);
    for (const x of decs) { const f = decisionForm(x); const r = el('tr');
      r.append(el('td', null, x.since ? 'il y a ' + ago(L.now - x.since) : ''), el('td', null, 'HD-' + x.hd + ' ' + (x.title || '')), el('td', null, f.title), el('td', null, f.question));
      const c = el('td'); const b = el('button', null, 'Trancher'); b.onclick = () => openRun(String(x.hd)); c.append(b); r.append(c); tb.append(r); }
    w.append(tb); main.append(w);
  } else main.append(el('div', 'empty', 'Aucune.'));
  // Runs récents
  const hh = el('h2', null, 'Runs — ' + (launchHours <= 48 ? '48 dernières heures' : '7 derniers jours') + ' · ' + L.runs.length + ' '); const sw = el('a', null, launchHours <= 48 ? 'voir 7 jours' : 'revenir à 48 h'); sw.href = '#'; sw.style.textTransform = 'none'; sw.style.fontWeight = '400';
  sw.onclick = e => { e.preventDefault(); launchHours = launchHours <= 48 ? 168 : 48; launchData = null; renderLauncher(); loadLauncher(); }; hh.append(sw); main.append(hh);
  const fi = el('input'); fi.className = 'lfilter'; fi.placeholder = 'filtrer : HD, titre, phase, résultat…'; fi.value = launchFilter; fi.oninput = () => { launchFilter = fi.value; renderLauncher(); const n = document.querySelector('.lfilter'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }; main.append(fi);
  const toks = norm(launchFilter).split(/\s+/).filter(Boolean);
  const runs = L.runs.filter(r => toks.every(t => norm(['HD-' + r.hd, r.title, r.phase, r.outcome, r.verdict, r.detail, r.stage].join(' ')).includes(t)));
  const list = el('div', 'lruns');
  for (const r of runs) {
    const ok = /^(posted|ready|pr-open|merged|ok|success|done|in-production)$/i.test(r.outcome || '') && r.verdict !== 'a-reprendre';
    const ko = /fail|abandon|error|refus|denied/i.test((r.outcome || '') + ' ' + (r.verdict || ''));
    const row = el('div', 'lrun ' + (r.running ? 'busy' : ko ? 'waiting' : ok ? 'done' : 'idle'));
    const h = el('div', 'lh');
    h.append(el('span', 'dot'), el('span', 'lt', new Date(r.at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })), el('span', 'lp', PHASE_FR[r.phase] || r.phase),
             el('span', 'lx', 'HD-' + r.hd + ' — ' + (r.title || '')),
             el('span', 'lo', r.running ? 'en cours' : [r.outcome, r.verdict].filter(Boolean).join(' · ') || '—'),
             el('span', 'lm', [r.minutes != null ? Math.round(r.minutes) + ' min' : null, r.turns ? r.turns + ' tours' : null, r.costUsd != null ? (Math.round(r.costUsd * 100) / 100).toLocaleString('fr-FR') + ' $' : null].filter(Boolean).join(' · ')));
    row.append(h);
    if (r.detail) row.append(el('div', 'ld', r.detail));
    const fl = el('div', 'lf');
    for (const f of r.files) { const b = el('button', 'quick' + (launchView === r.dir + '/' + f.name ? ' on' : ''), f.name); b.title = Math.max(1, Math.round(f.size / 1024)) + ' Ko'; b.onclick = () => viewLaunchFile(r.dir, f.name); fl.append(b); }
    if (r.sessionId && !r.running) { const b = el('button', 'quick', '↻ conversation'); b.title = 'Rouvrir cette conversation dans un onglet (claude --resume ' + r.sessionId.slice(0, 8) + '…)'; b.onclick = () => openRunConversation(r); fl.append(b); }
    row.append(fl);
    if (launchView && launchView.startsWith(r.dir + '/')) {
      const name = launchView.slice(r.dir.length + 1);
      if (name.endsWith('.png')) { const img = el('img', 'lview'); img.src = '/api/launcher/file?path=' + encodeURIComponent(r.dir + '\\' + name); row.append(img); }
      else row.append(el('pre', 'lview', launchViewText));
    }
    list.append(row);
  }
  if (!runs.length) list.append(el('div', 'empty', 'Aucun run.'));
  main.append(list);
  main.scrollTop = keepScroll;
}

// ── Runs du lanceur DANS LA LISTE (groupe 🤖) : une ligne par DEMANDE (runsByHd, plus bas) regroupant ses runs du jour (depuis minuit) et tout run en cours, avec le
// détail d'une session manuelle (conversation, fichiers, coût, PR). Lecture seule. Source : /api/launcher?hours=24, relu
// toutes les 30 s page visible (le serveur garde 15 s en cache) — aucune route nouvelle. Cadrage :
// le cadrage.
// launcherGroup est PURE (testée par sessions-dashboard-tests.ps1) : runs → éléments de liste ; la session headless
// d'un run en cours (même pid, ou même sessionId) est ABSORBÉE par lui — elle ne figure plus seule dans la liste.
// Étapes scriptées (go, merge, production, doc : pas de claude -p) : ligne sans conversation.
// Couleur (look) : en cours = busy · échec = waiting · PR qui attend la validation de l'utilisateur = ask · réussi = done.
// « Attend l'utilisateur » ne colore que le DERNIER run de la demande : les plus anciens ont fini leur part.
function launcherGroup(runs, waiting, open, since) {
  const SCRIPTED = ['go', 'merge', 'production', 'doc'];
  const KO = /fail|abandon|error|erreur|refus|denied|timeout|crash/i, OK = /^(posted|ready|pr-open|merged|ok|success|done|in-production)$/i;
  const wait = new Map((waiting || []).map(w => [String(w.hd), w]));
  const live = new Map();
  for (const s of open || []) if (s.headless) { if (s.pid) live.set('pid:' + s.pid, s); if (s.sessionId) live.set('sid:' + s.sessionId, s); }
  const latest = new Map();
  for (const r of runs || []) if (!latest.has(String(r.hd)) || latest.get(String(r.hd)).at < r.at) latest.set(String(r.hd), r);
  const items = [], absorbed = new Set();
  for (const r of runs || []) {
    if (!r.running && !(r.at >= since)) continue;
    const s = (r.pid && live.get('pid:' + r.pid)) || (r.liveSessionId && live.get('sid:' + r.liveSessionId)) || null;
    if (s) absorbed.add(s.sessionId);
    const w = latest.get(String(r.hd)) === r ? wait.get(String(r.hd)) || null : null;
    const o = [r.outcome, r.verdict].filter(Boolean).join(' · ');
    const look = r.running ? 'busy' : KO.test(o) || (w && w.stage === 'dev-failed') ? 'waiting' : w && w.stage === 'pr-awaiting-approval' ? 'ask'
      : OK.test(r.outcome || '') && r.verdict !== 'a-reprendre' ? 'done' : 'idle';
    const sessionId = (s && s.sessionId) || r.liveSessionId || r.sessionId || null;
    items.push({ kind:'run', key:'run:' + r.dir, run:r, wait:w, look, sessionId, scripted: SCRIPTED.includes(r.phase) && !sessionId,
      title: 'HD-' + r.hd + ' · ' + r.phase + (r.title ? ' — ' + r.title : ''), outcome: r.running ? 'en cours' : o,
      at: r.at, since: r.running || r.minutes == null ? r.at : r.at + Math.round(r.minutes * 60000),
      model: (s && s.model) || r.model || null, tokens: (s && s.tokens) || r.tokens || null, reply: (s && s.reply) || r.reply || null,
      pid: r.pid || null, cwd: s ? s.cwd : null,
      pr: w && w.prNumber ? w.prNumber : null, prUrl: w && w.prUrl ? w.prUrl : null });
  }
  items.sort((a, b) => (b.run.running - a.run.running) || b.at - a.at);
  return { items, absorbed };
}
// Une ligne par DEMANDE, pas par run : un HD qui passe diagnostic → dev → relecture → recette → merge faisait 5 lignes.
// runsByHd est PURE (testée par sessions-dashboard-tests.ps1) : éléments de launcherGroup → un élément par HD, qui
// REPREND le run en cours s'il y en a un, sinon le plus récent (titre, couleur, PR, conversation), et porte la liste de
// ses runs (du plus récent au plus ancien), leur enchaînement de phases et leur coût cumulé. Clé stable `hd:<n>` : la
// sélection survit au run suivant de la même demande.
function runsByHd(items) {
  const by = new Map();
  for (const it of items || []) { const k = String(it.run.hd); if (!by.has(k)) by.set(k, []); by.get(k).push(it); }
  const out = [];
  for (const [hd, list] of by) {
    list.sort((a, b) => b.at - a.at);
    const head = list.find(i => i.run.running) || list[0];
    const withPr = list.find(i => i.pr);
    const costs = list.filter(i => i.run.costUsd != null);
    out.push({ ...head, key: 'hd:' + hd, runs: list, runCount: list.length, phases: list.map(i => i.run.phase).reverse(),
      costTotal: costs.length ? Math.round(costs.reduce((s, i) => s + i.run.costUsd, 0) * 100) / 100 : null,
      pr: head.pr || (withPr ? withPr.pr : null), prUrl: head.prUrl || (withPr ? withPr.prUrl : null) });
  }
  out.sort((a, b) => (b.run.running - a.run.running) || b.at - a.at);
  return out;
}
// Run de la demande affiché dans le détail : le run choisi dans la frise (clé de groupe → dossier du run), sinon celui
// que reprend la ligne.
const runPick = new Map();
function pickRun(it) {
  if (!it || !it.runs) return it;
  const dir = runPick.get(it.key), sub = dir && it.runs.find(r => r.run.dir === dir);
  return sub && sub.run.dir !== it.run.dir ? { ...sub, key: it.key, runs: it.runs, runCount: it.runCount, phases: it.phases, costTotal: it.costTotal, picked: true } : it;
}
let runData = null, runTimer = null;
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Module « launcher » éteint (le serveur le dit dans data.modules ; le .ps1 ne dit rien : il l'a toujours).
const launcherOff = () => !!(data && data.modules && !data.modules.launcher);
async function loadRuns() {
  if (launcherOff()) { runData = null; return; }
  if (document.visibilityState === 'hidden' && runData) return;
  try { const r = await (await fetch('/api/launcher?hours=24', { cache:'no-store' })).json(); runData = r && r.present ? r : null; if (data) { renderList(); renderDetail(); } } catch {}
  if (pendingRun && data && runData) { const hd = pendingRun; pendingRun = null; openRun(hd); }
}
// Notification « HD-x t'attend » (cloche ou notification Windows ?run=x) : le DERNIER run de la demande, dans la liste ;
// à défaut (run d'avant minuit), la vue 🤖.
let pendingRun = new URLSearchParams(location.search).get('run');
function openRun(hd) {
  const it = allItems().filter(i => i.kind === 'run' && String(i.run.hd) === String(hd)).sort((a, b) => b.at - a.at)[0];
  if (!it) { openLauncher(); return; }
  if (launchMode) closeLauncher();
  runPick.delete(it.key);
  select(it.key, true);
}
const runGroup = () => {
  const runs = runData ? runData.runs : [], waiting = runData ? runData.waiting : [], open = data ? data.sessions : [], cards = cardsOn() ? runData.cards || [] : [];
  const g = launcherGroup(runs, waiting, open, midnight());
  // Une carte qui attend garde sa demande dans la liste, même si son dernier run date d'avant minuit.
  const old = cardRuns(runs, cards, midnight()), g2 = old.length ? launcherGroup(old, waiting, open, 0) : { items: [] };
  return { items: withCards(runsByHd(g.items.concat(g2.items)), cards), absorbed: g.absorbed };
};
const money = v => (Math.round(v * 100) / 100).toLocaleString('fr-FR') + ' $';
// ── Passes des AUTOMATES du poste (module « automations ») : scripts planifiés déclarés dans la configuration du
// poste. Un groupe par automate dans la liste (la passe en cours et la DERNIÈRE passe du jour qui a agi ou échoué), une carte
// par automate dans la vue d'ensemble, le détail d'une passe (résumé, fichiers, conversation). Source :
// /api/automations?since=<minuit>, relu toutes les 30 s page visible et juste après un « Lancer maintenant ».
// Les passes sans effet (quiet) n'ont pas de ligne : l'en-tête du groupe les compte et redit la dernière.
let autoData = null, autoAsked = false;
const automationsOff = () => !(data && data.modules && data.modules.automations);
async function loadAutomations() {
  if (automationsOff()) { autoData = null; return; }
  if (document.visibilityState === 'hidden' && autoData) return;
  autoAsked = true;
  try { const r = await fetch('/api/automations?since=' + midnight(), { cache:'no-store' }); autoData = r.ok ? await r.json() : null; if (data) { renderList(); renderDetail(); } } catch {}
  if (pendingPass && autoData) { const p = pendingPass; pendingPass = null; openPass(p); }
}
// automationGroups est PURE (testée par server/test/automations-page.test.ts) : vue du serveur → un groupe par
// automate et ses éléments de liste. La session sans terminal de la passe en cours (même sessionId, ou même pid) est
// ABSORBÉE par la ligne de la passe : elle ne figure plus seule dans la liste.
// Une seule passe terminée par automate : la plus récente (l'historique du jour se lit dans la carte et l'en-tête).
// `keep` : clés de passes à garder quand même (la passe sélectionnée, celle qu'un lien de notification ouvre).
// Couleur (look) : en cours = busy · passe en erreur = waiting · alerte = ask · à blanc = idle · réussie = done.
function automationGroups(autos, open, keep) {
  const look = p => p.level === 'error' ? 'waiting' : p.level === 'warn' ? 'ask' : p.status === 'dry-run' ? 'idle' : 'done';
  const groups = [], items = [], absorbed = new Set();
  for (const a of autos || []) {
    const name = (a.icon ? a.icon + ' ' : '') + a.label;
    groups.push({ key:'automation:' + a.id, title:name, states:['auto:' + a.id], auto:a });
    if (a.running) {
      const s = (open || []).find(x => x.headless && (x.sessionId === a.running.sessionId || (a.running.pid && x.pid === a.running.pid))) || null;
      if (s) absorbed.add(s.sessionId);
      items.push({ kind:'pass', key:'pass:' + a.id + ':' + a.running.run, auto:a, pass:null, running:true, look:'busy', sessionId:a.running.sessionId,
        title:name + ' · passe en cours', at:a.running.at, since:a.running.at, model:s ? s.model || null : null, tokens:s ? s.tokens || null : null, reply:s ? s.reply || null : null });
    }
    let shown = 0;
    for (const p of a.passes || []) {
      if (a.running && p.run === a.running.run) continue;
      if (shown++ && !(keep || []).includes('pass:' + a.id + ':' + p.run)) continue;
      items.push({ kind:'pass', key:'pass:' + a.id + ':' + p.run, auto:a, pass:p, running:false, look:look(p), sessionId:p.sessionId || null,
        title:name + ' · ' + new Date(p.at).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }), at:p.at, since:p.at + Math.round((p.minutes || 0) * 60000) });
    }
  }
  return { groups, items, absorbed };
}
let passKeep = null;      // passe qu'un lien de notification demande d'ouvrir, gardée dans la liste même si ce n'est plus la dernière
const autoGroup = () => automationGroups(autoData ? autoData.automations : [], data ? data.sessions : [], [selected, passKeep]);
// Groupes de la liste : ceux de la page, plus un par automate, juste avant « Fermées ».
const groupList = () => { const ag = autoGroup().groups; if (!ag.length) return GROUPS; const i = GROUPS.findIndex(g => g.key === 'closed'); return GROUPS.slice(0, i).concat(ag, GROUPS.slice(i)); };
const PASS_FR = { ok:'a agi', nothing:'rien à faire', 'dry-run':'à blanc', conflict:'conflit', rejected:'refusée', failed:'échec', unknown:'issue inconnue' };
function passSub(it) {
  if (it.running) return ['travaille' + (it.at ? ' depuis ' + ago(Date.now() - it.at) : ''), it.reply ? lastLine(it.reply) : null].filter(Boolean).join(' · ');
  const p = it.pass;
  return [p.summary, p.minutes != null ? (p.minutes < 1 ? '< 1 min' : Math.round(p.minutes) + ' min') : null, p.costUsd != null ? money(p.costUsd) : null].filter(Boolean).join(' · ');
}
// En-tête d'un groupe d'automate : passe en cours, dernière passe (et son résumé si elle était sans effet), passes
// sans effet du jour.
function autoGroupTitle(a) {
  const parts = [];
  if (a.running) parts.push('en cours');
  if (a.last) parts.push('dernière il y a ' + ago(Date.now() - a.last.at) + (a.last.quiet ? ' : ' + a.last.summary : ''));
  else if (!a.present) parts.push('historique absent');
  if (a.quietToday) parts.push(a.quietToday + ' sans effet aujourd’hui');
  return parts.length ? parts.join(' · ') : '';
}
// automationCard est PURE (testée par server/test/automations-page.test.ts) : la carte d'un automate dans la vue
// d'ensemble — couleur, résumé de la dernière passe, et les lignes « dernière passe », « prochaine », « 7 jours »,
// « dernier échec ».
function automationCard(a, now) {
  const fr = { ok:'a agi', nothing:'rien à faire', 'dry-run':'à blanc', conflict:'conflit', rejected:'refusée', failed:'échec', unknown:'issue inconnue' };
  const since = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + ' min' : m < 2880 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') : Math.floor(m / 1440) + ' j'; };
  const usd = v => (Math.round(v * 100) / 100).toLocaleString('fr-FR') + ' $';
  const l = a.last, w = a.week || {};
  const look = a.running ? 'busy' : !a.present || !l ? 'idle' : l.level === 'error' ? 'waiting' : l.level === 'warn' || a.late ? 'ask' : 'done';
  const lines = [];
  if (!a.present) lines.push(['historique', 'introuvable — l’automate a-t-il déjà tourné ? (chemin dans la configuration du poste)']);
  if (a.running) lines.push(['en cours', 'depuis ' + since(now - a.running.at)]);
  if (l) lines.push(['dernière passe', 'il y a ' + since(now - l.at) + ' · ' + (fr[l.status] || l.status) + (l.dryRun && l.status !== 'dry-run' ? ' (à blanc)' : '')]);
  if (a.late) lines.push(['en retard', (l ? 'aucune passe depuis ' + since(now - l.at) : 'aucune passe') + ' — la tâche planifiée tourne toutes les ' + a.everyMinutes + ' min']);
  else if (a.next && !a.running) lines.push(['prochaine', 'dans ' + since(a.next - now)]);
  if (w.count) lines.push(['7 jours', [w.count + (w.count > 1 ? ' passes' : ' passe'), w.failures ? w.failures + (w.failures > 1 ? ' échecs' : ' échec') : 'aucun échec',
    w.warnings ? w.warnings + (w.warnings > 1 ? ' alertes' : ' alerte') : null, w.costUsd != null ? usd(w.costUsd) + ' (' + usd(w.costAvg) + ' par passe)' : null].filter(Boolean).join(' · ')]);
  if (w.lastFailure) lines.push(['dernier échec', 'il y a ' + since(now - w.lastFailure.at) + ' : ' + w.lastFailure.summary]);
  return { look, title:(a.icon ? a.icon + ' ' : '') + a.label, summary: l ? l.summary : a.running ? 'première passe en cours' : 'aucune passe sur 8 jours', lines };
}
function automationSection() {
  const list = autoData ? autoData.automations : []; if (!list.length) return null;
  const box = el('div', 'qcards');
  for (const a of list) {
    const v = automationCard(a, Date.now());
    const c = el('div', 'qcard acard ' + v.look);
    const h = el('div', 'qhead'); h.append(el('b', null, v.title)); c.append(h);
    const sm = el('div', 'asum', v.summary);
    const it = a.running ? allItems().find(x => x.kind === 'pass' && x.running && x.auto.id === a.id) : a.last && allItems().find(x => x.key === 'pass:' + a.id + ':' + a.last.run);
    if (it) { sm.classList.add('lnk'); sm.title = 'Ouvrir cette passe'; sm.onclick = () => select(it.key, true); }
    c.append(sm);
    const dl = el('dl'); for (const [k, x] of v.lines) dl.append(el('dt', null, k), el('dd', null, x)); c.append(dl);
    const ob = automationOrders(a); if (ob) c.append(ob);
    box.append(c);
  }
  return box;
}
// « Lancer maintenant » : un bouton par ordre déclaré dans la configuration ; confirmation si l'ordre en demande une.
function automationOrders(a) {
  if (!canWrite || !a.orders || !a.orders.length) return null;
  const box = el('div', 'actions');
  for (const o of a.orders) {
    const b = el('button', null, '▶ ' + o.label);
    b.title = 'Lancer maintenant : ' + o.label + (a.week && a.week.costAvg != null ? ' — coût moyen d’une passe sur 7 jours : ' + money(a.week.costAvg) : '');
    b.onclick = e => { e.stopPropagation(); runAutomationOrder(a, o); };
    box.append(b);
  }
  return box;
}
async function runAutomationOrder(a, o) {
  if (!canWrite) return;
  if (o.confirm && !confirm(o.confirm)) return;
  say((a.icon ? a.icon + ' ' : '') + a.label + ' : ' + o.label + '…');
  try {
    const r = await fetch('/api/automations/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ id: a.id, order: o.id }) });
    const j = await r.json().catch(() => ({}));
    say(j.error ? 'refusé : ' + j.error : j.done ? a.label + ' : terminé' + (j.output ? ' — ' + j.output : '') : a.label + ' : passe lancée — elle apparaît dans son groupe dès que sa session démarre');
  } catch { say('échec de la demande'); }
  setTimeout(loadAutomations, 3000); setTimeout(loadAutomations, 15000);
}
// Notification d'échec (cloche ou notification Windows ?pass=<automate>:<passe>) : la passe, si elle est du jour.
let pendingPass = new URLSearchParams(location.search).get('pass');
function openPass(ref) {
  passKeep = 'pass:' + ref;
  const it = byKey(passKeep);
  if (!it) { say('passe introuvable dans la liste (d’avant minuit ?)'); return; }
  if (launchMode) closeLauncher();
  select(it.key, true);
}
let passFile = null, passFileText = null;      // fichier de la passe affiché dans le détail : '<clé>/<nom>'
async function openPassFile(it, name) {
  const key = it.key + '/' + name;
  if (passFile === key) { passFile = null; passFileText = null; return renderDetail(true); }
  passFile = key; passFileText = name.endsWith('.png') ? null : '…'; renderDetail(true);
  if (name.endsWith('.png')) return;
  try { const r = await fetch(passFileUrl(it, name), { cache:'no-store' }); passFileText = r.ok ? await r.text() : '(illisible : ' + r.status + ')'; } catch { passFileText = '(illisible)'; }
  if (passFile === key) renderDetail(true);
}
const passFileUrl = (it, name) => '/api/automations/file?id=' + encodeURIComponent(it.auto.id) + '&run=' + encodeURIComponent(it.pass.run) + '&name=' + encodeURIComponent(name);
// Détail d'une passe : en-tête (automate, issue, durée, coût), résumé, fichiers, conversation (en direct pendant la passe).
function renderPassDetail(it, force) {
  const main = $('main'), a = it.auto, p = it.pass;
  if (detailKey !== it.key || force) {
    if (detailKey !== it.key) { passFile = null; passFileText = null; }
    detailKey = it.key; main.replaceChildren();
    const head = el('div'); head.id = 'head'; const body = el('div'); body.id = 'body'; main.append(head, body);
    if (p) { const card = el('div', 'rcard ' + it.look); card.append(el('div', 'rtitle', p.summary)); body.append(card); }
    if (p && p.files && p.files.length && a.files) {
      body.append(el('h2', null, 'Fichiers de la passe'));
      const fl = el('div', 'lf');
      for (const f of p.files) { const b = el('button', 'quick' + (passFile === it.key + '/' + f ? ' on' : ''), f); b.onclick = () => openPassFile(it, f); fl.append(b); }
      body.append(fl);
      if (passFile && passFile.startsWith(it.key + '/')) {
        const name = passFile.slice(it.key.length + 1);
        if (name.endsWith('.png')) { const img = el('img', 'lview'); img.src = passFileUrl(it, name); body.append(img); }
        else if (name.endsWith('.html') && passFileText !== '…') body.append(noteFrame(passFileText || ''));
        else body.append(el('pre', 'lview', passFileText));
      }
    }
    if (it.sessionId) { body.append(el('h2', null, 'Conversation complète'), convPane()); applyConvView(it); }
    else body.append(el('div', 'empty', it.running ? 'Session de la passe pas encore repérée.' : 'Passe sans session Claude : pas de conversation (voir son résumé et ses fichiers).'));
  }
  const head = $('head'); head.replaceChildren(); head.className = it.look;
  head.append(el('div', 'dtitle', it.title));
  const chip = el('span', 'chip'); chip.append(el('span', 'dot'), it.running ? 'travaille · depuis ' + ago(Date.now() - it.at) : (PASS_FR[p.status] || p.status) + ' · il y a ' + ago(Date.now() - it.since));
  if (p && p.dryRun && p.status !== 'dry-run') chip.append(el('span', 'tag cl', 'à blanc'));
  head.append(chip);
  if (it.model) head.append(el('span', 'tok', '  ·  modèle : ' + modelName(it.model)));
  if (it.tokens) head.append(el('span', 'tok', '  ·  contexte : ' + it.tokens.toLocaleString('fr-FR') + ' tokens'));
  head.append(el('div', 'meta', [(a.icon ? a.icon + ' ' : '') + a.label, 'lancée le ' + new Date(it.at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }),
    p && p.minutes != null ? (p.minutes < 1 ? '< 1 min' : Math.round(p.minutes) + ' min') : null, p && p.costUsd != null ? money(p.costUsd) : null, it.sessionId].filter(Boolean).join(' · ')));
  const actions = el('div', 'actions');
  if (!it.running && it.sessionId && canWrite) {
    const b = el('button', 'primary', '↻ Reprendre dans un onglet'); b.title = 'claude --resume ' + it.sessionId + ' — pour l’inspecter ou la questionner ; l’automate ne la reprend pas';
    b.onclick = () => openPassConversation(it); actions.append(b);
  }
  const ob = automationOrders(a); if (ob) for (const b of [...ob.children]) actions.append(b);
  head.append(actions);
}
async function openPassConversation(it) {
  if (!confirm('Rouvrir la conversation de cette passe (' + it.auto.label + ') dans un nouvel onglet (claude --resume) ?\n\nPour l’inspecter ou la questionner. L’automate ne la reprend pas.')) return;
  try { const x = await post('/api/reopen?id=' + it.sessionId); say(x.error ? 'refusé : ' + x.error : 'onglet ouvert — la session apparaît dans quelques secondes'); } catch { say('échec de la demande'); }
}
// Enchaînement des phases d'une demande, du premier au dernier run ; au-delà de 5, seules les 5 dernières.
const phaseChain = phases => (phases.length > 5 ? ['…'].concat(phases.slice(-5)) : phases).map(p => RUN_FR[p] || p).join(' → ');
const RUN_FR = { diagnostic:'diagnostic', suite:'suite', dev:'dev', relecture:'relecture', recette:'recette', reprise:'reprise', relance:'relance', reveil:'réveil', go:'go', merge:'merge', production:'production', doc:'doc' };
function runSub(it) {
  const r = it.run, multi = it.runCount > 1;
  const tail = multi ? [phaseChain(it.phases), it.runCount + ' runs' + (it.costTotal != null ? ' · ' + money(it.costTotal) : '')] : [];
  if (r.running) return ['travaille' + (r.at ? ' depuis ' + ago(Date.now() - r.at) : '')].concat(tail, it.reply ? [lastLine(it.reply)] : []).join(' · ');
  return [it.wait && STAGE_FR[it.wait.stage] ? STAGE_FR[it.wait.stage] : null, it.outcome || null, it.scripted ? 'étape scriptée' : null]
    .concat(multi ? tail : [r.minutes != null ? Math.round(r.minutes) + ' min' : null, r.costUsd != null ? money(r.costUsd) : null]).filter(Boolean).join(' · ') || '—';
}
// ── Résultat d'un run : ce que le lanceur a CONSTATÉ, lu dans ses propres fichiers — report.json (production : verdict,
// PR, images déployées) et verdict.json (recette : verdict, résumé, étapes). runResult est PURE (testée par
// sessions-dashboard-tests.ps1) : null quand le run n'a ni l'un ni l'autre (l'en-tête montre déjà son `detail`).
function runResult(report, verdict) {
  if (report && typeof report === 'object' && report.verdict) {
    const live = report.verdict === 'in-production';
    const lines = [[report.mergeSha ? 'merge ' + String(report.mergeSha).slice(0, 10) : null,
      report.files != null ? report.files + ' fichier' + (report.files > 1 ? 's' : '') : null,
      Array.isArray(report.sides) && report.sides.length ? report.sides.join(' + ') : null].filter(Boolean).join(' · ')].filter(Boolean);
    for (const d of Array.isArray(report.deployments) ? report.deployments : [])
      lines.push(String(d.name || '?').replace(/-deployment$/, '') + ' ' + (d.tag || '?') + ' · '
        + (d.carries && d.rolledOut ? 'déployé' : d.carries ? 'pas encore déployé partout' : 'ne porte pas le correctif') + (d.reason ? ' (' + d.reason + ')' : ''));
    return { look: live ? 'done' : 'ask', title: live ? '🚀 En production' : '⏳ Pas encore en production (' + report.verdict + ')', lines,
      pr: Number(report.pr) > 0 ? Number(report.pr) : null };
  }
  if (verdict && typeof verdict === 'object' && verdict.verdict) {
    const v = String(verdict.verdict).toLowerCase(), n = Array.isArray(verdict.steps) ? verdict.steps.length : 0;
    const t = v === 'ok' ? ['done', '✅ Recette OK'] : v === 'ko' ? ['waiting', '❌ Recette KO'] : ['ask', '❔ Recette non concluante'];
    return { look: t[0], title: t[1] + (n ? ' · ' + n + ' étape' + (n > 1 ? 's' : '') : ''), lines: verdict.summary ? [String(verdict.summary)] : [], pr: null };
  }
  return null;
}
// Note ouverte d'office dans le détail d'un run : celle que l'on vient relire — ce qui change pour le métier
// (production), le compte rendu de recette, la note de doc, sinon la note postée sur le ticket. PURE (testée).
function runNote(phase, files) {
  const names = (files || []).map(f => f.name), first = { production:'resolution.html', recette:'recettenote.html', doc:'docnote.html' }[phase];
  return [first, 'devnote.html', 'note.html'].find(n => n && names.includes(n)) || null;
}
// Demande vue de bout en bout (frise des runs) : du premier run à la fin du dernier, dont le temps de travail du
// lanceur (somme des durées de run) — le reste est de l'attente (feu vert, file du lanceur, déploiement). PURE (testée).
function runSpan(runs, now) {
  const rs = (runs || []).map(i => i.run).filter(Boolean);
  if (rs.length < 2) return null;
  const first = rs.reduce((a, b) => (b.at < a.at ? b : a)), last = rs.reduce((a, b) => (b.at > a.at ? b : a));
  const end = Math.max(...rs.map(r => r.running ? now : r.at + Math.round((r.minutes || 0) * 60000)));
  const total = Math.max(0, Math.round((end - first.at) / 60000)), work = Math.min(total, Math.round(rs.reduce((s, r) => s + (r.minutes || 0), 0)));
  return { from: first.phase, fromAt: first.at, to: last.phase, toAt: last.at, totalMin: total, workMin: work, waitMin: total - work, running: rs.some(r => r.running) };
}
const dur = m => m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
// report.json / verdict.json d'un run TERMINÉ, lus une fois (ils ne changent plus) ; la page les relit par
// /api/launcher/file, route existante — rien de neuf côté serveur.
const runAux = new Map();
async function loadRunAux(r) {
  if (r.running || runAux.has(r.dir)) return;
  const names = (r.files || []).map(f => f.name), want = ['report.json', 'verdict.json'].filter(n => names.includes(n));
  if (!want.length) return;
  runAux.set(r.dir, {});
  const aux = {};
  for (const n of want) { try { aux[n.replace('.json', '')] = JSON.parse(await (await fetch('/api/launcher/file?path=' + encodeURIComponent(r.dir + '\\' + n), { cache:'no-store' })).text()); } catch {} }
  runAux.set(r.dir, aux);
  if (detailKey && detailKey.endsWith('|' + r.dir)) renderDetail(true);
}
// Note HTML du lanceur rendue (le serveur la sert en text/plain, exprès) : iframe SANS scripts — allow-same-origin
// seulement pour lire sa hauteur ; les liens s'ouvrent dans un nouvel onglet.
function noteFrame(html) {
  const f = el('iframe', 'lnote');
  f.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox'); f.setAttribute('referrerpolicy', 'no-referrer');
  f.srcdoc = '<base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px 16px;color:#1f1e1c}</style>' + html;
  f.onload = () => { try { f.style.height = Math.min(1200, f.contentDocument.documentElement.scrollHeight + 8) + 'px'; } catch {} };
  return f;
}
let runFile = null, runFileText = null;      // fichier du run affiché dans le détail : 'dir/nom'
async function viewRunFile(it, name) {
  const key = it.run.dir + '/' + name;
  if (runFile === key) { runFile = null; runFileText = null; return renderDetail(true); }
  openRunFile(it, name);
}
// quiet : appelé PENDANT le rendu du détail (note ouverte d'office) — pas de re-rendu immédiat, seulement à la lecture.
async function openRunFile(it, name, quiet) {
  const key = it.run.dir + '/' + name;
  runFile = key; runFileText = name.endsWith('.png') ? null : '…'; if (!quiet) renderDetail(true);
  if (!name.endsWith('.png')) { try { runFileText = await (await fetch('/api/launcher/file?path=' + encodeURIComponent(it.run.dir + '\\' + name), { cache:'no-store' })).text(); } catch { runFileText = '(illisible)'; } if (runFile === key) renderDetail(true); }
}
// Détail d'un run : en-tête (statut, modèle, coût, tours, PR), fichiers du run, conversation (suivie en direct pendant le run).
function renderRunDetail(it, force) {
  const main = $('main'), r = it.run;
  // Clé de détail = demande + run : le corps se reconstruit quand la demande passe au run suivant ou qu'on en choisit
  // un autre dans la frise.
  const dk = it.key + '|' + r.dir;
  // Résultat constaté (report.json / verdict.json) ; sa PR complète celle de la demande quand le lanceur ne la
  // donnait plus (étape scriptée hors attente : pas de `waiting`, donc pas de PR — l'en-tête n'avait aucun lien).
  loadRunAux(r);
  const aux = runAux.get(r.dir) || {}, res = runResult(aux.report, aux.verdict);
  if (res && res.pr && !it.pr) it = { ...it, pr: res.pr, prUrl: ui().prUrl ? ui().prUrl + res.pr : null };
  if (detailKey !== dk || force) {
    // Changement de run : sa note s'ouvre d'office (sauf fichier déjà choisi dans ce run).
    if (detailKey !== dk && !(runFile && runFile.startsWith(r.dir + '/'))) { const n = !r.running && runNote(r.phase, r.files); if (n) openRunFile(it, n, true); else { runFile = null; runFileText = null; } }
    detailKey = dk; main.replaceChildren();
    const head = el('div'); head.id = 'head'; const body = el('div'); body.id = 'body'; main.append(head, body);
    if (res) {
      const card = el('div', 'rcard ' + res.look); card.append(el('div', 'rtitle', res.title));
      for (const l of res.lines) card.append(el('div', 'rline', l));
      body.append(card);
    }
    // Bloc « Piloter » dans le CORPS (reconstruit au changement de run seulement) : la consigne en cours de frappe ne
    // doit pas être effacée par le rafraîchissement de l'en-tête, toutes les 2 s.
    const ob = el('div', 'orders'); ob.id = 'orders'; body.append(ob); renderOrders(it);
    // Frise des runs de la demande (du plus récent au plus ancien) : un clic affiche ce run (fichiers, conversation).
    if (it.runs && it.runs.length > 1) {
      body.append(el('h2', null, 'Runs de HD-' + r.hd + ' (' + it.runs.length + (it.costTotal != null ? ' · ' + money(it.costTotal) : '') + ')'));
      const sp = runSpan(it.runs, Date.now());
      if (sp) body.append(el('div', 'rspan', [(RUN_FR[sp.from] || sp.from) + ' ' + hhmm(sp.fromAt) + ' → ' + (RUN_FR[sp.to] || sp.to) + ' ' + hhmm(sp.toAt),
        dur(sp.totalMin) + (sp.running ? ' jusqu’ici' : ' de bout en bout'), dur(sp.workMin) + ' de travail du lanceur', dur(sp.waitMin) + ' d’attente (feu vert, file, déploiement)',
        it.costTotal != null ? money(it.costTotal) : null].filter(Boolean).join(' · ')));
      const fr = el('div', 'lf runs-hd');
      for (const x of it.runs) {
        const xr = x.run, o = xr.running ? 'en cours' : x.outcome || '—';
        const b = el('button', 'quick ' + x.look + (xr.dir === r.dir ? ' on' : ''),
          [new Date(xr.at).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }), RUN_FR[xr.phase] || xr.phase, o,
           xr.minutes != null ? Math.round(xr.minutes) + ' min' : null, xr.costUsd != null ? money(xr.costUsd) : null].filter(Boolean).join(' · '));
        const headDir = (it.runs.find(i => i.run.running) || it.runs[0]).run.dir;     // le run que reprend la ligne
        b.onclick = () => { if (xr.dir === headDir) runPick.delete(it.key); else runPick.set(it.key, xr.dir); runFile = null; renderDetail(true); };
        fr.append(b);
      }
      body.append(fr);
    }
    if (r.files && r.files.length) {
      body.append(el('h2', null, 'Fichiers du run'));
      const fl = el('div', 'lf');
      for (const f of r.files) { const b = el('button', 'quick' + (runFile === r.dir + '/' + f.name ? ' on' : ''), f.name); b.title = Math.max(1, Math.round(f.size / 1024)) + ' Ko'; b.onclick = () => viewRunFile(it, f.name); fl.append(b); }
      body.append(fl);
      if (runFile && runFile.startsWith(r.dir + '/')) {
        const name = runFile.slice(r.dir.length + 1);
        if (name.endsWith('.png')) { const img = el('img', 'lview'); img.src = '/api/launcher/file?path=' + encodeURIComponent(r.dir + '\\' + name); body.append(img); }
        else if (name.endsWith('.html') && runFileText !== '…') body.append(noteFrame(runFileText || ''));
        else body.append(el('pre', 'lview', runFileText));
      }
    }
    if (it.sessionId) { body.append(el('h2', null, 'Conversation complète'), convPane()); applyConvView(it); }
    else body.append(el('div', 'empty', it.scripted ? 'Étape scriptée du lanceur : aucune session Claude, donc pas de conversation (voir ses fichiers).' : 'Conversation introuvable : identifiant de session inconnu pour ce run.'));
  }
  const head = $('head'); head.replaceChildren(); head.className = it.look;
  head.append(el('div', 'dtitle', it.title));
  const chip = el('span', 'chip'); chip.append(el('span', 'dot'), (r.running ? 'travaille · depuis ' + ago(Date.now() - r.at) : (it.outcome || 'terminé') + ' · il y a ' + ago(Date.now() - it.since)));
  if (it.wait && STAGE_FR[it.wait.stage]) chip.append(el('span', 'tag cl', STAGE_FR[it.wait.stage]));
  head.append(chip);
  if (it.model) head.append(el('span', 'tok', '  ·  modèle : ' + modelName(it.model)));
  if (it.tokens) head.append(el('span', 'tok', '  ·  contexte : ' + it.tokens.toLocaleString('fr-FR') + ' tokens'));
  const meta = el('div', 'meta', ['🤖 lanceur · ' + (RUN_FR[r.phase] || r.phase), 'lancé le ' + new Date(r.at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }),
    r.minutes != null ? Math.round(r.minutes) + ' min' : null, r.turns ? r.turns + ' tours' : null, r.costUsd != null ? (Math.round(r.costUsd * 100) / 100).toLocaleString('fr-FR') + ' $' : null,
    it.pid ? 'pid ' + it.pid : null, it.sessionId].filter(Boolean).join(' · '));
  const a = prLink(it); if (a) meta.append(' · ', a);
  head.append(meta);
  if (r.detail) head.append(el('div', 'meta', r.detail));
  if (it.wait && it.wait.detail) head.append(el('div', 'meta', 'Demande : ' + it.wait.detail));
  head.append(hdBlock(r.hd));
  const actions = el('div', 'actions');
  if (!r.running && r.sessionId) { const b = el('button', 'primary', '↻ Reprendre dans un onglet'); b.title = 'claude --resume ' + r.sessionId + ' — pour l’inspecter ou la questionner ; le lanceur ne la reprend pas'; b.onclick = () => openRunConversation(r); actions.append(b); }
  const bl = el('button', null, 'Vue 🤖 Lanceur'); bl.onclick = () => openLauncher(); actions.append(bl);
  head.append(actions);
  head.append(el('div', 'banner', runBanner(!!r.running, !!(it.sessionId || r.sessionId))));
}
// La DEMANDE derrière un run (en-tête du détail) : demandeur, date, type, statut, assigné, client, liens Teams et
// de tickets, début de la description — lue par GET /api/launcher/hd (commande de lecture des tickets du lanceur), gardée
// ici par HD (l'en-tête se redessine toutes les 2 s ; le serveur garde 5 min). hdParts est PURE (testée par le .ps1).
const HD_STATUS_FR = { New:'Nouveau', Open:'Ouvert', InProgress:'En cours', Pending:'En attente', Waiting:'En attente', Resolved:'Résolu', Closed:'Fermé' };
const HD_KIND_FR = { Bug:'🐞 Bug', Idee:'💡 Idée' };
const HD_PRIO_FR = { Low:'basse', Medium:'moyenne', High:'haute', Urgent:'urgente' };
function hdParts(h) {
  const when = h.createdAt ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(h.createdAt) ? h.createdAt : h.createdAt + 'Z') : null;
  return [
    h.kind ? (HD_KIND_FR[h.kind] || h.kind) : null,
    h.status ? (HD_STATUS_FR[h.status] || h.status) : null,
    h.requester ? 'demandée par ' + h.requester : null,
    when && !isNaN(when) ? 'le ' + when.toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : null,
    h.domain ? 'domaine ' + h.domain : null,
    h.severity ? 'sévérité ' + h.severity : null,
    h.priority ? 'priorité ' + (HD_PRIO_FR[h.priority] || h.priority) : null,
    h.assignee ? 'assignée à ' + h.assignee : null,
    h.clients ? h.clients + (h.clients > 1 ? ' clients liés' : ' client lié') : null,
  ].filter(Boolean);
}
const hdInfo = {};                              // hd → { at, value } | { at, loading }
function hdBlock(hd) {
  const box = el('div', 'hdreq');
  const c = hdInfo[hd];
  if (!c || (!c.loading && Date.now() - c.at > (c.value.error ? 60000 : 300000))) {
    hdInfo[hd] = { at: Date.now(), loading: true, value: c && c.value };
    fetch('/api/launcher/hd?hd=' + encodeURIComponent(hd), { cache:'no-store' }).then(x => x.json()).catch(() => ({ error: 'serveur injoignable' }))
      .then(v => { hdInfo[hd] = { at: Date.now(), value: v }; renderDetail(); });
  }
  const h = hdInfo[hd].value;
  if (!h) { box.append(el('span', 'mute', '📨 Demande HD-' + hd + ' : lecture…')); return box; }
  if (h.error) { box.append(el('span', 'mute', '📨 Demande HD-' + hd + ' : ' + h.error)); return box; }
  const line = el('div', 'hdl'); line.append(el('b', null, '📨 Demande'), ' · ' + hdParts(h).join(' · '));
  const link = (txt, url) => { const a = el('a', null, txt); a.href = url; a.target = '_blank'; a.rel = 'noopener'; return a; };
  if (ui().ticketUrl) line.append(' · ', link((ui().ticketLabel || 'Ticket') + ' ↗', ui().ticketUrl + h.hd));
  if (h.teamsUrl) line.append(' · ', link('Teams ↗', h.teamsUrl));
  box.append(line);
  if (h.description) { const d = el('div', 'hdd', h.description); d.title = 'Début de la description de la demande'; box.append(d); }
  return box;
}
// Bandeau du détail d'un run : il ne parle de conversation (ni de « Reprendre ») que si le run en a une — une étape
// scriptée (go, merge, production, doc) n'a pas de session Claude.
// Titre du groupe 🤖 : « en cours » et « aujourd'hui » ne comptent QUE les runs du lanceur ; les autres claude -p
// (étiqueteur de sessions, automates divers) sont comptés à part — sinon l'étiqueteur passait pour un run en cours.
function autoTitle(base, rows) {
  const runs = rows.filter(it => it.kind === 'run'), nAuto = rows.length - runs.length;
  const parts = runs.length ? [runs.filter(it => it.run.running).length + ' en cours', runs.length + ' HD aujourd’hui'] : [];
  if (nAuto) parts.push(nAuto + (nAuto > 1 ? ' automates' : ' automate'));
  return parts.length ? base + ' — ' + parts.join(' · ') : base;
}
function runBanner(running, conv) {
  if (running) return conv ? 'Run du lanceur en cours (claude -p, sans terminal) : on ne lui écrit pas — les ordres se donnent une fois le run terminé. La conversation défile en direct.'
    : 'Étape scriptée du lanceur en cours : pas de session Claude ni de conversation ; les ordres se donnent une fois l’étape terminée.';
  return conv ? 'Run du lanceur terminé. « Reprendre » rouvre sa conversation dans un onglet, sans rien changer pour le lanceur ; « Piloter » lui donne un ordre.'
    : 'Étape scriptée du lanceur terminée : pas de session Claude ni de conversation à reprendre ; « Piloter » donne un ordre au lanceur.';
}

// ── Piloter le lanceur depuis le détail d'un run : go + consigne, livrer la PR (confirmation), relire,
// sauter la recette, reprendre, verdict du diagnostic. La page ne fait que TAPER la commande du lanceur
// (POST /api/launcher/order ⇒ la commande du lanceur) : il refait ses gardes et dit son refus, que l'on affiche tel quel.
// runOrders est PURE (testée par sessions-dashboard-tests.ps1) : les gestes PROPOSÉS selon la phase du run et l'étape de
// la demande — un filtre de lisibilité, pas une garde (le lanceur refuse ce qui n'a pas lieu d'être).
function runOrders(phase, stage, pr) {
  if (stage === 'deploying' || stage === 'in-production') return ['diagnostic', 'suite', 'relance', 'reveil'].includes(phase) ? ['verdict'] : [];
  // Étape de livraison (merge, production, doc) sans attente en cours : la demande est livrée ou en train de l'être —
  // un « go » n'a plus de sens (il proposait de relancer un dev sur un correctif déjà en production).
  if (!stage && ['merge', 'production', 'doc'].includes(phase)) return [];
  const dead = ['dev-abandoned', 'dev-failed', 'pr-closed'].includes(stage);
  const prSide = !dead && (stage === 'pr-awaiting-approval' || !!pr || ['dev', 'relecture', 'recette', 'reprise'].includes(phase));
  const o = prSide ? ['merge', 'review', 'recette-skip', 'rework'] : ['go'];
  if (['diagnostic', 'suite', 'relance', 'reveil'].includes(phase)) o.push('verdict');
  return o;
}
// ── Décision de la Tech (carte ✅ posée par le lanceur sous sa dernière note, `techDecision` de son state.json) :
// tranchée ICI comme sur la carte. decisionForm et decideBody sont PURES ; le
// lanceur refait toutes les gardes (ordre « decide ») et pose la note de trace qui ferme la carte.
const DECISION_KIND_FR = { validation:'✅ Validation Tech', cadrage:'📐 Ouvrir un cadrage', doc:'📝 Mémoire de domaine' };
function decisionForm(d) {
  let qs = [];
  try { qs = JSON.parse(d.questionsJson || '[]'); } catch { qs = []; }
  if (!Array.isArray(qs)) qs = [];
  const main = qs.find(q => q && q.id === 'decision') || { question:'', options:[] };
  const opts = q => (q.options || []).map(o => ({ id: String(o.id), label: String(o.label || o.id), recommended: !!o.recommended }));
  return {
    title: DECISION_KIND_FR[d.kind] || '✅ Décision de la Tech',
    question: String(main.question || ''),
    choices: qs.filter(q => q && q.id !== 'decision').map(q => ({ id: String(q.id), header: String(q.header || q.id), question: String(q.question || ''), options: opts(q) })),
    decisions: opts(main).map(o => ({ ...o, needsText: d.kind === 'validation' && o.id === 'non' })),
  };
}
function decideBody(hd, d, decision, picks, text) {
  const f = decisionForm(d);
  const dec = f.decisions.find(x => x.id === decision);
  if (!dec) return { error: 'décision inconnue' };
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (dec.needsText && !t) return { error: '« ' + dec.label + ' » demande un motif : il est dit au demandeur' };
  const choices = {};
  for (const c of f.choices) { const v = picks && picks[c.id]; if (v && c.options.some(o => o.id === v)) choices[c.id] = v; }
  return { hd: String(hd), order: 'decide', value: decision, choices, text: t };
}
const decisionOf = hd => ((runData && runData.decisions) || []).find(x => String(x.hd) === String(hd)) || null;
let decideUi = { key: null, picks: {}, text: '' };
function renderDecision(box, it, d) {
  const f = decisionForm(d), hd = String(it.run.hd);
  if (decideUi.key !== hd + ':' + d.interaction) {
    decideUi = { key: hd + ':' + d.interaction, picks: {}, text: '' };
    for (const c of f.choices) { const r = c.options.find(o => o.recommended); if (r) decideUi.picks[c.id] = r.id; }
  }
  const card = el('div', 'orderform decision');
  card.append(el('div', null, f.title + ' — en attente depuis ' + (d.since ? ago(Date.now() - d.since) : '?')));
  if (f.question) card.append(el('div', 'meta', f.question));
  for (const c of f.choices) {
    const line = el('div', 'meta'); line.append(c.header + ' — ' + c.question + ' ');
    const sel = el('select'); sel.append(el('option', null, '— choisir —')); sel.firstChild.value = '';
    for (const o of c.options) { const op = el('option', null, o.label + (o.recommended ? ' (recommandé)' : '')); op.value = o.id; if (decideUi.picks[c.id] === o.id) op.selected = true; sel.append(op); }
    sel.onchange = () => { decideUi.picks[c.id] = sel.value; };
    line.append(sel); card.append(line);
  }
  const ta = el('textarea'); ta.value = decideUi.text; ta.maxLength = 2000; ta.rows = 2;
  ta.placeholder = 'Consigne (Lancer), motif (Ne pas faire : obligatoire, dit au demandeur) ou texte « Autre »';
  ta.oninput = () => { decideUi.text = ta.value; };
  card.append(ta);
  const a = el('div', 'actions');
  for (const dec of f.decisions) {
    const b = el('button', dec.recommended ? 'primary' : null, dec.label); b.disabled = orderUi.busy;
    b.onclick = () => { const body = decideBody(hd, d, dec.id, decideUi.picks, decideUi.text); if (body.error) { orderUi.result = { ok: false, text: '⛔ ' + body.error }; renderOrders(it); return; } sendOrder(it, body); };
    a.append(b);
  }
  card.append(a, el('div', 'hint', 'Ordre « decide ' + hd + ' … » — rejouée comme un clic sur la carte ; une note visible le dit au demandeur et ferme la carte.'));
  box.append(card);
}
// ── Cartes de questions du lanceur (module « launcher », clé cardsApi — server/src/cards.ts) : ce que l'orchestrateur
// demande à l'opérateur sous une de ses notes se lit et se RÉPOND ici, comme le dialogue d'une session : options en
// boutons avec leur description, recommandée en premier, « Autre » en texte libre. Toutes les questions de la carte
// sont visibles ; rien ne part avant « Envoyer les réponses ». La réponse passe par la commande des cartes : dans le
// ticket, c'est un clic de l'opérateur sur la carte. cardRuns, withCards, cardForm et cardAnswers sont PURES
// (testées par server/test/page-cards.test.ts).
const CARD_FR = { arbitrage:'⚖️ Question pour toi', question:'❓ Question pour toi', validation:'✅ Validation — lancer le développement ?', cadrage:'📐 Ouvrir un cadrage ?', doc:'📝 Mémoire de domaine' };
// Le DERNIER run d'une demande dont une carte attend, quand il est antérieur à `since` (minuit) : la liste ne garde
// que les runs du jour, et la carte se traite depuis le détail d'un run.
function cardRuns(runs, cards, since) {
  const hds = new Set((cards || []).map(c => String(c.hd))), latest = new Map();
  for (const r of runs || []) { const k = String(r.hd); if (hds.has(k) && (!latest.has(k) || latest.get(k).at < r.at)) latest.set(k, r); }
  return [...latest.values()].filter(r => !r.running && !(r.at >= since));
}
// Éléments de la liste (un par demande) → les mêmes, avec leurs cartes ; une demande qui a une carte et ne travaille
// pas « attend ta décision » (couleur ask, groupe « À traiter »).
function withCards(items, cards) {
  const by = new Map();
  for (const c of cards || []) { const k = String(c.hd); if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
  return (items || []).map(it => by.has(String(it.run.hd)) ? { ...it, cards: by.get(String(it.run.hd)), look: it.run.running ? it.look : 'ask' } : it);
}
function cardForm(card) {
  const qs = Array.isArray(card && card.questions) ? card.questions.filter(q => q && q.id != null) : [];
  return {
    id: String(card.id), title: CARD_FR[card.flavor] || CARD_FR[card.kind] || 'Question pour toi', neighbours: Number(card.neighbours) || 0,
    questions: qs.map(q => {
      const options = (Array.isArray(q.options) ? q.options : []).map(o => ({ id: String(o.id), label: String(o.label || o.id), description: String(o.description || ''), recommended: !!o.recommended }));
      options.sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
      return { id: String(q.id), header: String(q.header || q.id), question: String(q.question || ''), multi: !!q.multiSelect, open: !options.length, options,
        required: card.kind === 'validation' && String(q.id) === 'decision' };
    }),
  };
}
// Ce qui part : { answers } ou { error } ; `missing` = les questions laissées sans réponse (la carte se ferme quand même).
function cardAnswers(card, picks, others) {
  const f = cardForm(card), answers = [], missing = [];
  for (const q of f.questions) {
    const known = new Set(q.options.map(o => o.id));
    let selected = ((picks && picks[q.id]) || []).filter(v => known.has(v));
    if (!q.multi) selected = selected.slice(0, 1);
    const other = String((others && others[q.id]) || '').trim();
    if (other.length > 2000) return { error: '« ' + q.header + ' » : 2 000 caractères au plus' };
    if (selected.length || other) answers.push({ questionId: q.id, selected, other: other || null }); else missing.push(q.header);
  }
  if (!answers.length) return { error: 'Réponds à au moins une question' };
  const dec = f.questions.find(q => q.required);
  if (dec) {
    const a = answers.find(x => x.questionId === dec.id);
    if (!a || a.selected.length !== 1) return { error: 'Choisis la décision : ' + dec.options.map(o => o.label).join(' / ') };
    if (card.flavor === 'validation' && a.selected[0] === 'non' && !a.other) return { error: '« Ne pas faire » demande un motif : il est dit au demandeur' };
  }
  return { answers, missing };
}
const cardsOn = () => !!(runData && runData.cardsToken === 'ok');
const cardsFor = hd => cardsOn() ? (runData.cards || []).filter(c => String(c.hd) === String(hd)) : [];
let cardUi = { key: null, picks: {}, others: {}, busy: false };
let cardFresh = null;   // demande dont les cartes ont été relues à l'instant pour l'affichage
// Avant de proposer une carte, la relire dans le ticket : elle a pu être répondue ou remplacée depuis le dernier relevé.
async function refreshCards(it, hd) {
  if (cardFresh === hd) return;
  cardFresh = hd;
  try {
    const r = await (await fetch('/api/launcher/cards?hd=' + encodeURIComponent(hd), { cache:'no-store' })).json();
    if (!runData || !Array.isArray(r.cards)) return;
    const fresh = r.cards.map(c => ({ hd, title: r.title || null, ...c }));
    const before = JSON.stringify(cardsFor(hd).map(c => c.id));
    runData.cards = (runData.cards || []).filter(c => String(c.hd) !== hd).concat(fresh);
    if (before !== JSON.stringify(fresh.map(c => c.id))) { renderList(); if (orderUi.key === it.key) renderOrders(it); }
  } catch {}
}
function renderCard(box, it, card) {
  const f = cardForm(card), hd = String(it.run.hd), key = hd + ':' + f.id;
  if (cardUi.key !== key) cardUi = { key, picks: {}, others: {}, busy: false };
  const c = el('div', 'dlg qcard');
  const since = card.postedAt ? Date.parse(String(card.postedAt).replace(/Z?$/, 'Z')) : 0;
  c.append(el('div', 'tabs', f.title + (card.addressee ? ' · ' + card.addressee : '') + (since ? ' · posée il y a ' + ago(Date.now() - since) : '')));
  for (const q of f.questions) {
    const blk = el('div', 'qblock');
    blk.append(el('div', 'q', q.header + ' — ' + q.question));
    if (q.options.length) {
      const os = el('div', 'opts');
      for (const o of q.options) {
        const on = (cardUi.picks[q.id] || []).includes(o.id);
        const b = el('button', 'opt' + (on ? ' sel' : '')); b.type = 'button'; b.disabled = cardUi.busy;
        b.append(el('span', 'n', on ? '✔' : (q.options.indexOf(o) + 1) + '.'), el('span', null, o.label + (o.recommended ? ' (recommandé)' : '')));
        if (o.description) b.append(el('span', 'd', o.description));
        b.onclick = () => {
          const cur = cardUi.picks[q.id] || [];
          cardUi.picks[q.id] = on ? cur.filter(v => v !== o.id) : q.multi ? cur.concat(o.id) : [o.id];
          orderUi.result = null; renderOrders(it);
        };
        os.append(b);
      }
      blk.append(os);
      if (q.multi) blk.append(el('div', 'hint', 'Plusieurs réponses possibles.'));
    }
    const row = el('div', 'row'); const ta = el('textarea'); ta.rows = q.open ? 2 : 1; ta.maxLength = 2000; ta.value = cardUi.others[q.id] || ''; ta.disabled = cardUi.busy;
    ta.placeholder = q.open ? 'Ta réponse…' : q.required ? 'Consigne pour le développement (Lancer), ou motif (Ne pas faire : obligatoire, dit au demandeur)' : 'Autre réponse, ou une précision (facultatif)';
    ta.oninput = () => { cardUi.others[q.id] = ta.value; };
    row.append(ta); blk.append(row);
    c.append(blk);
  }
  const a = el('div', 'row');
  const go = el('button', 'primary', 'Envoyer les réponses'); go.disabled = cardUi.busy || !canWrite;
  go.onclick = () => sendCard(it, card);
  a.append(go); c.append(a);
  c.append(el('div', 'hint', 'La réponse part dans le ticket sous ton nom, comme un clic sur la carte, et la carte se ferme : une question laissée vide reste sans réponse.'
    + (f.neighbours ? ' ' + plural(f.neighbours, 'autre carte reste ouverte', 'autres cartes restent ouvertes') + ' sous la même note.' : '')));
  box.append(c);
}
// Le message après « Envoyer les réponses » — PURE. L'orchestrateur prévenu dit ce qu'il a fait de la réponse
// (`launcher` : travail mis en file, suite signalée…) ; une commande qui ne le dit pas garde la phrase d'avant.
function cardAnsweredText(hd, missing, j) {
  const said = j && typeof j.launcher === 'string' && j.launcher.trim() ? j.launcher.trim() : '';
  return '✅ Réponse enregistrée dans HD-' + hd + (missing.length ? ' — sans réponse : ' + missing.join(', ') : '') + '. '
    + (said ? said.charAt(0).toUpperCase() + said.slice(1) + (/[.!?]$/.test(said) ? '' : '.') : 'Le lanceur la lit à sa prochaine passe.');
}
async function sendCard(it, card) {
  if (!canWrite || cardUi.busy) return;
  const hd = String(it.run.hd), key = it.key;
  const body = cardAnswers(card, cardUi.picks, cardUi.others);
  if (body.error) { orderUi.result = { ok: false, text: '⛔ ' + body.error }; renderOrders(it); return; }
  cardUi.busy = true; orderUi.result = null; renderOrders(it);
  let res, done = false;
  try {
    const r = await fetch('/api/launcher/answer', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ hd, card: String(card.id), answers: body.answers }) });
    const j = await r.json().catch(() => ({}));
    done = !!(r.ok && (j.ok === true || j.gone));
    res = r.ok && j.ok === true ? { ok: true, text: cardAnsweredText(hd, body.missing, j) }
      : { ok: false, text: '⛔ ' + (j.error || 'réponse refusée (' + r.status + ')') };
  } catch { res = { ok: false, text: '⛔ serveur injoignable' }; }
  cardUi.busy = false;
  if (done && runData) { runData.cards = (runData.cards || []).filter(c => !(String(c.hd) === hd && String(c.id) === String(card.id))); cardUi = { key: null, picks: {}, others: {}, busy: false }; renderList(); }
  say(res.text.split('\n')[0]);
  if (orderUi.key !== key) return;
  orderUi.result = res; renderOrders(it); setTimeout(loadRuns, 3000);
}
const ORDER_FR = { go:'▶ Feu vert (go)', merge:'🚀 Livrer la PR', review:'🔎 Relire la PR', 'recette-skip':'⏭ Sauter la recette', rework:'🔁 Reprendre la PR',
  adopt:'🔎 Relire les commits ajoutés, puis livrer', retry:'↻ Relancer la livraison', session:'🧑‍💻 Reprendre en session' };
// Livraison refusée (lot 1 des livraisons refusées) : la NATURE du refus, publiée par le
// lanceur (stages.json → waiting.refusalKind), remplace « Livrer la PR » par la suite qui a un sens. Commits ajoutés après
// les contrôles ⇒ les relire ici, puis livrer CE sha (merge --adopt-head) ; panne technique ⇒ relancer. Conflit,
// doublon, autre refus (lot 2) : « Livrer la PR » serait refusé à l'identique ⇒ « Reprendre en session » (formulaire
// Nouvelle session prérempli) ; offert aussi en repli après les deux premiers. PURE (testée par le .ps1).
function deliveryOrders(list, refusalKind) {
  if (!refusalKind || !list.includes('merge')) return list;
  if (refusalKind === 'head-changed') return [...list.map(o => o === 'merge' ? 'adopt' : o), 'session'];
  if (refusalKind === 'technical') return [...list.map(o => o === 'merge' ? 'retry' : o), 'session'];
  return list.map(o => o === 'merge' ? 'session' : o);
}
// Premier message de la session de reprise (PURE, testée par le .ps1) : la PR, ce que le lanceur a dit, et la règle —
// rien n'est mergé sans le go de l'humain. Une session qui livrerait seule ferait sauter la relecture que le refus garde.
const RESUME_WHAT = { conflict:'résous le conflit avec la branche principale', duplicate:'vérifie si elle double un travail déjà livré ou ouvert (à fermer) ou si elle le complète (à livrer)',
  'head-changed':'relis les commits ajoutés après les contrôles du lanceur', technical:'comprends la panne de la livraison' };
function resumePrompt(hd, pr, kind, reason) {
  const why = String(reason || '').replace(/^livraison refusée — /, '').replace(/\s+/g, ' ').trim();
  return ['La livraison automatique de la PR #' + pr + ' (demande HD-' + hd + ') a été refusée par le lanceur' + (why ? ' : « ' + why.slice(0, 500) + ' »' : '') + '.',
    'Reprends-la : pars de la branche de la PR à jour dans un worktree neuf, ' + (RESUME_WHAT[kind] || 'comprends ce qui bloque') + ', rebase sur la branche principale juste avant, rejoue build et tests.',
    'Ne merge rien sans mon go : montre-moi d’abord ce que tu as changé et le résultat des contrôles.'].join('\n\n');
}
// Ce que dit l'en-tête du bloc de relecture (PURE, testée par le .ps1) : commits ajoutés, ou PR réécrite (rebase,
// force-push) dont il faut tout relire, ou rien à relire (la PR porte de nouveau la tête contrôlée).
function diffHeadline(d) {
  if (!d || d.error) return '⛔ ' + ((d && d.error) || 'diff illisible');
  if (d.merged || d.state === 'closed') return 'La PR n’est plus ouverte (' + (d.merged ? 'mergée' : 'fermée') + ') : rien à livrer.';
  if (!d.changed) return 'La PR porte de nouveau le commit contrôlé par le lanceur : rien à relire, la livraison simple suffit.';
  const n = (d.commits || []).length, files = (d.files || []).length;
  const what = n + ' commit' + (n > 1 ? 's' : '') + ' · ' + files + ' fichier' + (files > 1 ? 's' : '');
  return d.rewritten ? '⚠️ La PR a été réécrite (rebase ou force-push) depuis les contrôles : c’est TOUTE la PR qui est à relire — ' + what + '.'
    : 'Arrivé sur la PR après les contrôles du lanceur, lu par personne : ' + what + '.';
}
let orderUi = { key: null, open: null, text: '', busy: false, result: null, diff: null };
function renderOrders(it) {
  const box = $('orders'); if (!box) return;
  const r = it.run, hd = String(r.hd);
  if (orderUi.key !== it.key) orderUi = { key: it.key, open: null, text: '', busy: false, result: null, diff: null };
  box.replaceChildren();
  if (r.running) return;
  const stage = it.wait ? it.wait.stage : null, pr = it.pr;
  // Cartes de questions (jeton rangé) : elles portent AUSSI la décision ✅ — l'ancien formulaire ne sert plus que sans elles.
  const cards = cardsFor(hd);
  if (cards.length) refreshCards(it, hd);
  const dec = cardsOn() ? null : decisionOf(hd);
  // Une décision en attente remplace le go nu : « Lancer » de la carte part avec ses choix et laisse la trace.
  const list = deliveryOrders(runOrders(r.phase, stage, pr).filter(o => !((dec || cards.some(c => c.kind === 'validation')) && o === 'go')), it.wait ? it.wait.refusalKind : null);
  const noToken = !!(runData && runData.cardsToken === 'absent' && (r.files || []).some(f => f.name === 'questions.json'));
  if (!list.length && !dec && !cards.length && !noToken) return;
  box.append(el('h2', null, 'Piloter HD-' + hd));
  for (const c of cards) renderCard(box, it, c);
  if (noToken) box.append(el('div', 'meta', 'Ce run a posé des questions : pour y répondre ici, range le jeton des cartes sur ce poste. En attendant, elles se traitent dans le ticket.'));
  if (dec) renderDecision(box, it, dec);
  const row = el('div', 'actions');
  for (const o of list) {
    if (o === 'verdict') {
      row.append(el('span', 'meta', 'Verdict du diagnostic :'));
      for (const v of ['ok', 'partiel', 'faux']) { const b = el('button', orderUi.open === 'verdict:' + v ? 'primary' : null, v); b.disabled = orderUi.busy; b.onclick = () => { orderUi.open = orderUi.open === 'verdict:' + v ? null : 'verdict:' + v; renderOrders(it); }; row.append(b); }
      continue;
    }
    const b = el('button', orderUi.open === o ? 'primary' : null, ORDER_FR[o]); b.disabled = orderUi.busy;
    b.onclick = () => o === 'session' ? openNew(null, { title: 'Reprendre la livraison de HD-' + hd + (pr ? ' (PR #' + pr + ')' : ''),
        prompt: resumePrompt(hd, pr || '?', it.wait && it.wait.refusalKind, it.wait && it.wait.detail), tags: [{ axis: 'fonction', v: 'livraison-refusee' }] })
      : o === 'adopt' ? toggleAdopt(it)
      : (o === 'go' || o === 'merge' || o === 'retry') ? (orderUi.open = orderUi.open === o ? null : o, renderOrders(it)) : sendOrder(it, { order: o });
    row.append(b);
  }
  box.append(row);
  const open = orderUi.open;
  if (open === 'go' || (open && open.startsWith('verdict:'))) {
    const f = el('div', 'orderform');
    const ta = el('textarea'); ta.value = orderUi.text; ta.maxLength = 2000; ta.rows = 3;
    ta.placeholder = open === 'go' ? 'Consigne pour la session de développement (facultatif) — ex. « charge les agents à part, comme dans AppointmentEndpointSetup »' : 'Commentaire (facultatif)';
    ta.oninput = () => { orderUi.text = ta.value; };
    const v = open.startsWith('verdict:') ? open.slice(8) : null;
    const go = el('button', 'primary', v ? 'Noter « ' + v + ' »' : 'Envoyer le feu vert'); go.disabled = orderUi.busy;
    go.onclick = () => sendOrder(it, v ? { order: 'verdict', value: v, text: orderUi.text } : { order: 'go', text: orderUi.text });
    const cancel = el('button', null, 'Annuler'); cancel.onclick = () => { orderUi.open = null; renderOrders(it); };
    const a = el('div', 'actions'); a.append(go, cancel);
    f.append(ta, a, el('div', 'hint', v ? 'Ordre « verdict ' + hd + ' ' + v + ' » — noté à la prochaine passe.' : 'Ordre « go ' + hd + ' » — correctif en file, toujours en PR à relire (jamais de merge automatique).'));
    box.append(f);
  } else if (open === 'adopt') {
    box.append(adoptForm(it, hd, pr));
  } else if (open === 'merge' || open === 'retry') {
    const f = el('div', 'orderform confirm');
    if (open === 'retry') f.append(el('div', 'meta', 'La livraison précédente a échoué pour une raison technique, sans rapport avec la PR : ' + ((it.wait && it.wait.detail) || '') ));
    f.append(el('div', null, '🚀 Livrer ' + (pr ? 'la PR #' + pr : 'la PR du lanceur') + ' de HD-' + hd + ' : rebase sur master, contrôles rejoués (20 à 40 min), puis squash-merge — elle part en PRODUCTION.'));
    const link = prLink(it); if (link) { const m = el('div', 'meta'); m.append('Relire avant : ', link); f.append(m); }
    const ok = el('button', 'primary', 'Confirmer la livraison'); ok.disabled = orderUi.busy; ok.onclick = () => sendOrder(it, { order: 'merge', confirm: true });
    const cancel = el('button', null, 'Annuler'); cancel.onclick = () => { orderUi.open = null; renderOrders(it); };
    const a = el('div', 'actions'); a.append(ok, cancel); f.append(a);
    box.append(f);
  }
  if (cardUi.busy) box.append(el('div', 'meta', 'Réponse en cours d’envoi…'));
  if (orderUi.busy) box.append(el('div', 'meta', 'Ordre en cours de transmission au lanceur…'));
  else if (orderUi.result) box.append(el('pre', 'orderres ' + (orderUi.result.ok ? 'ok' : 'ko'), orderUi.result.text));
}
// « J'ai relu, livrer » : le diff est relu à chaque ouverture (jamais un cache) — le sha envoyé est celui affiché.
async function toggleAdopt(it) {
  if (orderUi.open === 'adopt') { orderUi.open = null; renderOrders(it); return; }
  const key = it.key; orderUi.open = 'adopt'; orderUi.diff = { loading: true }; renderOrders(it);
  let d;
  try { const r = await fetch('/api/launcher/delivery-diff?hd=' + encodeURIComponent(String(it.run.hd))); d = await r.json().catch(() => ({ error: 'réponse illisible (' + r.status + ')' })); }
  catch { d = { error: 'lanceur injoignable' }; }
  if (orderUi.key !== key || orderUi.open !== 'adopt') return;
  orderUi.diff = d; renderOrders(it);
}
function adoptForm(it, hd, pr) {
  const f = el('div', 'orderform confirm adopt'), d = orderUi.diff || {};
  if (d.loading) { f.append(el('div', 'meta', 'Lecture du diff auprès du lanceur…')); return f; }
  f.append(el('div', null, diffHeadline(d)));
  if (!d.error && d.changed) {
    const ul = el('ul', 'commits');
    for (const c of d.commits || []) {
      const li = el('li'); li.append(el('code', null, String(c.sha || '').slice(0, 10)), ' ' + (c.title || ''), el('span', 'meta', '  ' + [c.author, c.date ? new Date(c.date).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : null].filter(Boolean).join(' · ')));
      ul.append(li);
    }
    f.append(ul);
    for (const x of d.files || []) {
      const det = el('details', 'difffile'), sum = el('summary');
      sum.append(el('code', null, x.path || '?'), el('span', 'meta', '  ' + (x.status || '') + '  +' + (x.additions ?? 0) + ' −' + (x.deletions ?? 0)));
      det.append(sum);
      const pre = el('pre', 'diff');
      for (const line of String(x.patch || '').split('\n')) pre.append(el('span', line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : null, line + '\n'));
      if (x.patchTruncated || !x.patch) pre.append(el('span', 'hunk', x.patch ? '… (tronqué — voir la PR)' : '(pas de diff texte : binaire, renommage ou trop gros)'));
      det.append(pre); f.append(det);
    }
    if (d.truncated) f.append(el('div', 'meta', '⚠️ Diff tronqué : la suite est sur la PR.'));
  }
  const link = prLink(it); if (link) { const m = el('div', 'meta'); m.append('Sur GitHub : ', link); f.append(m); }
  const a = el('div', 'actions');
  if (!d.error && d.changed && !d.merged && d.state !== 'closed' && /^[0-9a-f]{40}$/.test(d.prHead || '')) {
    const ok = el('button', 'primary', '✅ J’ai relu, livrer'); ok.disabled = orderUi.busy;
    ok.onclick = () => sendOrder(it, { order: 'merge', confirm: true, adoptHead: d.prHead });
    a.append(ok);
  } else if (!d.error && !d.changed && !d.merged && d.state !== 'closed') {
    const ok = el('button', 'primary', '🚀 Livrer'); ok.disabled = orderUi.busy; ok.onclick = () => sendOrder(it, { order: 'merge', confirm: true }); a.append(ok);
  }
  const again = el('button', null, '↻ Relire le diff'); again.onclick = () => { orderUi.open = null; toggleAdopt(it); };
  const cancel = el('button', null, 'Annuler'); cancel.onclick = () => { orderUi.open = null; renderOrders(it); };
  a.append(again, cancel); f.append(a);
  f.append(el('div', 'hint', 'Ordre « merge ' + hd + ' --adopt-head ' + (d.prHead ? String(d.prHead).slice(0, 10) + '…' : '<sha>') + ' »'
    + ' — seul ce commit est adopté : si la PR bouge encore, nouveau refus avec le nouveau diff. Rebase, contrôles rejoués (20 à 40 min), puis squash-merge en PRODUCTION.'));
  return f;
}
async function sendOrder(it, o) {
  if (!canWrite || orderUi.busy) return;
  const key = it.key; orderUi.busy = true; orderUi.result = null; renderOrders(it);
  let res;
  try {
    const r = await fetch('/api/launcher/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ hd: String(it.run.hd), ...o }) });
    const j = await r.json().catch(() => ({}));
    res = !r.ok || j.error ? { ok: false, text: '⛔ ' + (j.error || 'ordre refusé (' + r.status + ')') } : { ok: true, text: '✅ ' + (j.message || 'ordre transmis') };
  } catch { res = { ok: false, text: '⛔ lanceur injoignable' }; }
  if (orderUi.key !== key) return;
  orderUi.busy = false; orderUi.result = res; if (res.ok) { orderUi.open = null; orderUi.text = ''; }
  say(res.text.split('\n')[0]);
  renderOrders(it); setTimeout(loadRuns, 3000);
}

// ── Après un redémarrage de Windows : sessions qui étaient ouvertes, à rouvrir d'un coup ──
const rebootPick = new Map();       // sessionId -> coché ?
async function reopenMany(ids) {
  if (!ids.length) return say('aucune session cochée');
  say('réouverture de ' + plural(ids.length, 'session', 'sessions') + '…');
  try {
    const r = await (await fetch('/api/reopen-many', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ids }) })).json();
    say(r.error ? 'refusé : ' + r.error : plural(r.opened, 'onglet ouvert', 'onglets ouverts') + (r.skipped ? ' (' + r.skipped + ' ignorée(s))' : '') + ' — les sessions réapparaissent dans quelques secondes');
  } catch { say('échec de la demande'); }
  tick();
}
async function dismissReboot() { try { await post('/api/reboot-dismiss'); say('liste d\'avant le redémarrage oubliée'); } catch { say('échec de la demande'); } tick(); }
function rebootPanel() {
  const rb = data.reboot; if (!rb) return null;
  const box = el('div', 'reboot');
  box.append(el('div', 'rt', 'Windows a redémarré — ' + plural(rb.sessions.length, 'session était ouverte', 'sessions étaient ouvertes') + ' le ' + new Date(rb.at).toLocaleString('fr-FR')));
  const ul = el('div', 'rl');
  for (const s of rb.sessions) {
    if (!rebootPick.has(s.sessionId)) rebootPick.set(s.sessionId, true);
    const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = rebootPick.get(s.sessionId); cb.onchange = () => rebootPick.set(s.sessionId, cb.checked);
    lab.append(cb, el('span', null, s.title), el('span', 'rm', (s.pr ? 'PR #' + s.pr + ' · ' : '') + 'active il y a ' + ago(data.now - s.lastActivity)));
    ul.append(lab);
  }
  box.append(ul);
  const act = el('div', 'actions');
  const b1 = el('button', 'primary', 'Rouvrir la sélection'); b1.onclick = () => reopenMany(rb.sessions.map(s => s.sessionId).filter(id => rebootPick.get(id)));
  const b2 = el('button', null, 'Tout cocher / décocher'); b2.onclick = () => { const all = rb.sessions.every(s => rebootPick.get(s.sessionId)); rb.sessions.forEach(s => rebootPick.set(s.sessionId, !all)); renderDetail(true); };
  const b3 = el('button', null, 'Ignorer'); b3.title = 'Ne plus proposer ces sessions (elles restent dans « Fermées, reprenables »)'; b3.onclick = () => dismissReboot();
  act.append(b1, b2, b3); box.append(act);
  box.append(el('div', 'hint', 'Un onglet Windows Terminal par session, chacune reprise où elle s’était arrêtée (claude --resume).'));
  return box;
}

function prLink(it) {
  if (!it.pr || !/^https:\/\/github\.com\//.test(it.prUrl || '')) return null;
  const a = el('a', null, 'PR #' + it.pr); a.href = it.prUrl; a.target = '_blank'; a.rel = 'noopener'; a.onclick = e => e.stopPropagation(); return a;
}

function renderList() {
  const tokens = norm($('q').value).split(/\s+/).filter(Boolean);
  // Les fermées masquées ne réapparaissent que dans une recherche (étiquetées « masquée »).
  const items = allItems().filter(it => (!favOnly || it.fav) && (!it.hidden || tokens.length) && tokens.every(t => tagMatch(it, t) ?? it.hay.includes(t)));
  $('favonly').className = favOnly ? 'on' : '';
  $('sortbtn').className = sortMode === 'created' ? 'on' : '';
  $('sortbtn').title = sortMode === 'created' ? 'Trié par date de création (la plus récente d’abord) — clic : par dernière activité' : 'Trié par dernière activité — clic : par date de création';
  const expandAll = tokens.length || favOnly;     // recherche ou filtre favoris : on cherche aussi dans les groupes repliés
  const list = $('list'); list.replaceChildren(); flat = [];
  if (data.reboot) {               // après un redémarrage de Windows : rappel en tête, la vue d'ensemble propose la réouverture
    const b = el('div', 'rbanner', '↻ ' + plural(data.reboot.sessions.length, 'session ouverte', 'sessions ouvertes') + ' avant le redémarrage — rouvrir…');
    b.title = 'Afficher la liste dans la vue d\'ensemble'; b.onclick = () => select(null); list.append(b);
  }
  // Consultées récemment : raccourci en tête de liste. Pas pendant une recherche ou le filtre favoris (bruit),
  // et ces lignes n'entrent pas dans la navigation ↑ ↓ (la session y figure déjà dans son groupe d'état).
  if (!expandAll) {
    const all = new Map(allItems().filter(it => !it.hidden).map(it => [it.key, it]));
    const rec = recent.filter(r => all.has(r.k)).slice(0, RECENT_SHOWN);
    if (rec.length) {
      const isCollapsed = collapsed.has('recent');
      const head = el('div', 'grp');
      head.append(el('span', 'car', isCollapsed ? '▸' : '▾'), el('span', null, 'Consultées récemment'), el('span', 'n', rec.length));
      head.title = 'Les dernières sessions ouvertes dans cette page  ( b : revenir à la précédente )';
      head.onclick = () => { collapsed.has('recent') ? collapsed.delete('recent') : collapsed.add('recent'); localStorage.setItem('cc.collapsed', JSON.stringify([...collapsed])); renderList(); };
      list.append(head);
      if (!isCollapsed) for (const r of rec) {
        const it = all.get(r.k);
        const row = el('div', 'row-s ' + (it.look || it.state) + (it.key === selected ? ' sel' : ''));
        const tt = el('span', 't'); if (it.fav) tt.append(el('span', 'star', '★ ')); tt.append(label(it));
        row.append(el('span', 'dot'), tt, el('span', 'age', 'vue il y a ' + ago(Date.now() - r.at)));
        row.append(el('span', 'sub', it.kind === 'run' ? runSub(it) : it.kind === 'pass' ? passSub(it) : (it.kind === 'closed' ? 'fermée — terminal disparu' : LABEL[it.state]) + (it.lastPrompt ? ' · ' + it.lastPrompt : '')));
        row.title = label(it); row.onclick = () => select(it.key); row.ondblclick = () => primary(it);
        list.append(row);
      }
    }
  }
  for (const g of groupList()) {
    // 🤖 et automates : en cours d'abord (runs, passes et autres claude -p), puis du plus récent au plus ancien.
    const live = it => it.kind === 'run' ? it.run.running : it.kind === 'pass' ? it.running : it.kind === 'open';
    const byTime = g.key === 'auto' || !!g.auto;
    const rows = items.filter(it => g.states.includes(it.state)).sort(sortMode === 'created'
      ? (byTime ? (a, b) => (live(b) - live(a)) || createdOf(b) - createdOf(a) : (a, b) => (b.fav - a.fav) || createdOf(b) - createdOf(a))
      : byTime ? (a, b) => (live(b) - live(a)) || (b.at || b.since) - (a.at || a.since)
      : (a, b) => (b.fav - a.fav) || (g.asc ? (TODO.indexOf(a.state) - TODO.indexOf(b.state) || a.since - b.since) : b.since - a.since));
    if (!rows.length && (g.key !== 'todo' || expandAll) && !(g.auto && !expandAll)) continue;   // « À traiter » et les automates restent visibles même vides
    const isCollapsed = !expandAll && collapsed.has(g.key);
    // 🤖 replié : on garde sous les yeux ce qui compte — en cours, en échec, PR qui attend l'utilisateur.
    const urgent = g.key === 'auto' ? rows.filter(it => live(it) || it.look === 'waiting' || it.look === 'ask') : g.auto ? rows.filter(it => live(it) || it.look === 'waiting') : [];
    const head = el('div', 'grp');
    const gTitle = g.key === 'auto' ? autoTitle(g.title, rows) : g.auto ? g.title + (autoGroupTitle(g.auto) ? ' — ' + autoGroupTitle(g.auto) : '') : g.title;
    head.append(el('span', 'car', isCollapsed ? '▸' : '▾'), el('span', null, gTitle + (g.key === 'closed' && closedData.days ? ' · ' + closedData.days + ' j' : '')), el('span', 'n', rows.length));
    if (g.auto) head.title = 'Passes du jour qui ont agi ou échoué, et la passe en cours. Les passes sans effet sont comptées ici sans ligne. Replié : seulement en cours et en échec.' + (g.auto.last ? '\nDernière passe : ' + g.auto.last.summary : '');
    if (g.key === 'auto') head.title = 'Runs du lanceur depuis minuit et tout run en cours, plus les autres claude -p. Replié : seulement en cours, en échec et PR qui attend ta validation. L’historique long est dans la vue 🤖 ( l ).';
    if (g.key === 'todo' && rows.some(it => it.state === 'done' || it.state === 'ask')) {
      const all = el('a', null, 'tout marquer vu'); all.href = '#'; all.style.textTransform = 'none'; all.style.letterSpacing = '0'; all.style.fontWeight = '400';
      all.onclick = async e => { e.preventDefault(); e.stopPropagation(); try { await post('/api/ack?all=1'); say('sessions terminées marquées comme vues'); tick(); } catch {} };
      head.insertBefore(all, head.lastChild);
    }
    if (g.key === 'closed' && !expandAll) {
      const merged = rows.filter(it => it.prInfo && it.prInfo.state === 'MERGED');
      if (merged.length) {
        const a = el('a', 'lnk', 'masquer les ' + merged.length + ' à PR mergée'); a.href = '#';
        a.title = 'Retire de la liste les sessions fermées dont la PR est mergée (réversible, transcripts intacts)';
        a.onclick = e => { e.preventDefault(); e.stopPropagation(); setHidden(merged, true); };
        head.insertBefore(a, head.lastChild);
      }
    }
    head.onclick = () => { collapsed.has(g.key) ? collapsed.delete(g.key) : collapsed.add(g.key); localStorage.setItem('cc.collapsed', JSON.stringify([...collapsed])); renderList(); };
    list.append(head);
    if (isCollapsed && !urgent.length) continue;
    if (!rows.length && g.auto) continue;
    if (!rows.length) { const e = el('div', 'row-s empty'); e.append(el('span'), el('span', 'sub', 'rien à traiter')); e.style.cursor = 'default'; list.append(e); continue; }
    for (const it of isCollapsed ? urgent : rows) {
      flat.push(it.key);
      const r = el('div', 'row-s ' + (it.look || it.state) + (it.kind === 'run' || it.kind === 'pass' ? ' run' : '') + (it.key === selected ? ' sel' : ''));
      r.dataset.key = it.key;
      const tt = el('span', 't'); if (it.fav) tt.append(el('span', 'star', '★ ')); tt.append(label(it));
      { const d = driftTag(it); if (d) tt.append(d); }
      if (it.hidden) tt.append(el('span', 'tag hid', 'masquée'));
      r.append(el('span', 'dot'), tt, el('span', 'age', (it.model ? modelName(it.model) + ' · ' : '') + (it.tokens ? ktok(it.tokens) + ' · ' : '') + (sortMode === 'created' ? 'créée il y a ' + ago(data.now - createdOf(it)) : ago(data.now - it.since))));
      const merged = (closable(it) ? '✓ peut se fermer · ' : it.prInfo && it.prInfo.state === 'MERGED' ? 'PR mergée · ' : '') + (it.status === 'shell' && it.state !== 'shell' ? 'commande en arrière-plan · ' : '');
      const sub = el('span', 'sub', it.kind === 'run' ? runSub(it) : it.kind === 'pass' ? passSub(it) : it.kind === 'open' ? merged + (it.state === 'idle' ? (it.lastPrompt || it.name) : LABEL[it.state] + (it.lastPrompt ? ' · ' + it.lastPrompt : '')) : 'fermée · ' + merged + (it.lastPrompt || short(it.cwd)));
      r.append(sub);
      const chips = tagChips(it, 'tags'); if (chips) r.append(chips);
      const inb = teamsInboundOf(it);
      if (inb) { const x = el('span', 'tw inb', '📥 demande Teams de ' + (inb.chatLabel || inb.from)); x.title = 'Session ouverte automatiquement pour un message reçu en direct sur Teams : elle propose une réponse, rien ne part sans toi'; r.append(x); }
      const tws = teamsWaitsOf(it);
      if (tws.length) {
        const tw = el('span', 'tw' + (tws.some(w => w.status === 'replied') ? ' rep' : tws.some(w => w.alertedAt) ? ' alert' : ''), teamsWaitLine(tws[0], data.now, data.teams.reminders) + (tws.length > 1 ? ' · +' + (tws.length - 1) : ''));
        tw.title = tws.map(w => teamsWaitLine(w, data.now, data.teams.reminders) + '\n  « ' + w.excerpt + ' »').join('\n');
        r.append(tw);
      }
      const vals = validationsOf(it), vb = validationBadge(vals);
      if (vb) { const x = el('span', 'tw val' + (vals.refused || vals.unqualified ? ' ref' : vals.expected ? ' pre' : ''), vb); x.title = vals.items.filter(i => !i.withdrawn).map(i => validationLine(i, data.now) + '\n  ' + i.question).join('\n'); r.append(x); }
      if (canWrite && closable(it)) {                    // « peut se fermer » (inactive, tout est mergé) : ✕ la ferme sans ouvrir la session
        const line = el('span', 'sug'), bx = el('button', 'sgo', '✕ Fermer');
        bx.title = 'Inactive et tout est mergé : quitter la session (/exit, après confirmation) — la conversation reste reprenable depuis « Fermées »';
        bx.onclick = e => { e.stopPropagation(); closeSession(it); };
        bx.ondblclick = e => e.stopPropagation();
        line.append(bx); r.append(line);
      }
      const sg =canWrite && it.kind === 'open' && (it.status === 'idle' || it.status === 'shell') && it.suggestion;
      if (sg) {                                          // proposition de Claude Code : ▶ la lance sans ouvrir la session
        const line = el('span', 'sug'), cut = sg.endsWith('…');
        const go = el('button', 'sgo', '▶');
        go.title = cut ? 'Coupée à l’écran : lancée telle que Claude Code l’a écrite (Tab puis Entrée dans le terminal)' : 'Lancer cette proposition (revérifiée à l’écran juste avant)';
        go.onclick = e => { e.stopPropagation(); launchSuggestion(it, sg); };
        go.ondblclick = e => e.stopPropagation();
        line.append(go, el('span', 'stx', '💡 ' + sg)); line.title = 'Proposition de Claude Code : ' + sg; r.append(line);
      }
      r.title = label(it) + (it.model ? '\nmodèle : ' + it.model : '') + (it.tokens ? '\ncontexte : ' + it.tokens.toLocaleString('fr-FR') + ' tokens' : '');
      r.onclick = () => select(it.key);
      r.ondblclick = () => primary(it);
      list.append(r);
    }
  }
  if (!flat.length && expandAll) list.append(el('div', 'grp', favOnly && !tokens.length ? 'Aucun favori — touche f sur une session' : 'Aucun résultat'));
  const unread = data.notifs.filter(nf => nf.at > Number(localStorage.getItem('cc.notifSeen') || 0)).length; $('belln').textContent = unread ? unread : '';
  const todo = allItems().filter(it => TODO.includes(it.state)).length;
  document.title = (todo ? '(' + todo + ') ' : '') + 'Sessions Claude Code';
  refreshHoverCard();
}

// Survol d'une ligne de la liste : le dernier message de Claude (et sa proposition 💡), sans ouvrir la session.
// La ligne ne montre que TON dernier prompt et le bouton ▶ : pour savoir si la proposition vaut d'être lancée, il
// faut lire ce que Claude vient de dire. La liste est reconstruite à chaque rendu (toutes les 2 s) : la carte vit
// hors de la liste, l'écoute est déléguée à #list et renderList la rafraîchit. Pas de carte sur écran tactile ou
// étroit (pas de survol), ni pour la session déjà ouverte à droite (son message y est affiché).
const HOVER_DELAY = 350, CAN_HOVER = matchMedia('(hover: hover)');
let hoverKey = null, hoverShown = false, hoverTimer = null, hoverMuted = null;
function hoverCardEl() {
  let c = $('hovercard');
  if (!c) { c = el('div'); c.id = 'hovercard'; c.hidden = true; document.body.append(c); }
  return c;
}
function hideHoverCard() { clearTimeout(hoverTimer); hoverTimer = null; hoverShown = false; const c = $('hovercard'); if (c) c.hidden = true; }
function refreshHoverCard() {
  if (!hoverShown) return;
  const it = hoverKey && byKey(hoverKey), row = it && [...$('list').querySelectorAll('.row-s')].find(r => r.dataset.key === hoverKey);
  const reply = it && it.reply ? String(it.reply).trim() : '';
  if (!row || !reply || !CAN_HOVER.matches || NARROW.matches || hoverKey === selected) { const c = $('hovercard'); if (c) c.hidden = true; return; }
  const c = hoverCardEl(); c.className = it.look || it.state || '';
  const sig = hoverKey + '\n' + reply + '\n' + (it.suggestion || '');
  if (c.dataset.sig !== sig) {                     // même contenu : on ne touche pas au DOM (pas de saut de défilement)
    c.dataset.sig = sig; c.replaceChildren(el('div', 'hh', 'Dernier message de Claude'), el('div', 'hb', reply));
    if (it.suggestion) c.append(el('div', 'hs', '💡 ' + it.suggestion));
  }
  c.hidden = false;
  const a = $('list').getBoundingClientRect(), r = row.getBoundingClientRect();
  c.style.left = Math.round(a.right + 8) + 'px';
  c.style.top = Math.round(Math.max(8, Math.min(r.top, innerHeight - c.offsetHeight - 8))) + 'px';
  const hb = c.querySelector('.hb'); hb.scrollTop = hb.scrollHeight;   // message long : c'est sa fin qui dit où on en est
}
function hoverRow(key) {
  if (key === hoverKey) return;
  hideHoverCard(); hoverKey = key; if (key !== hoverMuted) hoverMuted = null;
  if (!key || key === hoverMuted) return;
  hoverTimer = setTimeout(() => { hoverShown = true; refreshHoverCard(); }, HOVER_DELAY);
}
$('list').addEventListener('mouseover', e => { const r = e.target.closest ? e.target.closest('.row-s') : null; hoverRow(r && r.dataset.key ? r.dataset.key : null); });
$('list').addEventListener('mouseleave', () => hoverRow(null));
$('list').addEventListener('scroll', () => { if (hoverShown) refreshHoverCard(); }, { passive: true });
$('list').addEventListener('click', () => { hoverMuted = hoverKey; hideHoverCard(); });   // on ouvre la session : la carte ne masque pas le détail

// Sessions consultées : une session compte comme « vue » si elle reste sélectionnée 1,5 s (parcourir la
// liste au clavier ne pollue pas l'historique), ou aussitôt qu'on agit dessus (onglet, réouverture, réponse).
const RECENT_KEEP = 30, RECENT_SHOWN = 6;
let recent = (() => { try { return JSON.parse(localStorage.getItem('cc.recent') || '[]').filter(r => r && r.k); } catch { return []; } })();
let recentTimer = null;
function touchRecent(key) {
  if (!key) return;
  recent = [{ k:key, at:Date.now() }].concat(recent.filter(r => r.k !== key)).slice(0, RECENT_KEEP);
  localStorage.setItem('cc.recent', JSON.stringify(recent));
}
function back() {                                  // revenir à la session consultée juste avant
  const keys = new Set(allItems().map(it => it.key));
  const prev = recent.find(r => r.k !== selected && keys.has(r.k));
  if (!prev) { say('aucune autre session consultée récemment'); return; }
  if (selected) touchRecent(selected);
  select(prev.k, true); touchRecent(prev.k); renderList();
}

// Écran étroit (téléphone) : liste OU détail, pas les deux. Ouvrir une session (ou le tableau, le lanceur…)
// passe au détail plein écran ; « ← Sessions », Échap ou le bouton retour du téléphone reviennent à la liste.
// Sur grand écran la classe est posée aussi mais sans effet (la CSS ne s'en sert que sous 820 px).
const NARROW = matchMedia('(max-width: 820px)');
function setPane(detail) {
  if (detail === document.body.classList.contains('mdetail')) return;
  if (detail) { document.body.classList.add('mdetail'); if (NARROW.matches) history.pushState({ pane:'detail' }, ''); $('main').scrollTop = 0; }
  else if (history.state && history.state.pane === 'detail') history.back();   // le popstate retire la classe
  else document.body.classList.remove('mdetail');
}
addEventListener('popstate', e => document.body.classList.toggle('mdetail', !!(e.state && e.state.pane === 'detail')));
function setMobileTitle(text, state) { const t = $('mtitle'); t.className = 'chip ' + (state || ''); t.replaceChildren(); if (state) t.append(el('span', 'dot')); t.append(el('span', 't', text)); }

function select(key, scroll) {
  clearTimeout(recentTimer);
  if (key) recentTimer = setTimeout(() => { if (selected === key) { touchRecent(key); renderList(); } }, 1500);
  selected = key; lastScreen = null; newMode = false; findMode = false; bcMode = false; boardMode = false; launchMode = false; chatsMode = false;
  setPane(!!key);
  key ? sessionStorage.setItem('cc.sel', key) : sessionStorage.removeItem('cc.sel');
  renderList(); renderDetail(true);
  if (scroll) { const r = document.querySelector('.row-s.sel'); if (r) r.scrollIntoView({ block:'nearest' }); }
  const it = key && byKey(key);
  if (it && (it.state === 'done' || it.state === 'ask')) post('/api/ack?id=' + it.sessionId).catch(() => {});
  refreshScreen();
}

// Ouverte hors du poste (tailscale serve) : LECTURE SEULE — le serveur refuse toute action (403), la page masque les commandes.
// Le serveur dit s'il accepte l'écriture (/api/whoami) : à distance, seulement pour le propriétaire du poste sur Tailscale.
// En attendant sa réponse — ou s'il refuse — la page reste en lecture seule.
const REMOTE = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
let canWrite = !REMOTE;
function whoami() {
  fetch('/api/whoami', { cache:'no-store' }).then(r => r.json()).then(w => { const was = canWrite; canWrite = !!w.write; document.body.classList.toggle('ro', !canWrite); if (canWrite && !was) say('écriture autorisée à distance (' + w.login + ')'); renderDetail(true); }).catch(() => {});
}
if (REMOTE) { document.body.classList.add('ro', 'remote'); whoami(); }
async function post(path) {
  if (!canWrite) return { error: 'lecture seule à distance', code: 4 };
  if (link.down) return { error: 'serveur injoignable — reconnexion en cours', code: 5 };
  const r = await fetch(path, { method:'POST' }); return r.json();
}
async function openTab(it) {
  say('ouverture de « ' + label(it) + ' »…');
  try { const r = await post('/api/focus?pid=' + it.pid);
    if (r.code === 0) { noTab.delete(it.key); say('onglet affiché'); }
    else { noTab.add(it.key); say(r.code === 3 ? 'onglet introuvable — tu peux la relancer dans un nouvel onglet' : 'console de la session inaccessible — tu peux la relancer dans un nouvel onglet'); renderDetail(); } }
  catch { say('échec de la demande'); }
}
const noTab = new Set();     // sessions dont l'onglet n'a pas pu être affiché : on propose la relance
async function relaunch(it) {
  // Sans confirmation : rien ne se perd (session inactive, invite vide exigées par le serveur ; conversation reprise).
  say('relance de « ' + label(it) + ' »…');
  relaunching = { key: it.key, until: Date.now() + 90000 };
  try { const r = await post('/api/relaunch?pid=' + it.pid);
    if (r.error) { relaunching = null; say('non relancée : ' + r.error); } else { noTab.delete(it.key); say('relancée dans un nouvel onglet — elle réapparaît dans quelques secondes'); } }
  catch { relaunching = null; say('échec de la demande'); }
  tick();
}
// Entre la fermeture et la réapparition dans le nouvel onglet, la session n'est dans aucune liste pendant quelques
// secondes : la sélection est gardée, pour que son détail revienne tout seul au lieu de la chercher dans la liste.
let relaunching = null;
const awaitingRelaunch = key => !!relaunching && relaunching.key === key && Date.now() < relaunching.until;
async function closeSession(it) {
  if (!it || it.kind !== 'open') return;
  if (!confirm('Fermer « ' + label(it) + ' » ?\n\nLa conversation est conservée : elle passe dans « Fermées, reprenables ». L’onglet du terminal reste ouvert sur une invite PowerShell.')) return;
  say('fermeture de « ' + label(it) + ' »…');
  try {
    let r = await post('/api/close?pid=' + it.pid);
    if (r.needForce) {
      if (!confirm(r.error + '.\n\nL’arrêter de force ? Le travail en cours dans ce tour sera perdu ; la conversation reste reprenable.')) { say('fermeture annulée'); return; }
      r = await post('/api/close?pid=' + it.pid + '&force=1');
    }
    say(r.error ? 'non fermée : ' + r.error : (r.forced ? 'session arrêtée' : 'session fermée') + ' — reprenable depuis « Fermées »');
  } catch { say('échec de la demande'); }
  tick(); loadClosed();
}
// Masquer des sessions FERMÉES : elles sortent de la liste, des consultées et des compteurs ; la recherche les retrouve.
let hiddenSet = new Set();
async function setHidden(list, on) {
  list = list.filter(it => it && it.kind === 'closed'); if (!list.length) return;
  if (on && list.length > 1 && !confirm('Masquer ' + list.length + ' sessions fermées ?\n\nElles restent trouvables par la recherche et peuvent être ré-affichées ; les transcripts ne sont pas touchés.')) return;
  for (const it of list) on ? hiddenSet.add(it.key) : hiddenSet.delete(it.key);
  if (on && list.some(it => it.key === selected)) select(null); else { renderList(); renderDetail(true); }
  try {
    await fetch('/api/hide', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ids: list.map(it => it.key), on }) });
    say(on ? (list.length > 1 ? list.length + ' sessions masquées' : 'session masquée') + ' — retrouvable par la recherche' : 'session ré-affichée');
  } catch { say('échec de la demande'); }
  tick();
}
async function toggleFav(it) {
  const on = !favs.has(it.key); on ? favs.add(it.key) : favs.delete(it.key);
  renderList(); renderDetail();
  try { await post('/api/fav?id=' + it.sessionId + '&on=' + (on ? 1 : 0)); say(on ? 'ajoutée aux favoris' : 'retirée des favoris'); } catch { say('échec de la demande'); }
}
// ── Pièces jointes : glisser-déposer n'importe où sur la page, coller une capture (Ctrl+V), bouton « Joindre » (téléphone).
// Le fichier part au serveur dès qu'il est déposé (/api/upload, écrit sous ~/.claude/uploads) ; le message envoyé porte
// son CHEMIN (« Capture : "C:\…\x.png" »), que Claude Code lit avec son outil Read. Une seule zone visible à la fois
// (réponse à une session, premier message d'une nouvelle session, message groupé) : c'est elle qui reçoit. ──
const ATT_MAX = 20 * 1024 * 1024, ATT_ACCEPT = 'image/*,.pdf,.txt,.log,.csv,.json,.md';
const attachSets = {};                                   // zone ('reply:<clé>', 'new', 'bc') -> pièces, survit aux re-rendus
const attList = key => attachSets[key] || (attachSets[key] = []);
const attBusy = key => attList(key).some(a => !a.path);
// Texte envoyé : le message, puis un libellé + chemin entre guillemets par pièce (une seule ligne : l'envoi la tape telle quelle).
// Zones de saisie de prompt : textarea de 4 lignes au moins, qui grandit avec le texte (jusqu'à ~12 lignes, puis défile).
function growArea(t) { if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 300) + 'px'; }
function promptArea(id, rows = 4) {
  const t = el('textarea', 'parea'); t.id = id; t.rows = rows; t.autocomplete = 'off'; t.spellcheck = true;
  t.addEventListener('input', () => growArea(t)); return t;
}
function withAttachments(key, text) {
  const refs = attList(key).filter(a => a.path).map(a => (a.img ? 'Capture' : 'Fichier') + ' : "' + a.path + '"');
  return [text.trim(), ...refs].filter(Boolean).join(' ');
}
function clearAttachments(key) { for (const a of attList(key)) if (a.url) URL.revokeObjectURL(a.url); attachSets[key] = []; refreshAttach(key); }
async function uploadFile(key, file) {
  if (!canWrite) return say('lecture seule à distance');
  if (file.size > ATT_MAX) return say('« ' + file.name + ' » non joint : trop gros (20 Mo au plus)');
  const img = /^image\//.test(file.type);
  const a = { name: file.name || (img ? 'capture.png' : 'fichier'), img, size: file.size, url: img ? URL.createObjectURL(file) : null, path: null };
  attList(key).push(a); refreshAttach(key);
  try {
    const r = await fetch('/api/upload', { method:'POST', headers:{ 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(a.name) }, body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.path) throw new Error(j.error || 'code ' + r.status);
    a.path = j.path; say('« ' + a.name + ' » joint');
  } catch (e) {
    const l = attList(key), i = l.indexOf(a); if (i >= 0) l.splice(i, 1); if (a.url) URL.revokeObjectURL(a.url);
    say('« ' + a.name + ' » non joint : ' + (e.message || 'échec de la demande'));
  }
  refreshAttach(key);
}
// Barre des pièces d'une zone : vignettes (retrait possible) + bouton « Joindre ». Se reconstruit à chaque changement.
function attachBar(key) {
  const bar = el('div', 'attach'); bar.dataset.key = key; fillAttach(bar); return bar;
}
function refreshAttach(key) { for (const bar of document.querySelectorAll('.attach')) if (bar.dataset.key === key) fillAttach(bar); }
function fillAttach(bar) {
  const key = bar.dataset.key; bar.replaceChildren();
  for (const a of attList(key)) {
    const chip = el('div', 'achip' + (a.path ? '' : ' up')); chip.title = a.path || 'envoi en cours…';
    if (a.url) { const im = el('img'); im.src = a.url; im.alt = ''; chip.append(im); } else chip.append(el('span', 'aic', '📄'));
    chip.append(el('span', 'an', a.name), el('span', 'as', a.path ? Math.max(1, Math.round(a.size / 1024)) + ' Ko' : 'envoi…'));
    const x = el('button', 'ax', '×'); x.title = 'Retirer (le message ne citera pas ce fichier)';
    x.onclick = () => { const l = attList(key), i = l.indexOf(a); if (i >= 0) l.splice(i, 1); if (a.url) URL.revokeObjectURL(a.url); refreshAttach(key); };
    chip.append(x); bar.append(chip);
  }
  const pick = el('input'); pick.type = 'file'; pick.multiple = true; pick.accept = ATT_ACCEPT; pick.hidden = true;
  pick.onchange = () => { for (const f of pick.files) uploadFile(key, f); pick.value = ''; };
  const b = el('button', 'quick', '📎 Joindre'); b.type = 'button'; b.title = 'Joindre une capture ou un fichier — ou glisse-le sur la page, ou colle une capture (Ctrl+V)';
  b.onclick = () => pick.click();
  bar.append(b, pick);
  if (!attList(key).length) bar.append(el('span', 'ahint', 'glisser un fichier ou coller une capture (Ctrl+V)'));
}
const activeAttach = () => { const bar = document.querySelector('#main .attach'); return bar && bar.dataset.key; };
const dropFiles = dt => dt && [...(dt.items || [])].some(i => i.kind === 'file');
document.addEventListener('dragover', e => {
  if (!dropFiles(e.dataTransfer)) return;
  e.preventDefault();                                    // sinon le navigateur ouvre le fichier à la place de la page
  e.dataTransfer.dropEffect = activeAttach() ? 'copy' : 'none';
  document.body.classList.toggle('dropping', !!activeAttach());
});
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', e => {
  if (!dropFiles(e.dataTransfer)) return;
  e.preventDefault(); document.body.classList.remove('dropping');
  const key = activeAttach(); if (!key) return say('ouvre une session (Répondre), une nouvelle session ou le message groupé pour joindre un fichier');
  for (const f of e.dataTransfer.files) uploadFile(key, f);
});
document.addEventListener('paste', e => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])]; if (!files.length) return;
  const key = activeAttach(); if (!key) return;
  e.preventDefault();                                    // une capture collée devient une pièce jointe, pas du texte
  for (const f of files) uploadFile(key, f);
});

let sending = false;
async function sendReply() {
  const it = selected && byKey(selected), inp = $('sendtext');
  if (!it || it.kind !== 'open' || !inp || sending) return;
  if (link.down) return say('serveur injoignable — le message reste dans la zone, à renvoyer une fois reconnecté');
  const akey = 'reply:' + it.key;
  if (attBusy(akey)) return say('pièce jointe en cours d’envoi — un instant');
  const text = withAttachments(akey, inp.value); if (!text) return;
  const queued = it.status === 'busy';
  sending = true; inp.disabled = $('sendbtn').disabled = true; say((queued ? 'mise en file pour « ' : 'envoi à « ') + label(it) + ' »…');
  try {
    const r = await (await fetch('/api/send?pid=' + it.pid, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text }) })).json();
    if (r.error) say('non envoyé : ' + r.error); else { inp.value = ''; growArea(inp); clearAttachments(akey); say(queued ? 'mis en file pour « ' + label(it) + ' » — Claude Code le prendra dès qu’il peut' : 'envoyé à « ' + label(it) + ' »'); }
  } catch { say('échec de la demande'); }
  sending = false; tick();
}
// PROPOSITION DE PROMPT : le texte grisé que Claude Code affiche dans l'invite vide après un tour (Tab dans le
// terminal pour l'accepter). Lue par le serveur avec l'écran (/api/screen → suggestion) ; « Lancer » la tape dans la
// session, le serveur revérifiant juste avant qu'elle est ENCORE exactement à l'écran. Coupée à l'écran (« … »), elle
// n'est pas tapée mais acceptée dans le terminal (Tab, Entrée) : le serveur n'en connaît pas la fin. « Modifier » (ou Tab dans la
// zone de réponse vide, ou la touche p) la recopie dans la zone de réponse pour l'ajuster avant d'envoyer.
let suggestion = null, suggestKey = null;
function renderSuggest(it, s) {
  const box = $('suggest'); if (!box) return;
  s = canWrite && (it.status === 'idle' || it.status === 'shell') && s ? s : null;
  if (suggestKey === it.key && box.dataset.sig === (s || '')) return;
  const changed = suggestKey !== it.key || suggestion !== s;
  suggestKey = it.key; suggestion = s; box.dataset.sig = s || '';
  box.replaceChildren(); box.hidden = !s;
  if (changed) renderDetail();                           // placeholder de la zone de réponse
  if (!s) return;
  const cut = s.endsWith('…');
  const go = el('button', 'primary', '▶ Lancer');
  go.title = cut ? 'Accepte la proposition dans le terminal (Tab puis Entrée) : c’est son texte complet qui part, pas la version coupée' : 'Tape cette proposition dans la session et l’envoie (revérifiée à l’écran juste avant)';
  go.onclick = () => launchSuggestion(it, s);
  const ed = el('button', null, '✎ Modifier'); ed.title = 'Recopie la proposition dans la zone de réponse  ( p )'; ed.onclick = () => fillSuggestion();
  box.append(el('span', 'slabel', '💡 Proposition de Claude Code'), el('span', 'stext', s), go, ed);
  if (cut) box.append(el('div', 'hint', 'Coupée à l’écran (…) : « Lancer » envoie son texte complet, que la page ne peut pas lire ; « Modifier » pour la réécrire.'));
}
function fillSuggestion() {
  const inp = $('sendtext'); if (!inp || inp.disabled || !suggestion) return false;
  inp.value = suggestion.endsWith('…') ? suggestion.slice(0, -1).trimEnd() : suggestion; growArea(inp); inp.focus(); return true;
}
async function launchSuggestion(it, text) {
  if (!text || sending) return;
  sending = true; say('lancement de la proposition dans « ' + label(it) + ' »…');
  try {
    const r = await (await fetch('/api/send?pid=' + it.pid, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text, suggestion: true }) })).json();
    if (r.error) say('non lancée : ' + r.error); else say('proposition lancée dans « ' + label(it) + ' »');
  } catch { say('échec de la demande'); }
  sending = false; tick();
}
async function reopen(it) {
  say('réouverture de « ' + label(it) + ' »…');
  try { const r = await post('/api/reopen?id=' + it.sessionId); say(r.error ? 'refusé : ' + r.error : 'nouvel onglet ouvert — la session apparaît dans quelques secondes'); }
  catch { say('échec de la demande'); }
}
const resumeCmd = it => (it.cwd ? 'cd "' + it.cwd + '"; ' : '') + 'claude --dangerously-skip-permissions --resume ' + it.sessionId;
async function copyCmd(it) { try { await navigator.clipboard.writeText(resumeCmd(it)); say('commande de reprise copiée'); } catch { say('copie refusée par le navigateur'); } }
const primary = it => { touchRecent(it.key); if (it.kind === 'pass') return undefined; return it.kind === 'run' ? (!it.run.running && it.run.sessionId ? openRunConversation(it.run) : undefined) : it.kind === 'open' ? openTab(it) : reopen(it); };

// ── Recherche dans les conversations ──
// Dès 3 caractères dans la recherche, le panneau de droite liste les passages des conversations (index plein
// texte côté serveur) ; la barre latérale continue de filtrer les sessions comme avant.
let findMode = false, findQ = '', findRes = null, findTimer = null, findSeq = 0;
function scheduleFind() {
  // Des filtres de tags seuls (« domaine:telephonie ») ne filtrent que la liste ; avec des mots (« domaine:telephonie sms »),
  // ils partent aussi au serveur, qui ne cherche les mots que dans les conversations portant ces tags.
  clearTimeout(findTimer); const full = $('q').value.trim(), words = full.split(/\s+/).filter(t => !isTagToken(t)).join(' ');
  const q = words.length < 3 ? '' : full;
  if (q.length < 3) { const was = findMode; findMode = false; findRes = null; findQ = ''; if (was) renderDetail(true); return; }
  findTimer = setTimeout(() => runFind(q), 350);
}
async function runFind(q) {
  const seq = ++findSeq;
  if (!findMode) { findMode = true; newMode = false; bcMode = false; boardMode = false; launchMode = false; chatsMode = false; findRes = null; findQ = q; renderDetail(true); }
  try {
    const r = await (await fetch('/api/find?q=' + encodeURIComponent(q), { cache:'no-store' })).json();
    if (seq !== findSeq) return;                   // une frappe plus récente a relancé la recherche
    findRes = r; findQ = q; if (findMode) renderDetail(true);
  } catch { if (seq === findSeq) say('recherche impossible'); }
}
// Surligne les mots cherchés, sans tenir compte des accents (le texte normalisé garde la longueur du texte).
function highlight(text, q) {
  const span = el('span'); const nt = norm(text);
  const toks = norm(q).split(/\s+/).filter(t => t.length >= 2);
  if (nt.length !== text.length || !toks.length) { span.textContent = text; return span; }
  const marks = [];
  for (const t of toks) { let i = nt.indexOf(t); while (i >= 0) { marks.push([i, i + t.length]); i = nt.indexOf(t, i + t.length); } }
  marks.sort((a, b) => a[0] - b[0]); let at = 0;
  for (const [s, e] of marks) { if (s < at) continue; span.append(text.slice(at, s), el('mark', null, text.slice(s, e))); at = e; }
  span.append(text.slice(at)); return span;
}
function snipEl(s, q) {
  const d = el('div', 'snip');
  d.append(el('span', 'who', (s.role === 'user' ? '🧑 toi' : '🤖 Claude') + (s.at ? ' · ' + new Date(s.at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '')), highlight(s.text, q));
  return d;
}
function renderFind() {
  detailKey = '__find__'; const main = $('main'); main.replaceChildren();
  main.append(el('div', 'dtitle', 'Dans les conversations — « ' + findQ + ' »'));
  const r = findRes;
  if (!r) { main.append(el('div', 'meta', 'recherche…')); return; }
  main.append(el('div', 'meta', (r.sessions || 0) + ' session' + (r.sessions > 1 ? 's' : '') + ' · ' + (r.total || 0) + ' message' + (r.total > 1 ? 's' : '') + ' · ' + r.ms + ' ms · ' + r.indexed + ' transcripts indexés' + (r.indexing ? ' — indexation en cours, résultats partiels' : '') + (r.sessions > r.hits.length ? ' · ' + r.hits.length + ' plus récentes affichées' : '')));
  if (!r.hits.length) { main.append(el('h2', null, 'Aucun message ne contient tous ces mots')); return; }
  const box = el('div'); box.style.marginTop = '16px';
  for (const h of r.hits) {
    const it = byKey(h.sessionId); const st = it ? it.state : 'closed';
    const c = el('div', 'fhit ' + st + (it ? ' go' : ''));
    const t = el('div', 'ft'); t.append(el('span', 'dot'), el('span', null, (it ? label(it) : h.title) || h.sessionId.slice(0, 8)),
      el('span', 'n', h.count + ' message' + (h.count > 1 ? 's' : '') + ' · ' + LABEL[st] + (it ? '' : ', hors liste')));
    if (!it && !h.title) t.children[1].textContent = 'session sans titre (lancement automatique) · ' + h.sessionId.slice(0, 8);
    if (it && it.hidden) t.children[1].append(el('span', 'tag hid', 'masquée'));
    c.append(t);
    if (h.cwd) c.append(el('div', 'meta', short(h.cwd)));
    for (const s of h.snippets) c.append(snipEl(s, findQ));
    if (it) { c.title = 'Ouvrir le détail de la session'; c.onclick = () => select(it.key, true); }
    else {
      const a = el('div', 'actions');
      const b1 = el('button', null, 'Rouvrir dans un nouvel onglet'); b1.onclick = () => reopen({ sessionId: h.sessionId, title: h.title });
      const fake = { sessionId: h.sessionId, cwd: h.cwd };
      const b2 = el('button', null, 'Copier la commande de reprise'); b2.title = resumeCmd(fake); b2.onclick = () => copyCmd(fake);
      a.append(b1, b2); c.append(a);
    }
    box.append(c);
  }
  main.append(box);
}

// ── Nouvelle session ──
// newFork : session source quand on part d'une session existante ({ sessionId, title, cwd }) — la nouvelle session reprend
// toute sa conversation (claude --resume <id> --fork-session, nouvel identifiant, la source n'est pas touchée).
// newPrefill : formulaire prérempli par une autre vue ({ title, prompt, tags }) — « Reprendre en session » d'une livraison
// refusée. Rien n'est lancé : on relit, on modifie, on choisit le dossier, puis « Lancer ».
let newMode = false, launching = false, newFork = null, newPrefill = null;
function openNew(fork = null, prefill = null) { newFork = fork; newPrefill = prefill; newTags = prefill ? prefill.tags.map(t => ({ ...t })) : forkTags(fork); findMode = false; bcMode = false; boardMode = false; launchMode = false; chatsMode = false; selected = null; sessionStorage.removeItem('cc.sel'); newMode = true; setPane(true); renderList(); renderDetail(true); }
function closeNew() { newMode = false; setPane(false); renderDetail(true); }

// ── Message à plusieurs sessions (✉) : même texte tapé dans chaque session cochée — seulement les inactives ou
// celles qui attendent une commande en arrière-plan (invite libre) ; le serveur revérifie chacune. ──
let bcMode = false, bcSending = false;
const bcPick = new Set();
const bcEligible = () => allItems().filter(it => it.kind === 'open' && !it.headless && (it.status === 'idle' || it.status === 'shell'));
function openBc() { findMode = false; newMode = false; boardMode = false; launchMode = false; chatsMode = false; selected = null; sessionStorage.removeItem('cc.sel'); bcMode = true; setPane(true); renderList(); renderDetail(true); }
function closeBc() { bcMode = false; setPane(false); renderDetail(true); }
function renderBc() {
  detailKey = '__bc__'; const main = $('main'); main.replaceChildren();
  main.append(el('div', 'dtitle', 'Écrire à plusieurs sessions'),
              el('div', 'meta', 'Le même message est tapé dans chaque session cochée, comme « Répondre » : seulement si elle est inactive et son invite vide (sinon elle est sautée). Chaque envoi est journalisé.'));
  const f = el('div'); f.id = 'bcform';
  const tx = promptArea('bc-text'); tx.maxLength = 4000; tx.autocomplete = 'off'; tx.placeholder = 'ex. « rebase sur origin/master et dis-moi où tu en es »';
  const list = el('div', 'bclist'); list.id = 'bc-list';
  const quick = el('div', 'actions');
  const qa = el('button', null, 'Toutes'); qa.onclick = () => { bcEligible().forEach(it => bcPick.add(it.key)); fillBc(); };
  const qn = el('button', null, 'Aucune'); qn.onclick = () => { bcPick.clear(); fillBc(); };
  const qc = el('button', null, 'Celles qui peuvent se fermer'); qc.onclick = () => { bcPick.clear(); bcEligible().filter(closable).forEach(it => bcPick.add(it.key)); fillBc(); };
  quick.append(qa, qn, qc);
  const go = el('button', 'primary', 'Envoyer'); go.id = 'bc-go'; go.onclick = () => sendBc();
  const cancel = el('button', null, 'Fermer'); cancel.onclick = () => closeBc();
  const acts = el('div', 'actions'); acts.append(go, cancel);
  const pick = el('div'); pick.append(quick, list);
  f.append(el('label', null, 'Message'), tx, el('label', null, 'Pièces jointes'), attachBar('bc'), el('label', null, 'Sessions'), pick, acts, el('div', 'hint', 'Ctrl+Entrée envoie · Échap ferme'));
  main.append(f); fillBc(); tx.focus();
}
function fillBc() {
  const list = $('bc-list'); if (!list) return; list.replaceChildren();
  const el2 = bcEligible().sort((a, b) => b.since - a.since);
  for (const k of [...bcPick]) if (!el2.some(it => it.key === k)) bcPick.delete(k);
  if (!el2.length) { list.append(el('div', 'empty', 'Aucune session inactive pour l’instant.')); }
  for (const it of el2) {
    const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = bcPick.has(it.key); cb.onchange = () => cb.checked ? bcPick.add(it.key) : bcPick.delete(it.key);
    lab.append(cb, el('span', null, label(it)), el('span', 'rm', LABEL[it.state] + ' · ' + ago(data.now - it.since))); list.append(lab);
  }
  const go = $('bc-go'); if (go) go.textContent = 'Envoyer à ' + plural(bcPick.size, 'session', 'sessions');
  list.onchange = () => { if ($('bc-go')) $('bc-go').textContent = 'Envoyer à ' + plural(bcPick.size, 'session', 'sessions'); };
}
async function sendBc() {
  const tx = $('bc-text'); if (!tx || bcSending) return;
  if (attBusy('bc')) return say('pièce jointe en cours d’envoi — un instant');
  const text = withAttachments('bc', tx.value); const targets = bcEligible().filter(it => bcPick.has(it.key));
  if (!text) return say('message vide'); if (!targets.length) return say('aucune session cochée');
  if (!confirm('Taper « ' + text + ' » dans ' + plural(targets.length, 'session', 'sessions') + ' ?\n\n' + targets.map(it => '• ' + label(it)).join('\n'))) return;
  bcSending = true; $('bc-go').disabled = true; say('envoi à ' + plural(targets.length, 'session', 'sessions') + '…');
  try {
    const r = await (await fetch('/api/send-many', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ pids: targets.map(it => it.pid), text }) })).json();
    const ok = r.results.filter(x => !x.error), ko = r.results.filter(x => x.error);
    say(plural(ok.length, 'envoi', 'envois') + (ko.length ? ' · ' + ko.length + ' sauté(s) : ' + ko.map(x => (x.title || x.pid) + ' (' + x.error + ')').join(', ') : ''));
    if (!ko.length) { tx.value = ''; growArea(tx); bcPick.clear(); clearAttachments('bc'); }
  } catch { say('échec de la demande'); }
  bcSending = false; if ($('bc-go')) $('bc-go').disabled = false; tick();
}
// ── Tags choisis à la création : posés comme une correction à la main (lot 3), avant le démarrage de la session ──
// Domaine et outil : listes fermées (/api/tag-vocab) ; sinon le mot devient une fonction (« Power Dial » → power-dial).
let newTags = [];
const isFonction = v => /^[a-z0-9]+(-[a-z0-9]+){0,4}$/.test(v) && v.length >= 3 && v.length <= 40;
// Une session dérivée repart du même sujet : ses domaine / outil / fonction sont proposés (retirables d'un clic).
const forkTags = fork => fork && fork.tags ? fork.tags.filter(t => TAG_EDITABLE.includes(t.axis)).map(t => ({ axis: t.axis, v: t.v })).slice(0, 8) : [];
function parseNewTag(text, vocab) {
  const s = text.trim(); if (!s) return null;
  const m = /^(domaine|outil|fonction)\s*:\s*(.+)$/i.exec(s);
  const axis = m ? m[1].toLowerCase() : null, raw = m ? m[2].trim() : s;
  const lists = { domaine: vocab.domaines || [], outil: vocab.outils || [] };
  for (const a of ['domaine', 'outil']) {
    if (axis && axis !== a) continue;
    const v = lists[a].find(x => tagSlug(x) === tagSlug(raw)); if (v) return { axis: a, v };
    if (axis) return { error: a + ' hors liste : ' + raw };
  }
  const f = tagSlug(raw);
  return isFonction(f) ? { axis: 'fonction', v: f } : { error: 'fonction : 1 à 5 mots, 3 à 40 caractères' };
}
function addNewTag() {
  const ti = $('nf-tag'); if (!ti) return true;
  const t = parseNewTag(ti.value, tagVocab || {}); if (!t) return true;
  if (t.error) { say(t.error); return false; }
  if (!newTags.some(x => x.axis === t.axis && x.v === t.v)) { if (newTags.length >= 8) { say('8 tags au plus'); return false; } newTags.push(t); }
  ti.value = ''; drawNewTags(); return true;
}
function drawNewTags() {
  const box = $('nf-tags'), ti = $('nf-tag'); if (!box || !ti) return;
  box.replaceChildren();
  for (const t of newTags) {
    const c = el('span', 'chip ' + t.axis, t.v + ' ×'); c.title = t.axis + ' : ' + t.v + '\nclic : retirer';
    c.onclick = () => { newTags = newTags.filter(x => x !== t); drawNewTags(); ti.focus(); };
    box.append(c);
  }
  box.append(ti);
  ti.placeholder = newTags.length ? '' : 'facultatif — ex. Téléphonie, contact-center, power-dial';
}
function newTagOptions(dl) {
  const v = tagVocab || {}, used = new Set(newTags.map(t => t.axis + ':' + t.v)), fn = new Map();
  for (const it of allItems()) for (const t of it.tags || []) if (t.axis === 'fonction' && isFonction(t.v)) fn.set(t.v, (fn.get(t.v) || 0) + 1);
  const opts = [...(v.domaines || []).map(x => ['domaine', x]), ...(v.outils || []).map(x => ['outil', x]),
                ...[...fn].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([x]) => ['fonction', x])];
  dl.replaceChildren();
  for (const [a, x] of opts) { if (used.has(a + ':' + x)) continue; const o = el('option'); o.value = a + ':' + x; dl.append(o); }
}
function renderNew() {
  detailKey = '__new__'; const main = $('main'); main.replaceChildren();
  const fork = newFork;
  main.append(el('div', 'dtitle', fork ? 'Nouvelle session à partir de « ' + (fork.title || fork.sessionId.slice(0, 8)) + ' »' : newPrefill ? 'Nouvelle session — ' + newPrefill.title : 'Nouvelle session'),
              el('div', 'meta', 'S’ouvre dans un nouvel onglet de la fenêtre Windows Terminal la plus récente, puis apparaît dans la liste.'));
  if (fork) main.append(el('div', 'banner', 'La nouvelle session repart de TOUTE la conversation de « ' + (fork.title || fork.sessionId) + ' » (claude --resume ' + fork.sessionId.slice(0, 8) + '… --fork-session) : elle a son propre identifiant, la session d’origine continue de son côté sans rien voir de la suite. Le contexte hérité compte dans la fenêtre de la nouvelle session.'));
  const f = el('div'); f.id = 'newform';
  const cwd = el('select'); cwd.id = 'nf-cwd'; cwd.append(el('option', null, 'chargement des dossiers…')); cwd.disabled = true;
  if (newPrefill) main.append(el('div', 'banner', 'Premier message prérempli par le lanceur : relis-le, ajuste-le, choisis le dossier du dépôt de la PR, puis « Lancer ». Rien n’est lancé ni mergé d’ici.'));
  const pr = el('textarea'); pr.id = 'nf-prompt'; pr.maxLength = 20000; pr.spellcheck = true;
  if (newPrefill) { pr.value = newPrefill.prompt; pr.rows = 8; }
  pr.placeholder = 'Facultatif — ex. « /cadrage HD-123456 » ou « regarde pourquoi … »';
  // Modèle : un groupe de boutons (un seul actif) plutôt qu'une liste ; « Autre… » ouvre la saisie libre pour un
  // identifiant complet (ex. claude-opus-5-5[1m]). Le champ #nf-model reste la valeur envoyée par launchNew.
  const mo = el('input'); mo.id = 'nf-model'; mo.autocomplete = 'off'; mo.spellcheck = false;
  mo.placeholder = 'identifiant complet — ex. claude-opus-5-5[1m]'; mo.value = localStorage.getItem('cc.newmodel') || '';
  const MODELS = [['', 'Par défaut', 'celui de ta config'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
  const mg = el('div', 'nf-seg'); mg.setAttribute('role', 'radiogroup'); mg.setAttribute('aria-label', 'Modèle');
  const segs = [];
  const pickModel = (key, focus) => {
    const other = key === '*';
    if (!other) mo.value = key; else if (MODELS.some(([k]) => k && k === mo.value)) mo.value = '';   // « Autre… » part d'un champ vide
    for (const b of segs) { const on = b.dataset.k === key; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; }
    mo.hidden = !other; if (other && focus) mo.focus();
  };
  for (const [k, lab, tip] of [...MODELS, ['*', 'Autre…', 'saisir un identifiant de modèle complet']]) {
    const b = el('button', null, lab); b.type = 'button'; b.dataset.k = k; b.setAttribute('role', 'radio'); if (tip) b.title = tip;
    b.onclick = () => pickModel(k, true);
    b.onkeydown = e => {                                    // flèches : comme un groupe de radios
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return; e.preventDefault(); const n = segs[(segs.indexOf(b) + d + segs.length) % segs.length]; pickModel(n.dataset.k, false); n.focus();
    };
    segs.push(b); mg.append(b);
  }
  pickModel(MODELS.some(([k]) => k === mo.value) ? mo.value : '*', false);
  const mbox = el('div', 'nf-model'); mbox.append(mg, mo);
  const br = el('input'); br.id = 'nf-branch'; br.autocomplete = 'off'; br.spellcheck = false;
  br.placeholder = 'facultatif — ex. feat/ma-branche : worktree neuf sur origin/master';
  const tbox = el('div', 'nf-tags'); tbox.id = 'nf-tags';
  const ti = el('input'); ti.id = 'nf-tag'; ti.setAttribute('list', 'nf-tagopts'); ti.autocomplete = 'off'; ti.spellcheck = false;
  const tdl = el('datalist'); tdl.id = 'nf-tagopts';
  ti.onfocus = () => { loadTagVocab().then(() => newTagOptions(tdl)); };
  ti.onkeydown = e => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); if (addNewTag()) newTagOptions(tdl); }
    else if (e.key === 'Backspace' && !ti.value && newTags.length) { newTags.pop(); drawNewTags(); newTagOptions(tdl); }
  };
  // Choix dans la liste des propositions : ajouté tout de suite (Chrome : inputType « insertReplacementText » ou absent).
  ti.oninput = e => { if ((!e.inputType || e.inputType === 'insertReplacementText') && ti.value) { if (addNewTag()) newTagOptions(tdl); } };
  tbox.onclick = e => { if (e.target === tbox) ti.focus(); };
  tbox.append(ti);                   // drawNewTags le retrouve par son id et place les puces devant
  const go = el('button', 'primary', 'Lancer'); go.id = 'nf-go'; go.onclick = () => launchNew();
  const cancel = el('button', null, 'Annuler'); cancel.onclick = () => closeNew();
  const acts = el('div', 'actions'); acts.append(go, cancel);
  f.append(el('label', null, 'Dossier'), cwd, el('label', null, 'Premier message'), pr,
           el('div', 'hint', 'Envoyé tel quel à la session dès son démarrage. Vide : la session attend ta première demande.'),
           el('label', null, 'Pièces jointes'), attachBar('new'),
           el('label', null, 'Tags'), tbox, tdl,
           el('div', 'hint', 'Entrée ajoute · clic sur un tag le retire. Domaine et outil : listes fermées ; sinon le mot devient une fonction (power-dial). Posés comme une correction à la main : l’étiqueteur ne les retire jamais.'),
           el('label', null, 'Modèle'), mbox,
           el('label', null, 'Branche neuve'), br,
           el('div', 'hint', 'Remplie : l’onglet récupère origin/master, crée la branche dans un worktree neuf (.claude\\worktrees\\<dernier segment>) et y lance la session, au même sous-dossier. Vide : session dans le dossier choisi.'),
           acts, el('div', 'hint', 'Ctrl+Entrée lance · Échap annule'));
  main.append(f); drawNewTags(); loadTagVocab(); pr.focus();
  fetch('/api/folders', { cache:'no-store' }).then(r => r.json()).then(r => {
    if (!newMode || !$('nf-cwd')) return;
    cwd.replaceChildren(); const last = localStorage.getItem('cc.newcwd');
    for (const d of r.folders || []) { const o = el('option', null, (short(d.path) || d.path) + '   —   il y a ' + ago(Date.now() - d.last) + ' · ' + d.count + ' session' + (d.count > 1 ? 's' : '')); o.value = d.path; o.title = d.path; cwd.append(o); }
    if (!cwd.options.length) { cwd.append(el('option', null, 'aucun dossier récent trouvé')); return; }
    const want = fork && fork.cwd ? fork.cwd.replace(/\\+$/, '').toLowerCase() : null, same = want && [...cwd.options].find(o => o.value.toLowerCase() === want);
    if (same) cwd.value = same.value;
    else if (last && [...cwd.options].some(o => o.value === last)) cwd.value = last;
    cwd.disabled = false;
  }).catch(() => { cwd.replaceChildren(el('option', null, 'liste des dossiers indisponible')); });
}
async function launchNew() {
  const cwd = $('nf-cwd'), pr = $('nf-prompt'), mo = $('nf-model'), br = $('nf-branch');
  if (!cwd || cwd.disabled || launching) return;
  if (attBusy('new')) return say('pièce jointe en cours d’envoi — un instant');
  // Premier message : passé par fichier au lancement (pas tapé) — les retours à la ligne y sont gardés, pièces en fin.
  const refs = withAttachments('new', ''), prompt = [pr.value.trim(), refs].filter(Boolean).join('\n\n');
  if (!addNewTag()) return;          // un tag tapé mais pas encore validé part avec la session — ou bloque s'il est invalide
  launching = true; $('nf-go').disabled = true; say('lancement d’une nouvelle session…');
  try {
    const r = await (await fetch('/api/new', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ cwd: cwd.value, prompt, model: mo.value.trim(), branch: br.value.trim(), forkFrom: newFork ? newFork.sessionId : '', tags: newTags }) })).json();
    if (r.error) say('non lancée : ' + r.error);
    else { clearAttachments('new'); localStorage.setItem('cc.newcwd', cwd.value); localStorage.setItem('cc.newmodel', mo.value.trim()); say(br.value.trim() ? 'onglet ouvert : création du worktree puis lancement (suivre dans l’onglet)' : 'nouvel onglet ouvert — la session apparaît dans quelques secondes'); launching = false; closeNew(); return; }
  } catch { say('échec de la demande'); }
  launching = false; if ($('nf-go')) $('nf-go').disabled = false;
}

// Largeur de la colonne « Derniers prompts » : glisser la poignée entre l'écran et la colonne, double-clic pour la
// largeur par défaut ; retenue d'une visite à l'autre (cc.promptw).
function promptResizer(split) {
  const w = +localStorage.getItem('cc.promptw'); if (w) split.style.setProperty('--promptw', w + 'px');
  const rz = el('div', 'vrz'); rz.title = 'Glisser pour élargir ou réduire les derniers prompts — double-clic : largeur par défaut';
  const clamp = x => Math.round(Math.max(220, Math.min(x, split.getBoundingClientRect().width - 320)));
  rz.onpointerdown = e => {
    e.preventDefault(); rz.setPointerCapture(e.pointerId); rz.classList.add('drag'); document.body.style.userSelect = 'none';
    const move = ev => split.style.setProperty('--promptw', clamp(split.getBoundingClientRect().right - ev.clientX) + 'px');
    const up = () => {
      rz.classList.remove('drag'); document.body.style.userSelect = ''; rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up);
      const v = parseInt(split.style.getPropertyValue('--promptw')); if (v) localStorage.setItem('cc.promptw', String(v));
    };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
  };
  rz.ondblclick = () => { split.style.removeProperty('--promptw'); localStorage.removeItem('cc.promptw'); };
  return rz;
}

function renderDetail(force) {
  $('newbtn').classList.toggle('on', newMode); $('bcbtn').classList.toggle('on', bcMode); $('boardbtn').classList.toggle('on', boardMode);
  $('launchbtn').classList.toggle('on', launchMode); $('chatsbtn').classList.toggle('on', chatsMode);
  document.body.classList.toggle('finding', findMode);
  const mt = launchMode ? 'Lanceur' : chatsMode ? 'Conversations Teams' : boardMode ? 'Tableau par projet' : newMode ? 'Nouvelle session' : bcMode ? 'Message à plusieurs sessions' : findMode ? 'Recherche dans les conversations' : null;
  if (mt) setMobileTitle(mt); else { const cur = selected && byKey(selected); cur ? setMobileTitle(label(cur), cur.look || cur.state) : setMobileTitle('Vue d’ensemble'); }
  if (launchMode) { if (detailKey !== '__launch__' || force) renderLauncher(); return; }   // rafraîchie par son propre minuteur (10 s)
  if (chatsMode) { if (detailKey !== '__chats__' || force) renderChats(); return; }   // rafraîchie par son minuteur (30 s) et à chaque nouvelle liste
  if (boardMode) { renderBoard(force); return; }
  if (newMode) { if (detailKey !== '__new__' || force) renderNew(); return; }
  if (bcMode) { if (detailKey !== '__bc__' || force) renderBc(); return; }
  if (findMode) { if (detailKey !== '__find__' || force) renderFind(); return; }
  const main = $('main'); const it = selected && byKey(selected);
  if (!it) {
    if (selected && data && closedData.days && !awaitingRelaunch(selected)) { selected = null; sessionStorage.removeItem('cc.sel'); }
    if (detailKey !== '' || force) { detailKey = ''; main.replaceChildren(el('div', null), el('div', null)); main.firstChild.id = 'head'; main.lastChild.id = 'body'; }
    renderOverview(); return;
  }
  if (it.kind === 'run') return renderRunDetail(pickRun(it), force);
  if (it.kind === 'pass') return renderPassDetail(it, force);
  if (detailKey !== it.key || force) {
    detailKey = it.key; main.replaceChildren();
    const head = el('div'); head.id = 'head'; const body = el('div'); body.id = 'body'; main.append(head, body);
    // Ouverte depuis la recherche dans les conversations : on garde sous les yeux les passages trouvés.
    const fh = findRes && findQ && $('q').value.trim() === findQ && findRes.hits.find(h => h.sessionId === it.sessionId);
    if (fh) {
      body.append(el('h2', null, 'Passages trouvés — « ' + findQ + ' » · ' + fh.count + ' message' + (fh.count > 1 ? 's' : '')));
      const box = el('div', 'fhit ' + it.state); for (const s of fh.snippets) box.append(snipEl(s, findQ)); body.append(box);
    }
    const term = it.kind === 'open' && !it.headless;      // automate (claude -p) : pas de terminal
    if (term) { const dg = el('div'); dg.id = 'dialog'; body.append(dg); }
    if (term) {
      body.append(el('h2', null, 'Répondre'));
      const sg = el('div', 'suggest'); sg.id = 'suggest'; sg.hidden = true; body.append(sg);
      const box = el('div', 'sendbox'); const inp = promptArea('sendtext'); inp.maxLength = 4000;
      const btn = el('button', 'primary', 'Envoyer'); btn.id = 'sendbtn'; btn.onclick = () => sendReply();
      box.append(inp, btn);
      for (const q of ['go', 'oui', 'non', 'continue']) { const b = el('button', 'quick', q); b.title = 'Pré-remplit la réponse (n\'envoie pas)'; b.onclick = () => { inp.value = q; growArea(inp); inp.focus(); }; box.append(b); }
      const hint = el('div', 'hint'); hint.id = 'sendhint'; box.append(attachBar('reply:' + it.key), hint); body.append(box);
    }
    const pr = el('div', 'prompts'); pr.id = 'prompts';
    if (it.headless && it.reply) { body.append(el('h2', null, 'Dernier message'), el('div', 'reply', it.reply)); }
    if (term) {
      const split = el('div', 'split'), ct = el('div', 'cterm'), cp = el('div', 'cprompts');
      const pre = el('pre', null, '…'); pre.id = 'screen';
      // Deux vues du même panneau : l'écran (ce que le terminal affiche encore) ou la conversation complète (transcript).
      const vh = el('h2', 'viewtabs');
      for (const [v, t, h] of [['screen', 'Écran du terminal', 'En direct, lecture seule : seulement ce que le terminal affiche encore'], ['conv', 'Conversation complète', 'Tout l’historique de la session, relu dans son transcript — défile jusqu’au premier message  ( h )']]) {
        const b = el('button', 'vtab', t); b.dataset.view = v; b.title = h; b.onclick = () => setConvView(v); vh.append(b);
      }
      ct.append(vh, pre, convPane()); cp.append(el('h2', null, 'Derniers prompts'), pr);
      split.append(ct, promptResizer(split), cp); body.append(split);
    } else body.append(el('h2', null, 'Derniers prompts'), pr);
    if (!term) body.append(el('h2', null, 'Conversation complète'), convPane());
    applyConvView(it);
  }
  const head = $('head'); head.replaceChildren(); head.className = it.state;
  { const dt = el('div', 'dtitle', label(it)), d = driftTag(it); if (d) dt.append(d); head.append(dt); }
  const chip = el('span', 'chip'); chip.append(el('span', 'dot'), LABEL[it.state] + ' · depuis ' + ago(data.now - it.since) + (it.waitingFor ? ' · ' + it.waitingFor : ''));
  if (it.status === 'shell' && it.state !== 'shell') { const t = el('span', 'tag cl', 'commande en arrière-plan'); t.title = 'Tour terminé ; une commande lancée en arrière-plan tourne encore dans cette session'; chip.append(t); }
  if (it.stale) { const t = el('span', 'tag cl', 'statut corrigé d\'après l\'écran'); t.title = 'Claude Code la déclare encore « au travail », mais ' + (it.stale === 'hook' ? 'elle a signalé la fin de son tour (hook Stop)' : 'son écran montre un tour terminé'); chip.append(t); }
  head.append(chip);
  if (it.model) { const md = el('span', 'tok', '  ·  modèle : ' + modelName(it.model)); md.title = it.model + ' — modèle du dernier message de la session (suit un /model en cours de route)'; head.append(md); }
  if (it.tokens) { const tk = el('span', 'tok', '  ·  contexte : ' + it.tokens.toLocaleString('fr-FR') + ' tokens'); tk.title = 'Taille du dernier appel au modèle : entrée + cache lu + cache écrit'; head.append(tk); }
  const meta = el('div', 'meta', [it.name, short(it.cwd), it.pid ? 'pid ' + it.pid : null, it.sessionId, it.version ? 'v' + it.version : null, it.startedAt ? 'lancée il y a ' + ago(data.now - it.startedAt) : null].filter(Boolean).join(' · '));
  const a = prLink(it); if (a) { meta.append(' · ', a); prTags(it).forEach(t => meta.append(t)); }
  head.append(meta);
  const dtags = tagChips(it, 'dtags'); if (dtags) head.append(dtags);
  const dinb = teamsInboundOf(it);
  if (dinb) {
    const box = el('div', 'twaits');
    const l = el('div', 'tw inb', '📥 Demande Teams de ' + (dinb.chatLabel || dinb.from)); l.append(el('span', 'tx', ' — session ouverte automatiquement ; rien n’est envoyé sans ton accord.'));
    if (it.kind === 'open' && it.status === 'idle') {
      const bs = el('span', 'twb'); const x = el('button', null, inboundIsArmed(it) ? 'Confirmer l’envoi à ' + (dinb.chatLabel || dinb.from) : 'Envoyer la réponse proposée');
      x.title = 'Demande à la session de poster sa réponse proposée dans le chat Teams (deux clics). Pour la corriger d’abord, réponds à la session.';
      x.onclick = () => teamsInboundSend(it, dinb); bs.append(x); l.append(bs);
    }
    box.append(l); head.append(box);
  }
  const dtws = teamsWaitsOf(it);
  if (dtws.length) {
    const box = el('div', 'twaits');
    for (const w of dtws) {
      const l = el('div', 'tw' + (w.status === 'replied' ? ' rep' : w.alertedAt ? ' alert' : ''), teamsWaitLine(w, data.now, data.teams.reminders)); l.append(el('span', 'tx', ' — « ' + w.excerpt + ' »'));
      const bs = el('span', 'twb');
      const b = (txt, action, tip) => { const x = el('button', null, txt); x.title = tip; x.onclick = () => teamsWaitAction(it, w, action); bs.append(x); };
      if (w.status === 'open') {
        b('Relancer maintenant', 'remind', 'La session écrit tout de suite une relance courte dans le chat (envoi autonome), même hors calendrier');
        b('Repousser', 'snooze', 'Pas de relance avant le prochain jour ouvré à 10 h');
      }
      b('Ne plus attendre', 'dismiss', 'Ferme l’attente : plus de relance, et une réponse éventuelle ne sera pas transmise');
      l.append(bs); box.append(l);
    }
    if (!data.teams.enabled) box.append(el('div', 'tx', 'Surveillance éteinte : aucune réponse ne sera lue tant que « node teams-watcher.ts login » n’a pas été fait.'));
    else if (!data.teams.reminders) box.append(el('div', 'tx', 'Relances automatiques éteintes (teams-watcher-config.json) : seul « Relancer maintenant » écrit au collègue.'));
    head.append(box);
  }
  const dvals = validationsOf(it);
  if (dvals && dvals.items.length) {
    const box = el('div', 'twaits vals');
    box.append(el('div', 'vh', 'Validations métier — ' + (validationBadge(dvals) || 'aucune en cours') + ' · une validation n’est pas un go'));
    for (const i of dvals.items) {
      const l = el('div', 'tw val' + (i.withdrawn ? ' wd' : i.decision === 'refuse' || i.state === 'non-qualifiee' ? ' ref' : i.state === 'tranchee' ? '' : ' pre'), validationLine(i, data.now));
      l.append(el('div', 'tx', i.question));
      if (i.reserve) l.append(el('div', 'tx', 'Réserve : ' + i.reserve));
      if (i.quote) l.append(el('div', 'tx q', '« ' + i.quote + ' »'));
      box.append(l);
    }
    head.append(box);
  }
  if (it.kind === 'open') head.append(gitBlock(it));
  if (it.headless) {
    head.append(el('div', 'banner', 'Automate sans terminal : ce claude -p a été lancé par un script (' + (it.entrypoint || 'sdk') + '), par exemple le diagnostic automatique. Il n’a ni onglet, ni écran, et ne lit pas de réponse : il se pilote depuis son lanceur. On voit ici son avancement (derniers prompts, dernier message, git).'));
    const fa = el('div', 'actions'); const bf = el('button', null, it.fav ? '★ Favori' : '☆ Favori'); bf.onclick = () => toggleFav(it); fa.append(bf); head.append(fa);
    return renderPromptsOnly(it);
  }
  const actions = el('div', 'actions');
  const b1 = el('button', 'primary' + (it.kind === 'open' ? ' act-focus' : ''), it.kind === 'open' ? 'Afficher l\'onglet' : 'Rouvrir dans un nouvel onglet'); b1.onclick = () => primary(it);
  const b2 = el('button', null, 'Copier la commande de reprise'); b2.title = resumeCmd(it); b2.onclick = () => copyCmd(it);
  const bf = el('button', null, it.fav ? '★ Favori' : '☆ Favori'); bf.title = (it.fav ? 'Retirer des favoris' : 'Mettre en favori') + '  ( f )'; if (it.fav) bf.style.color = 'var(--fav)'; bf.onclick = () => toggleFav(it);
  actions.append(b1, b2, bf);
  const bk = el('button', null, '⑂ Nouvelle session à partir de celle-ci'); bk.title = 'Ouvre une NOUVELLE session qui reprend toute cette conversation (claude --resume … --fork-session) ; celle-ci n’est pas touchée  ( d )';
  bk.onclick = () => openNew({ sessionId: it.sessionId, title: it.title, cwd: it.cwd, tags: it.tags }); actions.append(bk);
  if (it.kind === 'closed') {
    const bh = el('button', null, it.hidden ? 'Ré-afficher dans la liste' : 'Masquer');
    bh.title = it.hidden ? 'La remet dans « Fermées, reprenables »  ( x )' : 'La retire de la liste ; la recherche la retrouve, le transcript est intact  ( x )';
    bh.onclick = () => setHidden([it], !it.hidden); actions.append(bh);
  }
  if (it.kind === 'open') { const bx = el('button', null, '✕ Fermer la session'); bx.title = 'Quitte la session (/exit) ; la conversation reste reprenable  ( x )'; bx.onclick = () => closeSession(it); actions.append(bx); }
  // Toujours proposé (pas seulement quand l'onglet est introuvable) : fermer puis rouvrir en un seul geste.
  if (it.kind === 'open' && !it.headless) {
    const b3 = el('button', noTab.has(it.key) ? 'primary' : null, '↻ Fermer et rouvrir'); b3.disabled = it.status !== 'idle';
    b3.title = it.status === 'idle' ? 'Ferme la session (/exit) et la reprend aussitôt dans un nouvel onglet (claude --resume) ; la conversation est conservée' : 'Possible seulement quand la session est inactive';
    b3.onclick = () => relaunch(it); actions.append(b3);
  }
  head.append(actions);
  if (it.kind === 'closed') head.append(el('div', 'banner', 'Session fermée : son terminal n’existe plus. Tu peux la rouvrir dans un nouvel onglet (la conversation reprend où elle s’était arrêtée)' + (it.hidden ? ', ou la ré-afficher dans la liste — elle est masquée.' : ', ou la masquer si tu n’en as plus besoin.')));
  const inp = $('sendtext');
  if (inp) {
    // Au travail : l'invite de Claude Code reste vide et active — le message y est tapé et Claude Code le met EN FILE,
    // comme s'il avait été tapé dans le terminal pendant le tour.
    const queue = it.status === 'busy', can = it.status === 'idle' || it.status === 'shell' || queue;
    inp.disabled = $('sendbtn').disabled = !can || sending;
    $('sendbtn').textContent = queue ? 'Mettre en file' : 'Envoyer';
    inp.placeholder = queue ? 'La session travaille : ton message sera mis en file  ( r )  — Entrée pour l’ajouter · Maj+Entrée : à la ligne'
      : can ? (suggestKey === it.key && suggestion ? 'Tab : reprendre la proposition ci-dessus · ' : '') + 'Répondre à cette session…  ( r )  — Entrée pour envoyer · Maj+Entrée : à la ligne'
      : 'Réponse impossible : la session ' + (it.status === 'waiting' ? 'attend la réponse à un dialogue — utilise le panneau « Dialogue en attente » ou son onglet' : 'n’a pas d’invite libre');
    $('sendhint').textContent = queue ? 'Tapé dans l’invite de la session pendant qu’elle travaille : Claude Code le met en file et le prend dès qu’il peut (comme dans le terminal). Seulement si son invite est vide — les retours à la ligne y deviennent des espaces.'
      : can ? 'Tapé dans le terminal de la session, seulement si son invite est vide — les retours à la ligne y deviennent des espaces.' : '';
  }
  renderPromptsOnly(it);
}
function renderPromptsOnly(it) {
  const pr = $('prompts'); if (!pr) return; const sig = JSON.stringify([it.prompts || [], it.queued || []]);
  if (pr.dataset.sig !== sig) {
    pr.dataset.sig = sig; pr.replaceChildren();
    const ps = (it.prompts || []).slice().reverse();
    // Messages en file (tapés pendant qu'elle travaille) : pas encore dans l'historique, Claude Code les prendra au tour suivant.
    for (const q of (it.queued || []).slice().reverse()) {
      const d = el('div', 'prompt queued'), w = el('div', 'when'); w.append(el('span', 'tag', 'en file'), ' ' + (q.at ? new Date(q.at).toLocaleString('fr-FR') : ''));
      d.title = 'Mis en file pendant que la session travaille : Claude Code le prendra dès qu’il peut'; d.append(w, el('div', null, q.text)); pr.append(d);
    }
    if (!ps.length && !(it.queued || []).length) pr.append(el('div', 'empty', it.headless ? 'Un automate reçoit ses consignes par son lanceur : rien dans l’historique des prompts.' : 'Aucun prompt récent dans l\'historique.'));
    for (const p of ps) { const d = el('div', 'prompt'); d.append(el('div', 'when', new Date(p.at).toLocaleString('fr-FR')), el('div', null, p.text)); pr.append(d); }
  }
}

function renderOverview() {
  const head = $('head'), body = $('body'); const items = allItems().filter(it => !it.hidden);
  head.className = ''; head.replaceChildren(el('div', 'dtitle', 'Vue d\'ensemble'));
  const tiles = el('div', 'tiles');
  for (const st of ['waiting', 'ask', 'done', 'busy', 'shell', 'idle', 'auto', 'closed']) {
    const t = el('div', 'tile ' + st); t.append(el('b', null, items.filter(it => it.state === st).length), el('span', null, LABEL[st])); tiles.append(t);
  }
  head.append(tiles);
  const cl = allItems().filter(closable);
  const nsig = idleSig() + '/' + restartSig() + '/' + data.restarts.length + ':' + (data.restarts.length ? data.restarts[data.restarts.length - 1].at : 0) + '/' + data.notifs.length + '/' + (data.notifs.length ? data.notifs[data.notifs.length - 1].at : 0) + '/' + (data.reboot ? data.reboot.sessions.map(s => s.sessionId).join(',') : '') + '/' + cl.map(it => it.key).join(',')
    + '/' + (data.quota || []).map(q => q.alias + ':' + q.weeklyPct + ':' + q.measuredAt + ':' + q.status).join(',') + '/' + Math.floor(Date.now() / 60000) + '/' + (autoData ? autoData.now : '');
  if (body.dataset.sig === 'overview' && body.dataset.n === nsig) return;
  body.dataset.sig = 'overview'; body.dataset.n = nsig; body.replaceChildren();
  const rp = rebootPanel(); if (rp) body.append(rp);
  const qs = quotaSection(); if (qs) body.append(el('h2', null, 'Quota Claude de la semaine'), qs);
  const sp = restartPanel(); if (sp) body.append(sp);
  const as = automationSection(); if (as) body.append(el('h2', null, 'Automates du poste'), as);
  if (cl.length) {
    body.append(el('h2', null, 'Peuvent se fermer — ' + cl.length));
    const act = el('div', 'actions');
    const bc = el('button', 'primary', 'Fermer la sélection…'); bc.title = 'Ferme les sessions cochées (/exit) ; elles restent reprenables depuis « Fermées »'; bc.onclick = () => closeMany(cl.filter(it => closePick.get(it.key) !== false));
    const bt = el('button', null, 'Tout cocher / décocher'); bt.onclick = () => { const all = cl.every(it => closePick.get(it.key) !== false); cl.forEach(it => closePick.set(it.key, !all)); renderDetail(true); };
    act.append(bc, bt); body.append(act);
    const box = el('div', 'notifs');
    for (const it of cl) { const d = el('div', 'notif done pick');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = closePick.get(it.key) !== false; cb.onclick = e => e.stopPropagation(); cb.onchange = () => closePick.set(it.key, cb.checked);
      d.append(cb, el('span', 'when', it.git.worktree ? it.git.top.split('\\').pop() : 'sans worktree'), el('span', 'nt', label(it)), el('span', 'nx', (prMerged(it) ? 'PR #' + it.pr + ' mergée' : 'branche intégrée à master') + (it.git.worktree ? ', rien à commiter ni à pousser' : ''))); d.title = 'Sélectionner la session'; d.onclick = () => select(it.key, true); box.append(d); }
    body.append(box);
  }
  const ip = idlePanel(); if (ip) body.append(ip);
  body.append(el('h2', null, 'Notifications récentes'));
  if (!data.notifs.length) body.append(el('div', 'empty', 'Aucune notification envoyée pour l\'instant.'));
  else {
    const box = el('div', 'notifs');
    for (const nf of data.notifs.slice().reverse().slice(0, 30)) {
      const d = el('div', 'notif ' + (nf.kind === 'waiting' || nf.kind === 'automation' ? 'waiting' : nf.kind === 'launcher' ? 'ask' : 'done'));
      d.append(el('span', 'dot'), el('span', 'when', new Date(nf.at).toLocaleString('fr-FR')), el('span', 'nt', (nf.kind === 'launcher' ? '🤖 ' : '') + nf.title), el('span', 'nx', nf.text));
      d.title = nf.pass ? 'Ouvrir cette passe' : nf.hd ? 'Ouvrir le dernier run de HD-' + nf.hd : nf.kind === 'launcher' ? 'Ouvrir la vue Lanceur' : 'Sélectionner la session';
      d.onclick = () => { if (nf.pass) openPass(nf.pass); else if (nf.hd) openRun(nf.hd); else if (nf.kind === 'launcher') openLauncher(); else if (byKey(nf.sessionId)) select(nf.sessionId, true); else say('cette session n\'est plus listée'); };
      box.append(d);
    }
    body.append(box);
  }
  body.append(el('h2', null, 'Raccourcis clavier'));
  const keys = el('div', 'keys');
  for (const [k, d] of [['/', 'rechercher (titre, prompt, numéro de PR, dossier, identifiant)'], ['↑ ↓', 'parcourir les sessions'], ['Entrée', 'afficher l\'onglet de la session (ou rouvrir une session fermée)'],
                        ['n', 'aller à la prochaine session à traiter et afficher son onglet'], ['r', 'répondre à la session sélectionnée (Entrée envoie)'], ['p', 'reprendre la proposition de prompt de Claude Code dans la zone de réponse (Entrée l’envoie) — aussi Tab dans la zone vide'],['f', 'mettre la session en favori, ou la retirer (★ à côté de la recherche : favoris seulement)'], ['c', 'copier la commande de reprise'], ['1 – 9', 'session bloquée sur un dialogue : choisir l’option correspondante (tapée dans son terminal)'], ['+', 'lancer une nouvelle session (dossier, premier message, modèle)'], ['d', 'nouvelle session à partir de la session sélectionnée : elle reprend toute sa conversation (fork), l’originale n’est pas touchée'],['h', 'basculer entre l’écran du terminal et la conversation complète (tout l’historique, relu dans le transcript)'], ['b', 'revenir à la session consultée juste avant (liste « Consultées récemment » en tête)'], ['x', 'fermer la session sélectionnée (avec confirmation ; elle reste reprenable) — sur une session déjà fermée : la masquer / ré-afficher'], ['Échap', 'vider la recherche, puis revenir à cette vue']]) {
    const kk = el('span'); k.split(' ').forEach((x, i) => { if (i) kk.append(' '); kk.append(el('kbd', null, x)); }); keys.append(kk, el('span', null, d));
  }
  body.append(keys);
  body.append(el('h2', null, 'Dernières relances'));
  if (!data.restarts.length) body.append(el('div', 'empty', 'Aucune relance enregistrée.'));
  else {
    const w = el('div', 'tablewrap'), t = el('table'), hr = el('tr'); ['Quand', 'Session', 'Résultat'].forEach(h => hr.append(el('th', null, h))); t.append(hr);
    for (const r of data.restarts.slice().reverse()) { const tr = el('tr');
      tr.append(el('td', null, new Date(r.at).toLocaleString('fr-FR')), el('td', null, r.name + ' (' + r.sessionId.slice(0, 8) + ')'), el('td', r.code === 0 ? 'ok' : 'ko', r.result)); t.append(tr); }
    w.append(t); body.append(w);
  }
}

// ── Dialogues ──
// Une session qui ATTEND affiche un dialogue dans son terminal : question à choix (AskUserQuestion), demande de
// permission, menu. On le lit sur l'écran (options « N. libellé » au-dessus du pied « Enter to select · Esc to
// cancel ») et on propose de cliquer l'option : la page tape son chiffre dans la console. Le clavier ci-dessous
// couvre le reste (cases à cocher, onglets de questions, « Submit »), l'écran du terminal montre le résultat.
const SEP = /^[─━═-]{8,}$/;
function parseDialog(text) {
  const L = text.split('\n').map(s => s.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, ''));
  let end = L.length;
  for (let i = L.length - 1; i >= Math.max(0, L.length - 14); i--) if (/enter to (select|confirm|submit)|esc to (cancel|exit|go back)|to navigate/i.test(L[i])) { end = i; break; }
  const opts = []; let first = -1, submit = false;
  for (let i = Math.max(0, end - 45); i < end; i++) {
    const m = L[i].match(/^\s*(❯\s*)?(\d{1,2})\.\s+(.*\S)\s*$/);
    if (m) {
      const num = +m[2];
      if (num === 1) { opts.length = 0; first = i; }
      if (num === opts.length + 1) { opts.push({ num, label: m[3], sel: !!m[1], expect: m[2] + '. ' + m[3], desc: [] }); continue; }
    }
    const t = L[i].trim();
    if (opts.length && t === 'Submit') { submit = true; continue; }   // ligne « Submit » d'un choix multiple
    if (opts.length && t && !SEP.test(t) && /^\s{3,}/.test(L[i])) opts[opts.length - 1].desc.push(t);
  }
  if (!opts.length) return null;
  const q = []; let tabs = null;
  for (let i = first - 1, n = 0; i >= 0 && n < 14; i--, n++) {
    const t = L[i].trim();
    if (SEP.test(t)) break;
    if (!t) continue;
    if (/[☐☒✔]/.test(t) && /submit|→|←/i.test(t)) { tabs = t; break; }
    q.unshift(t); if (q.length >= 8) break;
  }
  return { opts, q: q.join('\n'), tabs, submit, multi: opts.some(o => /^\[[ ✔xX]\]/.test(o.label)), foot: end < L.length ? L[end].trim() : '' };
}
function renderStuckPrompt(it, box, draft) {
  const sig = 'stuck:' + draft;
  if (sig === lastDialogSig && box.dataset.pid === String(it.pid)) return;
  lastDialogSig = sig; box.dataset.pid = it.pid; box.replaceChildren();
  const expect = draft.split('\n').map(s => s.trim()).find(Boolean) || '';
  box.append(el('h2', null, 'Invite occupée — un texte y est resté'));
  const c = el('div', 'dlg');
  c.append(el('div', 'q', draft));
  const row = el('div', 'row');
  const go = el('button', 'primary', 'Envoyer ce texte'); go.title = 'Appuie sur Entrée dans le terminal de la session : le texte resté dans l’invite part tel quel';
  go.onclick = () => sendKeys(it, [{ k: 'Enter' }], expect, 'texte de l’invite envoyé');
  const clr = el('button', null, 'Vider l’invite'); clr.title = 'Appuie deux fois sur Échap dans le terminal de la session : le texte est effacé, rien n’est envoyé';
  clr.onclick = () => sendKeys(it, [{ k: 'Esc' }, { k: 'Esc' }], expect, 'invite vidée');
  row.append(go, clr); c.append(row);
  c.append(el('div', 'hint', 'Tant que ce texte est dans l’invite, aucun message ne peut être envoyé à la session. Envoie-le ou vide l’invite ; le texte est revérifié à l’écran juste avant.'));
  box.append(c);
}
let keying = false, lastDialogSig = null;
async function sendKeys(it, keys, expect, what) {
  if (keying) return; keying = true; document.querySelectorAll('#dialog button').forEach(b => b.disabled = true);
  try {
    const r = await (await fetch('/api/keys?pid=' + it.pid, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ keys, expect }) })).json();
    say(r.error ? 'non envoyé : ' + r.error : (what || 'touche envoyée') + ' — « ' + label(it) + ' »');
  } catch { say('échec de la demande'); }
  keying = false; lastDialogSig = null; setTimeout(refreshScreen, 350); setTimeout(refreshScreen, 1200);
}
// Session INACTIVE : deux blocages se lèvent aussi d'ici. Un DIALOGUE ouvert hors attente (plus d'invite à l'écran,
// pied « Enter to select · Esc to cancel » présent) ; une INVITE OCCUPÉE — un texte y est resté (brouillon tapé dans
// le terminal, message tapé mais jamais parti, menu « / ») et tout envoi est refusé tant qu'il y est. `draft` vient de
// /api/screen : null = pas d'invite à l'écran, '' = invite libre, sinon le texte resté.
function renderDialog(it, text, draft) {
  const box = $('dialog'); if (!box) return;
  const free = it.status === 'idle' || it.status === 'shell';
  let d = it.status === 'waiting' ? parseDialog(text) : null;
  if (!d && free && draft == null) { const x = parseDialog(text); if (x && x.foot) d = x; }
  const stuck = !d && free && draft ? draft : null;
  if (stuck) { renderStuckPrompt(it, box, stuck); return; }
  const sig = d ? JSON.stringify(d) : '';
  if (sig === lastDialogSig && box.dataset.pid === String(it.pid)) return;
  // Ne pas écraser une saisie en cours dans le panneau.
  const act = document.activeElement; if (act && (act.tagName === 'INPUT' || act.tagName === 'TEXTAREA') && box.contains(act) && act.value) return;
  lastDialogSig = sig; box.dataset.pid = it.pid; box.replaceChildren();
  if (!d) return;
  box.append(el('h2', null, 'Dialogue en attente — réponds ici'));
  const c = el('div', 'dlg');
  if (d.tabs) c.append(el('div', 'tabs', d.tabs));
  if (d.q) c.append(el('div', 'q', d.q));
  const os = el('div', 'opts'); let other = null;
  for (const o of d.opts) {
    const b = el('button', 'opt' + (o.sel ? ' sel' : '')); b.append(el('span', 'n', o.num + '.'), el('span', null, o.label));
    if (o.desc.length) b.append(el('span', 'd', o.desc.join(' ')));
    b.title = 'Tape « ' + o.num + ' » dans le terminal  ( touche ' + o.num + ' )';
    if (!d.multi && /^(type something|other|autre)/i.test(o.label)) other = o;
    b.onclick = () => sendKeys(it, [{ t: String(o.num) }], o.expect, 'option ' + o.num + ' « ' + o.label + ' »');
    os.append(b);
  }
  c.append(os);
  // Choix multiple : le chiffre coche / décoche ; « Submit » se valide à part. Avec plusieurs questions, → mène à
  // l'onglet Submit (récapitulatif) ; sinon on descend du curseur jusqu'à la ligne Submit puis Entrée.
  if (d.multi && d.submit) {
    const cur = Math.max(0, d.opts.findIndex(o => o.sel)), last = d.opts.map(o => /^\[[ ✔xX]\]/.test(o.label)).lastIndexOf(true);
    const keys = d.tabs ? [{ k: 'Right' }] : Array.from({ length: last - cur + 1 }, () => ({ k: 'Down' })).concat([{ k: 'Enter' }]);
    const row = el('div', 'row'); const b = el('button', 'primary', d.tabs ? 'Valider la sélection → question suivante' : 'Valider la sélection');
    b.title = 'Le chiffre d’une option la coche ou la décoche ; ce bouton valide les cases cochées';
    b.onclick = () => sendKeys(it, keys, d.opts[cur].expect, 'sélection validée'); row.append(b); c.append(row);
  }
  if (other) {
    const row = el('div', 'row'); const inp = promptArea('dlgother'); inp.placeholder = 'Ta réponse libre (option ' + other.num + ')… — Entrée pour envoyer · Maj+Entrée : à la ligne'; inp.maxLength = 4000;
    const go = el('button', 'primary', 'Envoyer la réponse libre');
    const fire = () => { const v = inp.value.trim(); if (!v) return; inp.value = ''; growArea(inp); inp.blur(); sendKeys(it, [{ t: String(other.num) }, { t: v }, { k: 'Enter' }], other.expect, 'réponse libre'); };
    go.onclick = fire; inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(); } else if (e.key === 'Escape') inp.blur(); };
    row.append(inp, go); c.append(row);
  }
  const kr = el('div', 'row keys');
  for (const [k, t, h] of [['Up', '↑', 'Monter'], ['Down', '↓', 'Descendre'], ['Space', 'Espace', 'Cocher / décocher (choix multiple)'], ['Enter', 'Entrée', 'Valider'], ['Left', '←', 'Question précédente'], ['Right', '→', 'Question suivante / Submit'], ['Tab', 'Tab', 'Champ suivant'], ['Esc', 'Échap', 'Annuler le dialogue']]) {
    // Hors attente, le serveur n'accepte une touche qu'avec un texte à retrouver à l'écran : la première option.
    const b = el('button', null, t); b.title = h; b.onclick = () => sendKeys(it, [{ k }], it.status === 'waiting' ? null : d.opts[0].expect, t); kr.append(b);
  }
  c.append(kr);
  c.append(el('div', 'hint', (d.foot ? 'Dans le terminal : ' + d.foot + '. ' : '') + 'Chaque clic est tapé dans le terminal de la session ; l’option visée est revérifiée à l’écran juste avant. Touches 1 à 9 : choisir une option.'));
  box.append(c);
}

// ───────────── Conversation complète : le transcript de la session (/api/transcript) ─────────────
// Le terminal ne garde que son tampon : pour relire le début d'une longue session, on lit son transcript .jsonl.
// Chargé par tranches depuis la fin (« plus ancien » remonte), puis suivi à chaque passe pour une session ouverte.
let conv = null;   // { key, id, items, start, end, more, busy, err } — celle de la session affichée
const convTools = () => localStorage.getItem('cc.convtools') !== '0';
// Sans choix mémorisé : la conversation sur téléphone (l'écran du terminal y est peu lisible), l'écran ailleurs.
const convView = () => { const v = localStorage.getItem('cc.view'); return v === 'conv' || v === 'screen' ? v : NARROW.matches ? 'conv' : 'screen'; };
// Écran étroit : les filets du terminal (─── sur toute la largeur) replieraient en plusieurs lignes : raccourcis.
const screenText = t => NARROW.matches ? t.replace(/[─━═▔▁]{24,}/g, m => m.slice(0, 24)) : t;
function convPane() {
  const w = el('div', 'conv'); w.id = 'conv';
  const bar = el('div', 'convbar');
  const lb = el('label'), cb = el('input'); cb.type = 'checkbox'; cb.checked = convTools();
  cb.onchange = () => { localStorage.setItem('cc.convtools', cb.checked ? '1' : '0'); drawConv(); };
  lb.append(cb, ' outils et résultats');
  const end = el('button', 'quick', '↓ fin'); end.title = 'Aller au dernier message'; end.onclick = () => { const l = $('convlist'); if (l) l.scrollTop = l.scrollHeight; };
  const st = el('span', 'meta'); st.id = 'convstat';
  bar.append(lb, end, st);
  const list = el('div', 'convlist', '…'); list.id = 'convlist';
  w.append(bar, list); return w;
}
function setConvView(v) {
  localStorage.setItem('cc.view', v);
  const it = selected && byKey(selected); if (it) applyConvView(it);
}
function applyConvView(it) {
  const pre = $('screen'), w = $('conv'); if (!w) return;
  const v = pre ? convView() : 'conv';
  if (pre) pre.hidden = v !== 'screen';
  w.hidden = v !== 'conv';
  document.querySelectorAll('.viewtabs .vtab').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'conv') loadConv(it, 'init');
}
async function loadConv(it, mode) {
  if (!$('convlist') || !it || !it.sessionId) return;
  if (!conv || conv.key !== it.key || conv.id !== it.sessionId) conv = { key: it.key, id: it.sessionId, items: [], start: null, end: null, more: false, busy: false, err: null };
  const c = conv;
  if (mode === 'init' && c.end != null) { drawConv(true); return; }      // déjà chargée : on revient dessus
  if (mode === 'more' && c.end == null) mode = 'init';
  if (c.busy) return; c.busy = true;
  try {
    const url = '/api/transcript?id=' + encodeURIComponent(c.id) + (mode === 'older' ? '&before=' + c.start : mode === 'more' ? '&after=' + c.end : '');
    const res = await fetch(url, { cache:'no-store' }); const r = await res.json();
    if (conv !== c) return;
    if (!res.ok) { c.err = r.error || ('erreur ' + res.status); drawConv(); return; }
    c.err = null;
    if (r.reset) { c.items = []; c.start = c.end = null; return; }          // transcript réécrit ou trop de retard : rechargé à la passe suivante
    if (mode === 'older') { c.items = r.items.concat(c.items); c.start = r.start; c.more = r.start > 0; drawConv(false, true); }
    else if (mode === 'more') { c.end = r.end; if (r.items.length) { c.items = c.items.concat(r.items); drawConv(); } }
    else { c.items = r.items; c.start = r.start; c.end = r.end; c.more = r.start > 0; drawConv(true); }
  } catch { if (conv === c) { c.err = 'transcript illisible (serveur injoignable ?)'; drawConv(); } }
  finally { c.busy = false; }
}
const convWhen = at => {
  const d = new Date(at); if (isNaN(d)) return '';
  const hm = d.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' }) + ' ' + hm;
};
// ── Markdown des messages de Claude ──
// Les réponses de Claude sont écrites en markdown : affichées en texte brut, on lisait des ** et des ` partout.
// Analyse PURE (texte -> arbre, testée sous node par sessions-dashboard-tests.ps1), puis construction DOM par
// createElement/textContent : jamais d'innerHTML, un transcript ne peut donc pas injecter de HTML. Liens : http(s) seuls.
// Sous-ensemble utile : titres, paragraphes, listes (puces, numérotées, imbriquées), citations, blocs de code,
// tableaux, filets ; en ligne : gras, italique, barré, code, liens [texte](url) et URL nues.
function mdInline(s) {
  const out = []; let buf = '', i = 0, m;
  const flush = () => { if (buf) { out.push({ k:'t', t:buf }); buf = ''; } };
  while (i < s.length) {
    const r = s.slice(i), c = r[0];
    if (c === '\\' && /^[\\`*_[\]~#>|()-]$/.test(r[1] || '')) { buf += r[1]; i += 2; continue; }
    if (c === '`' && (m = /^(`+)(?!`)([\s\S]*?[^`])\1(?!`)/.exec(r))) { flush(); out.push({ k:'code', t:m[2].replace(/^ ([\s\S]*) $/, '$1') }); i += m[0].length; continue; }
    if (c === '*' && (m = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(r))) { flush(); out.push({ k:'b', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '_' && !/\w$/.test(buf) && (m = /^__(?=\S)([\s\S]*?\S)__(?!\w)/.exec(r))) { flush(); out.push({ k:'b', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '~' && (m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(r))) { flush(); out.push({ k:'s', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '*' && (m = /^\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/.exec(r))) { flush(); out.push({ k:'i', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '_' && !/\w$/.test(buf) && (m = /^_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/.exec(r))) { flush(); out.push({ k:'i', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '[' && (m = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(r))) { flush(); out.push({ k:'a', href:m[2], c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === 'h' && !/\w$/.test(buf) && (m = /^https?:\/\/[^\s<>()`"]+/.exec(r))) {
      const url = m[0].replace(/[.,;:!?'»*]+$/, ''); flush(); out.push({ k:'a', href:url, c:[{ k:'t', t:url }] }); i += url.length; continue;
    }
    buf += c; i++;
  }
  flush(); return out;
}
function mdBlocks(text) {
  const L = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n'), out = []; let i = 0, m;
  const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/, HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/, HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const LI = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/, QUOTE = /^\s{0,3}>/;
  const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const isTable = j => L[j].includes('|') && j + 1 < L.length && SEP.test(L[j + 1]) && L[j + 1].includes('-');
  const cells = l => l.trim().replace(/^\|/, '').replace(/(^|[^\\])\|$/, '$1').split(/(?<!\\)\|/).map(x => mdInline(x.trim().replace(/\\\|/g, '|')));
  const starts = j => FENCE.test(L[j]) || HEAD.test(L[j]) || HR.test(L[j]) || LI.test(L[j]) || QUOTE.test(L[j]) || isTable(j);
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    if ((m = FENCE.exec(l))) {
      const fence = m[1], body = []; i++;
      while (i < L.length && !L[i].trim().startsWith(fence)) body.push(L[i++]);
      i++; out.push({ k:'code', lang:m[2], t:body.join('\n') }); continue;
    }
    if ((m = HEAD.exec(l))) { out.push({ k:'h', lv:m[1].length, in:mdInline(m[2]) }); i++; continue; }
    if (HR.test(l)) { out.push({ k:'hr' }); i++; continue; }
    if (isTable(i)) {
      const head = cells(l), rows = []; i += 2;
      while (i < L.length && L[i].trim() && L[i].includes('|')) rows.push(cells(L[i++]));
      out.push({ k:'table', head, rows }); continue;
    }
    if (QUOTE.test(l)) {
      const q = []; while (i < L.length && QUOTE.test(L[i])) q.push(L[i++].replace(/^\s{0,3}> ?/, ''));
      out.push({ k:'quote', c:mdBlocks(q.join('\n')) }); continue;
    }
    if (LI.test(l)) {
      const items = [], base = LI.exec(l)[1].length;
      while (i < L.length) {
        const x = LI.exec(L[i]);
        if (x) { items.push({ lv:Math.max(0, Math.floor((x[1].replace(/\t/g, '    ').length - base) / 2)), o:/\d/.test(x[2]) ? parseInt(x[2], 10) : null, t:x[3] }); i++; }
        else if (items.length && L[i].trim() && /^\s+\S/.test(L[i]) && !starts(i)) { items[items.length - 1].t += '\n' + L[i].trim(); i++; }
        else break;
      }
      out.push({ k:'list', items:items.map(x => ({ lv:Math.min(x.lv, 6), o:x.o, in:mdInline(x.t) })) }); continue;
    }
    const p = [l]; i++;
    while (i < L.length && L[i].trim() && !starts(i)) p.push(L[i++]);
    out.push({ k:'p', in:mdInline(p.join('\n')) });
  }
  return out;
}
// ── fin de l'analyse markdown ──
function mdInlineNodes(parent, toks) {
  for (const t of toks) {
    if (t.k === 't') parent.append(t.t);
    else if (t.k === 'code') parent.append(el('code', null, t.t));
    else if (t.k === 'a') { const a = el('a'); a.href = t.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = t.href; parent.append(mdInlineNodes(a, t.c)); }
    else parent.append(mdInlineNodes(el(t.k === 'b' ? 'strong' : t.k === 'i' ? 'em' : 'del'), t.c));
  }
  return parent;
}
function mdBlockNode(b) {
  switch (b.k) {
    case 'h': return mdInlineNodes(el('div', 'mdh mdh' + b.lv), b.in);
    case 'hr': return el('hr');
    case 'code': { const pre = el('pre', 'mdcode'); pre.append(el('code', null, b.t)); return pre; }
    case 'quote': { const q = el('blockquote'); for (const x of b.c) q.append(mdBlockNode(x)); return q; }
    case 'list': {
      const w = el('div', 'mdlist');
      for (const it of b.items) {
        const li = el('div', 'mdli'); li.style.marginLeft = (it.lv * 1.2) + 'em';
        li.append(el('span', 'mdmark', it.o != null ? it.o + '.' : it.lv ? '◦' : '•'), mdInlineNodes(el('span', 'mdlitx'), it.in));
        w.append(li);
      }
      return w;
    }
    case 'table': {
      const wrap = el('div', 'mdtable'), tb = el('table'), hr = el('tr');
      for (const c of b.head) hr.append(mdInlineNodes(el('th'), c));
      tb.append(hr);
      for (const r of b.rows) { const tr = el('tr'); for (const c of r) tr.append(mdInlineNodes(el('td'), c)); tb.append(tr); }
      wrap.append(tb); return wrap;
    }
    default: return mdInlineNodes(el('p'), b.in);
  }
}
// Arbre gardé sur le message : drawConv redessine toute la liste à chaque passe.
function mdRender(m) {
  const root = el('div', 'tx md');
  try { for (const b of (m.md || (m.md = mdBlocks(m.t)))) root.append(mdBlockNode(b)); }
  catch (e) { console.log('[sessions] markdown :', e); root.className = 'tx'; root.textContent = m.t; }
  return root;
}
function convItem(m) {
  if (m.r === 'tool') {
    const d = el('div', 'cm tool'); const lines = m.t.split('\n');
    d.append(el('span', 'tn', '⚙ ' + m.n), el('span', 'tx', ' ' + lines[0])); if (lines.length > 1) d.title = m.t;
    return d;
  }
  if (m.r === 'result' || m.r === 'summary') {
    const d = el('details', 'cm ' + (m.r === 'summary' ? 'sum' : 'res') + (m.e ? ' err' : ''));
    const first = (m.t.split('\n').find(l => l.trim()) || '(vide)').trim();
    d.append(el('summary', null, (m.r === 'summary' ? '📋 Résumé de compactage — ' : (m.e ? '✗ ' : '↳ ')) + (first.length > 160 ? first.slice(0, 160) + '…' : first)), el('pre', null, m.t));
    return d;
  }
  const d = el('div', 'cm ' + m.r);
  d.append(el('div', 'who', (m.r === 'user' ? 'Toi' : 'Claude') + (m.at ? ' · ' + convWhen(m.at) : '')), m.r === 'assistant' ? mdRender(m) : el('div', 'tx', m.t));
  return d;
}
function drawConv(toBottom, keepTop) {
  const list = $('convlist'), c = conv; if (!list || !c) return;
  if (String(getSelection()) && list.contains(getSelection().anchorNode) && !toBottom && !keepTop) return;   // ne pas casser une sélection en cours
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60, oldH = list.scrollHeight, oldTop = list.scrollTop;
  const tools = convTools(), shown = c.items.filter(m => tools || (m.r !== 'tool' && m.r !== 'result'));
  const frag = document.createDocumentFragment();
  if (c.more) { const b = el('button', 'quick older', '↑ charger plus ancien'); b.onclick = () => { const it = byKey(c.key); if (it) loadConv(it, 'older'); }; frag.append(b); }
  else if (c.end != null) frag.append(el('div', 'meta convtop', '— début de la conversation —'));
  if (c.err) frag.append(el('div', 'empty', c.err));
  else if (c.end != null && !shown.length) frag.append(el('div', 'empty', c.more ? 'Rien à afficher dans ce dernier morceau du transcript : charge plus ancien.' : 'Aucun message.'));
  for (const m of shown) frag.append(convItem(m));
  list.replaceChildren(frag);
  const st = $('convstat'); if (st) st.textContent = c.end == null ? '' : plural(shown.length, 'message', 'messages') + (c.more ? ' · transcript lu depuis ' + Math.round((c.end - c.start) / 1024).toLocaleString('fr-FR') + ' Ko de la fin' : ' · conversation entière');
  if (toBottom || (atBottom && !keepTop)) list.scrollTop = list.scrollHeight;
  else if (keepTop) list.scrollTop = oldTop + (list.scrollHeight - oldH);
}
function refreshConv() {
  const it = pickRun(selected && byKey(selected)), w = $('conv');
  if (it && w && !w.hidden && (it.kind === 'open' || (it.kind === 'run' && it.run.running) || (it.kind === 'pass' && it.running)) && conv && conv.key === it.key && conv.id === it.sessionId && conv.end != null) loadConv(it, 'more');
}

async function refreshScreen() {
  const it = selected && byKey(selected); const pre = $('screen');
  if (!it || it.kind !== 'open' || !pre) return;
  try {
    const r = await (await fetch('/api/screen?pid=' + it.pid, { cache:'no-store' })).json();
    if (selected !== it.key) return;
    const text = r.text == null ? '(écran illisible : la session n\'est pas dans une console accessible)' : r.text;
    if (text !== lastScreen && !String(getSelection())) { lastScreen = text; pre.textContent = screenText(text); pre.scrollTop = pre.scrollHeight; }
    renderDialog(it, r.text || '', r.draft);
    renderSuggest(it, r.suggestion || null);
  } catch {}
}

async function loadClosed() { try { closedData = await (await fetch('/api/closed', { cache:'no-store' })).json(); if (data) { renderList(); renderDetail(); } } catch {} }
// ───── Lien avec le serveur : coupure, reconnexion, redémarrage ─────
// Le serveur annonce dans /api/state l'identifiant de SON démarrage (boot) et l'empreinte des fichiers de la page
// (page). Coupure ⇒ bandeau « reconnexion en cours », actions suspendues, la lecture continue toutes les 2 s.
// Retour ⇒ démarrage différent : resynchronisation complète ; page différente : rechargement (différé si une
// saisie est en cours, pour ne rien perdre).
function typing() {
  const a = document.activeElement, t = $('sendtext');
  return !!((t && t.value.trim()) || newMode || bcMode || (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'search')) && a.value));
}
function drawLink() {
  const b = $('offline'); if (!b) return;
  document.body.classList.toggle('offline', !!link.down);
  if (link.down) {
    const s = Math.round((Date.now() - link.down.since) / 1000);
    b.className = 'down'; b.hidden = false;
    b.replaceChildren(el('b', null, '⟳ Serveur injoignable — reconnexion en cours…'),
      el('span', null, ' depuis ' + (s < 90 ? s + ' s' : Math.round(s / 60) + ' min') + ' · la page reprend seule dès qu’il répond ; les actions sont suspendues'
        + (s >= 120 ? ' · toujours rien : le serveur a-t-il été relancé ?' : '') + (link.down.why ? ' (' + link.down.why + ')' : '')));
  } else if (link.reload) {
    const go = el('button', null, 'Recharger');
    go.onclick = () => location.reload();
    b.className = 'reload'; b.hidden = false;
    b.replaceChildren(el('b', null, '↻ Serveur redémarré avec une nouvelle version de la page'), el('span', null, ' — rechargement dès la saisie terminée, ou maintenant : '), go);
  } else b.hidden = true;
}
/** Une lecture d'état réussie : compare le démarrage et la page à ceux qu'on connaissait. */
function linkUp(srv) {
  const wasDown = link.down; link.down = null;
  const boot = srv && srv.boot, page = srv && srv.page;
  const restarted = !!(link.boot && boot && boot !== link.boot), newPage = !!(link.page && page && page !== link.page);
  if (!link.boot) { link.boot = boot || null; link.page = page || null; }
  if (newPage || link.reload) {
    link.reload = true;
    if (!typing()) { location.reload(); return true; }
  } else if (restarted || wasDown) {
    link.boot = boot || link.boot;
    tagVocab = null; loadClosed(); loadRuns(); loadAutomations();
    if (REMOTE) whoami();
    say(restarted ? 'serveur redémarré — page resynchronisée' : 'reconnecté au serveur');
  }
  drawLink(); return false;
}
function linkDown(why) {
  if (!link.down) { link.down = { since: Date.now(), tries: 0, why: '' }; console.log('[sessions] serveur injoignable :', why); }
  link.down.tries++; link.down.why = why; drawLink();
}
async function tick() {
  const live = $('live'); ticking = true;
  try {
    const r = await fetch('/api/state', { cache:'no-store', signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('réponse ' + r.status);
    data = await r.json(); favs = new Set(data.favs || []); hiddenSet = new Set(data.hidden || []); $('launchbtn').hidden = launcherOff(); chatsBadge();
    if (linkUp(data.server)) return;
    renderList(); renderDetail(); refreshScreen(); refreshConv(); try { renderQuota(); } catch (e) { console.log('[sessions] quota :', e); }
    if (pendingRun && runData) { const hd = pendingRun; pendingRun = null; openRun(hd); }   // ?run= : runs arrivés avant l'état
    if (!autoAsked && !automationsOff()) loadAutomations();                               // module annoncé par l'état : première lecture
    live.className = ''; if (!notice) live.textContent = 'à jour · ' + new Date().toLocaleTimeString('fr-FR');
  } catch (e) {
    linkDown(e && e.name === 'TimeoutError' ? 'pas de réponse en 25 s' : e && /^réponse /.test(e.message) ? e.message : '');
    live.className = 'down'; live.textContent = 'reconnexion…';
  } finally { ticking = false; }
}

function move(delta) {
  if (!flat.length) return;
  const i = flat.indexOf(selected);
  select(flat[Math.max(0, Math.min(flat.length - 1, i < 0 ? (delta > 0 ? 0 : flat.length - 1) : i + delta))], true);
}
document.addEventListener('keydown', e => {
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#newform')) {   // dans le formulaire : Ctrl+Entrée / Échap seulement
    if (e.key === 'Escape') { e.preventDefault(); closeNew(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); launchNew(); }
    return;
  }
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#bcform')) {    // message groupé : Ctrl+Entrée / Échap seulement
    if (e.key === 'Escape') { e.preventDefault(); closeBc(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendBc(); }
    return;
  }
  if (chatTyping()) {                                                              // réponse à une conversation Teams : Ctrl+Entrée / Échap seulement
    const id = document.activeElement.closest('.creply').dataset.chat;
    if (e.key === 'Escape') { e.preventDefault(); chatReplying.delete(id); renderChats(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); chatSend(id); }
    return;
  }
  if (document.activeElement && document.activeElement.id === 'sendtext') {       // dans la zone de réponse : rien d'autre que Entrée / Échap
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } else if (e.key === 'Escape') document.activeElement.blur();
    else if (e.key === 'Tab' && !e.shiftKey && !document.activeElement.value && suggestion && suggestKey === selected) { if (fillSuggestion()) e.preventDefault(); }
    return;
  }
  if (document.activeElement && document.activeElement.id === 'dlgother') return;   // réponse libre : gérée par son champ
  const inSearch = document.activeElement === $('q');
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') { if ($('q').value) { $('q').value = ''; renderList(); scheduleFind(); } else if (inSearch) $('q').blur(); else if (selected) select(null); else setPane(false); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); return; }
  if (e.key === 'Enter') { let it = selected && flat.includes(selected) && byKey(selected); if (!it && inSearch && flat.length) { select(flat[0], true); it = byKey(flat[0]); } if (it) primary(it); return; }
  if (inSearch) return;
  if (e.key === '/') { e.preventDefault(); $('q').focus(); $('q').select(); }
  else if (e.key === 'n') { const todo = allItems().filter(it => TODO.includes(it.state)).sort((a, b) => TODO.indexOf(a.state) - TODO.indexOf(b.state) || a.since - b.since);
    if (!todo.length) { say('rien à traiter'); return; } const i = todo.findIndex(it => it.key === selected); const it = todo[(i + 1) % todo.length]; select(it.key, true); openTab(it); }
  else if (e.key === 'f') { const it = selected && byKey(selected); if (it && it.kind !== 'run') toggleFav(it); }
  else if (/^[1-9]$/.test(e.key) && $('dialog') && $('dialog').querySelectorAll('button.opt')[+e.key - 1]) { e.preventDefault(); $('dialog').querySelectorAll('button.opt')[+e.key - 1].click(); }
  else if (e.key === 'p' && suggestion && suggestKey === selected) { if (fillSuggestion()) e.preventDefault(); }
  else if (e.key === 'r') { const i = $('sendtext'); if (i && !i.disabled) { e.preventDefault(); i.focus(); } }
  else if (e.key === 'c') { const it = selected && byKey(selected); if (it) copyCmd(it); }
  else if (e.key === 'b') back();
  else if (e.key === 'h') { const it = selected && byKey(selected); if (it && $('screen')) setConvView(convView() === 'conv' ? 'screen' : 'conv'); else if ($('conv')) $('conv').scrollIntoView({ block:'start' }); }
  else if (e.key === 'x') { const it = selected && byKey(selected); if (it && it.kind !== 'run') it.kind === 'closed' ? setHidden([it], !it.hidden) : closeSession(it); }
  else if (e.key === '+') { e.preventDefault(); newMode ? closeNew() : openNew(); }
  else if (e.key === 'd') { const it = selected && byKey(selected); if (it && !it.headless) { e.preventDefault(); openNew({ sessionId: it.sessionId, title: it.title, cwd: it.cwd, tags: it.tags }); } }
  else if (e.key === 't') { boardMode ? closeBoard() : openBoard(); }
  else if (e.key === 'l') { launchMode ? closeLauncher() : openLauncher(); }
  else if (e.key === 'm') { chatsMode ? closeChats() : openChats(); }
});
$('q').addEventListener('input', () => { renderList(); scheduleFind(); });
$('bell').onclick = () => { localStorage.setItem('cc.notifSeen', String(Date.now())); select(null); setPane(true); $('main').scrollTop = 0; };
$('mback').onclick = () => { if (selected) select(null); else if (launchMode) closeLauncher(); else if (chatsMode) closeChats(); else if (boardMode) closeBoard(); else if (newMode) closeNew(); else if (bcMode) closeBc(); else setPane(false); };
$('mfind').onclick = () => setPane(true);
$('newbtn').onclick = () => newMode ? closeNew() : openNew();
$('bcbtn').onclick = () => bcMode ? closeBc() : openBc();
$('boardbtn').onclick = () => boardMode ? closeBoard() : openBoard();
$('launchbtn').onclick = () => launchMode ? closeLauncher() : openLauncher();
$('chatsbtn').onclick = () => chatsMode ? closeChats() : openChats();
$('favonly').onclick = () => { favOnly = !favOnly; localStorage.setItem('cc.favonly', favOnly ? '1' : '0'); renderList(); };
$('sortbtn').onclick = () => { sortMode = sortMode === 'created' ? 'activity' : 'created'; localStorage.setItem('cc.sort', sortMode); say(sortMode === 'created' ? 'tri par date de création' : 'tri par dernière activité'); renderList(); };
// Largeur de la barre latérale : glisser son bord droit, double-clic pour revenir à 360 px ; retenue d'une visite à l'autre.
(() => {
  const app = $('app'), rz = $('resizer');
  const clamp = w => Math.round(Math.max(220, Math.min(w, Math.max(220, innerWidth - 320))));
  const apply = w => { if (w) app.style.setProperty('--sidew', clamp(w) + 'px'); else app.style.removeProperty('--sidew'); };
  apply(+localStorage.getItem('cc.sidew') || 0);
  rz.addEventListener('pointerdown', e => {
    e.preventDefault(); rz.setPointerCapture(e.pointerId); rz.classList.add('drag'); document.body.classList.add('resizing');
    const move = ev => apply(ev.clientX);
    const up = () => {
      rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); rz.removeEventListener('pointercancel', up);
      rz.classList.remove('drag'); document.body.classList.remove('resizing');
      localStorage.setItem('cc.sidew', String(parseInt(getComputedStyle(app).getPropertyValue('--sidew')) || 0));
    };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up); rz.addEventListener('pointercancel', up);
  });
  rz.addEventListener('dblclick', () => { apply(0); localStorage.removeItem('cc.sidew'); });
  addEventListener('resize', () => { const w = +localStorage.getItem('cc.sidew'); if (w) apply(w); });
})();
if (selected && new URLSearchParams(location.search).get('sel')) setPane(true);   // lien direct : on arrive sur la session
tick(); loadClosed(); loadRuns(); setInterval(() => { if (!ticking) tick(); else if (link.down) drawLink(); }, 2000); setInterval(loadClosed, 30000); runTimer = setInterval(loadRuns, 30000); setInterval(loadAutomations, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (!ticking) tick(); loadRuns(); loadAutomations(); } });
if (new URLSearchParams(location.search).get('view') === 'launcher') openLauncher();    // clic sur une alerte du lanceur (notification Windows)
