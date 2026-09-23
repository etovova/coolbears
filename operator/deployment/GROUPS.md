# Ограниченная групповая подпись загрузки

После трёх начальных verified-операций можно подготовить **2–4 следующие
операции insert** одним запросом. Число означает транзакции, не NFT. Создание
аккаунтов и повторы остаются одиночными. Это ручная Devnet-процедура, не
автоматическая загрузка всей коллекции и не разрешение открыть продажи.

```sh
node operator/deployment/owner-console/cli.mjs status private/DEPLOYMENT
node operator/deployment/owner-console/cli.mjs prepare-group private/DEPLOYMENT 2
node operator/deployment/owner-console/cli.mjs serve private/DEPLOYMENT
```

Нужны существующий canonical bundle и отдельный приватный RPC, как в
[owner-console/README.md](owner-console/README.md). `prepare-group` разрешён
только для непрерывных ещё не начатых insert-операций, подписываемых одним
владельцем. Vault не расшифровывается, пароль не запрашивается. Для последней
одиночной операции есть `prepare-next`.

Подготовка проверяет Devnet genesis, предшествующие finalized accounts и
config lines, баланс, комиссии и unsigned simulation каждой операции. Все
сообщения получают один blockhash. До записи и перед выдачей кошельку требуется
не менее 80 оставшихся block heights. Это запас, не гарантия завершения до
истечения. Каждая insert-инструкция задаёт свой явный индекс; симуляции
выполняются относительно существующего проверенного префикса, без подставных
будущих accounts. Перед выдачей выполняется повторная проверка всей группы;
любой отказ блокирует запрос целиком.

Wallet Standard `solana:signTransaction` вызывается один раз с 2–4 входами.
Кошелёк может показать несколько окон подтверждения. `signAllTransactions`
из отдельного injected/deeplink API здесь не вызывается. Автоматического
перехода к одиночным подписям при ошибке нет. Только совместимые Devnet/v0
кошельки. Реальные Phantom/Solflare и телефоны этим изменением не проверены.

## Журнал и восстановление

Группа хранится в существующем append-only журнале. Один `prepare-group`
атомарно создаёт связанные попытки, один `request-wallet-group` занимает их
общим claim ID. Перезапуск или другая вкладка не снимают claim. Только явный
отказ кошелька 4001 с правильным claim может записать `wallet-declined-group`.
Таймаут, потеря ответа и неполный ответ разрешением на повтор не являются.

Браузер и сервер проверяют **все** подписанные сообщения в исходном порядке.
Изменённый, переставленный, повторённый или отсутствующий элемент отклоняет
весь ответ. Только после проверки записывается один `signed-group`; частичное
сохранение в журнал не допускается. При потере подтверждения можно сохранить
тот же готовый ответ повторно без нового вызова кошелька. После перезагрузки
панель сверяет IndexedDB и авторитетный журнал. Приватный JSON всей группы
можно импортировать прежней командой `import-response`; RPC и пароль не нужны.
Файл ограничен 32 KiB, не принимается через симлинк.

**Журнал с групповыми событиями требует код PR37 или новее.** Не запускать
старый код для изменения истории. Не удалять bundle, journal, browser storage,
SQLite или locks ради разблокировки. Копии bundle не запускать одновременно.
Отсутствующий полный callback может потребовать отдельного доказательного
review каждой попытки; автоматического восстановления подписи нет.

## Последовательная отправка

Панель только подписывает. `status` указывает первую ещё не verified операцию;
`send-one` и `resume` работают по прежним правилам [SENDING.md](SENDING.md).
Подпись следующих операций не разрешает пропустить предыдущую. Signed
simulation, проверка срока, durable send claim, точные bytes и finalized
проверка выполняются для каждого шага отдельно. Неизвестный результат
останавливает продвижение; failed/expired требуют явного review/retry из
[RETRY.md](RETRY.md) и [EXPIRY.md](EXPIRY.md).

Оставшиеся подписи могут истечь, пока оператор проверяет первый шаг. Они не
заменяются автоматически. После завершения группы нужно отдельно подготовить
следующую. Прогресс считает только verified-операции, не подписи. Свежий полный
бюджет, custody, endpoint, процесс покупки 1–50 и настоящие кошельки ещё требуют
отдельного завершения. Цена 0,2 SOL, продажи закрыты.

Проверки: `deployment-group.test.mjs` использует disposable encrypted bundle,
подписанный fixture-кошелёк, SDK accounts, имитацию RPC и настоящий файловый
журнал. Chromium проверяет HTTP, DOM, IndexedDB, группу из четырёх операций и
потерю ответа после сохранения. Это не реальные blockchain-транзакции.

Источники: [Metaplex insert items](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/insert-items),
[Wallet Standard Solana](https://github.com/wallet-standard/wallet-standard/blob/master/extensions/solana.md),
локальные типы `@solana/wallet-standard-features/lib/types/signTransaction.d.ts`,
[Phantom signAllTransactions](https://docs.phantom.com/phantom-deeplinks/provider-methods/signalltransactions),
[Solflare signAllTransactions](https://docs.solflare.com/solflare/technical/deeplinks/provider-methods/signalltransactions).
Последние два источника описывают отдельные API кошельков, не реализацию нашего
Wallet Standard клиента.
