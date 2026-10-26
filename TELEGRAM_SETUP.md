# «Симулятор перекупа» — Telegram Mini App

Игровой сайт: https://perekup-simulator-game.onrender.com/?tg=1

Сервер бота: https://perekup-control-api.onrender.com

## Запуск своего бота

1. В Telegram открой [@BotFather](https://t.me/BotFather) и отправь `/newbot`.
2. Укажи название и уникальное имя, заканчивающееся на `bot`.
3. Скопируй **токен**, выданный BotFather. Никому его не отправляй и не коммить в GitHub.
4. Открой [Render → perekup-control-api → Environment](https://dashboard.render.com/web/srv-dbei4v4s728c73cah650/env).
5. Создай переменную `TELEGRAM_BOT_TOKEN` со значением токена. Нажми **Save, deploy**.
6. После успешного запуска Render открой чат своего бота и отправь `/start`. Он ответит кнопкой **«🚗 Играть в „Перекупа“»**.
7. Сервер сам настраивает меню бота и HTTPS webhook. Также работают `/play` и `/help`.
8. Для кнопки **«Открыть приложение»** в профиле бота (главного Mini App) открой BotFather → `/mybots` → твой бот → Bot Settings → Configure Mini App и укажи URL из первой строки.

## Как устроено

- Обычный веб-сайт остаётся доступным по прежней ссылке.
- Mini App открывает существующую игру внутри Telegram на телефоне и компьютере.
- На первом запуске подписанные Telegram WebApp `initData` проверяются на сервере (HMAC-SHA-256 и срок действия).
- Создаётся отдельное облачное сохранение по Telegram ID в существующей базе Postgres. В админке этот игрок появится с логином `tg_<Telegram ID>`.
- Вход без ручного логина/пароля; игровые данные синхронизируются через действующие `/api/me` и `/api/me/sync`.
- Первая Telegram-сессия начинается с игры, сохранённой в WebView Telegram. Существующее Safari-сохранение не объединяется автоматически — можно вручную войти в обычный онлайн-аккаунт через вкладку «Профиль».
- Токен находится **только** в Render Environment на сервере.
- Бот не работает до установки `TELEGRAM_BOT_TOKEN`.

## Поддержка и диагностика

- Проверь статус сервера: https://perekup-control-api.onrender.com/api/health
- Проверь, подключён ли бот: https://perekup-control-api.onrender.com/api/telegram/status
- В Render Logs после настройки ожидается строка `Telegram bot configured: @...`.
- Если указал неверный токен, Telegram API вернёт ошибку в Render Logs (без самого токена).
- Не отключай Postgres: Telegram-аккаунты сохраняются в той же базе, что и остальные игроки.
