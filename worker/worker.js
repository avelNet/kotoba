// Котоба — сервер на Cloudflare Workers + D1.
//
// Что делает:
//   POST /tg        — вебхук бота: /start, /stop, /stats (только для админа),
//                     любое другое сообщение пересылается админу как отзыв,
//                     ответ админа (reply) уходит обратно автору.
//   POST /ping      — приложение раз в несколько минут сообщает: сколько ответов сегодня,
//                     часовой пояс, час напоминания. Пользователь проверяется по initData.
//   POST /feedback  — отзыв из приложения → админу в Telegram.
//   GET  /due       — (для GitHub Actions) кому сейчас слать напоминание.
//   POST /unsub     — (для GitHub Actions) пометить тех, кто заблокировал бота.
//   GET  /stats     — (для GitHub Actions / админа) статистика удержания.
//
// Переменные (Settings → Variables and Secrets):
//   BOT_TOKEN       — токен бота (secret)
//   WEBHOOK_SECRET  — любая длинная строка, та же передаётся в setWebhook (secret)
//   ADMIN_SECRET    — любая длинная строка для GitHub Actions (secret)
//   ADMIN_CHAT_ID   — твой chat_id: сюда приходят отзывы, только тебе отвечает /stats
//   APP_URL         — адрес приложения (https://avelnet.github.io/kotoba/)
//   SALT            — любая строка: подмешивается в хэш id для статистики (secret)
// Привязка базы: D1 database с именем переменной DB.

const DEFAULT_TZ = 180;   // минут к UTC, пока приложение не сообщило своё (Москва)
const DEFAULT_HOUR = 8;   // час напоминания по умолчанию

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS subs (
     chat_id INTEGER PRIMARY KEY, name TEXT, tz INTEGER, hour INTEGER,
     active INTEGER DEFAULT 1, created TEXT, last_day TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, first_day TEXT, last_day TEXT)`,
  `CREATE TABLE IF NOT EXISTS activity (uid TEXT, day TEXT, answers INTEGER, PRIMARY KEY (uid, day))`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const q of SCHEMA) await db.prepare(q).run();
  schemaReady = true;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
});

// ---------- даты ----------
const localDay = (tzMin, now = Date.now()) => new Date(now + tzMin * 60000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const clampTz = v => { v = Math.round(Number(v)); return Number.isFinite(v) && v >= -720 && v <= 840 ? v : null; };

// ---------- крипто ----------
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

// Проверка initData мини-приложения (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
export async function checkInitData(initData, botToken, maxAgeSec = 7 * 86400) {
  if (!initData || typeof initData !== 'string') return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await hmac('WebAppData', botToken);
  const calc = hex(await hmac(secret, dcs));
  if (calc !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get('auth_date') || 0);
  if (!(age < maxAgeSec)) return null;
  try { return JSON.parse(p.get('user') || 'null'); } catch (e) { return null; }
}

// ---------- Telegram ----------
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ ok: false }));
}
const appButton = (env, text = '📚 Открыть Котобу') =>
  ({ inline_keyboard: [[{ text, web_app: { url: env.APP_URL } }]] });
const nameOf = u => [u.first_name, u.last_name].filter(Boolean).join(' ') + (u.username ? ` (@${u.username})` : '');

const WELCOME = `こんにちは！ Это Котоба — японский с нуля прямо в Telegram.

• Хирагана → катакана → слова → кандзи, по порядку
• Интервальные повторения, как в Anki: забытое вернётся вовремя
• Каждое утро пришлю напоминание (время меняется в настройках, /stop — выключить)

Есть идея или нашёл ошибку — просто напиши сюда, я прочитаю.`;

async function onUpdate(env, upd) {
  const m = upd.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const chat = m.chat.id, text = (m.text || '').trim();
  const isAdmin = String(chat) === String(env.ADMIN_CHAT_ID);
  const db = env.DB;

  if (/^\/start\b/.test(text)) {
    await db.prepare(`INSERT INTO subs (chat_id, name, tz, hour, active, created) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(chat_id) DO UPDATE SET active = 1, name = excluded.name`)
      .bind(chat, nameOf(m.from || {}), DEFAULT_TZ, DEFAULT_HOUR, new Date().toISOString()).run();
    await tg(env, 'sendMessage', { chat_id: chat, text: WELCOME, reply_markup: appButton(env, '📚 Начать') });
    return;
  }
  if (/^\/stop\b/.test(text)) {
    await db.prepare('UPDATE subs SET active = 0 WHERE chat_id = ?').bind(chat).run();
    await tg(env, 'sendMessage', { chat_id: chat, text: 'Напоминания выключены. Включить снова — /start.' });
    return;
  }
  if (/^\/stats\b/.test(text) && isAdmin) {
    await tg(env, 'sendMessage', { chat_id: chat, text: statsText(await stats(db)) });
    return;
  }
  // ответ админа на пересланный отзыв → автору
  if (isAdmin && m.reply_to_message) {
    const tag = /#u(\d+)/.exec(m.reply_to_message.text || '');
    if (tag && text) {
      const r = await tg(env, 'sendMessage', { chat_id: Number(tag[1]), text: `✉️ Ответ разработчика:\n\n${text}` });
      await tg(env, 'sendMessage', { chat_id: chat, text: r.ok ? 'Отправлено ✓' : `Не доставлено: ${r.description || 'ошибка'}` });
      return;
    }
  }
  if (isAdmin || !text) return;
  await feedback(env, m.from || { id: chat }, text, 'бот');
  await tg(env, 'sendMessage', { chat_id: chat, text: 'Спасибо! Передал разработчику 🙏' });
}

async function feedback(env, user, text, where) {
  if (!env.ADMIN_CHAT_ID) return false;
  const r = await tg(env, 'sendMessage', {
    chat_id: env.ADMIN_CHAT_ID,
    text: `💬 Отзыв (${where}) от ${nameOf(user) || 'без имени'} #u${user.id}\n\n${String(text).slice(0, 3000)}\n\n— ответь реплаем, и я перешлю`,
  });
  return !!r.ok;
}

// ---------- статистика ----------
export async function stats(db, now = Date.now()) {
  const users = (await db.prepare('SELECT uid, first_day FROM users').all()).results || [];
  const act = (await db.prepare('SELECT uid, day, answers FROM activity').all()).results || [];
  const subs = (await db.prepare('SELECT COUNT(*) AS n, SUM(active) AS a FROM subs').first()) || {};
  const byUser = {};
  for (const a of act) (byUser[a.uid] = byUser[a.uid] || []).push(a.day);
  const today = localDay(0, now);
  const ret = k => {
    let base = 0, kept = 0;
    for (const u of users) {
      if (dayDiff(u.first_day, today) < k) continue; // ещё рано судить
      base++;
      if ((byUser[u.uid] || []).some(d => dayDiff(u.first_day, d) >= k)) kept++;
    }
    return { base, kept, pct: base ? Math.round(kept * 100 / base) : null };
  };
  const day2 = (() => {
    let base = 0, kept = 0;
    for (const u of users) {
      if (dayDiff(u.first_day, today) < 1) continue;
      base++;
      if ((byUser[u.uid] || []).some(d => dayDiff(u.first_day, d) === 1)) kept++;
    }
    return { base, kept, pct: base ? Math.round(kept * 100 / base) : null };
  })();
  const recent = {};
  for (const a of act) if (dayDiff(a.day, today) < 7) recent[a.day] = (recent[a.day] || 0) + 1;
  const newByDay = {};
  for (const u of users) if (dayDiff(u.first_day, today) < 7) newByDay[u.first_day] = (newByDay[u.first_day] || 0) + 1;
  return {
    users: users.length, subs: subs.n || 0, subsActive: subs.a || 0,
    day2, d7: ret(7), d14: ret(14),
    dau: Object.keys(recent).sort().map(d => [d, recent[d], newByDay[d] || 0]),
    answers: act.reduce((s, a) => s + (a.answers || 0), 0),
  };
}
export function statsText(s) {
  const r = x => x.pct == null ? '—' : `${x.pct}% (${x.kept}/${x.base})`;
  return [
    `📊 Котоба`,
    `Открывали приложение: ${s.users}`,
    `Подписаны на бота: ${s.subs} (напоминания вкл: ${s.subsActive})`,
    ``,
    `Вернулись на 2-й день: ${r(s.day2)}`,
    `Занимаются через 7+ дней: ${r(s.d7)}`,
    `Занимаются через 14+ дней: ${r(s.d14)}`,
    ``,
    `По дням (активных / новых):`,
    ...s.dau.map(([d, n, nw]) => `${d.slice(5)}: ${n} / ${nw}`),
    ``,
    `Всего ответов: ${s.answers}`,
  ].join('\n');
}

// ---------- обработчики ----------
async function onPing(env, body) {
  const user = await checkInitData(body.initData, env.BOT_TOKEN);
  if (!user || !user.id) return json({ ok: false, error: 'bad initData' }, 401);
  const tz = clampTz(body.tz) ?? DEFAULT_TZ;
  const day = localDay(tz);
  const answers = Math.max(0, Math.min(5000, Math.round(Number(body.answers) || 0)));
  const uid = (await sha256((env.SALT || '') + ':' + user.id)).slice(0, 24);
  const db = env.DB;
  await db.prepare(`INSERT INTO users (uid, first_day, last_day) VALUES (?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET last_day = excluded.last_day`).bind(uid, day, day).run();
  if (answers > 0) {
    await db.prepare(`INSERT INTO activity (uid, day, answers) VALUES (?, ?, ?)
      ON CONFLICT(uid, day) DO UPDATE SET answers = MAX(answers, excluded.answers)`).bind(uid, day, answers).run();
  }
  // настройки напоминания — только если человек подписан на бота
  let hour = body.hour === null || body.hour === 'off' ? -1 : Math.round(Number(body.hour));
  if (!(hour >= -1 && hour <= 23)) hour = DEFAULT_HOUR;
  await db.prepare(`UPDATE subs SET tz = ?, hour = ?, last_day = CASE WHEN ? > 0 THEN ? ELSE last_day END
    WHERE chat_id = ?`).bind(tz, hour, answers, day, user.id).run();
  return json({ ok: true });
}

// кому слать напоминание прямо сейчас: местный час совпал, сегодня ещё не занимался
export async function due(db, now = Date.now()) {
  const rows = (await db.prepare('SELECT chat_id, tz, hour, last_day FROM subs WHERE active = 1 AND hour >= 0').all()).results || [];
  return rows.filter(r => {
    const tz = r.tz ?? DEFAULT_TZ;
    const localHour = new Date(now + tz * 60000).getUTCHours();
    return localHour === r.hour && r.last_day !== localDay(tz, now);
  }).map(r => r.chat_id);
}

const authed = (req, env) => env.ADMIN_SECRET && req.headers.get('Authorization') === `Bearer ${env.ADMIN_SECRET}`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      await ensureSchema(env.DB);
      if (url.pathname === '/tg' && req.method === 'POST') {
        if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
        await onUpdate(env, await req.json());
        return new Response('ok');
      }
      if (url.pathname === '/ping' && req.method === 'POST') return onPing(env, await req.json());
      if (url.pathname === '/feedback' && req.method === 'POST') {
        const body = await req.json();
        const user = await checkInitData(body.initData, env.BOT_TOKEN);
        const text = String(body.text || '').trim();
        if (!user || !text) return json({ ok: false }, 400);
        return json({ ok: await feedback(env, user, text, 'приложение') });
      }
      if (url.pathname === '/due' && authed(req, env)) {
        const at = Number(url.searchParams.get('at')) || Date.now();
        return json({ chats: await due(env.DB, at) });
      }
      if (url.pathname === '/unsub' && req.method === 'POST' && authed(req, env)) {
        const { chats = [] } = await req.json();
        for (const c of chats) await env.DB.prepare('UPDATE subs SET active = 0 WHERE chat_id = ?').bind(c).run();
        return json({ ok: true, n: chats.length });
      }
      if (url.pathname === '/stats' && authed(req, env)) return json(await stats(env.DB));
      if (url.pathname === '/') return new Response('Kotoba API работает');
      return new Response('not found', { status: 404 });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
};
