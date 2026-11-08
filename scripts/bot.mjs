// Использование:
//   node scripts/bot.mjs remind  — отправить ежедневное напоминание с кнопкой
//   node scripts/bot.mjs setup   — один раз поставить кнопку «Учить» в меню бота
// Переменные окружения: BOT_TOKEN, CHAT_ID, APP_URL

const { BOT_TOKEN, CHAT_ID, APP_URL } = process.env;
const mode = process.argv[2] || 'remind';

if (!BOT_TOKEN || !APP_URL || (mode === 'remind' && !CHAT_ID)) {
  console.error('Нужны переменные BOT_TOKEN, APP_URL' + (mode === 'remind' ? ' и CHAT_ID' : ''));
  process.exit(1);
}

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

const LINES = [
  'おはよう！ Карточки на сегодня ждут.',
  'Время японского 🗾 Пара минут на повторения — и слова не забудутся.',
  'がんばって！ Сегодняшние повторения уже готовы.',
  'Каждый день понемногу — так и доходят до N4. Начнём?',
  'Не прерывай серию 🔥 Карточки на сегодня готовы.',
  'Новые слова и повторения ждут. いっしょに がんばろう！',
];

if (mode === 'setup') {
  await api('setChatMenuButton', {
    ...(CHAT_ID ? { chat_id: Number(CHAT_ID) } : {}),
    menu_button: { type: 'web_app', text: 'Учить', web_app: { url: APP_URL } },
  });
  console.log('Кнопка меню установлена');
} else {
  const day = Math.floor(Date.now() / 864e5);
  await api('sendMessage', {
    chat_id: CHAT_ID,
    text: LINES[day % LINES.length],
    reply_markup: { inline_keyboard: [[{ text: '📚 Начать занятие', web_app: { url: APP_URL } }]] },
  });
  console.log('Напоминание отправлено');
}
