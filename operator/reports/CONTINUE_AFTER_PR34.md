# Продолжение PR34: проверка истечения (PR35)

23 сентября 2026. Base PR34 `b1e56de7c95ba5d5247968b86eded708ae76017f`,
ветка `deployment-expiry-recovery-20260923`. Финальные HEAD/PR/CI записываются
в актуальный `CoolBears_Collection(1).md` и описание PR после публикации.
На момент этого checkpoint CI нового commit ещё не запускался.

## Добавлено

- Submission gateway сохраняет неизменяемый первый hash/slot/lastValidHeight
  из собственного getLatestBlockhash до ответа клиенту.
- `expiry.mjs` проверяет finalized anchor block, invalid hash, вышедшую высоту,
  archive floor и отсутствие receipt. Обходит finalized payer history до
  реальной строки старше anchor, максимум 10 × 100 строк, затем проверяет
  archive/receipt ещё раз. Пропуски, fork, pruning, 429 и лимиты блокируют review.
- `coolbears_authorizeExpiredRetry` проверяет exact canonical signed bytes и
  сам собирает evidence. SQLite сохраняет proof с привязкой к claim и digest
  просмотренной истории. Возможен атомарный retirement ещё не отправленной
  подписанной попытки; send при этом не вызывается. Неизвестный другой claim
  обойти нельзя. Одна новая signature возможна лишь после failed/expired proof
  текущего claim; старые подписи запрещены навсегда, история не удаляется.
- `review-expiry ... --authorize-retry` проверяет серверный acknowledgment,
  повторно читает expiry/null receipts и все predecessor accounts/config lines,
  затем CAS сохраняет expired. Потеря ответа/CAS восстанавливается тем же review.
  Отдельный prepare-retry требует новый hash и новую ручную подпись владельца.
- У default read gateway нет submission/expiry opt-in или публичного history
  scan. Внутренние дополнительные RPC доступны только серверной проверке.

## Локальное подтверждение

- `/tmp/pr35-core.log`: 38 tests passed (expiry/RPC и gateway до добавления
  четырёх новых gateway-сценариев), 11854 мс.
- `/tmp/pr35-gateway.log`: 27 tests passed, 21268 мс (все 19 gateway и 8 scoped
  RPC). Наборы пересекаются; не складывать как уникальные tests.
- `/tmp/pr35-linked.log`: 1 связанный fixture passed, 76882 мс. Потеря server
  reply, mismatch accounts, конфликт writer-lock, повтор review, локальный
  expired, новый hash/owner signature, единственный send новых bytes и verified.
  Старые bytes не отправлялись. Удалялся только lock одноразового test fixture.
- `/tmp/pr35-runtime.log`: настоящий workerd/SQLite, 15 cases passed,
  41 intercepted upstream calls, 5 fixture submissions, 0 live transactions.
  Проверены рестарты, durable proof, запрет старой подписи и одна новая попытка.
  Miniflare 5.20260921.0-alpha. После теста изменён только поясняющий комментарий
  Worker и документация; точный final bundle hash проверит CI.

## Сохранённые границы

Продажи закрыты, цена 0,2 SOL. Лабораторию 2/2 не повторять. Журналы, locks,
SQLite, browser storage и реальные bundle не очищать. Код не развёрнут, PR
не сливались, site/Cloudflare/DNS/Helius plan не менялись, live транзакций нет.

Реальные custody/password владельца и отдельный private endpoint/secrets ещё
не настроены. Пароль не генерировать вместо владельца и не просить секреты
в чате: только безопасный локальный TTY. Оригиналы и приватные изображения,
CID, атрибуты, rank/mapping не публиковать и не менять.

История и finality доверяют одному RPC; это не независимое consensus proof.
Нет полного signed callback или заранее сохранённого anchor — review блокирован.
Следующие этапы: реальная приватная настройка и свежие оценки, удобная очередь
подписи, buyer RPC и покупка 1–50, реальные Phantom/Solflare/телефоны. Mainnet
и открытие продаж отдельно. Детальные условия: `deployment/EXPIRY.md`.
