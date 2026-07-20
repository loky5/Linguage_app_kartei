/* ==========================================================================
   Kartei — logica dell'app
   Tutto vive in localStorage, nessun server: funziona completamente offline.
   ========================================================================== */

const STORAGE_KEY = 'kartei_state_v1';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Ore di attesa prima del prossimo ripasso, indicizzate per "stage" (1..8).
// stage 0 = parola nuova, mai imparata.
const STAGE_HOURS = [null, 4, 24, 72, 168, 336, 720, 1440, 2880];
const MAX_STAGE = STAGE_HOURS.length - 1;
const RETRY_HOURS = 4; // quando si sbaglia, si ritenta presto

const NEW_BATCH_SIZE = 10;
const REVIEW_BATCH_SIZE = 30;
const CHOICES_COUNT = 4;

let STATE = null;
let SESSION = null; // sessione di pratica in corso

/* ---------------------------- Utilità generiche ---------------------------- */

function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function now() { return Date.now(); }

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sample(arr, n) {
  return shuffle(arr).slice(0, n);
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function formatRelative(ms) {
  if (ms < HOUR) return 'meno di un\u2019ora';
  if (ms < DAY) return Math.round(ms / HOUR) + ' ore';
  if (ms < 30 * DAY) return Math.round(ms / DAY) + ' giorni';
  return Math.round(ms / (30 * DAY)) + ' mesi';
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

function simplifyUmlauts(s) {
  return s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'ae').replace(/Ö/g, 'oe').replace(/Ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

function normalizeDE(s) {
  return s
    .toLowerCase()
    .replace(/\|/g, '')
    .replace(/\+\s*(akk|dat|gen)\b/g, '')
    .replace(/[.,;:!?()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function answersMatch(input, target) {
  const a = normalizeDE(input);
  const b = normalizeDE(target);
  if (!a) return false;
  if (a === b) return true;
  if (simplifyUmlauts(a) === simplifyUmlauts(b)) return true;
  if (b.length >= 5 && levenshtein(simplifyUmlauts(a), simplifyUmlauts(b)) <= 1) return true;
  return false;
}

/* ---------------------------- Storage / stato ---------------------------- */

function loadState() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { console.warn('localStorage non disponibile', e); }
  if (raw) {
    try {
      STATE = JSON.parse(raw);
      migrateState();
      saveState();
      return;
    } catch (e) { console.warn('Stato corrotto, reimposto dai dati originali', e); }
  }
  seedFromSource();
}

function freshProgress() {
  return { stage: 0, nextReview: null, lastReviewed: null, correctCount: 0, wrongCount: 0 };
}

function migrateState() {
  if (!STATE.settings) STATE.settings = { theme: 'auto' };
  if (!STATE.meta) STATE.meta = { createdAt: now() };
  STATE.words.forEach(w => {
    if (w.progress && w.progress.de && w.progress.en) {
      // Formato bilingue precedente (v2, progressi separati): li uniamo in una
      // scatola sola. Usiamo la lingua più indietro come riferimento, così la
      // parola non risulta "consolidata" finché non lo sono entrambe.
      const de = w.progress.de, en = w.progress.en;
      const reviews = [de.nextReview, en.nextReview].filter(v => v !== null && v !== undefined);
      w.progress = {
        stage: Math.min(de.stage ?? 0, en.stage ?? 0),
        nextReview: reviews.length ? Math.min(...reviews) : null,
        lastReviewed: Math.max(de.lastReviewed || 0, en.lastReviewed || 0) || null,
        correctCount: (de.correctCount || 0) + (en.correctCount || 0),
        wrongCount: (de.wrongCount || 0) + (en.wrongCount || 0),
      };
    } else if (!w.progress) {
      // Formato originale (v1): i campi erano diretti sulla parola.
      w.progress = {
        stage: typeof w.stage === 'number' ? w.stage : 0,
        nextReview: w.nextReview !== undefined ? w.nextReview : null,
        lastReviewed: w.lastReviewed !== undefined ? w.lastReviewed : null,
        correctCount: typeof w.correctCount === 'number' ? w.correctCount : 0,
        wrongCount: typeof w.wrongCount === 'number' ? w.wrongCount : 0,
      };
    }
    if (typeof w.progress.stage !== 'number') w.progress.stage = 0;
    if (w.progress.nextReview === undefined) w.progress.nextReview = null;
    if (w.progress.lastReviewed === undefined) w.progress.lastReviewed = null;
    if (typeof w.progress.correctCount !== 'number') w.progress.correctCount = 0;
    if (typeof w.progress.wrongCount !== 'number') w.progress.wrongCount = 0;
  });
}

function seedFromSource() {
  const seed = typeof SEED_DATA !== 'undefined' ? SEED_DATA : { courses: [], words: [] };
  STATE = {
    courses: JSON.parse(JSON.stringify(seed.courses)),
    words: JSON.parse(JSON.stringify(seed.words)).map(w => ({
      ...w,
      progress: freshProgress(),
    })),
    settings: { theme: 'auto' },
    meta: { createdAt: now() },
  };
  saveState();
}

function saveState() {
  STATE.meta.updatedAt = now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE));
  } catch (e) {
    console.error('Impossibile salvare lo stato', e);
    toast('Attenzione: salvataggio non riuscito');
  }
}

/* ---------------------------- Selettori dati ---------------------------- */

function getCourse(id) { return STATE.courses.find(c => c.id === id); }
function getLevel(id) {
  for (const c of STATE.courses) {
    const l = c.levels.find(l => l.id === id);
    if (l) return { level: l, course: c };
  }
  return null;
}
function wordsOfLevel(levelId) { return STATE.words.filter(w => w.levelId === levelId); }
function wordsOfCourse(courseId) { return STATE.words.filter(w => w.courseId === courseId); }

const LANGS = ['de', 'en'];
function langLabel(lang) { return lang === 'de' ? 'tedesco' : 'inglese'; }
function langLabelShort(lang) { return lang === 'de' ? 'DE' : 'EN'; }

// L'inglese è "attivo" per una parola solo se è stato compilato (testo non vuoto).
function hasLang(word, lang) { return lang === 'de' ? true : !!(word.en && word.en.trim()); }

// Le lingue da esercitare per una parola, in ordine casuale (tedesco sempre presente).
function langsForWord(word) { return hasLang(word, 'en') ? shuffle(['de', 'en']) : ['de']; }

function isDue(word) {
  const p = word.progress;
  return p.stage >= 1 && p.nextReview !== null && p.nextReview <= now();
}
function isNew(word) { return word.progress.stage === 0; }

function dueCount(words) { return words.filter(isDue).length; }
function newCount(words) { return words.filter(isNew).length; }
function masteredCount(words) { return words.filter(w => w.progress.stage >= 6).length; }

function stageBucket(stage) {
  if (stage === 0) return 'none';
  if (stage <= 2) return 'low';
  if (stage <= 5) return 'mid';
  return 'high';
}

/* ---------------------------- Algoritmo di ripetizione ---------------------------- */
// Una parola avanza di scatola solo se, nella sessione, sono state risposte
// correttamente TUTTE le sue lingue attive (tedesco e, se presente, inglese).

function recordAnswer(word, correct) {
  const p = word.progress;
  if (correct) {
    p.stage = Math.min((p.stage || 0) + 1, MAX_STAGE);
    p.nextReview = now() + STAGE_HOURS[p.stage] * HOUR;
    p.correctCount++;
  } else {
    p.stage = Math.max((p.stage || 1) - 1, 1);
    p.nextReview = now() + RETRY_HOURS * HOUR;
    p.wrongCount++;
  }
  p.lastReviewed = now();
}

/* ---------------------------- Router ---------------------------- */

function currentRoute() {
  const hash = location.hash.replace(/^#/, '') || '/home';
  const parts = hash.split('/').filter(Boolean);
  return parts;
}

window.addEventListener('hashchange', render);

function nav(path) { location.hash = path; }

function render() {
  const parts = currentRoute();
  const root = document.getElementById('app');
  const [seg0, seg1, seg2, seg3] = parts;

  let html = '';
  let showTabs = false;

  if (seg0 === 'home' || parts.length === 0) {
    html = viewHome(); showTabs = true;
  } else if (seg0 === 'course' && seg1) {
    html = viewCourse(seg1);
  } else if (seg0 === 'level' && seg1) {
    html = viewLevel(seg1);
  } else if (seg0 === 'session' && seg1 && seg2 && seg3) {
    html = viewSessionStart(seg1, seg2, seg3); // mode / scopeType / scopeId
  } else if (seg0 === 'add' && !seg1) {
    html = viewAddMenu(); showTabs = true;
  } else if (seg0 === 'add' && seg1 === 'course') {
    html = viewCourseForm();
  } else if (seg0 === 'add' && seg1 === 'level' && seg2) {
    html = viewLevelForm(seg2);
  } else if (seg0 === 'add' && seg1 === 'word' && seg2) {
    html = viewWordForm(seg2, null);
  } else if (seg0 === 'edit' && seg1 === 'word' && seg2) {
    html = viewWordForm(null, seg2);
  } else if (seg0 === 'import') {
    html = viewImport(seg1 || null);
  } else if (seg0 === 'settings') {
    html = viewSettings(); showTabs = true;
  } else {
    html = viewHome(); showTabs = true;
  }

  root.innerHTML = `
    <div class="screen ${seg0 === 'session' ? 'screen--session' : ''}">${html}</div>
    ${showTabs ? viewTabbar(seg0) : ''}
    <div class="toast" id="toast"></div>
  `;
  window.scrollTo(0, 0);
  attachHandlers(parts);
}

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------------------------- Componenti condivisi ---------------------------- */

function iconBack() {
  return `<svg viewBox="0 0 24 24" fill="none" width="22" height="22"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function iconChevron() {
  return `<svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function iconGear() {
  return `<svg viewBox="0 0 24 24" fill="none" width="20" height="20"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M19.4 13a7.97 7.97 0 000-2l2-1.5-2-3.4-2.4 1a8 8 0 00-1.7-1L15 3h-6l-.3 2.6a8 8 0 00-1.7 1l-2.4-1-2 3.4L4.6 11a7.97 7.97 0 000 2l-2 1.5 2 3.4 2.4-1a8 8 0 001.7 1L9 21h6l.3-2.6a8 8 0 001.7-1l2.4 1 2-3.4-2-1.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

function backRow(label, href) {
  return `<div class="back-row">
    <a href="#${href}">${iconBack()}</a>
    <span style="font-size:13px;color:var(--ink-soft);font-weight:600">${esc(label)}</span>
  </div>`;
}

function viewTabbar(active) {
  const tabs = [
    { id: 'home', href: '/home', label: 'Home', icon: `<path d="M4 11.5L12 4l8 7.5M6 10v9h12v-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` },
    { id: 'add', href: '/add', label: 'Aggiungi', icon: `<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>` },
    { id: 'settings', href: '/settings', label: 'Impostazioni', icon: `<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M19.4 13a7.97 7.97 0 000-2l2-1.5-2-3.4-2.4 1a8 8 0 00-1.7-1L15 3h-6l-.3 2.6a8 8 0 00-1.7 1l-2.4-1-2 3.4L4.6 11a7.97 7.97 0 000 2l-2 1.5 2 3.4 2.4-1a8 8 0 001.7 1L9 21h6l.3-2.6a8 8 0 001.7-1l2.4 1 2-3.4-2-1.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/>` },
  ];
  return `<nav class="tabbar">
    ${tabs.map(t => `<a href="#${t.href}" class="${active === t.id ? 'active' : ''}">
      <svg viewBox="0 0 24 24" width="22" height="22">${t.icon}</svg>
      <span>${t.label}</span>
    </a>`).join('')}
  </nav>`;
}

/* ---------------------------- Vista: Home ---------------------------- */

function viewHome() {
  const allWords = STATE.words;
  const totalDue = dueCount(allWords);
  const totalNew = newCount(allWords);

  const hero = totalDue > 0 ? `
    <div class="hero">
      <div class="hero-num">${totalDue}</div>
      <div class="hero-label">parol${totalDue === 1 ? 'a' : 'e'} da ripassare oggi</div>
      <button class="btn btn-primary" data-action="start-review-all">Ripassa ora</button>
    </div>
  ` : `
    <div class="hero">
      <div class="hero-empty">${totalNew > 0 ? 'Nessuna parola in scadenza. Ottimo lavoro \u2014 puoi imparare parole nuove qui sotto.' : 'Nessuna parola in scadenza oggi.'}</div>
    </div>
  `;

  const secondary = totalNew > 0 ? `
    <div class="hero-secondary">
      <div>
        <div class="label">Parole nuove da imparare</div>
        <div class="num">${totalNew}</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-action="start-learn-all">Impara nuove</button>
    </div>
  ` : '';

  const courses = STATE.courses.slice().sort((a, b) => a.order - b.order);
  const courseCards = courses.map(c => {
    const words = wordsOfCourse(c.id);
    const total = words.length;
    const mastered = masteredCount(words);
    const due = dueCount(words);
    const pct = total ? Math.round((mastered / total) * 100) : 0;
    return `<a class="course-card accent-${c.color}" href="#/course/${c.id}">
      <div class="chip"></div>
      <div class="body">
        <div class="name">${esc(c.name)}</div>
        <div class="meta">${total} parole \u00b7 ${mastered} consolidate</div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      ${due > 0 ? `<div class="badge">${due}</div>` : ''}
    </a>`;
  }).join('');

  return `
    <div class="topbar" style="padding:0 0 6px">
      <div class="wordmark"><span class="mark"></span>Kartei</div>
      <a class="icon-btn" href="#/settings">${iconGear()}</a>
    </div>
    ${hero}
    ${secondary}
    <div class="section-title">I tuoi corsi</div>
    ${courseCards || emptyState('Nessun corso ancora', 'Crea il tuo primo corso per iniziare a imparare.', '/add/course', 'Crea un corso')}
  `;
}

function emptyState(title, sub, href, cta) {
  return `<div class="empty">
    <div class="big">\u{1F4C7}</div>
    <div style="font-weight:800;color:var(--ink);font-size:16px">${esc(title)}</div>
    <p>${esc(sub)}</p>
    ${href ? `<a href="#${href}" class="btn btn-primary" style="display:inline-flex;width:auto;padding-left:22px;padding-right:22px">${esc(cta)}</a>` : ''}
  </div>`;
}

/* ---------------------------- Vista: Corso ---------------------------- */

function viewCourse(courseId) {
  const c = getCourse(courseId);
  if (!c) return emptyState('Corso non trovato', 'Torna alla home.', '/home', 'Home');
  const levels = c.levels.slice().sort((a, b) => a.order - b.order);

  const rows = levels.map(l => {
    const words = wordsOfLevel(l.id);
    const due = dueCount(words);
    const nw = newCount(words);
    const mastered = masteredCount(words);
    return `<a class="level-row" href="#/level/${l.id}">
      <div class="num" style="--accent:var(--${colorVar(c.color)})">${l.order}</div>
      <div class="body">
        <div class="name">${esc(l.name)}</div>
        <div class="meta">${words.length} parole \u00b7 ${mastered} consolidate${due ? ` \u00b7 ${due} da ripassare` : ''}${nw ? ` \u00b7 ${nw} nuove` : ''}</div>
      </div>
      <div class="chev">${iconChevron()}</div>
    </a>`;
  }).join('');

  const words = wordsOfCourse(c.id);
  const totalDue = dueCount(words);

  return `
    ${backRow('Home', '/home')}
    <div class="page-title">${esc(c.name)}</div>
    <div class="page-sub">${words.length} parole in ${levels.length} livelli</div>
    ${totalDue > 0 ? `<button class="btn btn-primary" style="margin-bottom:18px" data-action="start-review" data-scope-type="course" data-scope-id="${c.id}">Ripassa le ${totalDue} dovute</button>` : ''}
    <div class="section-title">Livelli</div>
    ${rows}
    <div class="list-actions">
      <a class="btn btn-secondary" href="#/add/level/${c.id}">+ Nuovo livello</a>
    </div>
  `;
}

function colorVar(color) {
  const map = { blue: 'blue', red: 'red', gold: 'gold', teal: 'teal', violet: 'violet' };
  return map[color] || 'navy';
}

/* ---------------------------- Vista: Livello ---------------------------- */

function viewLevel(levelId) {
  const found = getLevel(levelId);
  if (!found) return emptyState('Livello non trovato', 'Torna alla home.', '/home', 'Home');
  const { level: l, course: c } = found;
  const words = wordsOfLevel(l.id).sort((a, b) => a.de.localeCompare(b.de, 'de'));
  const due = dueCount(words);
  const nw = newCount(words);

  // Distribuzione per stage (visualizzazione "schedario Leitner"), unica per parola
  const labels = ['Nuove', 'Scatola 1', 'Scatola 2', 'Scatola 3'];
  const buckets = [0, 0, 0, 0];
  words.forEach(w => {
    const b = stageBucket(w.progress.stage);
    if (b === 'none') buckets[0]++; else if (b === 'low') buckets[1]++; else if (b === 'mid') buckets[2]++; else buckets[3]++;
  });
  const maxB = Math.max(...buckets, 1);
  const leitner = `<div class="leitner accent-${c.color}">
    <div class="leitner-legend">${labels.map(l => `<span>${l}</span>`).join('')}</div>
    <div class="leitner-row">
      <div class="leitner-bars">
        ${buckets.map((v, i) => `<div class="leitner-col">
          <div class="leitner-bar" style="height:${Math.max(4, (v / maxB) * 44)}px; ${i === 0 ? 'background:var(--line)' : ''}"></div>
          <div class="leitner-label">${v}</div>
        </div>`).join('')}
      </div>
    </div>
  </div>`;

  const wordRows = words.map(w => `
    <div class="word-row">
      <span class="stage-dot" data-lvl="${stageBucket(w.progress.stage)}"></span>
      <div class="word-row-main">
        <div class="word-row-line"><span class="de">${esc(w.de)}</span></div>
        ${hasLang(w, 'en') ? `<div class="word-row-line"><span class="en">${esc(w.en)}</span></div>` : ''}
        <div class="it">${esc(w.it)}</div>
      </div>
      <a class="icon-btn" style="width:26px;height:26px" href="#/edit/word/${w.id}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 000-3L18 6a2.1 2.1 0 00-3 0L4.5 16.5V20z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
      </a>
    </div>
  `).join('');

  return `
    ${backRow(c.name, '/course/' + c.id)}
    <div class="page-title">${esc(l.name)}</div>
    <div class="page-sub">${words.length} parole \u00b7 ogni parola avanza solo se sai sia il tedesco sia l'inglese</div>
    ${leitner}
    <div class="btn-row" style="margin-bottom:22px">
      <button class="btn btn-primary" data-action="start-learn" data-scope-type="level" data-scope-id="${l.id}" ${nw === 0 ? 'disabled' : ''}>Impara nuove (${nw})</button>
      <button class="btn btn-secondary" data-action="start-review" data-scope-type="level" data-scope-id="${l.id}" ${due === 0 ? 'disabled' : ''}>Ripassa (${due})</button>
    </div>
    <div class="section-title">Parole</div>
    <div class="card" style="padding:6px 10px">
      ${wordRows || '<div class="empty" style="padding:20px"><p>Nessuna parola in questo livello.</p></div>'}
    </div>
    <div class="list-actions">
      <a class="btn btn-secondary" href="#/add/word/${l.id}">+ Aggiungi parola</a>
      <a class="btn btn-secondary" href="#/import/${l.id}">Importa in blocco</a>
    </div>
  `;
}

/* ---------------------------- Vista: Aggiungi (menu) ---------------------------- */

function viewAddMenu() {
  return `
    <div class="page-title">Aggiungi</div>
    <div class="page-sub">Crea nuovi corsi, livelli o parole</div>
    <a class="settings-item" href="#/add/course">Nuovo corso
      <span class="sub">Un nuovo blocco indipendente, come un tab nel tuo Excel</span>
    </a>
    ${STATE.courses.length ? STATE.courses.map(c => `
      <a class="settings-item" href="#/add/level/${c.id}">Nuovo livello in \u201c${esc(c.name)}\u201d
        <span class="sub">Aggiungi un nuovo blocco di parole a questo corso</span>
      </a>
    `).join('') : ''}
    ${STATE.courses.length ? `
      <a class="settings-item" href="#/import">Importa parole in blocco
        <span class="sub">Incolla un elenco di parole (tedesco;italiano) in un livello esistente o nuovo</span>
      </a>
    ` : ''}
  `;
}

function viewCourseForm() {
  const colors = ['blue', 'red', 'gold', 'teal', 'violet'];
  return `
    ${backRow('Aggiungi', '/add')}
    <div class="page-title">Nuovo corso</div>
    <form id="courseForm">
      <div class="card">
        <label class="field-label" for="cname">Nome del corso</label>
        <input type="text" id="cname" placeholder="Es. Francese \u2014 Base" required>
        <label class="field-label">Colore</label>
        <div class="color-picker">
          ${colors.map((c, i) => `<div class="color-swatch accent-${c} ${i === 0 ? 'selected' : ''}" style="background:var(--${c})" data-color="${c}"></div>`).join('')}
        </div>
        <input type="hidden" id="ccolor" value="blue">
      </div>
      <button class="btn btn-primary" type="submit">Crea corso</button>
    </form>
  `;
}

function viewLevelForm(courseId) {
  const c = getCourse(courseId);
  if (!c) return emptyState('Corso non trovato', '', '/home', 'Home');
  const nextOrder = (c.levels.reduce((m, l) => Math.max(m, l.order), 0) || 0) + 1;
  return `
    ${backRow(c.name, '/course/' + c.id)}
    <div class="page-title">Nuovo livello</div>
    <form id="levelForm" data-course-id="${c.id}">
      <div class="card">
        <label class="field-label" for="lname">Nome del livello</label>
        <input type="text" id="lname" value="Livello ${nextOrder}" required>
      </div>
      <button class="btn btn-primary" type="submit">Crea livello</button>
    </form>
  `;
}

function viewWordForm(levelIdForNew, wordIdForEdit) {
  const isEdit = !!wordIdForEdit;
  const word = isEdit ? STATE.words.find(w => w.id === wordIdForEdit) : null;
  const levelId = isEdit ? word.levelId : levelIdForNew;
  const found = getLevel(levelId);
  if (!found) return emptyState('Livello non trovato', '', '/home', 'Home');
  const { level: l, course: c } = found;

  return `
    ${backRow(l.name, '/level/' + l.id)}
    <div class="page-title">${isEdit ? 'Modifica parola' : 'Nuova parola'}</div>
    <div class="page-sub">${esc(c.name)} \u2014 ${esc(l.name)}</div>
    <form id="wordForm" data-level-id="${l.id}" ${isEdit ? `data-word-id="${word.id}"` : ''}>
      <div class="card">
        <label class="field-label" for="wde">Tedesco</label>
        <input type="text" id="wde" value="${esc(isEdit ? word.de : '')}" required>
        <label class="field-label" for="wit">Italiano</label>
        <input type="text" id="wit" value="${esc(isEdit ? word.it : '')}" required>
        <label class="field-label" for="wen">Inglese <span style="font-weight:500;color:var(--ink-faint)">(lascia vuoto se non lo sai ancora)</span></label>
        <input type="text" id="wen" value="${esc(isEdit && word.en ? word.en : '')}">
      </div>
      <button class="btn btn-primary" type="submit">${isEdit ? 'Salva modifiche' : 'Aggiungi parola'}</button>
      ${isEdit ? `<button type="button" class="btn btn-danger" style="margin-top:10px" data-action="delete-word" data-word-id="${word.id}">Elimina parola</button>` : ''}
    </form>
  `;
}

/* ---------------------------- Vista: Importa in blocco ---------------------------- */

function viewImport(levelId) {
  const found = levelId ? getLevel(levelId) : null;
  const courseOptions = STATE.courses.map(c => `<option value="${c.id}" ${found && found.course.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const levelsForFirstCourse = (found ? found.course : STATE.courses[0]);
  const levelOptions = levelsForFirstCourse ? levelsForFirstCourse.levels.map(l => `<option value="${l.id}" ${found && found.level.id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('') : '';

  return `
    ${backRow('Indietro', found ? '/level/' + found.level.id : '/add')}
    <div class="page-title">Importa parole</div>
    <div class="page-sub">Una parola per riga: <code>tedesco;italiano</code> oppure <code>tedesco;italiano;inglese</code></div>
    <form id="importForm">
      <div class="card">
        <label class="field-label" for="impCourse">Corso</label>
        <select id="impCourse">${courseOptions}</select>
        <label class="field-label" for="impLevel">Livello</label>
        <select id="impLevel">${levelOptions}</select>
        <label class="field-label" for="impText">Parole</label>
        <textarea id="impText" placeholder="die Prüfung;esame&#10;der Termin;appuntamento, scadenza"></textarea>
      </div>
      <button class="btn btn-primary" type="submit">Importa</button>
    </form>
  `;
}

/* ---------------------------- Vista: Sessione (pratica) ---------------------------- */

function buildScopeWords(scopeType, scopeId) {
  if (scopeType === 'all') return STATE.words;
  if (scopeType === 'course') return wordsOfCourse(scopeId);
  if (scopeType === 'level') return wordsOfLevel(scopeId);
  return [];
}

function buildItemQueue(candidateWords, batchSize) {
  const chosen = sample(candidateWords, batchSize);
  const queue = [];
  chosen.forEach(w => langsForWord(w).forEach(l => queue.push({ wordId: w.id, lang: l })));
  return queue;
}
function buildLearnQueue(scopeWords) { return buildItemQueue(scopeWords.filter(isNew), NEW_BATCH_SIZE); }
function buildReviewQueue(scopeWords) { return buildItemQueue(scopeWords.filter(isDue), REVIEW_BATCH_SIZE); }

function viewSessionStart(mode, scopeType, scopeId) {
  const scopeWords = buildScopeWords(scopeType, scopeId === '_' ? null : scopeId);
  const queue = mode === 'learn' ? buildLearnQueue(scopeWords) : buildReviewQueue(scopeWords);

  if (queue.length === 0) {
    return `
      ${emptyState('Niente da fare qui', mode === 'learn' ? 'Non ci sono parole nuove da imparare in questo momento.' : 'Non ci sono parole da ripassare in questo momento.', '/home', 'Torna alla home')}
    `;
  }

  SESSION = {
    mode, // 'learn' | 'review'
    scopeType, scopeId,
    queue,
    pos: 0,
    correct: 0,
    wrong: 0,
    total: queue.length,
    pool: scopeWords, // per generare distrattori
    stepState: null,
    lastPresentedWordId: null,
  };

  return renderSessionStep();
}

function currentSessionItem() {
  const entry = SESSION.queue[SESSION.pos];
  return { word: STATE.words.find(w => w.id === entry.wordId), lang: entry.lang };
}

function distractorsFor(word, field, count) {
  let pool = SESSION.pool.filter(w => w.id !== word.id && w[field] && w[field] !== word[field]);
  if (pool.length < count) pool = STATE.words.filter(w => w.id !== word.id && w[field] && w[field] !== word[field]);
  const chosen = sample(pool, count);
  const seen = new Set([word[field]]);
  const result = [];
  for (const w of chosen) {
    if (!seen.has(w[field])) { seen.add(w[field]); result.push(w[field]); }
  }
  return result;
}

function renderSessionProgress() {
  const pct = Math.round((SESSION.pos / SESSION.total) * 100);
  return `<div class="session-top">
    <a class="icon-btn" href="#/home" onclick="return confirm('Uscire dalla sessione? I progressi fatti finora restano salvati.')">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
    </a>
    <div class="session-progress"><div class="session-progress-fill" style="width:${pct}%"></div></div>
    <div style="font-size:12px;font-weight:700;color:var(--ink-soft)">${SESSION.pos}/${SESSION.total}</div>
  </div>`;
}

function langBadge(lang) {
  return `<span class="lang-badge lang-badge-${lang}">${langLabelShort(lang)}</span>`;
}

function renderLearnPresentation(word, accentColor) {
  return `
    ${renderSessionProgress()}
    <div class="quiz-kicker">Nuova parola</div>
    <div class="learn-card accent-${accentColor}">
      <div class="learn-de">${esc(word.de)}</div>
      ${hasLang(word, 'en') ? `<div class="learn-en-big">${esc(word.en)}</div>` : ''}
      <div class="learn-div"></div>
      <div class="learn-it">${esc(word.it)}</div>
    </div>
    <button class="btn btn-primary" data-action="learn-continue">Ho capito, testami</button>
  `;
}

function renderSessionStep() {
  if (SESSION.pos >= SESSION.total) return renderSessionSummary();
  const { word, lang } = currentSessionItem();
  const found = getLevel(word.levelId);
  const accentColor = found ? found.course.color : 'blue';

  if (SESSION.mode === 'learn' && SESSION.stepState === null && SESSION.lastPresentedWordId !== word.id) {
    SESSION.stepState = 'present';
    SESSION.lastPresentedWordId = word.id;
    return renderLearnPresentation(word, accentColor);
  }

  // scelta tipo di esercizio: multiple choice o scrittura, alternati
  if (!SESSION.stepState || SESSION.stepState === 'present' || SESSION.stepState === 'present-done') {
    const exerciseType = SESSION.mode === 'learn' ? 'choice' : (Math.random() < 0.5 ? 'choice' : 'typing');
    SESSION.stepState = exerciseType;
  }

  if (SESSION.stepState === 'choice') {
    return renderChoiceExercise(word, lang, accentColor);
  } else {
    return renderTypingExercise(word, lang, accentColor);
  }
}

function renderChoiceExercise(word, lang, accentColor) {
  const reverse = SESSION.mode === 'review' && Math.random() < 0.3;
  const promptField = reverse ? 'it' : lang;
  const answerField = reverse ? lang : 'it';
  if (!SESSION.exercise || SESSION.exercise.wordId !== word.id || SESSION.exercise.lang !== lang || SESSION.exercise.kind !== 'choice') {
    const distractors = distractorsFor(word, answerField, CHOICES_COUNT - 1);
    const options = shuffle([word[answerField], ...distractors]);
    SESSION.exercise = { kind: 'choice', wordId: word.id, lang, promptField, answerField, options, answered: false };
  }
  const ex = SESSION.exercise;
  const kicker = ex.promptField === 'it' ? `Come si dice in ${langLabel(lang)}?` : 'Cosa significa?';
  return `
    ${renderSessionProgress()}
    <div class="quiz-kicker-row"><span class="quiz-kicker">${kicker}</span>${langBadge(lang)}</div>
    <div class="prompt-card accent-${accentColor}">
      <div class="prompt-word">${esc(word[ex.promptField])}</div>
    </div>
    <div class="choice-grid" id="choiceGrid">
      ${ex.options.map((opt, i) => `<button class="choice-btn" data-idx="${i}" data-action="answer-choice">${esc(opt)}</button>`).join('')}
    </div>
  `;
}

function renderTypingExercise(word, lang, accentColor) {
  if (!SESSION.exercise || SESSION.exercise.wordId !== word.id || SESSION.exercise.lang !== lang || SESSION.exercise.kind !== 'typing') {
    SESSION.exercise = { kind: 'typing', wordId: word.id, lang, answered: false };
  }
  return `
    ${renderSessionProgress()}
    <div class="quiz-kicker-row"><span class="quiz-kicker">Scrivi in ${langLabel(lang)}</span>${langBadge(lang)}</div>
    <div class="prompt-card accent-${accentColor}">
      <div class="prompt-sub">${esc(word.it)}</div>
    </div>
    <form id="typingForm">
      <input type="text" id="typingInput" class="type-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="\u2026">
      <button class="btn btn-primary" type="submit" style="margin-top:14px">Controlla</button>
    </form>
    <div id="typingFeedback"></div>
  `;
}

function afterAnswer(correct, word, lang) {
  if (!SESSION.pendingResults) SESSION.pendingResults = {};
  if (!SESSION.pendingResults[word.id]) SESSION.pendingResults[word.id] = [];
  SESSION.pendingResults[word.id].push(correct);
  if (correct) SESSION.correct++; else SESSION.wrong++;
}

// Quando una parola ha esaurito le sue lingue in coda, la scatola avanza solo
// se TUTTE le risposte date per quella parola in questa sessione erano corrette.
function finalizeWordIfDone(word) {
  const nextEntry = SESSION.queue[SESSION.pos + 1];
  const stillPending = nextEntry && nextEntry.wordId === word.id;
  if (stillPending) return;
  const results = SESSION.pendingResults[word.id] || [];
  const combined = results.length > 0 && results.every(r => r);
  recordAnswer(word, combined);
  delete SESSION.pendingResults[word.id];
  saveState();
}

function goNextStep(delay, word) {
  setTimeout(() => {
    finalizeWordIfDone(word);
    SESSION.pos++;
    SESSION.stepState = null;
    SESSION.exercise = null;
    document.getElementById('app').querySelector('.screen').innerHTML = renderSessionStep();
    attachHandlers(currentRoute());
  }, delay);
}

function renderSessionSummary() {
  const accuracy = SESSION.total ? Math.round((SESSION.correct / (SESSION.correct + SESSION.wrong || 1)) * 100) : 0;
  const uniqueWords = new Set(SESSION.queue.map(it => it.wordId)).size;
  const summary = `
    <div class="quiz-kicker">${SESSION.mode === 'learn' ? 'Parole imparate' : 'Ripasso completato'}</div>
    <div class="card" style="text-align:center;padding:28px 16px">
      <div style="font-size:40px">${accuracy >= 80 ? '\u2728' : accuracy >= 50 ? '\u{1F44D}' : '\u{1F4AA}'}</div>
      <div style="font-weight:800;font-size:19px;margin-top:6px">Ottimo lavoro!</div>
    </div>
    <div class="card">
      <div class="summary-stat"><span class="label">Parole in questa sessione</span><span class="val">${uniqueWords}</span></div>
      <div class="summary-stat"><span class="label">Domande totali (DE + EN)</span><span class="val">${SESSION.total}</span></div>
      <div class="summary-stat"><span class="label">Risposte corrette</span><span class="val" style="color:var(--good)">${SESSION.correct}</span></div>
      <div class="summary-stat"><span class="label">Risposte sbagliate</span><span class="val" style="color:var(--bad)">${SESSION.wrong}</span></div>
      <div class="summary-stat"><span class="label">Precisione</span><span class="val">${accuracy}%</span></div>
    </div>
    <div class="btn-row">
      <a class="btn btn-secondary" href="#/home">Torna alla home</a>
      ${SESSION.mode === 'learn' ? `<button class="btn btn-primary" data-action="learn-more" data-scope-type="${SESSION.scopeType}" data-scope-id="${SESSION.scopeId}">Impara altre 10</button>` : ''}
    </div>
  `;
  SESSION.done = true;
  return summary;
}

/* ---------------------------- Vista: Impostazioni ---------------------------- */

function viewSettings() {
  const totalWords = STATE.words.length;
  const totalCourses = STATE.courses.length;
  const mastered = masteredCount(STATE.words);
  const created = new Date(STATE.meta.createdAt).toLocaleDateString('it-IT');

  return `
    <div class="page-title">Impostazioni</div>
    <div class="card">
      <div class="kv"><span class="k">Corsi</span><span class="v">${totalCourses}</span></div>
      <div class="kv"><span class="k">Parole totali</span><span class="v">${totalWords}</span></div>
      <div class="kv"><span class="k">Parole consolidate</span><span class="v">${mastered}</span></div>
      <div class="kv"><span class="k">In uso dal</span><span class="v">${created}</span></div>
    </div>

    <div class="section-title">Aspetto</div>
    <div class="card">
      <label class="field-label" for="themeSelect">Tema</label>
      <select id="themeSelect">
        <option value="auto" ${STATE.settings.theme === 'auto' ? 'selected' : ''}>Automatico (di sistema)</option>
        <option value="light" ${STATE.settings.theme === 'light' ? 'selected' : ''}>Chiaro</option>
        <option value="dark" ${STATE.settings.theme === 'dark' ? 'selected' : ''}>Scuro</option>
      </select>
    </div>

    <div class="section-title">Backup</div>
    <button class="settings-item" data-action="export-backup">Esporta backup
      <span class="sub">Salva un file con tutti i tuoi corsi e progressi</span>
    </button>
    <button class="settings-item" data-action="import-backup">Importa backup
      <span class="sub">Ripristina da un file esportato in precedenza</span>
    </button>
    <input type="file" id="backupFile" accept="application/json" style="display:none">

    <div class="section-title">Dati</div>
    <button class="settings-item danger" data-action="reset-progress">Reimposta tutti i progressi
      <span class="sub">Riporta ogni parola a \u201cnuova\u201d, mantenendo corsi e parole</span>
    </button>
    <button class="settings-item danger" data-action="reset-all">Ripristina i dati originali
      <span class="sub">Cancella tutto e reimporta i corsi originali del tuo Excel</span>
    </button>
  `;
}

/* ---------------------------- Gestione eventi ---------------------------- */

function applyTheme() {
  const t = STATE.settings.theme;
  document.documentElement.setAttribute('data-theme', t === 'auto' ? '' : t);
}

function attachHandlers(parts) {
  applyTheme();
  const app = document.getElementById('app');

  // colore corso (form nuovo corso)
  app.querySelectorAll('.color-swatch').forEach(el => {
    el.addEventListener('click', () => {
      app.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      el.classList.add('selected');
      document.getElementById('ccolor').value = el.dataset.color;
    });
  });

  const courseForm = document.getElementById('courseForm');
  if (courseForm) courseForm.addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('cname').value.trim();
    const color = document.getElementById('ccolor').value;
    if (!name) return;
    const c = { id: uid('c'), name, sourceName: name, color, order: STATE.courses.length + 1, levels: [] };
    STATE.courses.push(c);
    saveState();
    toast('Corso creato');
    nav('/course/' + c.id);
  });

  const levelForm = document.getElementById('levelForm');
  if (levelForm) levelForm.addEventListener('submit', e => {
    e.preventDefault();
    const courseId = levelForm.dataset.courseId;
    const c = getCourse(courseId);
    const name = document.getElementById('lname').value.trim();
    if (!name || !c) return;
    const order = (c.levels.reduce((m, l) => Math.max(m, l.order), 0) || 0) + 1;
    const l = { id: uid('l'), name, order };
    c.levels.push(l);
    saveState();
    toast('Livello creato');
    nav('/level/' + l.id);
  });

  const wordForm = document.getElementById('wordForm');
  if (wordForm) wordForm.addEventListener('submit', e => {
    e.preventDefault();
    const de = document.getElementById('wde').value.trim();
    const it = document.getElementById('wit').value.trim();
    const en = document.getElementById('wen').value.trim();
    if (!de || !it) return;
    const wordId = wordForm.dataset.wordId;
    if (wordId) {
      const w = STATE.words.find(x => x.id === wordId);
      w.de = de; w.it = it; w.en = en || null;
      saveState();
      toast('Parola aggiornata');
      nav('/level/' + w.levelId);
    } else {
      const levelId = wordForm.dataset.levelId;
      const found = getLevel(levelId);
      const w = { id: uid('w'), courseId: found.course.id, levelId, de, it, en: en || null, progress: freshProgress() };
      STATE.words.push(w);
      saveState();
      toast('Parola aggiunta');
      nav('/level/' + levelId);
    }
  });

  app.querySelectorAll('[data-action="delete-word"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Eliminare questa parola definitivamente?')) return;
      const wordId = btn.dataset.wordId;
      const w = STATE.words.find(x => x.id === wordId);
      const levelId = w.levelId;
      STATE.words = STATE.words.filter(x => x.id !== wordId);
      saveState();
      toast('Parola eliminata');
      nav('/level/' + levelId);
    });
  });

  // corso -> aggiorna elenco livelli quando si cambia corso nell'import
  const impCourse = document.getElementById('impCourse');
  const impLevel = document.getElementById('impLevel');
  if (impCourse) impCourse.addEventListener('change', () => {
    const c = getCourse(impCourse.value);
    impLevel.innerHTML = c.levels.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  });

  const importForm = document.getElementById('importForm');
  if (importForm) importForm.addEventListener('submit', e => {
    e.preventDefault();
    const levelId = document.getElementById('impLevel').value;
    const found = getLevel(levelId);
    if (!found) { toast('Seleziona un livello valido'); return; }
    const text = document.getElementById('impText').value;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let added = 0;
    lines.forEach(line => {
      const parts = line.split(/;|\t/).map(p => p.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) {
        STATE.words.push({
          id: uid('w'), courseId: found.course.id, levelId,
          de: parts[0], it: parts[1], en: parts[2] || null,
          progress: freshProgress(),
        });
        added++;
      }
    });
    saveState();
    toast(`${added} parole importate`);
    nav('/level/' + levelId);
  });

  // sessioni
  app.querySelectorAll('[data-action="start-review-all"]').forEach(b => b.addEventListener('click', () => nav('/session/review/all/_')));
  app.querySelectorAll('[data-action="start-learn-all"]').forEach(b => b.addEventListener('click', () => nav('/session/learn/all/_')));
  app.querySelectorAll('[data-action="start-review"]').forEach(b => b.addEventListener('click', () => nav(`/session/review/${b.dataset.scopeType}/${b.dataset.scopeId}`)));
  app.querySelectorAll('[data-action="start-learn"]').forEach(b => b.addEventListener('click', () => nav(`/session/learn/${b.dataset.scopeType}/${b.dataset.scopeId}`)));
  app.querySelectorAll('[data-action="learn-more"]').forEach(b => b.addEventListener('click', () => {
    location.hash = `/session/learn/${b.dataset.scopeType}/${b.dataset.scopeId}`;
    render();
  }));

  const learnContinue = app.querySelector('[data-action="learn-continue"]');
  if (learnContinue) learnContinue.addEventListener('click', () => {
    SESSION.stepState = 'present-done';
    app.querySelector('.screen').innerHTML = renderSessionStep();
    attachHandlers(parts);
  });

  app.querySelectorAll('[data-action="answer-choice"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (SESSION.exercise.answered) return;
      SESSION.exercise.answered = true;
      const { word, lang } = currentSessionItem();
      const chosen = btn.textContent;
      const correct = chosen === word[SESSION.exercise.answerField];
      app.querySelectorAll('.choice-btn').forEach(b => {
        b.disabled = true;
        if (b.textContent === word[SESSION.exercise.answerField]) b.classList.add('correct');
        else if (b === btn) b.classList.add('wrong');
      });
      afterAnswer(correct, word, lang);
      goNextStep(correct ? 650 : 1300, word);
    });
  });

  const typingForm = document.getElementById('typingForm');
  if (typingForm) {
    const input = document.getElementById('typingInput');
    input.focus();
    typingForm.addEventListener('submit', e => {
      e.preventDefault();
      if (SESSION.exercise.answered) return;
      SESSION.exercise.answered = true;
      const { word, lang } = currentSessionItem();
      const correct = answersMatch(input.value, word[lang]);
      input.disabled = true;
      const fb = document.getElementById('typingFeedback');
      fb.innerHTML = `<div class="type-feedback ${correct ? 'good' : 'bad'}">${correct ? 'Esatto!' : 'Non proprio.'}${!correct ? `<span class="answer">${esc(word[lang])}</span>` : ''}</div>`;
      afterAnswer(correct, word, lang);
      goNextStep(correct ? 750 : 1700, word);
    });
  }

  // impostazioni
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) themeSelect.addEventListener('change', () => {
    STATE.settings.theme = themeSelect.value;
    saveState();
    applyTheme();
    toast('Tema aggiornato');
  });

  const exportBtn = app.querySelector('[data-action="export-backup"]');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(STATE, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `kartei-backup-${d}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Backup esportato');
  });

  const importBtn = app.querySelector('[data-action="import-backup"]');
  const fileInput = document.getElementById('backupFile');
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data.courses || !data.words) throw new Error('formato non valido');
          if (!confirm('Questo sostituirà tutti i dati attuali con quelli del backup. Continuare?')) return;
          STATE = data;
          migrateState();
          saveState();
          toast('Backup ripristinato');
          nav('/home');
        } catch (err) {
          toast('File non valido');
        }
      };
      reader.readAsText(file);
    });
  }

  const resetProgress = app.querySelector('[data-action="reset-progress"]');
  if (resetProgress) resetProgress.addEventListener('click', () => {
    if (!confirm('Tutte le parole torneranno allo stato \u201cnuova\u201d. I corsi e le parole restano. Continuare?')) return;
    STATE.words.forEach(w => { w.progress = freshProgress(); });
    saveState();
    toast('Progressi reimpostati');
    render();
  });

  const resetAll = app.querySelector('[data-action="reset-all"]');
  if (resetAll) resetAll.addEventListener('click', () => {
    if (!confirm('Questo cancella corsi, parole e progressi personalizzati e reimporta i dati originali del tuo Excel. Continuare?')) return;
    seedFromSource();
    toast('Dati originali ripristinati');
    nav('/home');
  });
}

/* ---------------------------- Avvio ---------------------------- */

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(err => console.warn('SW non registrato', err));
    });
  }
}

function init() {
  loadState();
  applyTheme();
  render();
  registerServiceWorker();
}

init();
