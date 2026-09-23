# PR35: ручной повтор после проверенного истечения

Продажи закрыты, цена 0,2 SOL. Этот этап продолжает PR34 и не развёрнут.
Приватный custody/endpoint ещё предстоит настроить. Лабораторию 2/2 не повторять;
существующие журналы, browser storage, SQLite, locks и bundle не очищать.

## Когда разрешается новая попытка

Истёкший blockhash и `null` по signature сами по себе недостаточны. Новый
`coolbears_authorizeExpiredRetry` работает только при `allowSubmission: true`
и принимает точные сохранённые signed bytes утверждённого canonical message.
Он не пересылается upstream и не отправляет транзакцию.

1. При успешном `getLatestBlockhash` submission gateway **до ответа клиенту**
   сохраняет hash, context slot и lastValidBlockHeight. Первая запись неизменна;
   конфликтующий срок действия останавливает операцию. Без этого anchor review
   не разрешён. Клиент не может передать свой anchor как доказательство.
2. Сервер заново проверяет Devnet genesis. Finalized `getBlock` сохранённого slot
   должен содержать ровно тот hash. Затем `isBlockhashValid` при finalized должен
   вернуть false, а finalized блок его context slot — высоту больше сохранённой
   lastValidBlockHeight. Fork/пропущенный или недоступный блок блокирует review.
3. `getFirstAvailableBlock` должен покрывать anchor. Исторический status и
   finalized transaction точной signature должны отсутствовать.
4. Сервер читает finalized `getSignaturesForAddress` утверждённого payer, который
   входит в accountKeys каждой допустимой транзакции. Страницы идут от новых
   записей к старым с `before`: максимум 10 страниц по 100 строк. Нужна настоящая
   finalized строка **старше anchor slot**; пустая или оборванная страница до этой
   границы не доказывает отсутствие. Строки должны быть упорядочены, без повторов
   signatures. Найденная candidate signature останавливает review независимо
   от её err. `minContextSlot` проверяет свежесть узла, а не фильтрует историю.
5. После обхода ещё раз проверяются archive floor и оба отсутствующих receipt.
   Общий предел проверки — 25 секунд и 24 upstream-вызова; каждый вызов проходит
   прежние дневные квоты, durable ledger, cooldown и интервал минимум 200 мс.
6. В SQLite атомарно сохраняется proof с hash, anchor/horizon slots, высотами,
   числом страниц и SHA-256 просмотренных signature/slot. Он связан с точными
   message identity, signature и hash signed bytes. Старые claims не удаляются.
7. Клиент проверяет точный ответ, неизменность bundle/журнала, снова читает
   finalized invalid hash, высоту, оба отсутствующих receipt и **все аккаунты
   предыдущего шага**, включая полный префикс config lines. Только затем CAS
   записывает `expired`. Следующая попытка требует отдельного `prepare-retry`,
   свежего preflight/unsigned simulation, нового hash и новой подписи владельца.
   Обычный sender повторяет signed simulation перед единственной отправкой.

Если подписанная попытка ещё не отправлялась, review может атомарно сохранить
её claim **вместе с доказательством истечения**, не выполняя send. Если текущий
server claim относится к другой неизвестной попытке, это запрещено. Если
предыдущий claim уже имеет собственный failed/expired proof, следующую истёкшую
подписанную попытку можно закрыть тем же способом. Повторно использованная
signature запрещена навсегда. Proof старой попытки не освобождает новую.

## Команды после реальной приватной настройки

Сначала проверить успешный результат сохранённой попытки:

```sh
node operator/deployment/send-cli.mjs resume private/DEPLOYMENT collection-create
```

Для отдельной проверки истечения:

```sh
node operator/deployment/send-cli.mjs review-expiry private/DEPLOYMENT collection-create --authorize-retry
```

Только после сохранённого `expired`:

```sh
node operator/deployment/owner-console/cli.mjs prepare-retry private/DEPLOYMENT collection-create
node operator/deployment/owner-console/cli.mjs serve private/DEPLOYMENT
```

Затем владелец явно подписывает новый запрос; отправка — отдельный
`send-one ... --devnet-send`, восстановление — `resume`. Пароль вводится только
в локальном TTY; RPC URL и Bearer token находятся в приватном окружении, не в
аргументах, чате, отчётах или frontend. Автоматической очереди/отправки нет.

## Потеря ответа и границы доказательства

Если SQLite уже сохранила proof, но ответ потерян или локальная проверка/CAS
не прошла, повторять только **review-expiry той же попытки**. Сервер возвращает
сохранённый proof без повторного upstream, пока именно этот claim текущий;
клиент заново проверяет сеть и accounts. Серверный proof может уже существовать
до локального `expired`: это не основание подписывать/отправлять в обход журнала.
После локального `expired` команда возвращает `already-recorded`, явно без
свежей проверки. Старые proofs и signatures остаются доступны после замены claim.

Это ограниченная проверка согласованности доверенного RPC, **не независимое
криптографическое доказательство отсутствия**. SHA-256 истории связывает
просмотренные строки, но не доказывает полноту индекса провайдера. Один RPC
остаётся источником finality, archive и address history. Заведомо неполная
история, pruning, индекс без старой строки, более 1000 строк до границы, fork,
429, malformed response, изменение журнала и повреждённое storage блокируют
новую попытку. Нет обхода лимита, fallback или автоматического повторения.

Старые claims без заранее сохранённого anchor нельзя разблокировать этим
методом. Потерянный callback кошелька без сохранённых полных signed bytes тоже
не поддерживается. Mainnet, реальные кошельки/телефоны, полноценный процесс
покупки 1–50 и открытие продаж остаются отдельными этапами.

## Проверки

Unit-проверки покрывают границы страниц, pruning/fork, появление receipt,
неверную сеть, точный одноразовый RPC grant, конкурентный review, потерю
подтверждения записи и постоянные claims. Связанный fixture проходит
review → потеря ответа → account mismatch → CAS failure → restart/review →
expired → новый hash/подпись → send → finalized success. Старые bytes не
отправляются. Workerd-проверка использует настоящий SQLite и перезапуски;
весь outbound перехвачен. Это не live Devnet или проверка настоящего кошелька.

Первичные источники, проверенные 23 сентября 2026:
[getLatestBlockhash](https://solana.com/docs/rpc/http/getlatestblockhash),
[getBlock](https://solana.com/docs/rpc/http/getblock),
[isBlockhashValid](https://solana.com/docs/rpc/http/isblockhashvalid),
[getBlockHeight](https://solana.com/docs/rpc/http/getblockheight),
[getFirstAvailableBlock](https://solana.com/docs/rpc/http/getfirstavailableblock),
[getSignaturesForAddress](https://solana.com/docs/rpc/http/getsignaturesforaddress).
