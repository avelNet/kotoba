'use strict';

/* ================= Данные и колоды ================= */

const DATA = (typeof buildData !== 'undefined' ? buildData : require('./data.js').buildData)();
const DECKS = [
  { key: 'hira',  name: 'Хирагана', needs: null,   defNew: 10 },
  { key: 'kata',  name: 'Катакана', needs: 'hira', defNew: 10 },
  { key: 'words', name: 'Слова',    needs: 'hira', defNew: 10 },
  { key: 'kanji', name: 'Кандзи',   needs: 'kata', defNew: 3 },
];
const BY_ID = {};
for (const d of DECKS) for (const c of DATA[d.key]) BY_ID[c.id] = c;

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
    v: 1, ts: 0, cards: {},
    daily: { day: -1, new: {}, reviews: 0 },
    settings: { newPerDay, tts: true },
    streak: { last: -1, count: 0 },
  };
}

function normalize(s) {
  const f = freshState();
  if (!s || typeof s !== 'object' || typeof s.cards !== 'object') return f;
  return {
    v: 1, ts: s.ts || 0, cards: s.cards,
    daily: { ...f.daily, ...(s.daily || {}) },
    settings: { ...f.settings, ...(s.settings || {}), newPerDay: { ...f.settings.newPerDay, ...((s.settings || {}).newPerDay || {}) } },
    streak: { ...f.streak, ...(s.streak || {}) },
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

function newAvailable(state, deck, extra = 0) {
  if (!deckUnlocked(state, deck)) return [];
  const done = state.daily.new[deck.key] || 0;
  let left = (state.settings.newPerDay[deck.key] || 0) - done + extra;
  const kataReady = deckComplete(state, 'kata');
  const out = [];
  for (const c of DATA[deck.key]) {
    if (left <= 0) break;
    if (state.cards[c.id]) continue;
    if (c.hasKata && !kataReady) continue;
    out.push(c.id); left--;
  }
  return out;
}

function dueIds(state, today, deckKey) {
  const out = [];
  for (const id in state.cards) {
    const c = BY_ID[id];
    if (!c || (deckKey && c.deck !== deckKey)) continue;
    if (state.cards[id].d <= today) out.push(id);
  }
  return out;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function buildQueue(state, today, extra = 0) {
  rollDay(state, today);
  const due = shuffle(dueIds(state, today));
  const news = [];
  for (const d of DECKS) news.push(...newAvailable(state, d, extra));
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

function markStudied(state, today) {
  if (state.streak.last === today) return;
  state.streak.count = state.streak.last === today - 1 ? state.streak.count + 1 : 1;
  state.streak.last = today;
}

/* ================= Хранение: Telegram CloudStorage + localStorage ================= */

const CHUNK = 80; // карточек на один ключ CloudStorage (лимит значения 4096 символов)

function serializeChunks(state) {
  const ids = Object.keys(state.cards), chunks = [];
  for (let k = 0; k < ids.length; k += CHUNK) {
    chunks.push(ids.slice(k, k + CHUNK).map(id => {
      const c = state.cards[id];
      return [id, c.i, c.e, c.d, c.r, c.l].join('|');
    }).join('\n'));
  }
  return chunks;
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
function metaOf(state, n) {
  const { cards, ...rest } = state;
  return JSON.stringify({ ...rest, n });
}

const Store = {
  cloud: null, saved: [], timer: null,
  init() {
    const tg = typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp;
    if (tg && tg.initData && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9') && tg.CloudStorage) this.cloud = tg.CloudStorage;
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
        this.cloud[method](...args, (err, res) => { clearTimeout(t); resolve(err ? null : res); });
      } catch (e) { clearTimeout(t); resolve(null); }
    });
  },
  async loadCloud() {
    if (!this.cloud) return null;
    const raw = await this.call('getItem', 'm');
    if (!raw) return null;
    let meta; try { meta = JSON.parse(raw); } catch (e) { return null; }
    const keys = Array.from({ length: meta.n || 0 }, (_, k) => 'c' + k);
    let chunks = [];
    if (keys.length) {
      const res = await this.call('getItems', keys);
      if (!res) return null;
      chunks = keys.map(k => res[k] || '');
    }
    this.saved = chunks.slice();
    const { n, ...rest } = meta;
    return { ...rest, cards: parseChunks(chunks) };
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
    this.timer = setTimeout(() => this.flush(state), immediate ? 0 : 1500);
  },
  async flush(state) {
    const chunks = serializeChunks(state);
    for (let k = 0; k < chunks.length; k++) {
      if (chunks[k] !== this.saved[k]) await this.call('setItem', 'c' + k, chunks[k]);
    }
    if (this.saved.length > chunks.length) {
      const extra = []; for (let k = chunks.length; k < this.saved.length; k++) extra.push('c' + k);
      await this.call('removeItems', extra);
    }
    await this.call('setItem', 'm', metaOf(state, chunks.length));
    this.saved = chunks;
  },
};

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

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function renderHome() {
  setBack(null);
  const today = dayNumber();
  rollDay(S, today);
  const dueAll = dueIds(S, today).length;
  let newAll = 0;
  const rows = DECKS.map(d => {
    const total = DATA[d.key].length, intro = introducedCount(S, d.key);
    const due = dueIds(S, today, d.key).length;
    const nw = newAvailable(S, d).length; newAll += nw;
    const unlocked = deckUnlocked(S, d);
    const needName = d.needs ? DECKS.find(x => x.key === d.needs).name : '';
    const status = !unlocked ? `🔒 после «${esc(needName)}»`
      : intro === total ? `пройдено, повторений: ${due}`
      : `новых: ${nw} · повторить: ${due}`;
    return `<div class="deck${unlocked ? '' : ' locked'}">
      <div class="deck-top"><b>${esc(d.name)}</b><span class="muted">${intro}/${total}</span></div>
      <div class="bar"><i style="width:${(intro / total * 100).toFixed(1)}%"></i></div>
      <div class="muted small">${status}</div></div>`;
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
    <h3>Колоды</h3>
    ${rows}
    <button class="btn ghost" id="settings">Настройки</button>`;
  const go = document.getElementById('go');
  if (go) go.onclick = () => startSession(0);
  const more = document.getElementById('more');
  if (more) more.onclick = () => startSession(10);
  document.getElementById('settings').onclick = renderSettings;
}

function startSession(extra) {
  const today = dayNumber();
  const queue = buildQueue(S, today, extra);
  if (!queue.length) { renderHome(); return; }
  session = { queue, pos: 0, today, answered: 0, correct: 0, revealed: false, initial: queue.length };
  setBack(() => { Store.save(S, true); renderHome(); });
  renderCard();
}

function cardFront(c) {
  return `<div class="front ${c.deck === 'words' ? 'word' : ''}">${esc(c.front)}</div>`;
}
function cardBack(c) {
  if (c.deck === 'hira' || c.deck === 'kata') return `<div class="answer">${esc(c.romaji)}</div>`;
  if (c.deck === 'words') return `<div class="answer">${esc(c.ru)}</div>${c.kanji ? `<div class="kanji-form">${esc(c.kanji)}</div>` : ''}`;
  const ex = DATA.words.filter(w => w.kanji && w.kanji.includes(c.front)).slice(0, 3)
    .map(w => `<div class="ex"><span class="jp">${esc(w.kanji)}</span> <span class="muted">${esc(w.front)}</span> — ${esc(w.ru)}</div>`).join('');
  return `<div class="answer">${esc(c.ru)}</div>
    <div class="readings">${c.on ? `<div><span class="tag">он</span> ${esc(c.on)}</div>` : ''}${c.kun ? `<div><span class="tag">кун</span> ${esc(c.kun)}</div>` : ''}</div>
    ${ex ? `<div class="examples">${ex}</div>` : ''}`;
}
const speakText = c => c.deck === 'kanji' ? '' : c.front;

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
  renderCard();
}

function renderFinish() {
  const s = session;
  Store.save(S, true);
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

function renderSettings() {
  setBack(renderHome);
  const inputs = DECKS.map(d => `<label class="set-row"><span>${esc(d.name)}: новых в день</span>
    <input type="number" min="0" max="50" inputmode="numeric" data-k="${d.key}" value="${S.settings.newPerDay[d.key]}"></label>`).join('');
  $app().innerHTML = `<h2>Настройки</h2>
    ${inputs}
    <label class="set-row"><span>Озвучивать карточки</span><input type="checkbox" id="tts" ${S.settings.tts ? 'checked' : ''}></label>
    <p class="muted small">Колоды открываются по очереди: катакана и слова — после всей хираганы, кандзи — после всей катаканы. Слова на катакане появятся, когда пройдёшь катакану.</p>
    <h3>Резервная копия</h3>
    <p class="muted small">Прогресс хранится в облаке Telegram. Для надёжности можно скопировать его текстом.</p>
    <textarea id="backup" rows="4" placeholder="Сюда появится копия, или вставь свою для восстановления"></textarea>
    <div class="row gap"><button class="btn" id="export">Создать копию</button><button class="btn" id="import">Восстановить</button></div>
    <h3>Опасная зона</h3>
    <button class="btn danger" id="reset">Сбросить весь прогресс</button>
    <p class="muted small center">Котоба · ${Object.keys(S.cards).length} карточек в изучении</p>`;
  $app().querySelectorAll('input[data-k]').forEach(inp => inp.onchange = () => {
    const v = Math.max(0, Math.min(50, parseInt(inp.value, 10) || 0));
    inp.value = v; S.settings.newPerDay[inp.dataset.k] = v; Store.save(S);
  });
  document.getElementById('tts').onchange = e => { S.settings.tts = e.target.checked; Store.save(S); };
  const ta = document.getElementById('backup');
  document.getElementById('export').onclick = () => {
    ta.value = JSON.stringify(S); ta.select();
    try { navigator.clipboard.writeText(ta.value); ta.placeholder = ''; } catch (e) {}
  };
  document.getElementById('import').onclick = () => {
    let parsed; try { parsed = JSON.parse(ta.value); } catch (e) { alert('Не получилось прочитать копию'); return; }
    if (!parsed || typeof parsed.cards !== 'object') { alert('Это не похоже на копию прогресса'); return; }
    if (!confirm('Заменить текущий прогресс этой копией?')) return;
    S = normalize(parsed); Store.save(S, true); renderHome();
  };
  document.getElementById('reset').onclick = () => {
    if (!confirm('Точно стереть весь прогресс? Это нельзя отменить.')) return;
    S = freshState(); Store.save(S, true); renderHome();
  };
}

async function boot() {
  const tg = TG();
  if (tg) {
    tg.ready(); tg.expand();
    try { if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes(); } catch (e) {}
  }
  S = await Store.load();
  if ('speechSynthesis' in window) { try { speechSynthesis.getVoices(); } catch (e) {} }
  document.addEventListener('visibilitychange', () => { if (document.hidden && S) Store.save(S, true); });
  renderHome();
}

if (typeof document !== 'undefined') boot();
if (typeof module !== 'undefined') module.exports = { DATA, DECKS, BY_ID, schedule, buildQueue, freshState, normalize, serializeChunks, parseChunks, newAvailable, newCardState, dayNumber, rollDay, markStudied, metaOf };
