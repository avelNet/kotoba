// Использование:
//   node scripts/bot.mjs remind — разослать напоминания тем, у кого сейчас «их» час (запускается каждый час)
//   node scripts/bot.mjs setup  — один раз: вебхук на сервер, команды бота, кнопка «Учить» в меню
//   node scripts/bot.mjs stats  — вывести статистику в лог
//
// Переменные: BOT_TOKEN, APP_URL, API_URL (адрес воркера), ADMIN_SECRET, WEBHOOK_SECRET.
// Пока API_URL не задан, работает старый режим: одно напоминание в CHAT_ID в 00:xx UTC.

const { BOT_TOKEN, APP_URL, CHAT_ID, WEBHOOK_SECRET } = process.env;
const API_URL = (process.env.API_URL || '').replace(/\/+$/, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const mode = process.argv[2] || 'remind';
const forced = process.env.FORCED === 'true'; // запуск руками из Actions

if (!BOT_TOKEN || !APP_URL) { console.error('Нужны BOT_TOKEN и APP_URL'); process.exit(1); }
const multi = !!(API_URL && ADMIN_SECRET);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}
async function must(method, body) {
  const j = await api(method, body);
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
async function server(path, opts = {}) {
  const res = await fetch(API_URL + path, {
    ...opts, headers: { Authorization: `Bearer ${ADMIN_SECRET}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const LINES = [
  'おはよう！ Карточки на сегодня ждут.',
  'Время японского 🗾 Пара минут на повторения — и слова не забудутся.',
  'がんばって！ Сегодняшние повторения уже готовы.',
  'Каждый день понемногу — так и доходят до цели. Начнём?',
  'Не прерывай серию 🔥 Карточки на сегодня готовы.',
  'Новые слова и повторения ждут. いっしょに がんばろう！',
];
const message = chat => ({
  chat_id: chat,
  text: LINES[Math.floor(Date.now() / 864e5) % LINES.length],
  reply_markup: { inline_keyboard: [[{ text: '📚 Начать занятие', web_app: { url: APP_URL } }]] },
});

if (mode === 'setup') {
  await must('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Учить', web_app: { url: APP_URL } } });
  console.log('Кнопка меню «Учить» установлена для всех');
  if (multi) {
    if (!WEBHOOK_SECRET) throw new Error('Для вебхука нужен WEBHOOK_SECRET');
    await must('setWebhook', { url: API_URL + '/tg', secret_token: WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true });
    await must('setMyCommands', { commands: [
      { command: 'start', description: 'Начать и включить напоминания' },
      { command: 'stop', description: 'Выключить напоминания' },
    ] });
    if (CHAT_ID) await must('setMyCommands', {
      scope: { type: 'chat', chat_id: Number(CHAT_ID) },
      commands: [
        { command: 'stats', description: 'Статистика' },
        { command: 'start', description: 'Начать и включить напоминания' },
        { command: 'stop', description: 'Выключить напоминания' },
      ],
    });
    console.log('Вебхук и команды установлены:', API_URL + '/tg');
  } else {
    console.log('API_URL / ADMIN_SECRET не заданы — вебхук не ставлю (старый режим)');
  }
} else if (mode === 'stats') {
  if (!multi) throw new Error('Нужны API_URL и ADMIN_SECRET');
  console.log(JSON.stringify(await server('/stats'), null, 2));
} else if (!multi) {
  // старый режим: одному человеку раз в день
  if (!CHAT_ID) throw new Error('Нужен CHAT_ID');
  if (new Date().getUTCHours() !== 0 && !forced) { console.log('Не тот час, пропускаю'); process.exit(0); }
  await must('sendMessage', message(CHAT_ID));
  console.log('Напоминание отправлено');
} else {
  // Actions может запуститься с опозданием — берём начало текущего часа + 30 минут
  const at = Math.floor(Date.now() / 36e5) * 36e5 + 30 * 60000;
  const { chats } = await server('/due?at=' + at);
  console.log(`К отправке: ${chats.length}`);
  let sent = 0;
  const gone = [];
  for (const chat of chats) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const j = await api('sendMessage', message(chat));
      if (j.ok) { sent++; break; }
      if (j.error_code === 429) { await sleep(((j.parameters && j.parameters.retry_after) || 5) * 1000); continue; }
      if (j.error_code === 403 || (j.error_code === 400 && /chat not found/i.test(j.description))) gone.push(chat);
      else console.log(`Ошибка для ${chat}: ${j.description}`);
      break;
    }
    await sleep(40); // ~25 сообщений в секунду, ниже лимита Telegram
  }
  if (gone.length) await server('/unsub', { method: 'POST', body: JSON.stringify({ chats: gone }) });
  console.log(`Отправлено: ${sent}, заблокировали бота: ${gone.length}`);
}
