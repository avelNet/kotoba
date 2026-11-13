'use strict';

/* ================= Данные и колоды ================= */

const DATA = (typeof buildData !== 'undefined' ? buildData : require('./data.js').buildData)();
const DECKS = [
  { key: 'hira',  name: 'Хирагана', needs: null,   defNew: 10 },
  { key: 'kata',  name: 'Катакана', needs: 'hira', defNew: 10 },
  { key: 'words', name: 'Слова',    needs: 'hira', defNew: 10 },
  { key: 'kanji', name: 'Кандзи',   needs: 'kata', defNew: 3 },
  { key: 'wk',    name: 'Слова в кандзи', needs: 'kata', defNew: 10 },
  { key: 'mine',  name: 'Мои слова', needs: null,  defNew: 10 },
];
DATA.mine = [];
DATA.wk = [];
const BY_ID = {};
for (const d of DECKS) for (const c of DATA[d.key]) BY_ID[c.id] = c;

// Свои слова хранятся в состоянии как {id, k: кана, j: кандзи, r: перевод, c: категория}
function setCustom(list, state) {
  if (state) syncBuiltin(state);
  for (const c of DATA.mine) delete BY_ID[c.id];
  DATA.mine = (list || []).map(w => ({ id: w.id, deck: 'mine', front: w.k, kanji: w.j || '', ru: w.r, cat: w.c || '' }));
  for (const c of DATA.mine) BY_ID[c.id] = c;
  rebuildWK();
}
// «Слова в кандзи»: для каждого слова с кандзи — отдельная карточка «кандзи → чтение и перевод».
// Создаются автоматически, ничего вручную исправлять не нужно.
function categories() {
  const out = [];
  for (const c of DATA.mine) if (c.cat && !out.includes(c.cat)) out.push(c.cat);
  return out;
}
// onlyDeck может быть 'mine#Числа' — только одна категория своих слов
function splitDeck(onlyDeck) {
  if (!onlyDeck) return [null, null];
  const i = onlyDeck.indexOf('#');
  return i < 0 ? [onlyDeck, null] : [onlyDeck.slice(0, i), onlyDeck.slice(i + 1)];
}
const isKanjiChar = ch => /[\u4e00-\u9fff\u3005]/.test(ch);
let builtinOff = false; // выключен ли встроенный набор слов (зеркало S.settings.builtin)
const syncBuiltin = st => { builtinOff = !!(st && st.settings && st.settings.builtin === false); };
const wordSources = () => builtinOff ? DATA.mine : [...DATA.words, ...DATA.mine];
function rebuildWK() {
  for (const c of DATA.wk) delete BY_ID[c.id];
  const seen = new Set();
  DATA.wk = [];
  for (const w of wordSources()) {
    if (!w.kanji || ![...w.kanji].some(isKanjiChar)) continue;
    const id = 'x:' + w.id;
    if (seen.has(id)) continue; seen.add(id);
    DATA.wk.push({ id, deck: 'wk', front: w.kanji, kana: w.front, ru: w.ru, src: w.id });
  }
  for (const c of DATA.wk) BY_ID[c.id] = c;
}
rebuildWK();
// Карточка слова в кандзи открывается, когда само слово уже знакомо и все его кандзи пройдены в колоде «Кандзи»
function wkEligible(state, c) {
  const src = state.cards[c.src];
  if (!src || !(src.r >= 1)) return false;
  for (const ch of c.front) {
    if (!isKanjiChar(ch)) continue;
    if (!BY_ID['j:' + ch] || !state.cards['j:' + ch]) return false;
  }
  return true;
}
// Порядок новых кандзи: сначала знаки из уже знакомых слов (чаще встречающиеся — раньше), потом остальные
function kanjiOrder(state) {
  const freq = {};
  for (const w of [...DATA.words, ...DATA.mine]) {
    if (!w.kanji || !state.cards[w.id]) continue;
    for (const ch of new Set(w.kanji)) if (isKanjiChar(ch)) freq[ch] = (freq[ch] || 0) + 1;
  }
  return DATA.kanji.map((c, i) => ({ c, i, f: freq[c.front] || 0 }))
    .sort((a, b) => (b.f > 0) - (a.f > 0) || b.f - a.f || a.i - b.i).map(x => x.c);
}
const cleanField = v => String(v || '').replace(/[\t\n\r|]+/g, ' ').trim();

/* ================= Алгоритм повторений (упрощённый SM-2) ================= */

const DAY_MS = 864e5;
const ROLLOVER_HOURS = 4; // новый «день» начинается в 4:00, как в Anki

function dayNumber(date = new Date()) {
  const t = date.getTime() - date.getTimezoneOffset() * 6e4 - ROLLOVER_HOURS * 36e5;
  return Math.floor(t / DAY_MS);
}

// Карточка: i — интервал (дни, 0 = в процессе заучивания), e — лёгкость ×100,
// d — день следующего показа, r — число ответов, l — число забываний.
function newCardState(today) { return { i: 0, e: 250, d: today, r: 0, l: 0 }; }

// g: 0 Снова, 1 Трудно, 2 Хорошо, 3 Легко. requeue = показать ещё раз в этом занятии.
function schedule(c, g, today) {
  const n = { ...c, r: c.r + 1 };
  if (g === 0) {
    if (c.i > 0) n.l = c.l + 1;
    n.i = 0; n.e = Math.max(130, c.e - 20); n.d = today;
    return { card: n, requeue: true };
  }
  if (c.i === 0) {
    if (g === 1) { n.d = today; return { card: n, requeue: true }; }
    n.i = g === 2 ? 1 : 3;
    if (g === 3) n.e = c.e + 15;
  } else {
    const f = c.e / 100;
    if (g === 1) { n.i = Math.max(c.i + 1, Math.round(c.i * 1.2)); n.e = Math.max(130, c.e - 15); }
    else if (g === 2) { n.i = Math.max(c.i + 1, Math.round(c.i * f)); }
    else { n.i = Math.max(Math.max(c.i + 1, Math.round(c.i * f)) + 1, Math.round(c.i * f * 1.3)); n.e = c.e + 15; }
  }
  n.i = Math.min(n.i, 365);
  n.d = today + n.i;
  return { card: n, requeue: false };
}

function fmtInterval(res) {
  if (res.requeue) return 'сейчас';
  const i = res.card.i;
  if (i < 30) return i + ' д';
  if (i < 365) return Math.round(i / 30) + ' мес';
  return '1 год';
}

/* ================= Состояние ================= */

function freshState() {
  const newPerDay = {};
  for (const d of DECKS) newPerDay[d.key] = d.defNew;
  return {
    v: 1, ts: 0, cards: {}, custom: [], time: { start: null, days: {} },
    profile: { name: '', about: '', goal: 'N4', exam: '', avatar: { type: 'auto', char: '学', color: '#d1453b' } },
    photo: '',
    daily: { day: -1, new: {}, reviews: 0 },
    settings: { newPerDay, tts: true, remind: 8, builtin: true },
    intro: false,
    streak: { last: -1, count: 0 },
  };
}

function normalize(s) {
  const f = freshState();
  if (!s || typeof s !== 'object' || typeof s.cards !== 'object') return f;
  return {
    v: 1, ts: s.ts || 0, cards: s.cards,
    custom: Array.isArray(s.custom) ? s.custom.filter(w => w && w.id && w.k && w.r) : [],
    time: (s.time && typeof s.time.days === 'object') ? { start: s.time.start ?? null, days: s.time.days } : f.time,
    profile: { ...f.profile, ...(s.profile || {}), avatar: { ...f.profile.avatar, ...((s.profile || {}).avatar || {}) } },
    photo: typeof s.photo === 'string' ? s.photo : '',
    daily: { ...f.daily, ...(s.daily || {}) },
    settings: { ...f.settings, ...(s.settings || {}), newPerDay: { ...f.settings.newPerDay, ...((s.settings || {}).newPerDay || {}) } },
    streak: { ...f.streak, ...(s.streak || {}) },
    intro: !!s.intro,
  };
}

function rollDay(state, today) {
  if (state.daily.day !== today) state.daily = { day: today, new: {}, reviews: 0 };
}

function introducedCount(state, deckKey) {
  let n = 0;
  for (const c of DATA[deckKey]) if (state.cards[c.id]) n++;
  return n;
}
function deckComplete(state, deckKey) { return introducedCount(state, deckKey) === DATA[deckKey].length; }
function deckUnlocked(state, deck) { return !deck.needs || deckComplete(state, deck.needs); }

function newAvailable(state, deck, extra = 0, cat = null) {
  if (!deckUnlocked(state, deck)) return [];
  if (deck.key === 'words' && state.settings.builtin === false) return [];
  const done = state.daily.new[deck.key] || 0;
  let left = (state.settings.newPerDay[deck.key] || 0) - done + extra;
  const kataReady = deckComplete(state, 'kata');
  const out = [];
  let list = DATA[deck.key];
  if (deck.key === 'kanji') list = kanjiOrder(state);
  if (deck.key === 'wk') list = DATA.wk.filter(c => !state.cards[c.id] && wkEligible(state, c))
    .sort((a, b) => (state.cards[b.src].i || 0) - (state.cards[a.src].i || 0));
  for (const c of list) {
    if (left <= 0) break;
    if (state.cards[c.id]) continue;
    if (cat != null && c.cat !== cat) continue;
    if (c.hasKata && !kataReady) continue;
    out.push(c.id); left--;
  }
  return out;
}

function dueIds(state, today, deckKey, cat = null) {
  const out = [];
  for (const id in state.cards) {
    const c = BY_ID[id];
    if (!c || (deckKey && c.deck !== deckKey)) continue;
    if (builtinOff && (c.deck === 'words' || (c.deck === 'wk' && c.src && c.src.startsWith('w:')))) continue;
    if (cat != null && c.cat !== cat) continue;
    if (state.cards[id].d <= today) out.push(id);
  }
  return out;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function buildQueue(state, today, extra = 0, onlyDeck = null) {
  rollDay(state, today);
  const [deckKey, cat] = splitDeck(onlyDeck);
  const due = shuffle(dueIds(state, today, deckKey, cat));
  // новые карточки разных колод чередуем по очереди: кана, слово, кана, слово…
  const decks = DECKS.filter(d => !deckKey || d.key === deckKey);
  // сначала кандзи-версии уже знакомых слов, потом остальные новые вперемешку
  const wkNews = decks.filter(d => d.key === 'wk').flatMap(d => newAvailable(state, d, extra));
  const perDeck = decks.filter(d => d.key !== 'wk').map(d => newAvailable(state, d, extra, cat));
  const news = [...wkNews];
  for (let i = 0; perDeck.some(l => i < l.length); i++) for (const l of perDeck) if (i < l.length) news.push(l[i]);
  if (!due.length) return news;
  if (!news.length) return due;
  // равномерно перемешиваем новые с повторениями, сохраняя порядок новых
  const out = [], step = (due.length + news.length) / news.length;
  let ni = 0, di = 0;
  for (let k = 0; k < due.length + news.length; k++) {
    if (ni < news.length && k >= Math.round(ni * step + step / 2 - 0.5)) out.push(news[ni++]);
    else if (di < due.length) out.push(due[di++]);
    else out.push(news[ni++]);
  }
  return out;
}

// Свободное повторение: выученные карточки, слабые (короткий интервал, частые забывания) — в приоритете
function practiceQueue(state, filter, size = 20) {
  const pool = [];
  for (const id in state.cards) {
    const c = BY_ID[id];
    if (!c) continue;
    const st = state.cards[id];
    // карточка только показана, но ещё ни разу не проверялась — ей место в обычном занятии, не в тренировке
    if (!(st.r > 0)) continue;
    if (builtinOff && (c.deck === 'words' || (c.deck === 'wk' && c.src && c.src.startsWith('w:')))) continue;
    if (filter === 'rj') { if (c.deck !== 'words' && c.deck !== 'mine') continue; }
    else if (filter === 'hard' ? !(st.l > 0 || st.e < 230 || st.i <= 1) : (filter !== 'all' && c.deck !== filter)) continue;
    pool.push({ id, w: st.l * 3 + 10 / (st.i + 1) + Math.random() * 4 });
  }
  pool.sort((a, b) => b.w - a.w);
  return shuffle(pool.slice(0, size).map(x => x.id));
}

function markStudied(state, today) {
  if (state.streak.last === today) return;
  state.streak.count = state.streak.last === today - 1 ? state.streak.count + 1 : 1;
  state.streak.last = today;
}

/* ================= Хранение: Telegram CloudStorage + localStorage ================= */

// Лимит значения CloudStorage — 4096; японские и русские буквы в UTF-8 весят 2–3 байта,
// поэтому режем строки по байтам с запасом, а не по символам
const CHUNK_BYTES = 3800;
const utf8len = str => { let n = 0; for (const ch of str) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };
function packLines(lines, max = CHUNK_BYTES) {
  const out = []; let cur = '', curB = 0;
  for (const line of lines) {
    const b = utf8len(line);
    if (cur && curB + 1 + b > max) { out.push(cur); cur = ''; curB = 0; }
    cur = cur ? cur + '\n' + line : line; curB += (curB ? 1 : 0) + b;
  }
  if (cur) out.push(cur);
  return out;
}

function serializeChunks(state) {
  return packLines(Object.keys(state.cards).map(id => {
    const c = state.cards[id];
    return [id, c.i, c.e, c.d, c.r, c.l].join('|');
  }));
}
function parseChunks(chunks) {
  const cards = {};
  for (const ch of chunks) {
    if (!ch) continue;
    for (const line of ch.split('\n')) {
      const p = line.split('|');
      if (p.length !== 6) continue;
      cards[p[0]] = { i: +p[1], e: +p[2], d: +p[3], r: +p[4], l: +p[5] };
    }
  }
  return cards;
}
function metaOf(state, n, nu = 0, nt = 0, np = 0) {
  const { cards, custom, time, photo, ...rest } = state;
  return JSON.stringify({ ...rest, n, nu, nt, np });
}
function serializePhoto(state) {
  const p = state.photo || '', out = [];
  for (let k = 0; k < p.length; k += 3500) out.push(p.slice(k, k + 3500));
  return out;
}
// Время занятий: строки «день|сек в приложении|сек добавлено вручную», первая строка — «s|день начала учёта»
function serializeTime(state) {
  const t = state.time || { start: null, days: {} };
  const lines = [`s|${t.start ?? ''}`];
  for (const d of Object.keys(t.days).sort((a, b) => a - b)) {
    const v = t.days[d]; lines.push(`${d}|${Math.round(v.a || 0)}|${Math.round(v.m || 0)}`);
  }
  return packLines(lines);
}
function parseTime(chunks) {
  const t = { start: null, days: {} };
  for (const ch of chunks) {
    if (!ch) continue;
    for (const line of ch.split('\n')) {
      const p = line.split('|');
      if (p[0] === 's') { t.start = p[1] === '' ? null : +p[1]; continue; }
      if (p.length === 3) t.days[p[0]] = { a: +p[1], m: +p[2] };
    }
  }
  return t;
}
// Группы кусков в CloudStorage: c — карточки, u — свои слова, t — время
const GROUPS = [
  { prefix: 'c', meta: 'n',  ser: serializeChunks, parse: (ch, out) => { out.cards = parseChunks(ch); } },
  { prefix: 'u', meta: 'nu', ser: serializeCustom, parse: (ch, out) => { out.custom = parseCustom(ch); } },
  { prefix: 't', meta: 'nt', ser: serializeTime,   parse: (ch, out) => { if (ch.length) out.time = parseTime(ch); } },
  { prefix: 'p', meta: 'np', ser: serializePhoto,  parse: (ch, out) => { out.photo = ch.join(''); } },
];
// Свои слова — отдельными кусками до ~3500 символов
function serializeCustom(state) {
  return packLines((state.custom || []).map(w => [w.id, w.k, w.j || '', w.r, ...(w.c ? [w.c] : [])].map(cleanField).join('\t')));
}
function parseCustom(chunks) {
  const list = [];
  for (const ch of chunks) {
    if (!ch) continue;
    for (const line of ch.split('\n')) {
      const p = line.split('\t');
      if (p.length >= 4 && p[0] && p[1] && p[3]) list.push({ id: p[0], k: p[1], j: p[2], r: p[3], ...(p[4] ? { c: p[4] } : {}) });
    }
  }
  return list;
}

const Store = {
  cloud: null, savedG: { c: [], u: [], t: [], p: [] }, timer: null, chain: Promise.resolve(),
  why: '', lastSync: 0, failed: false,
  init() {
    const tg = typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.initData) this.why = 'приложение открыто не через Telegram-бота';
    else if (!tg.isVersionAtLeast || !tg.isVersionAtLeast('6.9') || !tg.CloudStorage) this.why = `старая версия Telegram (${tg.version}), обнови приложение`;
    else this.cloud = tg.CloudStorage;
  },
  loadLocal() {
    try { return JSON.parse(localStorage.getItem('kotoba')); } catch (e) { return null; }
  },
  saveLocal(state) {
    try { localStorage.setItem('kotoba', JSON.stringify(state)); } catch (e) {}
  },
  call(method, ...args) {
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 5000);
      try {
        this.cloud[method](...args, (err, res) => { clearTimeout(t); if (err) this.lastErr = String(err); resolve(err ? null : (res === undefined ? true : res)); });
      } catch (e) { clearTimeout(t); resolve(null); }
    });
  },
  async loadCloud() {
    if (!this.cloud) return null;
    const raw = await this.call('getItem', 'm');
    if (!raw) return null;
    let meta; try { meta = JSON.parse(raw); } catch (e) { return null; }
    const keysBy = GROUPS.map(g => Array.from({ length: meta[g.meta] || 0 }, (_, k) => g.prefix + k));
    const all = keysBy.flat();
    let res = {};
    if (all.length) { res = await this.call('getItems', all); if (!res) return null; }
    const { n, nu, nt, np, ...rest } = meta;
    const out = { ...rest };
    GROUPS.forEach((g, gi) => {
      const ch = keysBy[gi].map(k => res[k] || '');
      this.savedG[g.prefix] = ch.slice();
      g.parse(ch, out);
    });
    return out;
  },
  async load() {
    this.init();
    const local = this.loadLocal();
    const cloud = await this.loadCloud();
    const best = (cloud && (!local || (cloud.ts || 0) >= (local.ts || 0))) ? cloud : local;
    return normalize(best);
  },
  save(state, immediate) {
    state.ts = Date.now();
    this.saveLocal(state);
    if (!this.cloud) return;
    clearTimeout(this.timer);
    // Сохраняем почти сразу: мини-приложение могут закрыть в любой момент
    this.timer = setTimeout(() => { this.chain = this.chain.then(() => this.flush(state)); }, immediate ? 0 : 250);
  },
  async flush(state) {
    let ok = true;
    const counts = {};
    for (const g of GROUPS) {
      const chunks = g.ser(state), saved = this.savedG[g.prefix];
      counts[g.meta] = chunks.length;
      for (let k = 0; k < chunks.length; k++) {
        if (chunks[k] === saved[k]) continue;
        if (await this.call('setItem', g.prefix + k, chunks[k])) saved[k] = chunks[k];
        else ok = false;
      }
      if (saved.length > chunks.length) {
        const extra = []; for (let k = chunks.length; k < saved.length; k++) extra.push(g.prefix + k);
        if (await this.call('removeItems', extra)) saved.length = chunks.length;
      }
    }
    // Метаданные пишем только если все куски записались, иначе облако останется в согласованном старом состоянии
    if (ok && await this.call('setItem', 'm', metaOf(state, counts.n, counts.nu, counts.nt, counts.np))) {
      this.failed = false; this.lastSync = Date.now();
    } else {
      this.failed = true;
    }
    updateSyncBadge();
  },
};

function syncText() {
  if (!Store.cloud) return `⚠️ Прогресс только на этом устройстве: ${Store.why}`;
  if (Store.failed) return '⚠️ Не удалось сохранить в облако, попробую ещё раз' + (Store.lastErr ? ` (${Store.lastErr})` : '');
  if (!Store.lastSync) return '☁️ Прогресс хранится в облаке Telegram';
  const d = new Date(Store.lastSync);
  return `☁️ Сохранено в облаке Telegram · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function updateSyncBadge() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('sync');
  if (el) { el.textContent = syncText(); el.classList.toggle('warn', !Store.cloud || Store.failed); }
}

/* ================= Озвучка ================= */

function speak(text) {
  try {
    if (!text || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; u.rate = 0.85;
    const v = speechSynthesis.getVoices().find(v => (v.lang || '').toLowerCase().startsWith('ja'));
    if (v) u.voice = v;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch (e) {}
}

/* ================= Интерфейс ================= */

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const TG = () => (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) ? window.Telegram.WebApp : null;
function haptic(kind) { try { const tg = TG(); if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {} }

let S = null;          // состояние
let session = null;    // текущее занятие
const $app = () => document.getElementById('app');

function setBack(fn) {
  const tg = TG();
  if (!tg || !tg.BackButton) return;
  tg.BackButton.offClick(setBack._h || (() => {}));
  if (fn) { setBack._h = fn; tg.BackButton.onClick(fn); tg.BackButton.show(); }
  else { setBack._h = null; tg.BackButton.hide(); }
}

// Нижняя панель вкладок: показывается на главной, в словаре и настройках, прячется во время занятия
let currentTab = 'home';
function setTabs(active) {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  document.body.classList.toggle('has-tabs', !!active);
  nav.hidden = !active;
  if (!active) return;
  currentTab = active;
  nav.querySelectorAll('button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === active ? 'page' : 'false'));
}
function openTab(tab) {
  if (tab === 'dict') renderDict();
  else if (tab === 'profile') renderProfile();
  else if (tab === 'settings') renderSettings();
  else renderHome();
  window.scrollTo(0, 0);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function renderHome() {
  setBack(null);
  setTabs('home');
  const today = dayNumber();
  rollDay(S, today);
  const dueAll = dueIds(S, today).length;
  let newAll = 0;
  const rows = DECKS.filter(d => !(d.key === 'words' && S.settings.builtin === false)).map(d => {
    const total = DATA[d.key].length, intro = introducedCount(S, d.key);
    const due = dueIds(S, today, d.key).length;
    const nw = newAvailable(S, d).length; newAll += nw;
    const unlocked = deckUnlocked(S, d);
    const needName = d.needs ? DECKS.find(x => x.key === d.needs).name : '';
    const wkReady = d.key === 'wk' ? DATA.wk.filter(c => S.cards[c.id] || wkEligible(S, c)).length : 0;
    const status = d.key === 'mine' && !total ? 'добавь свои слова во вкладке «Словарь»'
      : d.key === 'wk' && unlocked && !wkReady ? 'появятся, когда пройдёшь кандзи из знакомых слов'
      : !unlocked ? `🔒 после «${esc(needName)}»`
      : intro === total ? `пройдено, повторений: ${due}`
      : `новых: ${nw} · повторить: ${due}`;
    const playable = unlocked && (due + nw) > 0;
    return `<div class="deck${unlocked ? '' : ' locked'}${playable ? ' playable' : ''}" data-k="${d.key}">
      <div class="deck-top"><b>${esc(d.name)}</b><span class="muted">${intro}/${total}</span></div>
      <div class="bar"><i style="width:${total ? (intro / total * 100).toFixed(1) : 0}%"></i></div>
      <div class="muted small">${status}${playable ? ' · <span class="accent">учить только её ▶</span>' : ''}</div></div>`

  }).join('');
  const tomorrow = dueIds(S, today + 1).length;
  const streak = S.streak.last >= today - 1 ? S.streak.count : 0;
  const total = dueAll + newAll;
  $app().innerHTML = `
    <header class="hero">
      <div class="logo">言葉</div>
      <div><div class="title">Котоба</div><div class="muted small">🔥 ${streak} ${plural(streak, 'день', 'дня', 'дней')} подряд · сегодня ответов: ${S.daily.reviews}</div></div>
    </header>
    <section class="today">
      <div class="stat"><div class="num">${dueAll}</div><div class="muted small">повторить</div></div>
      <div class="stat"><div class="num accent">${newAll}</div><div class="muted small">новых</div></div>
      <div class="stat"><div class="num">${tomorrow}</div><div class="muted small">завтра</div></div>
    </section>
    ${total ? `<button class="btn primary big" id="go">Начать занятие · ${total}</button>`
      : `<div class="done">На сегодня всё 🎉<div class="muted small">Возвращайся завтра — повторения уже запланированы.</div></div>
         <button class="btn big" id="more">Учить ещё 10 новых</button>`}
    ${Object.keys(S.cards).length ? `<button class="btn big" id="practice">🔁 Повторить изученное</button>` : ''}
    <h3>Колоды</h3>
    ${rows}
    <div id="sync" class="muted small center"></div>`;
  updateSyncBadge();
  const go = document.getElementById('go');
  if (go) go.onclick = () => startSession(0);
  const more = document.getElementById('more');
  if (more) more.onclick = () => startSession(10);
  $app().querySelectorAll('.deck.playable').forEach(el => el.onclick = () => startSession(0, el.dataset.k));
  const pr = document.getElementById('practice');
  if (pr) pr.onclick = renderPracticePicker;
}

function startSession(extra, onlyDeck = null) {
  const today = dayNumber();
  const queue = buildQueue(S, today, extra, onlyDeck);
  if (!queue.length) { renderHome(); return; }
  session = { queue, pos: 0, today, answered: 0, correct: 0, revealed: false, initial: queue.length };
  setTabs(null);
  setBack(() => { Store.save(S, true); renderHome(); });
  renderCard();
}

function renderPracticePicker() {
  setTabs(null);
  setBack(renderHome);
  // считаем ровно то, что попадёт в тренировку: только карточки, которые уже хоть раз проверялись
  const count = k => practiceQueue(S, k, 1e9).length;
  const opts = [{ key: 'all', name: 'Всё вперемешку', n: count('all') }, { key: 'hard', name: 'Сложные карточки', n: count('hard') }];
  for (const d of DECKS) opts.push({ key: d.key, name: d.name, n: count(d.key) });
  const shown = opts.filter(o => o.n > 0);
  const rj = count('rj');
  $app().innerHTML = `<h2>Повторить изученное</h2>
    <p class="muted small">Свободная тренировка в любое время, до 20 карточек за раз. Расписание повторений не сдвигается, а если что-то забыл — карточка вернётся в ближайшие повторения.</p>
    ${rj ? `<button class="btn big pick rjpick" data-k="rj"><span>✍️ С русского на японский<span class="muted small rjsub">видишь перевод — пишешь слово каной</span></span><span class="muted">${rj}</span></button>` : ''}
    ${shown.length ? shown.map(o => `<button class="btn big pick" data-k="${o.key}"><span>${esc(o.name)}</span><span class="muted">${o.n}</span></button>`).join('')
      : `<div class="done muted">Пока нечего повторять. Карточка появится здесь, когда ты хотя бы раз ответишь на неё в обычном занятии.</div>
         <button class="btn big" id="pback">На главную</button>`}`;
  const pb = document.getElementById('pback'); if (pb) pb.onclick = renderHome;
  $app().querySelectorAll('.pick').forEach(b => b.onclick = () => startPractice(b.dataset.k));
}

function startPractice(filter) {
  const queue = practiceQueue(S, filter);
  if (!queue.length) { renderPracticePicker(); return; }
  session = { queue, pos: 0, today: dayNumber(), answered: 0, correct: 0, revealed: false, practice: true, reverse: filter === 'rj' };
  setTabs(null);
  setBack(() => { Store.save(S, true); renderHome(); });
  renderCard();
}

function cardFront(c) {
  const isWord = c.deck === 'words' || c.deck === 'mine' || c.deck === 'wk';
  // длинные слова уменьшаем, чтобы помещались в одну строку карточки
  return `<div class="front ${isWord ? 'word' : ''}"${isWord ? ` style="--len:${Math.max(4, [...c.front].length)}"` : ''}>${esc(c.front)}</div>`;
}
function cardBack(c) {
  if (c.deck === 'hira' || c.deck === 'kata') return `<div class="answer">${esc(c.romaji)}</div>`;
  if (c.deck === 'words' || c.deck === 'mine') return `<div class="answer">${esc(c.ru)}</div>${c.kanji ? `<div class="kanji-form">${esc(c.kanji)}</div>` : ''}`;
  if (c.deck === 'wk') return `<div class="kanji-form">${esc(c.kana)}</div><div class="answer">${esc(c.ru)}</div>`;
  const ex = (c.ex || []).map(e => `<div class="ex"><span class="jp">${esc(e.w)}</span> <span class="muted">${esc(e.r)}</span>${e.sp ? ' <span class="tag">особое</span>' : ''} — ${esc(e.ru)}</div>`).join('');
  return `<div class="answer">${esc(c.ru)}</div>
    <div class="readings">${c.on ? `<div><span class="tag">он</span> ${esc(c.on)}</div>` : ''}${c.kun ? `<div><span class="tag">кун</span> ${esc(c.kun)}</div>` : ''}</div>
    ${ex ? `<div class="examples">${ex}</div>` : ''}`;
}
const speakText = c => c.deck === 'kanji' ? '' : c.deck === 'wk' ? c.kana : c.front;

function renderCard() {
  const s = session;
  if (s.pos >= s.queue.length) return renderFinish();
  const id = s.queue[s.pos], c = BY_ID[id], st = S.cards[id];
  const deckName = DECKS.find(d => d.key === c.deck).name;
  // Оставшиеся показы: всё, что в очереди, плюс будущая проверка для ещё не показанных новых карточек
  const rest = s.queue.slice(s.pos);
  const left = rest.length + new Set(rest.filter(x => !S.cards[x])).size;
  const isNew = !st;
  const head = `<div class="progress"><div class="bar"><i style="width:${(s.pos / (s.pos + left) * 100).toFixed(1)}%"></i></div>
    <div class="muted small row"><span>${esc(deckName)}${isNew ? ' · <b class="accent">новое</b>' : ''}</span><span>осталось ${left} ${plural(left, 'показ', 'показа', 'показов')}</span></div></div>`;
  const sound = S.settings.tts && speakText(c) ? `<button class="icon" id="say" aria-label="Озвучить">🔊</button>` : '';

  if (s.reverse) return renderReverse(s, id, c, head);
  if (isNew) {
    // Знакомство: показываем сразу с ответом, проверим чуть позже в этом же занятии
    $app().innerHTML = `${head}<div class="card">${sound}${cardFront(c)}<div class="sep"></div>${cardBack(c)}</div>
      <div class="hint muted small">Запомни — через пару карточек спрошу.</div>
      <div class="actions"><button class="btn primary big" id="ok">Запомнил</button></div>`;
    if (S.settings.tts) speak(speakText(c));
    document.getElementById('ok').onclick = () => {
      S.cards[id] = newCardState(s.today);
      S.daily.new[c.deck] = (S.daily.new[c.deck] || 0) + 1;
      requeue(s, id); s.pos++;
      Store.save(S); haptic('light'); renderCard();
    };
  } else if (!s.revealed) {
    $app().innerHTML = `${head}<div class="card tap" id="card">${sound}${cardFront(c)}<div class="sep"></div><div class="placeholder muted">Вспомни ответ</div></div>
      <div class="actions"><button class="btn primary big" id="show">Показать ответ</button></div>`;
    const reveal = () => { s.revealed = true; renderCard(); };
    document.getElementById('show').onclick = reveal;
    document.getElementById('card').onclick = e => { if (e.target.id !== 'say') reveal(); };
  } else if (s.practice) {
    $app().innerHTML = `${head}<div class="card">${sound}${cardFront(c)}<div class="sep"></div>${cardBack(c)}</div>
      <div class="actions grades two"><button class="btn grade g0" data-ok="0"><b>Не помню</b></button><button class="btn grade g2" data-ok="1"><b>Помню</b></button></div>`;
    if (S.settings.tts) speak(speakText(c));
    $app().querySelectorAll('.grade').forEach(b => b.onclick = () => answerPractice(b.dataset.ok === '1'));
  } else {
    const labels = ['Снова', 'Трудно', 'Хорошо', 'Легко'];
    const btns = labels.map((l, g) => `<button class="btn grade g${g}" data-g="${g}"><b>${l}</b><span>${fmtInterval(schedule(st, g, s.today))}</span></button>`).join('');
    $app().innerHTML = `${head}<div class="card">${sound}${cardFront(c)}<div class="sep"></div>${cardBack(c)}</div>
      <div class="actions grades">${btns}</div>`;
    if (S.settings.tts) speak(speakText(c));
    $app().querySelectorAll('.grade').forEach(b => b.onclick = () => answer(+b.dataset.g));
  }
  const say = document.getElementById('say');
  if (say) say.onclick = e => { e.stopPropagation(); speak(speakText(c)); };
}

// Обратный режим (RU → JP): показываем перевод, слово нужно написать каной (или кандзи).
// Сравнение мягкое: без пробелов и знаков препинания, полуширинные/полноширинные символы приводятся к одному виду.
function normAnswer(t) {
  return String(t || '').normalize('NFKC').replace(/[\s。、.,!?！？・~〜「」()（）]/g, '').toLowerCase();
}
function checkTyped(c, typed) {
  const t = normAnswer(typed);
  if (!t) return false;
  return [c.front, c.kanji].some(v => v && normAnswer(v) === t);
}
function renderReverse(s, id, c, head) {
  const front = `<div class="front word rjq" style="--len:${Math.max(6, [...(c.ru || '')].length / 1.6)}">${esc(c.ru)}</div>`;
  if (!s.revealed) {
    $app().innerHTML = `${head}<div class="card">${front}<div class="sep"></div>
        <input id="tin" class="search tinput" lang="ja" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Напиши каной" enterkeyhint="done">
      </div>
      <div class="actions"><button class="btn big g0half" id="tgive">Не помню</button><button class="btn primary big" id="tcheck">Проверить</button></div>`;
    const inp = document.getElementById('tin');
    const check = () => { s.typed = inp.value; s.ok = checkTyped(c, inp.value); s.revealed = true; renderCard(); };
    document.getElementById('tcheck').onclick = () => { if (inp.value.trim()) check(); else inp.focus(); };
    document.getElementById('tgive').onclick = () => { s.typed = ''; s.ok = false; s.revealed = true; renderCard(); };
    inp.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing && inp.value.trim()) { e.preventDefault(); check(); } };
    setTimeout(() => inp.focus(), 50);
    return;
  }
  const sound = S.settings.tts ? `<button class="icon" id="say" aria-label="Озвучить">🔊</button>` : '';
  const verdict = s.ok ? `<div class="tverdict ok">✓ Верно</div>`
    : s.typed ? `<div class="tverdict bad">✗ Ты написал: <span class="jp">${esc(s.typed)}</span></div>`
    : `<div class="tverdict bad">Правильный ответ:</div>`;
  $app().innerHTML = `${head}<div class="card">${sound}${front}<div class="sep"></div>${verdict}
      <div class="front word" style="--len:${Math.max(4, [...c.front].length)}">${esc(c.front)}</div>
      ${c.kanji ? `<div class="kanji-form">${esc(c.kanji)}</div>` : ''}</div>
    <div class="actions">${s.ok
      ? `<button class="btn primary big" id="tnext">Дальше</button>`
      : `${s.typed ? `<button class="btn big" id="tforce">Засчитать</button>` : ''}<button class="btn primary big" id="tnext">Дальше</button>`}</div>`;
  if (S.settings.tts) speak(c.front);
  haptic(s.ok ? 'light' : 'heavy');
  const say = document.getElementById('say');
  if (say) say.onclick = () => speak(c.front);
  const go = ok => { s.typed = ''; answerPractice(ok); };
  document.getElementById('tnext').onclick = () => go(!!s.ok);
  const f = document.getElementById('tforce'); if (f) f.onclick = () => go(true);
}

function requeue(s, id) {
  const at = Math.min(s.pos + 4, s.queue.length);
  s.queue.splice(at, 0, id);
}

function answer(g) {
  const s = session, id = s.queue[s.pos];
  const res = schedule(S.cards[id], g, s.today);
  S.cards[id] = res.card;
  if (res.requeue) requeue(s, id);
  s.answered++; if (g > 0) s.correct++;
  S.daily.reviews++;
  markStudied(S, s.today);
  s.pos++; s.revealed = false;
  haptic(g === 0 ? 'heavy' : 'light');
  Store.save(S);
  ping();
  renderCard();
}

// В тренировке интервалы не растут; забытая карточка ставится в повторения на сегодня
function answerPractice(ok) {
  const s = session, id = s.queue[s.pos], st = S.cards[id];
  rollDay(S, s.today);
  S.daily.pr = (S.daily.pr || 0) + 1;
  if (!ok) {
    if (st.d > s.today) S.cards[id] = { ...st, d: s.today };
    requeue(s, id);
  }
  s.answered++; if (ok) s.correct++;
  markStudied(S, s.today);
  s.pos++; s.revealed = false;
  haptic(ok ? 'light' : 'heavy');
  Store.save(S);
  ping();
  renderCard();
}

function renderFinish() {
  const s = session;
  Store.save(S, true);
  ping(true);
  const acc = s.answered ? Math.round(s.correct / s.answered * 100) : 100;
  setBack(renderHome);
  $app().innerHTML = `<div class="finish">
    <div class="big-emoji">🎌</div>
    <h2>Занятие окончено</h2>
    <p class="muted">Ответов: ${s.answered} · верных: ${acc}%</p>
    <p class="muted">🔥 серия: ${S.streak.count} ${plural(S.streak.count, 'день', 'дня', 'дней')}</p>
    <button class="btn primary big" id="home">На главную</button></div>`;
  document.getElementById('home').onclick = renderHome;
}

// Словарь: слова, которые уже в изучении. «Выучено» — интервал повторения от 3 дней (вспомнил минимум дважды подряд)
const LEARNED_DAYS = 3;
let dictState = { filter: 'learned', q: '' };
function strength(i) { return i >= 21 ? 4 : i >= 7 ? 3 : i >= LEARNED_DAYS ? 2 : i >= 1 ? 1 : 0; }
function renderDict() {
  setBack(null);
  setTabs('dict');
  const all = wordSources().filter(w => S.cards[w.id]).reverse();
  const learned = all.filter(w => S.cards[w.id].i >= LEARNED_DAYS);
  const learning = all.filter(w => S.cards[w.id].i < LEARNED_DAYS);
  const mine = DATA.mine.slice().reverse();
  const lists = { learned, learning, all, mine };
  const segs = [['learned', 'Выучено', learned.length], ['learning', 'Учу', learning.length], ['all', 'Все', all.length], ['mine', 'Мои', mine.length]];
  $app().innerHTML = `<h2>Словарь</h2>
    <p class="muted small">«Выучено» — слова, которые ты вспомнил несколько раз подряд и повторяешь раз в ${LEARNED_DAYS}+ дня. Нажми на слово, чтобы услышать его.</p>
    <div class="seg" id="dseg">${segs.map(([k, l, n]) => `<button data-f="${k}" aria-pressed="${dictState.filter === k}">${l} <span class="muted">${n}</span></button>`).join('')}</div>
    <div id="dadd"></div>
    <input type="search" id="dq" class="search" placeholder="Поиск: кана, кандзи или перевод" value="${esc(dictState.q)}">
    <div id="dlist"></div>`;
  const drawAdd = () => {
    const box = document.getElementById('dadd');
    if (dictState.filter !== 'mine') { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="addbox">
      <div class="addrow"><input id="ak" class="search" placeholder="Кана: えんぴつ" autocomplete="off"><input id="ar" class="search" placeholder="Перевод: карандаш" autocomplete="off"></div>
      <div class="addrow"><input id="aj" class="search" placeholder="Кандзи (необяз.): 鉛筆" autocomplete="off"><input id="ac" class="search" list="cats" placeholder="Категория (необяз.)" autocomplete="off" value="${esc(dictState.cat || '')}"></div>
      <datalist id="cats">${categories().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <button class="btn primary big" id="aadd">Добавить слово</button>
      <details class="bulk"><summary>Вставить списком</summary>
        ${S.settings.builtin !== false ? `<p class="muted small warn">Включён встроенный набор слов: слова, которые в нём уже есть, не попадут в «Мои», а встанут в изучение из него (без категорий). Чтобы все слова были твоими, выключи набор в настройках.</p>` : ''}
        <p class="muted small">Каждое слово с новой строки: <b>кана|перевод|кандзи</b>. Кандзи можно не писать. Строка <b># Название</b> задаёт категорию для слов ниже.</p>
        <textarea id="abulk" rows="5" placeholder="# Числа&#10;いち|один|一&#10;に|два|二"></textarea>
        <button class="btn big" id="abulkadd">Добавить список</button>
      </details>
      <p class="muted small" id="amsg" aria-live="polite"></p></div>`;
    const msg = t => { document.getElementById('amsg').textContent = t; };
    document.getElementById('aadd').onclick = () => {
      const r = addWords([[document.getElementById('ak').value, document.getElementById('ar').value, document.getElementById('aj').value, document.getElementById('ac').value]]);
      if (r.added + r.pulled) { renderDict(); msg2(r); }
      else if (r.dups.length) { msg(`Такое слово уже есть: ${r.dups[0]}`); haptic('heavy'); }
      else msg(r.note || 'Нужно заполнить кану и перевод');
    };
    document.getElementById('abulkadd').onclick = () => {
      const rows = parseBulk(document.getElementById('abulk').value);
      if (!rows.length) { msg('Список пуст'); return; }
      const r = addWords(rows);
      renderDict(); msg2(r);
    };
  };
  const msg2 = r => {
    const parts = [];
    if (r.added) parts.push(`добавлено: ${r.added} (в изучение пойдут по лимиту «Мои слова: новых в день»)`);
    if (r.pulled) parts.push(`уже были в колоде «Слова», поставил в изучение: ${r.pulled}`);
    if (r.dups.length) parts.push(`уже есть в списке, не добавил: ${r.dups.join('; ')}`);
    if (r.skipped) parts.push(`пропущено (пустые строки или уже учишь): ${r.skipped}`);
    const el = document.getElementById('amsg'); if (el) el.textContent = parts.join(' · ');
    haptic('light');
  };
  const draw = () => {
    const q = dictState.q.trim().toLowerCase();
    const isMine = dictState.filter === 'mine';
    const cats = isMine ? categories() : [];
    if (dictState.cat && !cats.includes(dictState.cat)) dictState.cat = '';
    const items = lists[dictState.filter].filter(w => (!q || [w.front, w.kanji, w.ru, w.cat].join(' ').toLowerCase().includes(q))
      && (!isMine || !dictState.cat || w.cat === dictState.cat));
    const chips = cats.length ? `<div class="chips">${['', ...cats].map(c => `<button class="chipf" data-c="${esc(c)}" aria-pressed="${(dictState.cat || '') === c}">${c ? esc(c) : 'Все'}</button>`).join('')}</div>` : '';
    document.getElementById('dlist').innerHTML = chips + (items.length
      ? `<div class="dict">${items.map(w => {
          const st = S.cards[w.id] ? strength(S.cards[w.id].i) : 0;
          return `<div class="drow${isMine ? ' mine' : ''}" data-say="${esc(w.front)}" role="button" tabindex="0"><span class="dk"><span class="dkana">${esc(w.front)}</span>${w.kanji ? `<span class="dkanji">${esc(w.kanji)}</span>` : ''}</span>
            <span class="dru">${esc(w.ru)}${isMine && w.cat && !dictState.cat ? `<span class="dcat">${esc(w.cat)}</span>` : ''}</span><span class="dots" title="Прочность запоминания">${S.cards[w.id] ? '●'.repeat(st) + '○'.repeat(4 - st) : 'новое'}</span>
            ${isMine ? `<span class="dact"><button class="dedit" data-id="${esc(w.id)}" aria-label="Изменить">✎</button><button class="ddel" data-id="${esc(w.id)}" aria-label="Удалить">✕</button></span>` : ''}</div>`;
        }).join('')}</div>`
      : `<div class="done muted">${q ? 'Ничего не найдено' : dictState.filter === 'learned' ? 'Пока пусто. Слово попадёт сюда, когда ты несколько раз подряд вспомнишь его в повторениях.' : isMine ? 'Своих слов пока нет. Добавь первое выше.' : 'Пока пусто. Начни учить колоду «Слова» на главной.'}</div>`);
    document.querySelectorAll('.chipf').forEach(b => b.onclick = () => { dictState.cat = b.dataset.c; drawAdd(); draw(); });
    document.querySelectorAll('.drow').forEach(b => b.onclick = e => { if (!e.target.closest('.dact')) speak(b.dataset.say); });
    document.querySelectorAll('.dedit').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const w = S.custom.find(x => x.id === b.dataset.id); if (!w) return;
      const row = b.closest('.drow');
      row.outerHTML = `<div class="editrow" data-id="${esc(w.id)}">
        <div class="addrow"><input class="search" data-f="k" value="${esc(w.k)}" placeholder="Кана"><input class="search" data-f="r" value="${esc(w.r)}" placeholder="Перевод"></div>
        <div class="addrow"><input class="search" data-f="j" value="${esc(w.j || '')}" placeholder="Кандзи (необяз.)"><input class="search" data-f="c" list="cats" value="${esc(w.c || '')}" placeholder="Категория"></div>
        <div class="row gap"><button class="btn" data-act="cancel">Отмена</button><button class="btn primary" data-act="save">Сохранить</button></div></div>`;
      const box = document.querySelector(`.editrow[data-id="${CSS.escape(w.id)}"]`);
      box.querySelector('[data-act=cancel]').onclick = () => draw();
      box.querySelector('[data-act=save]').onclick = () => {
        const v = f => cleanField(box.querySelector(`[data-f=${f}]`).value);
        if (!v('k') || !v('r')) { box.querySelector('[data-f=k]').focus(); return; }
        const dup = findDuplicate(v('k'), v('j'), w.id);
        if (dup) {
          let m = box.querySelector('.emsg');
          if (!m) { m = document.createElement('p'); m.className = 'muted small emsg'; box.appendChild(m); }
          m.textContent = `Такое слово уже есть: ${dup.k} — ${dup.r}. Если это другое слово с тем же чтением, укажи кандзи.`;
          haptic('heavy'); return;
        }
        w.k = v('k'); w.r = v('r'); w.j = v('j');
        if (v('c')) w.c = v('c'); else delete w.c;
        setCustom(S.custom, S); Store.save(S, true); haptic('light'); renderDict();
      };
    });
    document.querySelectorAll('.ddel').forEach(b => b.onclick = e => {
      e.stopPropagation();
      if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Удалить?'; return; }
      S.custom = S.custom.filter(w => w.id !== b.dataset.id);
      delete S.cards[b.dataset.id];
      setCustom(S.custom, S); Store.save(S, true); renderDict();
    });
  };
  document.getElementById('dseg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    dictState.filter = b.dataset.f;
    document.querySelectorAll('#dseg button').forEach(x => x.setAttribute('aria-pressed', x === b));
    drawAdd(); draw();
  };
  document.getElementById('dq').oninput = e => { dictState.q = e.target.value; draw(); };
  drawAdd(); draw();
}

// Список текстом: «кана|перевод|кандзи|категория», строка «# Название» задаёт категорию для строк ниже
function parseBulk(text) {
  let cat = '';
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const h = /^#+\s*(.*)$/.exec(t);
    if (h) { cat = cleanField(h[1]); continue; }
    const p = t.split('|');
    rows.push([p[0], p[1], p[2], p[3] != null && p[3].trim() ? p[3] : cat]);
  }
  return rows;
}

// Дубль: та же кана, и кандзи совпадает или у одного из слов его нет.
// Омонимы с разными кандзи (はし 橋 / 箸) — разрешены.
function findDuplicate(k, j, exceptId = null) {
  return S.custom.find(w => w.id !== exceptId && w.k === k && (!j || !w.j || w.j === j)) || null;
}

// Добавление своих слов: rows = [[кана, перевод, кандзи, категория], ...]
// Новые слова встают в очередь и идут в изучение по лимиту «Мои слова: новых в день»
function addWords(rows) {
  const today = dayNumber();
  const res = { added: 0, pulled: 0, skipped: 0, dups: [] };
  for (const row of rows) {
    const k = cleanField(row[0]), r = cleanField(row[1]), j = cleanField(row[2]), c = cleanField(row[3]);
    if (!k || !r) { res.skipped++; continue; }
    const built = S.settings.builtin === false ? null : DATA.words.find(w => w.front === k);
    if (built) {
      if (S.cards[built.id]) { res.skipped++; continue; }
      S.cards[built.id] = newCardState(today); res.pulled++; continue;
    }
    const dup = findDuplicate(k, j);
    if (dup) { res.dups.push(`${dup.k}${dup.j ? ' (' + dup.j + ')' : ''} — ${dup.r}`); continue; }
    const id = 'm:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    S.custom.push({ id, k, j, r, ...(c ? { c } : {}) });
    res.added++;
  }
  if (res.added + res.pulled) { setCustom(S.custom, S); Store.save(S, true); }
  return res;
}

/* ================= Учёт времени ================= */

const IDLE_MS = 120000; // если 2 минуты ничего не нажимал — время не идёт
const TICK_S = 5;
let lastActivity = Date.now();
function timeDay(state, day) {
  const d = state.time.days;
  return d[day] || (d[day] = { a: 0, m: 0 });
}
function startTimeTracking() {
  const bump = () => { lastActivity = Date.now(); };
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(e => window.addEventListener(e, bump, { passive: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) bump(); });
  let sinceSave = 0;
  setInterval(() => {
    if (document.hidden || Date.now() - lastActivity > IDLE_MS || !S) return;
    timeDay(S, dayNumber()).a += TICK_S;
    sinceSave += TICK_S;
    if (sinceSave >= 30) { sinceSave = 0; Store.save(S); }
    if (currentTab === 'profile' && document.getElementById('ptoday')) updateProfileNumbers();
  }, TICK_S * 1000);
}
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}
function daySum(state, day) { const v = state.time.days[day]; return v ? (v.a || 0) + (v.m || 0) : 0; }
function timeStats(state) {
  const today = dayNumber();
  const start = state.time.start ?? today;
  const tracked = Math.max(1, today - start + 1);
  let total = 0;
  for (const d in state.time.days) total += daySum(state, +d);
  const dow = (new Date(Date.now() - ROLLOVER_HOURS * 36e5).getDay() + 6) % 7; // 0 = понедельник
  let week = 0; for (let d = today - dow; d <= today; d++) week += daySum(state, d);
  let last7 = 0; for (let d = today - 6; d <= today; d++) last7 += daySum(state, d);
  return { today: daySum(state, today), week, avg7: last7 / Math.min(7, tracked), avgAll: total / tracked, total, tracked, start };
}
/* ================= Сервер: статистика, напоминания, отзывы ================= */
const CONFIG = (typeof window !== 'undefined' && window.KOTOBA_CONFIG) || {};
const API_URL = String(CONFIG.api || '').replace(/\/+$/, '');
const PING_EVERY = 5 * 60000; // не чаще раза в 5 минут, чтобы не упираться в лимиты бесплатного сервера
let lastPing = 0, pingTimer = null;
function answersToday() {
  return S.daily.day === dayNumber() ? (S.daily.reviews || 0) + (S.daily.pr || 0) : 0;
}
function ping(force = false) {
  const tg = TG();
  if (!API_URL || !tg || !S) return;
  const now = Date.now();
  if (!force && now - lastPing < PING_EVERY) {
    if (!pingTimer) pingTimer = setTimeout(() => { pingTimer = null; ping(true); }, PING_EVERY - (now - lastPing));
    return;
  }
  if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
  lastPing = now;
  const remind = S.settings.remind;
  try {
    // text/plain — без предварительного CORS-запроса
    fetch(API_URL + '/ping', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ initData: tg.initData, answers: answersToday(), tz: -new Date().getTimezoneOffset(), hour: remind >= 0 ? remind : null }) })
      .catch(() => {});
  } catch (e) {}
}
async function sendFeedback(text) {
  const tg = TG();
  if (!API_URL || !tg) return false;
  try {
    const r = await fetch(API_URL + '/feedback', { method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ initData: tg.initData, text }) });
    return (await r.json()).ok === true;
  } catch (e) { return false; }
}
function openLink(url) {
  const tg = TG();
  try { if (/^https:\/\/t\.me\//.test(url) && tg) return tg.openTelegramLink(url); if (tg) return tg.openLink(url); } catch (e) {}
  window.open(url, '_blank');
}

function renderFeedback() {
  setTabs('profile');
  setBack(renderProfile);
  $app().innerHTML = `<div class="row"><button class="linkbtn" id="fback">← Профиль</button></div>
    <h2>Написать разработчику</h2>
    <p class="muted small">Нашёл ошибку в слове, чего-то не хватает или просто понравилось — пиши. Сообщение придёт разработчику в Telegram, ответ придёт в чат с ботом.</p>
    <textarea id="ftext" rows="6" maxlength="3000" placeholder="Твоё сообщение"></textarea>
    <button class="btn primary big" id="fsend">Отправить</button>
    <p class="muted small" id="fmsg" aria-live="polite"></p>`;
  document.getElementById('fback').onclick = renderProfile;
  const btn = document.getElementById('fsend'), msg = document.getElementById('fmsg'), ta = document.getElementById('ftext');
  btn.onclick = async () => {
    const text = ta.value.trim();
    if (!text) { msg.textContent = 'Напиши хоть пару слов 🙂'; return; }
    btn.disabled = true; msg.textContent = 'Отправляю…';
    const ok = await sendFeedback(text);
    btn.disabled = false;
    if (ok) { ta.value = ''; msg.textContent = 'Спасибо! Сообщение отправлено 🙏'; haptic('light'); }
    else msg.textContent = 'Не получилось отправить. Можно написать прямо в чат с ботом — сообщение тоже дойдёт.';
  };
}

// Приветствие при первом запуске
function renderIntro() {
  setBack(null);
  const tabs = document.getElementById('tabs'); if (tabs) tabs.hidden = true;
  $app().innerHTML = `<div class="intro">
    <div class="big-emoji">🗾</div>
    <h2>Котоба</h2>
    <p>Японский с нуля — по паре минут в день.</p>
    <ol class="intro-list">
      <li><b>Сначала кана.</b> Хирагана, потом катакана. Слова и кандзи откроются по ходу.</li>
      <li><b>Новая карточка</b> сначала показывается с ответом, потом проверяется в том же занятии.</li>
      <li><b>Оценивай честно:</b> «Снова», если не вспомнил. Забытое вернётся, выученное будет появляться всё реже.</li>
      <li><b>Каждый день понемногу</b> лучше, чем час раз в неделю. Бот утром пришлёт напоминание.</li>
    </ol>
    <button class="btn primary big" id="istart">Начать</button>
  </div>`;
  document.getElementById('istart').onclick = () => {
    S.intro = true; Store.save(S, true);
    if (tabs) tabs.hidden = false;
    haptic('light'); renderHome();
  };
}

let profileManualLog = [];
function updateProfileNumbers() {
  const st = timeStats(S);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ptoday', fmtDur(st.today)); set('pweek', fmtDur(st.week)); set('pavg7', fmtDur(st.avg7));
  set('pavgall', fmtDur(st.avgAll)); set('ptotal', fmtDur(st.total));
}
const TG_USER = () => { try { const tg = TG(); return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null; } catch (e) { return null; } };
const GOALS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const AV_COLORS = ['#d1453b', '#e08a1e', '#2b9a64', '#2f8fbf', '#4a6fe0', '#8a5cd6', '#c2477f', '#5b6170'];
const AV_CHARS = ['学', '桜', '猫', '侍', '龍', '星', '山', '海', '火', '心'];
function profileName() { const u = TG_USER(); return S.profile.name || (u && u.first_name) || 'Ученик'; }
function avatarHTML(size, prof = S.profile, photo = S.photo) {
  const u = TG_USER(), av = prof.avatar;
  const type = av.type === 'auto' ? (photo ? 'photo' : (u && u.photo_url ? 'tg' : 'char')) : av.type;
  const st = `width:${size}px;height:${size}px`;
  if (type === 'photo' && photo) return `<img class="ava" style="${st}" src="${photo}" alt="">`;
  if (type === 'tg' && u && u.photo_url) return `<img class="ava" style="${st}" src="${esc(u.photo_url)}" alt="" referrerpolicy="no-referrer">`;
  return `<span class="ava ch" style="${st};background:${esc(av.color)};font-size:${Math.round(size * .48)}px">${esc(av.char || '学')}</span>`;
}
function examLeft() {
  if (!S.profile.exam) return null;
  const [y, m, d] = S.profile.exam.split('-').map(Number);
  const ms = new Date(y, m - 1, d) - new Date(new Date().toDateString());
  return Math.round(ms / DAY_MS);
}
function totalAnswers() { let n = 0; for (const id in S.cards) n += S.cards[id].r || 0; return n; }

function renderProfile() {
  setBack(null);
  setTabs('profile');
  const st = timeStats(S);
  const today = dayNumber();
  const u = TG_USER();
  const days = [];
  for (let d = today - 6; d <= today; d++) {
    const v = S.time.days[d] || { a: 0, m: 0 };
    const dt = new Date(Date.now() - (today - d) * DAY_MS - ROLLOVER_HOURS * 36e5);
    days.push({ d, a: v.a || 0, m: v.m || 0, label: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][dt.getDay()] });
  }
  const max = Math.max(1800, ...days.map(x => x.a + x.m));
  const startDate = new Date(Date.now() - (today - st.start) * DAY_MS - ROLLOVER_HOURS * 36e5);
  const learned = k => DATA[k].filter(c => S.cards[c.id] && S.cards[c.id].i >= LEARNED_DAYS).length;
  const kana = learned('hira') + learned('kata');
  const words = learned('words') + learned('mine');
  const kanji = learned('kanji');
  const streak = S.streak.last >= today - 1 ? S.streak.count : 0;
  const left = examLeft();
  $app().innerHTML = `
    <section class="phead">
      <button class="icon gear" id="psettings" aria-label="Настройки">⚙︎</button>
      ${avatarHTML(84)}
      <div class="pname">${esc(profileName())}</div>
      ${u && u.username ? `<div class="muted small">@${esc(u.username)}</div>` : ''}
      ${S.profile.about ? `<p class="pabout">${esc(S.profile.about)}</p>` : ''}
      <div class="pbadges">
        <span class="badge">🎯 Цель: JLPT ${esc(S.profile.goal)}</span>
        ${left != null ? `<span class="badge">${left > 0 ? `📅 до экзамена ${left} ${plural(left, 'день', 'дня', 'дней')}` : left === 0 ? '📅 экзамен сегодня!' : '📅 экзамен прошёл'}</span>` : ''}
        <span class="badge">🔥 ${streak} ${plural(streak, 'день', 'дня', 'дней')} подряд</span>
      </div>
      <button class="btn small-btn" id="pedit">Редактировать профиль</button>
    </section>

    <h3>Выучено</h3>
    <section class="pstats three">
      <div class="stat"><div class="num sm">${kana}</div><div class="muted small">знаков каны</div></div>
      <div class="stat"><div class="num sm">${words}</div><div class="muted small">слов</div></div>
      <div class="stat"><div class="num sm">${kanji}</div><div class="muted small">кандзи</div></div>
    </section>
    <div class="ptotal"><span class="muted small">Ответов в повторениях за всё время</span><b>${totalAnswers()}</b></div>

    <h3>Время занятий</h3>
    <section class="pstats">
      <div class="stat"><div class="num sm" id="ptoday">${fmtDur(st.today)}</div><div class="muted small">сегодня</div></div>
      <div class="stat"><div class="num sm" id="pweek">${fmtDur(st.week)}</div><div class="muted small">эта неделя</div></div>
      <div class="stat"><div class="num sm" id="pavg7">${fmtDur(st.avg7)}</div><div class="muted small">в среднем в день<br>за 7 дней</div></div>
      <div class="stat"><div class="num sm" id="pavgall">${fmtDur(st.avgAll)}</div><div class="muted small">в среднем в день<br>за всё время</div></div>
    </section>
    <div class="ptotal"><span class="muted small">Всего с ${startDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</span><b id="ptotal">${fmtDur(st.total)}</b></div>
    <div class="chart">${days.map(x => `<div class="col${x.d === today ? ' today' : ''}" title="${fmtDur(x.a + x.m)}">
      <div class="bars"><i class="m" style="height:${(x.m / max * 100).toFixed(1)}%"></i><i class="a" style="height:${(x.a / max * 100).toFixed(1)}%"></i></div>
      <span class="v">${x.a + x.m >= 60 ? Math.round((x.a + x.m) / 60) : ''}</span><span class="muted small">${x.label}</span></div>`).join('')}</div>
    <div class="legend muted small"><span><i class="a"></i>в Котобе</span><span><i class="m"></i>добавлено вручную</span><span>(минуты)</span></div>

    <h3>Добавить время</h3>
    <p class="muted small">Котоба считает время сама, пока ты в приложении. Учебник, тетрадь, аудирование и переписку добавляй здесь.</p>
    <div class="addtime">${[10, 15, 30, 60].map(m => `<button class="btn" data-min="${m}">+${m} мин</button>`).join('')}</div>
    <div class="row gap"><input type="number" id="pmin" class="search" min="1" max="600" inputmode="numeric" placeholder="Своё время, мин"><button class="btn" id="padd">Добавить</button></div>
    <p class="muted small" id="pmsg" aria-live="polite"></p>
    ${API_URL || CONFIG.donate ? `<div class="plinks">
      ${API_URL && TG() ? `<button class="btn" id="pfeed">💬 Написать разработчику</button>` : ''}
      ${CONFIG.donate ? `<button class="btn" id="pdonate">♥ Поддержать проект</button>` : ''}
    </div>` : ''}
    <div id="sync" class="muted small center"></div>`;
  updateSyncBadge();
  const pf = document.getElementById('pfeed'); if (pf) pf.onclick = () => { haptic('light'); renderFeedback(); };
  const pd = document.getElementById('pdonate'); if (pd) pd.onclick = () => openLink(CONFIG.donate);
  document.getElementById('psettings').onclick = () => { haptic('light'); renderSettings(); };
  document.getElementById('pedit').onclick = renderProfileEdit;
  const add = min => {
    min = Math.max(1, Math.min(600, Math.round(min)));
    timeDay(S, dayNumber()).m += min * 60;
    profileManualLog.push(min);
    Store.save(S, true); haptic('light');
    const y = window.scrollY; renderProfile(); window.scrollTo(0, y);
    const msg = document.getElementById('pmsg');
    msg.innerHTML = `Добавлено ${min} мин · <button class="linkbtn" id="pundo">отменить</button>`;
    document.getElementById('pundo').onclick = () => {
      const last = profileManualLog.pop(); if (!last) return;
      const v = timeDay(S, dayNumber()); v.m = Math.max(0, v.m - last * 60);
      Store.save(S, true); const y2 = window.scrollY; renderProfile(); window.scrollTo(0, y2);
    };
  };
  document.querySelectorAll('.addtime [data-min]').forEach(b => b.onclick = () => add(+b.dataset.min));
  document.getElementById('padd').onclick = () => {
    const v = parseInt(document.getElementById('pmin').value, 10);
    if (v > 0) add(v); else document.getElementById('pmsg').textContent = 'Введи число минут';
  };
}

// Редактирование профиля: изменения в черновике, сохраняются кнопкой
function renderProfileEdit() {
  const u = TG_USER();
  const draft = JSON.parse(JSON.stringify(S.profile));
  let photo = S.photo;
  if (draft.avatar.type === 'auto') draft.avatar.type = photo ? 'photo' : (u && u.photo_url ? 'tg' : 'char');
  setTabs('profile');
  const back = () => renderProfile();
  setBack(back);
  const draw = () => {
    $app().innerHTML = `<div class="row"><button class="linkbtn" id="eback">← Профиль</button></div>
      <h2>Профиль</h2>
      <section class="phead flat"><div id="eprev">${avatarHTML(84, draft, photo)}</div></section>
      <div class="seg" id="atype">
        ${u && u.photo_url ? `<button data-t="tg" aria-pressed="${draft.avatar.type === 'tg'}">Фото Telegram</button>` : ''}
        <button data-t="photo" aria-pressed="${draft.avatar.type === 'photo'}">Своё фото</button>
        <button data-t="char" aria-pressed="${draft.avatar.type === 'char'}">Иероглиф</button>
      </div>
      <div id="aopts"></div>
      <label class="field"><span class="muted small">Имя</span><input id="ename" class="search" maxlength="40" value="${esc(draft.name || profileName())}"></label>
      <label class="field"><span class="muted small">О себе</span><textarea id="eabout" rows="3" maxlength="160" placeholder="Например: учу японский, чтобы переехать в Японию">${esc(draft.about)}</textarea></label>
      <div class="field"><span class="muted small">Цель</span><div class="seg" id="egoal">${GOALS.map(g => `<button data-g="${g}" aria-pressed="${draft.goal === g}">${g}</button>`).join('')}</div></div>
      <label class="field"><span class="muted small">Дата экзамена (необязательно)</span><input type="date" id="eexam" class="search" value="${esc(draft.exam)}"></label>
      <button class="btn primary big" id="esave">Сохранить</button>`;
    const opts = document.getElementById('aopts');
    if (draft.avatar.type === 'char') {
      opts.innerHTML = `<div class="pick">${AV_CHARS.map(c => `<button class="chip${draft.avatar.char === c ? ' on' : ''}" data-c="${c}">${c}</button>`).join('')}</div>
        <div class="pick">${AV_COLORS.map(c => `<button class="dot${draft.avatar.color === c ? ' on' : ''}" data-col="${c}" style="background:${c}" aria-label="Цвет"></button>`).join('')}</div>`;
      opts.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { keep(); draft.avatar.char = b.dataset.c; draw(); });
      opts.querySelectorAll('[data-col]').forEach(b => b.onclick = () => { keep(); draft.avatar.color = b.dataset.col; draw(); });
    } else if (draft.avatar.type === 'photo') {
      opts.innerHTML = `<label class="btn big filebtn">${photo ? 'Выбрать другое фото' : 'Выбрать фото'}<input type="file" id="efile" accept="image/*" hidden></label>
        <p class="muted small" id="emsg"></p>`;
      document.getElementById('efile').onchange = e => {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        document.getElementById('emsg').textContent = 'Обрабатываю…';
        shrinkPhoto(f).then(url => { keep(); photo = url; draw(); }).catch(() => { document.getElementById('emsg').textContent = 'Не получилось открыть это фото'; });
      };
    }
    document.getElementById('atype').onclick = e => { const b = e.target.closest('button'); if (!b) return; keep(); draft.avatar.type = b.dataset.t; draw(); };
    document.getElementById('egoal').onclick = e => { const b = e.target.closest('button'); if (!b) return; keep(); draft.goal = b.dataset.g; draw(); };
    document.getElementById('eback').onclick = back;
    document.getElementById('esave').onclick = () => {
      keep();
      S.profile = draft;
      S.photo = photo || '';
      Store.save(S, true); haptic('light');
      renderProfile();
    };
  };
  const keep = () => {
    const n = document.getElementById('ename'); if (n) draft.name = n.value.trim().slice(0, 40);
    const a = document.getElementById('eabout'); if (a) draft.about = a.value.trim().slice(0, 160);
    const x = document.getElementById('eexam'); if (x) draft.exam = x.value;
  };
  draw();
}
// Уменьшаем фото до 128×128 (JPEG), чтобы влезло в облако Telegram
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject;
    r.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const S2 = 128, c = document.createElement('canvas'); c.width = c.height = S2;
        const k = Math.max(S2 / img.width, S2 / img.height), w = img.width * k, h = img.height * k;
        c.getContext('2d').drawImage(img, (S2 - w) / 2, (S2 - h) / 2, w, h);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

function renderSettings() {
  const MAX_NEW = 400;
  // Сохраняем значения полей при любом выходе: на iOS событие change не срабатывает, если не убрать фокус
  const commit = () => {
    $app().querySelectorAll('input[data-k]').forEach(inp => {
      const v = Math.max(0, Math.min(MAX_NEW, parseInt(inp.value, 10) || 0));
      S.settings.newPerDay[inp.dataset.k] = v;
    });
    Store.save(S, true);
  };
  setBack(null);
  setTabs('profile');
  renderSettings.commit = commit;
  setBack(() => { commit(); renderProfile(); });
  const inputs = DECKS.map(d => `<label class="set-row"><span>${esc(d.name)}: новых в день</span>
    <input type="number" min="0" max="${MAX_NEW}" inputmode="numeric" data-k="${d.key}" value="${S.settings.newPerDay[d.key]}"></label>`).join('');
  $app().innerHTML = `<div class="row"><button class="linkbtn" id="sback">← Профиль</button></div>
    <h2>Настройки</h2>
    ${inputs}
    <button class="btn primary big" id="save">Сохранить</button>
    <p class="muted small" id="saved" hidden>Сохранено ✓</p>
    <label class="set-row"><span>Озвучивать карточки</span><input type="checkbox" id="tts" ${S.settings.tts ? 'checked' : ''}></label>
    ${API_URL ? `<label class="set-row"><span>Напоминание от бота</span><select id="remind">
      <option value="-1"${S.settings.remind < 0 ? ' selected' : ''}>выключено</option>
      ${Array.from({ length: 18 }, (_, i) => i + 5).map(h => `<option value="${h}"${S.settings.remind === h ? ' selected' : ''}>в ${h}:00</option>`).join('')}
    </select></label>
    <p class="muted small">Напоминание не придёт, если в этот день ты уже занимался. Чтобы бот мог писать, нажми у него «Старт».</p>` : ''}
    <p class="muted small">Колоды открываются по очереди: катакана и слова — после всей хираганы, кандзи — после всей катаканы. Слова на катакане появятся, когда пройдёшь катакану.</p>
    <h3>Слова</h3>
    <label class="set-row"><span>Встроенный набор слов N5</span><input type="checkbox" id="builtin" ${S.settings.builtin !== false ? 'checked' : ''}></label>
    <p class="muted small">Выключи, если хочешь учить только свои слова (вкладка «Словарь» → «Мои»).</p>
    <button class="btn danger" id="wreset">Убрать все слова из изучения</button>
    <p class="muted small">Удалит прогресс по всем словам и сами «Мои слова». Кана и кандзи останутся.</p>
    <h3>Резервная копия</h3>
    <p class="muted small">Прогресс хранится в облаке Telegram. Для надёжности можно скопировать его текстом.</p>
    <textarea id="backup" rows="4" placeholder="Сюда появится копия, или вставь свою для восстановления"></textarea>
    <div class="row gap"><button class="btn" id="export">Создать копию</button><button class="btn" id="import">Восстановить</button></div>
    <h3>Опасная зона</h3>
    <button class="btn danger" id="reset">Сбросить весь прогресс</button>
    <p class="muted small center">Котоба · ${Object.keys(S.cards).length} карточек в изучении</p>`;
  document.getElementById('sback').onclick = () => { commit(); renderProfile(); };
  $app().querySelectorAll('input[data-k]').forEach(inp => {
    inp.oninput = commit;
    inp.onblur = () => { inp.value = S.settings.newPerDay[inp.dataset.k]; };
  });
  document.getElementById('save').onclick = () => {
    commit();
    const s = document.getElementById('saved'); s.hidden = false;
    haptic('light');
    setTimeout(() => { s.hidden = true; }, 1500);
  };
  document.getElementById('tts').onchange = e => { S.settings.tts = e.target.checked; Store.save(S); };
  document.getElementById('builtin').onchange = e => {
    S.settings.builtin = e.target.checked;
    setCustom(S.custom, S); Store.save(S, true);
  };
  const wr = document.getElementById('wreset');
  wr.onclick = () => {
    if (!wr.classList.contains('armed')) { wr.classList.add('armed'); wr.textContent = 'Точно? Нажми ещё раз'; return; }
    for (const id of Object.keys(S.cards)) {
      const c = BY_ID[id];
      if (!c || c.deck === 'words' || c.deck === 'mine' || c.deck === 'wk') delete S.cards[id];
    }
    S.custom = []; setCustom(S.custom, S);
    for (const k of ['words', 'mine', 'wk']) delete S.daily.new[k];
    Store.save(S, true); haptic('heavy');
    wr.textContent = 'Слова убраны ✓'; wr.disabled = true;
  };
  const rem = document.getElementById('remind');
  if (rem) rem.onchange = () => { S.settings.remind = parseInt(rem.value, 10); Store.save(S, true); ping(true); };
  const ta = document.getElementById('backup');
  document.getElementById('export').onclick = () => {
    ta.value = JSON.stringify(S); ta.select();
    try { navigator.clipboard.writeText(ta.value); ta.placeholder = ''; } catch (e) {}
  };
  document.getElementById('import').onclick = () => {
    let parsed; try { parsed = JSON.parse(ta.value); } catch (e) { alert('Не получилось прочитать копию'); return; }
    if (!parsed || typeof parsed.cards !== 'object') { alert('Это не похоже на копию прогресса'); return; }
    if (!confirm('Заменить текущий прогресс этой копией?')) return;
    S = normalize(parsed); setCustom(S.custom, S); Store.save(S, true); renderHome();
  };
  document.getElementById('reset').onclick = () => {
    if (!confirm('Точно стереть весь прогресс? Это нельзя отменить.')) return;
    S = freshState(); setCustom(S.custom, S); Store.save(S, true); renderHome();
  };
}

async function boot() {
  const tg = TG();
  if (tg) {
    tg.ready(); tg.expand();
    try { if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes(); } catch (e) {}
  }
  S = await Store.load();
  setCustom(S.custom, S);
  let pulled = false;
  if (S.time.start == null) { S.time.start = dayNumber(); pulled = true; }
  // всегда досинхронизируем облако: если прошлое сохранение не прошло, локальная копия новее
  Store.save(S, true);
  startTimeTracking();
  if ('speechSynthesis' in window) { try { speechSynthesis.getVoices(); } catch (e) {} }
  document.addEventListener('visibilitychange', () => { if (document.hidden && S) Store.save(S, true); });
  window.addEventListener('pagehide', () => { if (S) Store.save(S, true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S) ping(true); });
  const nav = document.getElementById('tabs');
  if (nav) nav.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (currentTab === 'settings' && renderSettings.commit) renderSettings.commit();
    haptic('light');
    openTab(b.dataset.tab);
  };
  ping(true);
  // приветствие — только совсем новым пользователям
  if (!S.intro && Object.keys(S.cards).length === 0) renderIntro();
  else { if (!S.intro) { S.intro = true; Store.save(S); } renderHome(); }
}

if (typeof document !== 'undefined') boot();
if (typeof module !== 'undefined') module.exports = { normAnswer, checkTyped, findDuplicate, parseBulk, categories, splitDeck, wkEligible, kanjiOrder, rebuildWK, serializeTime, parseTime, timeStats, addWords, setCustom, serializeCustom, parseCustom, practiceQueue, DATA, DECKS, BY_ID, schedule, buildQueue, freshState, normalize, serializeChunks, parseChunks, newAvailable, newCardState, dayNumber, rollDay, markStudied, metaOf };
