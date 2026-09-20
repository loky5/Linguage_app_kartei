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
const DEFAULT_DAILY_GOAL = 20;

let STATE = null;
let SESSION = null; // sessione di pratica in corso

/* ---------------------------- Utilità generiche ---------------------------- */

function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function now() { return Date.now(); }

function pad2(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayStr() { return dateStr(new Date()); }

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
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeDE(s) {
  return s
    .toLowerCase()
    .replace(/\|/g, '')
    .replace(/\+\s*(akk|dat|gen)\b/g, '')
    .replace(/[.,;:!?()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^to /, '')
    .replace(/ \d+$/, '');
}

// Chiave per riconoscere la stessa parola tra versioni diverse dei dati
// (ignora maiuscole, "|", indicazioni +akk/dat/gen e il numero finale 1/2/3).
function wordKey(de) { return normalizeDE(String(de || '')); }

function answersMatchOne(input, target) {
  const a = normalizeDE(input);
  const b = normalizeDE(target);
  if (!a) return false;
  if (a === b) return true;
  if (simplifyUmlauts(a) === simplifyUmlauts(b)) return true;
  if (b.length >= 5 && levenshtein(simplifyUmlauts(a), simplifyUmlauts(b)) <= 1) return true;
  return false;
}

// I campi possono contenere più alternative separate da virgola (es. traduzioni
// italiane sinonime): basta indovinarne una.
// Verbi inglesi con le tre forme ("to go, went, have gone"): va scritta la voce completa
// (infinito, simple past e present perfect), quindi non si separano le virgole.
function isVerbForms(target) { return /^to [^,;]+,[^,;]+,[^,;]+$/i.test(String(target || '').trim()); }

function answersMatch(input, target) {
  if (isVerbForms(target)) return answersMatchOne(input, target);
  return String(target || '').split(/[,;]/).some(alt => answersMatchOne(input, alt));
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
  if (typeof STATE.settings.dailyGoal !== 'number') STATE.settings.dailyGoal = DEFAULT_DAILY_GOAL;
  if (!STATE.meta) STATE.meta = { createdAt: now() };
  if (!STATE.meta.activeDays) STATE.meta.activeDays = {};
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
  upgradeSeedIfNeeded();
}

const SEED_VERSION = (typeof SEED_DATA !== 'undefined' && SEED_DATA.version) || 1;
const isSeedCourseId = id => /^([se]\d+|c\d+-tedesco-.+)$/.test(id);
// Per i corsi solo inglese si usa l'infinito (i verbi hanno anche le altre forme).
const progressKey = w => (hasLang(w, 'de') ? wordKey(w.de) : 'en:' + wordKey(String(w.en).split(',')[0]));

// Quando i dati originali (Excel) vengono aggiornati, i corsi e le parole originali
// vengono sostituiti dalla nuova versione. I progressi restano: ogni parola nuova
// eredita quelli della stessa parola tedesca presente prima. Le parole, i livelli e i
// corsi creati a mano nell'app vengono conservati.
function upgradeSeedIfNeeded() {
  if (typeof SEED_DATA === 'undefined' || (STATE.meta.seedVersion || 1) >= SEED_VERSION) return;

  const oldCourses = STATE.courses, oldWords = STATE.words;
  const oldLevelInfo = new Map();
  oldCourses.forEach(c => c.levels.forEach(l => oldLevelInfo.set(l.id, { course: c, level: l })));
  const isSeedWord = w => isSeedCourseId(w.courseId) && /^(w\d+|[se]\d+-l\d+-\d+)$/.test(w.id);

  const progressByKey = new Map();
  oldWords.filter(isSeedWord).forEach(w => {
    const k = progressKey(w), prev = progressByKey.get(k);
    if (!prev || w.progress.stage > prev.stage) progressByKey.set(k, w.progress);
  });

  const seed = JSON.parse(JSON.stringify(SEED_DATA));
  const newWords = seed.words.map(w => {
    const p = progressByKey.get(progressKey(w));
    return { ...w, progress: p ? { ...p } : freshProgress() };
  });

  const customCourses = oldCourses.filter(c => !isSeedCourseId(c.id));
  const newCourseBySource = new Map(seed.courses.map(c => [c.sourceName, c]));
  const customWords = [];

  // livelli creati a mano dentro corsi originali: si agganciano al corso con lo stesso foglio
  oldCourses.filter(c => isSeedCourseId(c.id)).forEach(oc => {
    const nc = newCourseBySource.get(oc.sourceName);
    if (!nc) return;
    oc.levels.filter(l => !/^(l\d+|c\d+-.+-liv\d+|[se]\d+-l\d+)$/.test(l.id)).forEach(l => {
      nc.levels.push({ ...l, order: nc.levels.reduce((m, x) => Math.max(m, x.order), 0) + 1 });
      oldWords.filter(w => w.levelId === l.id).forEach(w => customWords.push({ ...w, courseId: nc.id }));
    });
  });

  // parole aggiunte a mano dentro un livello originale: stesso foglio e stesso nome di livello
  oldWords.filter(w => !isSeedWord(w) && isSeedCourseId(w.courseId)).forEach(w => {
    const info = oldLevelInfo.get(w.levelId);
    if (!info || customWords.some(x => x.id === w.id)) return;
    const nc = newCourseBySource.get(info.course.sourceName);
    const nl = nc && (nc.levels.find(l => l.name === info.level.name) || nc.levels.find(l => l.order === info.level.order) || nc.levels[nc.levels.length - 1]);
    if (nl) customWords.push({ ...w, courseId: nc.id, levelId: nl.id });
  });

  // corsi creati a mano (con i loro livelli e parole)
  const customCourseWords = oldWords.filter(w => customCourses.some(c => c.id === w.courseId));
  const baseOrder = seed.courses.length;
  customCourses.forEach((c, i) => { c.order = baseOrder + i + 1; });

  STATE.courses = seed.courses.concat(customCourses);
  STATE.words = newWords.concat(customWords, customCourseWords);
  STATE.meta.seedVersion = SEED_VERSION;
}

function seedFromSource() {
  const seed = typeof SEED_DATA !== 'undefined' ? SEED_DATA : { courses: [], words: [] };
  STATE = {
    courses: JSON.parse(JSON.stringify(seed.courses)),
    words: JSON.parse(JSON.stringify(seed.words)).map(w => ({
      ...w,
      progress: freshProgress(),
    })),
    settings: { theme: 'auto', dailyGoal: DEFAULT_DAILY_GOAL },
    meta: { createdAt: now(), activeDays: {}, seedVersion: SEED_VERSION },
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

// Una lingua è "attiva" per una parola solo se è stata compilata (testo non vuoto).
// Le parole dei corsi "solo inglese" non hanno il tedesco.
function hasLang(word, lang) { return !!(word[lang] && String(word[lang]).trim()); }

// Le lingue da esercitare per una parola, in ordine casuale.
function langsForWord(word) {
  const langs = LANGS.filter(l => hasLang(word, l));
  return shuffle(langs.length ? langs : ['de']);
}

function isEnOnlyCourse(course) { return !!(course && course.enOnly); }

function isDue(word) {
  const p = word.progress;
  return p.stage >= 1 && p.nextReview !== null && p.nextReview <= now();
}
function isNew(word) { return word.progress.stage === 0; }

function dueCount(words) { return words.filter(isDue).length; }
function newCount(words) { return words.filter(isNew).length; }
function masteredCount(words) { return words.filter(w => w.progress.stage >= 6).length; }

/* ---------------------------- Serie giornaliera (streak) ---------------------------- */

function recordActivityToday() {
  const t = todayStr();
  STATE.meta.activeDays[t] = (STATE.meta.activeDays[t] || 0) + 1;
}

function todayAnswerCount() { return STATE.meta.activeDays[todayStr()] || 0; }

// Giorni consecutivi con almeno una risposta, contando all'indietro da oggi
// (o da ieri, se oggi non si è ancora esercitato: la serie non è ancora rotta).
function currentStreak() {
  const days = STATE.meta.activeDays || {};
  const d = new Date();
  if (!days[dateStr(d)]) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (days[dateStr(d)]) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

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
  } else if (seg0 === 'search') {
    html = viewSearch();
  } else if (seg0 === 'manage' && seg1 === 'courses') {
    html = viewManageCourses();
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
function iconSearch() {
  return `<svg viewBox="0 0 24 24" fill="none" width="20" height="20"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}
function iconTrash() {
  return `<svg viewBox="0 0 24 24" fill="none" width="15" height="15"><path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m2 0-1 13a2 2 0 01-2 2H8a2 2 0 01-2-2L5 7h14z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function iconUp() {
  return `<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function iconDown() {
  return `<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function backRow(label, href) {
  return `<div class="back-row">
    <a href="#${href}" aria-label="Torna a ${esc(label)}">${iconBack()}</a>
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

  const streak = currentStreak();
  const goal = STATE.settings.dailyGoal || DEFAULT_DAILY_GOAL;
  const done = todayAnswerCount();
  const goalPct = Math.min(100, Math.round((done / goal) * 100));
  const streakBar = `
    <div class="streak-row">
      <div class="streak-flame ${streak > 0 ? 'lit' : ''}">${streak > 0 ? '\u{1F525}' : '\u{1F9CA}'}<span>${streak} ${streak === 1 ? 'giorno' : 'giorni'}</span></div>
      <div class="streak-goal">
        <div class="streak-goal-label">Oggi: ${done}/${goal} risposte</div>
        <div class="progress-track"><div class="progress-fill" style="width:${goalPct}%;background:var(--gold)"></div></div>
      </div>
    </div>
  `;

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
      <div style="display:flex;gap:4px">
        <a class="icon-btn" href="#/search" aria-label="Cerca parole">${iconSearch()}</a>
        <a class="icon-btn" href="#/settings" aria-label="Impostazioni">${iconGear()}</a>
      </div>
    </div>
    ${streakBar}
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

  const rows = levels.map((l, i) => {
    const words = wordsOfLevel(l.id);
    const due = dueCount(words);
    const nw = newCount(words);
    const mastered = masteredCount(words);
    return `<div class="level-row-wrap">
      <a class="level-row" href="#/level/${l.id}">
        <div class="num" style="--accent:var(--${colorVar(c.color)})">${levelNum(l)}</div>
        <div class="body">
          <div class="name">${esc(l.name)}</div>
          <div class="meta">${words.length} parole \u00b7 ${mastered} consolidate${due ? ` \u00b7 ${due} da ripassare` : ''}${nw ? ` \u00b7 ${nw} nuove` : ''}</div>
        </div>
        <div class="chev">${iconChevron()}</div>
      </a>
      <div class="manage-actions">
        <button class="icon-btn" data-action="level-up" data-level-id="${l.id}" aria-label="Sposta su" ${i === 0 ? 'disabled' : ''}>${iconUp()}</button>
        <button class="icon-btn" data-action="level-down" data-level-id="${l.id}" aria-label="Sposta gi\u00f9" ${i === levels.length - 1 ? 'disabled' : ''}>${iconDown()}</button>
        <button class="icon-btn" data-action="level-delete" data-level-id="${l.id}" aria-label="Elimina livello ${esc(l.name)}" style="color:var(--bad)">${iconTrash()}</button>
      </div>
    </div>`;
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
    <button class="settings-item danger" style="margin-top:18px" data-action="course-delete" data-course-id="${c.id}">Elimina corso
      <span class="sub">Cancella \u201c${esc(c.name)}\u201d e tutte le sue ${words.length} parole</span>
    </button>
  `;
}

function colorVar(color) {
  const map = { blue: 'blue', red: 'red', gold: 'gold', teal: 'teal', violet: 'violet', green: 'green', pink: 'pink', orange: 'orange', sky: 'sky' };
  return map[color] || 'navy';
}

// Numero mostrato nel riquadro del livello: quello scritto nel nome (come nel file Excel).
function levelNum(l) {
  const m = /\d+/.exec(l.name || '');
  return m ? m[0] : l.order;
}

/* ---------------------------- Vista: Livello ---------------------------- */

function viewLevel(levelId) {
  const found = getLevel(levelId);
  if (!found) return emptyState('Livello non trovato', 'Torna alla home.', '/home', 'Home');
  const { level: l, course: c } = found;
  const words = wordsOfLevel(l.id); // ordine originale del file Excel (nessun riordino alfabetico)
  const due = dueCount(words);
  const nw = newCount(words);

  const sortedLevels = c.levels.slice().sort((a, b) => a.order - b.order);
  const idx = sortedLevels.findIndex(lv => lv.id === l.id);
  const prevLevel = idx > 0 ? sortedLevels[idx - 1] : null;
  const nextLevel = idx < sortedLevels.length - 1 ? sortedLevels[idx + 1] : null;

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
        ${hasLang(w, 'de')
          ? `<div class="word-row-line"><span class="de">${esc(w.de)}</span></div>
        ${hasLang(w, 'en') ? `<div class="word-row-line"><span class="en">${esc(w.en)}</span></div>` : ''}`
          : `<div class="word-row-line"><span class="de">${esc(w.en)}</span></div>`}
        <div class="it">${esc(w.it)}</div>
      </div>
      <a class="icon-btn" style="width:26px;height:26px" href="#/edit/word/${w.id}" aria-label="Modifica parola ${esc(w.de || w.en)}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 000-3L18 6a2.1 2.1 0 00-3 0L4.5 16.5V20z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
      </a>
    </div>
  `).join('');

  return `
    ${backRow(c.name, '/course/' + c.id)}
    <div class="page-title">${esc(l.name)}</div>
    <div class="page-sub">${words.length} parole \u00b7 ${isEnOnlyCourse(c) ? 'ogni parola avanza quando sai l\u2019inglese' : 'ogni parola avanza solo se sai sia il tedesco sia l\u2019inglese'}</div>
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
    <div class="level-nav">
      ${prevLevel
        ? `<a class="level-nav-btn" href="#/level/${prevLevel.id}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${esc(prevLevel.name)}</span></a>`
        : `<span class="level-nav-btn disabled"></span>`}
      ${nextLevel
        ? `<a class="level-nav-btn" href="#/level/${nextLevel.id}"><span>${esc(nextLevel.name)}</span><svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`
        : `<span class="level-nav-btn disabled"></span>`}
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
  const colors = ['blue', 'red', 'gold', 'teal', 'violet', 'green', 'pink', 'orange', 'sky'];
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
    <form id="wordForm" data-level-id="${l.id}" ${isEdit ? `data-word-id="${word.id}"` : ''} ${isEnOnlyCourse(c) ? 'data-en-only="1"' : ''}>
      <div class="card">
        ${isEnOnlyCourse(c) ? '' : `<label class="field-label" for="wde">Tedesco</label>
        <input type="text" id="wde" value="${esc(isEdit ? word.de : '')}" required>`}
        <label class="field-label" for="wit">Italiano</label>
        <input type="text" id="wit" value="${esc(isEdit ? word.it : '')}" required>
        ${isEnOnlyCourse(c)
          ? `<label class="field-label" for="wen">Inglese</label>
        <input type="text" id="wen" value="${esc(isEdit && word.en ? word.en : '')}" required>`
          : `<label class="field-label" for="wen">Inglese <span style="font-weight:500;color:var(--ink-faint)">(lascia vuoto se non lo sai ancora)</span></label>
        <input type="text" id="wen" value="${esc(isEdit && word.en ? word.en : '')}">`}
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
    <div class="page-sub">Una parola per riga: <code>tedesco;italiano</code> oppure <code>tedesco;italiano;inglese</code>. Nei corsi solo inglese: <code>inglese;italiano</code></div>
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

/* ---------------------------- Vista: Cerca ---------------------------- */

function searchResultsHtml(query) {
  const q = query.trim().toLowerCase();
  if (!q) return `<div class="empty" style="padding:30px 20px"><p>Digita per cercare tra le ${STATE.words.length} parole (tedesco, italiano o inglese).</p></div>`;
  const matches = STATE.words.filter(w =>
    (w.de && w.de.toLowerCase().includes(q)) ||
    (w.it && w.it.toLowerCase().includes(q)) ||
    (w.en && w.en.toLowerCase().includes(q))
  ).slice(0, 100);
  if (matches.length === 0) return `<div class="empty" style="padding:30px 20px"><p>Nessuna parola trovata per “${esc(query)}”.</p></div>`;
  return matches.map(w => {
    const found = getLevel(w.levelId);
    const ctx = found ? `${esc(found.course.name)} · ${esc(found.level.name)}` : '';
    return `<a class="word-row search-result" href="#/edit/word/${w.id}">
      <span class="stage-dot" data-lvl="${stageBucket(w.progress.stage)}"></span>
      <div class="word-row-main">
        ${hasLang(w, 'de')
          ? `<div class="word-row-line"><span class="de">${esc(w.de)}</span></div>
        ${hasLang(w, 'en') ? `<div class="word-row-line"><span class="en">${esc(w.en)}</span></div>` : ''}`
          : `<div class="word-row-line"><span class="de">${esc(w.en)}</span></div>`}
        <div class="it">${esc(w.it)}</div>
        ${ctx ? `<div class="search-ctx">${ctx}</div>` : ''}
      </div>
    </a>`;
  }).join('');
}

function viewSearch() {
  return `
    ${backRow('Home', '/home')}
    <div class="page-title">Cerca</div>
    <div class="page-sub">Trova una parola tra i tuoi corsi, in qualunque lingua</div>
    <input type="text" id="searchInput" class="type-input" style="text-align:left" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Cerca in tedesco, italiano o inglese…">
    <div class="card" style="padding:6px 10px;margin-top:16px" id="searchResults">
      ${searchResultsHtml('')}
    </div>
  `;
}

/* ---------------------------- Vista: Gestisci corsi ---------------------------- */

function viewManageCourses() {
  const courses = STATE.courses.slice().sort((a, b) => a.order - b.order);
  const rows = courses.map((c, i) => {
    const words = wordsOfCourse(c.id);
    return `<div class="manage-row">
      <div class="chip accent-${c.color}" style="background:var(--accent)"></div>
      <div class="body">
        <div class="name">${esc(c.name)}</div>
        <div class="meta">${words.length} parole · ${c.levels.length} livelli</div>
      </div>
      <div class="manage-actions">
        <button class="icon-btn" data-action="course-up" data-course-id="${c.id}" aria-label="Sposta su" ${i === 0 ? 'disabled' : ''}>${iconUp()}</button>
        <button class="icon-btn" data-action="course-down" data-course-id="${c.id}" aria-label="Sposta giù" ${i === courses.length - 1 ? 'disabled' : ''}>${iconDown()}</button>
        <button class="icon-btn" data-action="course-delete" data-course-id="${c.id}" aria-label="Elimina corso ${esc(c.name)}" style="color:var(--bad)">${iconTrash()}</button>
      </div>
    </div>`;
  }).join('');

  return `
    ${backRow('Impostazioni', '/settings')}
    <div class="page-title">Gestisci corsi</div>
    <div class="page-sub">Riordina o elimina i tuoi corsi</div>
    ${rows || emptyState('Nessun corso', 'Crea il tuo primo corso.', '/add/course', 'Crea un corso')}
  `;
}

/* ---------------------------- Vista: Sessione (pratica) ---------------------------- */

function buildScopeWords(scopeType, scopeId) {
  if (scopeType === 'all') return STATE.words;
  if (scopeType === 'course') return wordsOfCourse(scopeId);
  if (scopeType === 'level') return wordsOfLevel(scopeId);
  return [];
}

function buildItemQueue(chosen) {
  const queue = [];
  chosen.forEach(w => langsForWord(w).forEach(l => queue.push({ wordId: w.id, lang: l })));
  return queue;
}
// "Impara nuove" segue l'ordine originale del livello (come nel file Excel),
// non un ordine casuale, così le parole si imparano in sequenza.
function buildLearnQueue(scopeWords) {
  return buildItemQueue(scopeWords.filter(isNew).slice(0, NEW_BATCH_SIZE));
}
// Il ripasso pesca invece a caso tra le parole dovute, per non rivedere sempre le stesse.
function buildReviewQueue(scopeWords) {
  return buildItemQueue(sample(scopeWords.filter(isDue), REVIEW_BATCH_SIZE));
}

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

// Significati separati da ";" o ",": un distrattore non deve condividerne nessuno con la
// risposta giusta (es. "fare" e "fare; creare" sarebbero entrambi corretti).
function meaningsOf(s) { return String(s || '').toLowerCase().split(/[;,]/).map(t => t.trim()).filter(Boolean); }

function distractorsFor(word, field, count) {
  const correct = new Set(meaningsOf(word[field]));
  const ok = w => w.id !== word.id && w[field] && w[field] !== word[field] && !meaningsOf(w[field]).some(t => correct.has(t));
  let pool = SESSION.pool.filter(ok);
  if (pool.length < count) pool = STATE.words.filter(ok);
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
    <a class="icon-btn" href="#/home" aria-label="Esci dalla sessione" onclick="return confirm('Uscire dalla sessione? I progressi fatti finora restano salvati.')">
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
      ${hasLang(word, 'de')
        ? `<div class="learn-de">${esc(word.de)}</div>
      ${hasLang(word, 'en') ? `<div class="learn-en-big">${esc(word.en)}</div>` : ''}`
        : `<div class="learn-de">${esc(word.en)}</div>`}
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
  const reverse = SESSION.mode === 'review' && Math.random() < 0.3;
  if (!SESSION.exercise || SESSION.exercise.wordId !== word.id || SESSION.exercise.lang !== lang || SESSION.exercise.kind !== 'typing') {
    const promptField = reverse ? lang : 'it';
    const answerField = reverse ? 'it' : lang;
    SESSION.exercise = { kind: 'typing', wordId: word.id, lang, promptField, answerField, answered: false };
  }
  const ex = SESSION.exercise;
  const kicker = ex.answerField === 'it' ? 'Scrivi in italiano' : `Scrivi in ${langLabel(lang)}`;
  return `
    ${renderSessionProgress()}
    <div class="quiz-kicker-row"><span class="quiz-kicker">${kicker}</span>${langBadge(lang)}</div>
    <div class="prompt-card accent-${accentColor}">
      <div class="prompt-sub">${esc(word[ex.promptField])}</div>
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
  recordActivityToday();
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
      <div class="summary-stat"><span class="label">Domande totali</span><span class="val">${SESSION.total}</span></div>
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

    <div class="section-title">Obiettivo giornaliero</div>
    <div class="card">
      <label class="field-label" for="goalInput">Risposte al giorno per tenere viva la serie</label>
      <input type="number" id="goalInput" min="1" max="500" value="${STATE.settings.dailyGoal || DEFAULT_DAILY_GOAL}">
    </div>

    <div class="section-title">Corsi</div>
    <a class="settings-item" href="#/manage/courses">Gestisci corsi
      <span class="sub">Riordina o elimina corsi esistenti</span>
    </a>

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

/* ---------------------------- Gestione corsi e livelli ---------------------------- */

// Scambia l'ordine con il vicino (sopra o sotto) in base alla posizione ordinata attuale.
function swapOrder(sortedList, id, dir) {
  const idx = sortedList.findIndex(x => x.id === id);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= sortedList.length) return;
  const a = sortedList[idx], b = sortedList[swapIdx];
  const tmp = a.order; a.order = b.order; b.order = tmp;
}

function moveCourse(courseId, dir) {
  const sorted = STATE.courses.slice().sort((a, b) => a.order - b.order);
  swapOrder(sorted, courseId, dir);
  saveState();
  render();
}

function moveLevel(levelId, dir) {
  const found = getLevel(levelId);
  if (!found) return;
  const sorted = found.course.levels.slice().sort((a, b) => a.order - b.order);
  swapOrder(sorted, levelId, dir);
  saveState();
  render();
}

function deleteCourse(courseId) {
  const c = getCourse(courseId);
  if (!c) return;
  const words = wordsOfCourse(courseId);
  if (!confirm(`Eliminare il corso “${c.name}” e tutte le sue ${words.length} parole? Questa azione non si può annullare.`)) return;
  STATE.courses = STATE.courses.filter(x => x.id !== courseId);
  STATE.words = STATE.words.filter(w => w.courseId !== courseId);
  saveState();
  toast('Corso eliminato');
  nav('/home');
}

function deleteLevel(levelId) {
  const found = getLevel(levelId);
  if (!found) return;
  const words = wordsOfLevel(levelId);
  if (!confirm(`Eliminare il livello “${found.level.name}” e tutte le sue ${words.length} parole? Questa azione non si può annullare.`)) return;
  found.course.levels = found.course.levels.filter(l => l.id !== levelId);
  STATE.words = STATE.words.filter(w => w.levelId !== levelId);
  saveState();
  toast('Livello eliminato');
  nav('/course/' + found.course.id);
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
    const enOnly = !!wordForm.dataset.enOnly;
    const de = enOnly ? '' : document.getElementById('wde').value.trim();
    const it = document.getElementById('wit').value.trim();
    const en = document.getElementById('wen').value.trim();
    if ((!enOnly && !de) || !it || (enOnly && !en)) return;
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
      if (isEnOnlyCourse(found.course)) {
        // corsi solo inglese: inglese;italiano (i significati multipli dell'italiano restano uniti)
        if (parts.length >= 2 && parts[0] && parts[1]) {
          STATE.words.push({
            id: uid('w'), courseId: found.course.id, levelId,
            de: '', en: parts[0], it: parts.slice(1).filter(Boolean).join('; '),
            progress: freshProgress(),
          });
          added++;
        }
        return;
      }
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
      const answerField = SESSION.exercise.answerField;
      const correct = answersMatch(input.value, word[answerField]);
      input.disabled = true;
      const fb = document.getElementById('typingFeedback');
      fb.innerHTML = `<div class="type-feedback ${correct ? 'good' : 'bad'}">${correct ? 'Esatto!' : 'Non proprio.'}${!correct ? `<span class="answer">${esc(word[answerField])}</span>` : ''}</div>`;
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

  const goalInput = document.getElementById('goalInput');
  if (goalInput) goalInput.addEventListener('change', () => {
    const v = parseInt(goalInput.value, 10);
    STATE.settings.dailyGoal = (v > 0) ? v : DEFAULT_DAILY_GOAL;
    saveState();
    toast('Obiettivo aggiornato');
  });

  // gestione corsi (riordino/eliminazione)
  app.querySelectorAll('[data-action="course-up"]').forEach(b => b.addEventListener('click', () => moveCourse(b.dataset.courseId, -1)));
  app.querySelectorAll('[data-action="course-down"]').forEach(b => b.addEventListener('click', () => moveCourse(b.dataset.courseId, 1)));
  app.querySelectorAll('[data-action="course-delete"]').forEach(b => b.addEventListener('click', () => deleteCourse(b.dataset.courseId)));

  // gestione livelli (riordino/eliminazione)
  app.querySelectorAll('[data-action="level-up"]').forEach(b => b.addEventListener('click', () => moveLevel(b.dataset.levelId, -1)));
  app.querySelectorAll('[data-action="level-down"]').forEach(b => b.addEventListener('click', () => moveLevel(b.dataset.levelId, 1)));
  app.querySelectorAll('[data-action="level-delete"]').forEach(b => b.addEventListener('click', () => deleteLevel(b.dataset.levelId)));

  // ricerca (filtro live, senza cambiare rotta a ogni carattere)
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.focus();
    searchInput.addEventListener('input', () => {
      document.getElementById('searchResults').innerHTML = searchResultsHtml(searchInput.value);
    });
  }

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
