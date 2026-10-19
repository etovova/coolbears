# Продолжение после PR37 — проверка нового заказа

23 сентября 2026. Base PR37 `637bbd10babbaad6fbe1fed5794649d75cc00d9f`.
Его CI 35887339492 successful: 327 passed, 1 прежний skip, 0 failed;
Chromium 7 scenarios, workerd/SQLite 15 cases. Ключи и endpoint не настроены.

## Добавлено

- `operator/orders/preflight.mjs`: чтение нового заказа 1–50 с revision 0,
  без истории и паузы, только Devnet. Неподходящие входы блокируются до RPC.
- Проверка полного genesis, программ, machine/guard/collection, всех config
  lines, остатка случайного списка индексов и отсутствия всех новых assets.
  Закрытый guard сравнивается с точным approved профилем; обычный покупатель
  блокируется до fee/simulation. Никакой команды открытия нет.
- Баланс, свежий blockhash, fee первого сообщения и base asset rent; unsigned
  simulation первого item. После неё повторные accounts/остаток/баланс/срок
  и digest заказа. Срок ограничен; redirects/retry/fallback отсутствуют.
- CLI `orders/check.mjs preflight <private-order.json>` читает ограниченный
  regular file без симлинков. Отдельный `COOLBEARS_BUYER_RPC_URL`, вывод без
  endpoint/secrets/paths/transaction bytes. Файл не записывается.
- Deployment-проверки по-прежнему требуют zero redemptions и точный префикс;
  состояние после минта допускается только новым order verifier.

## Проверки на момент commit

- `order-preflight.test.mjs`: **12 passed, 0 failed**, 6958 мс, лог
  `/tmp/pr38-preflight-final.log`. Настоящие SDK layouts/unsigned messages,
  ограниченный transport и файловый CLI; RPC fixtures, live transactions=0.
- Прежние account/order-planner/order-journal тесты: **40 passed, 0 failed**,
  3948 мс, `/tmp/pr38-existing.log`.
- `git diff --check` успешен. Полный CI для нового commit ещё не завершён;
  финальные результаты записываются в PR и CoolBears_Collection(1).md.

## Границы и следующий шаг

Инструкция `operator/orders/PREFLIGHT.md`. Существующие попытки/частичные заказы
не перепланируются. Пока проверяется только первый item нового заказа, не
50 последовательных исполнений. Успешен лишь текущий закрытый owner-профиль.
`readyToSign=false`, `readyToSubmit=false`, `salesOpen=false` всегда.
Budget частичный: protocol charges/остальные fees/полный итог неизвестны;
нельзя выдавать эту оценку за сумму для пополнения. Нет asset custody, подписи,
sender, public buyer gateway, finalized recovery или интерфейса покупки.

Далее: реальная private custody/endpoint и свежий бюджет полного выпуска;
durable buyer storage/asset signers, проверка signed bytes, отдельный gateway,
sender/recovery, UI и реальные Phantom/Solflare/телефоны. Пароль выбирает
владелец в безопасном локальном TTY; не генерировать вместо него и не просить
секреты в чате. Продажи закрыты, цена 0,2 SOL. Mainnet/открытие отдельно.
Не повторять лабораторию 2/2; не очищать journal/bundle/browser/SQLite/locks.
Рабочие lab RPC/secrets, Helius-план, сайт/DNS/защита и оригиналы не менялись.
