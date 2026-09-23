# Подготовка deployment, подпись и проверка только чтением

Модуль строит неподписанный план полного выпуска, проверяет обмен подписываемыми байтами и сохраняет локальный журнал отдельных попыток. Отдельный read-only адаптер проверяет сеть, accounts и finalized-результат через явно указанный RPC. Добавлены зашифрованное хранение трёх новых account signers и сохранение запроса/ответа подписи владельца. Здесь нет интерфейса кошелька, симуляции или отправки транзакций. Продажи остаются закрытыми; готовность к Mainnet не заявляется.

## План полного выпуска

`buildDeploymentPlan` использует официальный Core SDK, Core Candy Machine SDK и `jsonGuardParser` установленного CLI 0.4.3. Для текущей политики и canonical metadata план содержит **1431 отдельную транзакцию**:

| Этап | Транзакций | Требуемые подписанты | Ожидаемый результат |
| --- | ---: | --- | --- |
| `collection-create` | 1 | Владелец + новый collection | Collection, update authority владельца, royalties 7%. |
| `reserve-create` | 1 | Владелец + новый reserved asset | #0000 в этой коллекции, получатель — владелец. |
| `machine-create` | 1 | Владелец + новый machine | Allocate + initialize + create guard + wrap в одной транзакции; 9999 позиций. |
| `insert-*` | 1428 | Владелец | Config lines #0001–#9999 без повторов и пропусков. |

Для проверяемой формы v0 первые три шаблона занимают соответственно 424, 442 и 721 байт. У вставок обычно семь строк; последняя транзакция объединяет инструкции на семь и три строки. Все шаблоны проверяются по фактическому размеру SDK, не более 1232 байт. Если будущая версия SDK или политика увеличит machine bundle сверх лимита, построение остановится; непроверенного автоматического разбиения создания машины нет.

Владелец из `metadata/policy.json` назначается payer, collection update authority, Candy Machine authority и Candy Guard authority. Guard — PDA от адреса machine; отдельного ключа guard нет. Mint authority после wrap — этот guard. `addressGate` разрешает только владельца, Sol Payment настроен на 0,5 SOL в его адрес; публичные продажи не открываются. Шаблоны не используют lab operator как authority.

Адреса collection, reserved asset и machine передаются явно и остаются стабильными. Их существование, доступность приватных подписантов и отсутствие конфликтующих accounts в сети здесь не проверяются. Текущий план описывает создание **новой** коллекции: путь использования уже существующей коллекции потребует отдельной проверенной подготовки.

Файловый handoff сохраняет один текущий запрос. 1431 транзакция не означает обещание удобного процесса из 1431 ручного подтверждения. Способ группировки запросов в кошельке, интерфейс прогресса, ограничения мобильных кошельков и восстановление пользователя пока не реализованы.

## API

```js
const plan = await buildDeploymentPlan({
  cluster, collection, reservedAsset, machine,
  blockhash, lastValidBlockHeight,
  machineRentLamports, // положительная decimal string в пределах u64
});
const manifest = deploymentManifestFromPlan(deploymentId, plan);
```

`plan.mode` — `offline-unsigned-deployment`; `readyToSubmit`, `networkVerified`, `blockhashVerified`, `rentVerified` и `salesOpen` равны `false`. `feeQuote: null`; счётчики запросов, подписей и отправок равны нулю. Строковый cluster — метка намерения, не подтверждение genesis hash сети.

`machineRentLamports` — явное входное значение для System Program create-account; заглушка `getRent` не обращается в сеть. Полный machine account занимает 871827 байт. Число из тестового fixture не является бюджетом, текущей ценой rent или рекомендацией пополнить кошелёк. Перед будущим исполнением нужен отдельный read-only расчёт в выбранной сети, включая остальные accounts и комиссии.

Каждый шаг содержит `id`, `kind`, `dependsOn`, `requiredSigners`, `transactionBase64`, `serializedSize`, `messageSha256`, `blockhash`, `lastValidBlockHeight`, `expected`. Все подписи в плановых байтах пустые. Manifest — отдельная копия с точной схемой `{version: 1, id, cluster, owner, steps}`; шаги manifest не содержат `kind` и `serializedSize`. Это проверяемое намерение, не подтверждение состояния сети.

| Функция | Назначение |
| --- | --- |
| `createSigningRequest({ deploymentId, stepId, attempt, cluster, owner, transactionBase64, lastValidBlockHeight })` | Проверить подготовленные байты: владелец — первый signer/fee payer, его подпись пуста, подписи остальных signers уже корректны. |
| `verifySigningResponse(request, { transactionBase64 })` | Проверить неизменность сообщения, всех signers и прежних частичных подписей; проверить Ed25519-подписи и вернуть канонические signed bytes и signature. |
| `createDeploymentJournal(directory, manifest)` | Создать новый локальный каталог с неизменяемым manifest; существующий каталог не перезаписывается. |
| `readDeploymentJournal(directory)` | Прочитать manifest и последовательно воспроизвести события. |
| `appendDeploymentEvent(directory, event, { expectedRevision })` | Под исключительной файловой блокировкой проверить и добавить одно событие, затем перечитать сохранённое состояние. |
| `nextDeploymentAction(snapshot)` | Выбрать следующий шаг модели либо reconciliation; завершение не разрешает открытие продаж. |

Неподписанный шаблон коллекции, резервного asset или machine нельзя сразу передать в `createSigningRequest`: сначала потребуются реальные частичные подписи соответствующих новых accounts. `vault.mjs` создаёт только эти частичные подписи после проверки всего canonical manifest. Приватный ключ владельца ему не нужен: будущее подключение кошелька должно вернуть подписанные байты. Новый модуль custody создаёт и хранит эти три signer в зашифрованном bundle; одних публичных адресов недостаточно для восстановления. См. [хранение и owner handoff](CUSTODY.md).

## Попытки, журнал и восстановление

Все шаги имеют последовательные зависимости. Перед будущим запросом кошельку необходимо сохранить событие `prepare` с request и `retry`; перед передачей в RPC — сохранить проверенный ответ `signed`, затем отдельный `claim-send`. Ответ отправителя `accepted` ещё не подтверждает выполнение. Активная попытка после перезагрузки ведёт к `reconcile`; неопределённый исход `unknown` запрещает повторную отправку и переход к следующему шагу.

Поздний корректный ответ кошелька может дополнить последнюю `unknown` попытку подписанными байтами, сохранив `unknown`. Повторный `claim-send` из уже занятой/неопределённой попытки запрещён. Явный отказ `cancelled`, доказанные `failed`/`expired` допускают только отдельно рассмотренный `retry: true`; завершённые шаги и предыдущая история сохраняются.

Один общий blockhash в офлайн-плане — шаблон для проверки структуры. Он не предназначен для исполнения всей очереди. Перед каждой реальной попыткой потребуется свежий blockhash и проверка его срока действия. Журнал допускает изменение blockhash относительно исходного шаблона, сохраняя остальные байты сообщения. При этом частичные подписи нужно заново создать для нового сообщения; кошелёк владельца должен сохранить их без изменений. Нельзя заменить blockhash в уже подписанном сообщении и оставить прежние подписи.

Файловый журнал использует новый каталог, приватные разрешения, fsync и публикацию файлов без перезаписи. События связаны hash chain, revision проверяется под локальной блокировкой каталога. Существующая `.writer-lock` не захватывается автоматически после предполагаемого сбоя: сначала нужно установить, что прежний процесс завершён, и сверить историю. Семантика рассчитана на локальную файловую систему; её нельзя автоматически переносить на облачное синхронизируемое хранилище или считать распределённой блокировкой.

Hash chain помогает обнаружить повреждение/пропуск внутри сохранённой истории, но **не является защитой от подмены** лицом с доступом к записи. Без независимо сохранённой последней вершины цепочки нельзя доказать отсутствие удаления целого конечного фрагмента или полного пересоздания истории. Тесты файловых операций не равнозначны испытанию физического отключения питания.

## Подтверждение результата и границы CLI

Журнальное событие `reconcile` принимает нормализованный proof. Новый `reconcileDeploymentStep` строит такой proof из явно выбранного RPC после проверки сети, finalized-статуса, точных подписанных bytes и ожидаемых accounts. Сам журнал по-прежнему проверяет только структуру и привязки proof: `expectedStateVerified: true` во входном JSON само по себе ничего не доказывает. В исполнитель нельзя добавлять путь, который принимает произвольный proof от пользователя. Пустой ответ RPC и таймаут не являются доказательством expiry или отсутствия результата.

## Read-only адаптер

`intent.mjs` сначала заново строит весь канонический SDK-план и сравнивает manifest целиком: expected-поля, инструкции, адреса, authority, подписи, каждый batch и зависимости. Одной хеш-цепочки generic journal недостаточно: произвольный перевод с expected-полем чужой готовой коллекции не должен считаться созданием коллекции CoolBears. Поддерживается ровно нынешний полный план из 1431 шага; другие планы требуют отдельной реализации.

`rpc.mjs` допускает только ограниченный набор методов чтения. Требуются явный HTTPS endpoint и совпадение полного genesis hash сети. Нет fallback, повторных запросов, redirects, simulation, airdrop или отправки. У каждого запроса ограничены время чтения всего ответа и размер тела (по умолчанию 15 секунд и 4 MiB). Адаптер задаёт общий монотонный бюджет 30 секунд для серии RPC-чтений и повторно проверяет возраст результата после чтения журнала. Ошибки не содержат URL с API-ключом или ответ провайдера. RPC остаётся доверенным источником состояния: это не light client и не криптографическое доказательство честности провайдера.

Команды из корня репозитория используют ранее установленный локально `COOLBEARS_RPC_URL`; значение ключа не нужно вставлять в команду или передавать в чат:

```sh
node operator/deployment/check.mjs preflight private/DEPLOYMENT_JOURNAL collection-create
node operator/deployment/check.mjs reconcile private/DEPLOYMENT_JOURNAL collection-create
```

Это команды для **существующего нового полного журнала**, а не для завершённой Devnet-лаборатории. Они выводят JSON, не записывают события и не отправляют транзакции. Код создания зашифрованного bundle подготовлен; реальные production-ключи и журнал ещё не создавались. Нынешний RPC сайта ограничен лабораторией и не разрешает нужный набор новых accounts/rent.

| Проверка | Что подтверждает успешный ответ |
| --- | --- |
| `preflightDeploymentStep({directory, stepId, endpoint})` | Текущий шаг журнала, политику, genesis, исполняемые программы, существующее состояние и отсутствие конфликтующих новых accounts; частичную оценку rent/комиссии/баланса. |
| `reconcileDeploymentStep({directory, stepId, endpoint})` | Успех сохранённой подписанной транзакции при finalized, точное совпадение всех её bytes и ожидаемые effects в account snapshot не старше transaction slot. |

Preflight для ещё неподготовленной попытки получает новый confirmed blockhash и возвращает **неподписанный candidate**. Его комиссия рассчитывается для нового serialized message. Для сохранённой попытки сохраняются её exact bytes и частичные подписи; обновлять их ради получения положительной цены нельзя. Отчёт привязан к `manifestSha256`, `expectedRevision`, `expectedHeadHash`, `messageSha256`; после RPC журнал перечитывается и изменение истории отменяет результат. Успешное чтение не резервирует баланс, не гарантирует срок blockhash и не заменяет повторную проверку перед будущей отправкой.

Оценка бюджета намеренно частичная: актуальная комиссия одного точного сообщения, текущий баланс и rent полного machine account. До создания машины fresh rent должен совпадать с суммой в плане и System Program instruction; расхождение блокирует продолжение. Collection/reserve/guard rent, protocol charges, остальные шаги и повторы ещё не подсчитаны. `budget.complete=false`, `totalDeploymentLamports=null`, `readyToSubmit=false`, `simulationVerified=false`. Не использовать эту оценку как общую сумму пополнения.

Все deployment-owned accounts читаются одним `getMultipleAccounts` при finalized. SDK-декодирование проверяет program owner, discriminator, размер и ожидаемые поля: owner/authority, royalties, закрытый guard и все уже загруженные config lines. Счётчики коллекции должны быть нулевыми до reserve и равны единице после него. После создания машины в коллекции допускается только служебный UpdateDelegate, выведенный для этой машины; произвольный delegate не принимается. На этапе deployment `itemsRedeemed` должен оставаться нулём. Расхождение счётчика, bitmap, пропуск или подмена любой ранее загруженной строки блокируют продолжение.

Receipt verifier повторно проверяет все подписи и требует равенства полного serialized transaction из `getTransaction` сохранённым байтам. Нужны finalized status, `err=null`, совпадающие slots и version; затем accounts с `minContextSlot` не ниже transaction slot. Только после повторного чтения неизменившегося журнала возвращается `proof.kind=verified`. Для сохранения вызывающий код обязан использовать возвращённую `expectedRevision`; helper сам ничего не записывает. Любой null, RPC error, недостаточная finality или несовпадение оставляет результат `unknown`. Адаптер пока **не выдаёт failed/expired proof** и не разрешает автоматический повтор.

Проверенные официальные RPC-контракты: [getMultipleAccounts](https://solana.com/docs/rpc/http/getmultipleaccounts), [getFeeForMessage](https://solana.com/docs/rpc/http/getfeeformessage), [rent](https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption), [isBlockhashValid](https://solana.com/docs/rpc/http/isblockhashvalid), [getTransaction](https://solana.com/docs/rpc/http/gettransaction).

Исследован установленный CLI 0.4.3:

- `commands/cm/create.js` создаёт новый machine signer и использует `umi.identity` как collection update authority. `SDK create.js` объединяет создание machine, guard и wrap; `createCandyMachine.js` запрашивает rent при сборке.
- `lib/cm/insertItems.js` группирует последовательные незагруженные строки и упаковывает инструкции по размеру. Наш план использует это разбиение и независимую проверку сериализованных байтов.
- `lib/umi/sendTransaction.js` вызывает `buildAndSign`, затем ещё раз `identity.signTransaction` и сразу отправляет. Ошибка отправки возвращает пустые signature/blockhash. Штатного CLI-флага для браузерной подписи владельцем или экспорта unsigned deployment здесь нет.
- `confirmTransaction.js` принимает положительный slot без проверки ошибки исполнения; `confirmAllTransactions.js` в status-режиме не проверяет достижение запрошенного `confirmationStatus`. `asset-cache.loaded`, выставленный этими helper-функциями, не является finalized-доказательством.

Поэтому штатный CLI sender не используется как исполнитель этого журнала. Будущий owner handoff должен иметь собственную проверку байтов и сохранение signature до отправки. Импорт SDK/CLI parser не делает остальные helper-функции частью безопасного исполняющего пути.

Официальные основы: [Core collection creation](https://www.metaplex.com/docs/smart-contracts/core/collections/create), [CLI cm create](https://www.metaplex.com/docs/dev-tools/cli/cm/create), [CLI cm insert](https://www.metaplex.com/docs/dev-tools/cli/cm/insert), [Solana transactions](https://solana.com/docs/core/transactions). Один transaction атомарен, последовательность deployment-транзакций — нет.

Офлайн-проверки: `operator/tests/deployment-*.test.mjs`; из `operator` — `npm run verify`. Они проверяют настоящую SDK-сериализацию, байтовый протокол и локальные файловые сценарии с тестовыми данными. Они не подтверждают реальное развёртывание, подпись владельца на телефоне или исполнение всех 1431 транзакций. Общие условия следующего этапа: [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md).

Набор read-only проверок добавляет 62 теста: 8 canonical intent, 17 RPC, 15 receipt, 11 account state и 11 сквозных сценариев с настоящими SDK-байтами, локальными журналами и синтетическими подписями. В account decoder учтено различие `Buffer.slice()` и `Uint8Array.slice()` в SDK: guard bit-array decode работает с собственной копией, чтобы canonical-проверка не меняла сравниваемый буфер. Сетевые ответы подменяются fixtures; эти тесты не являются результатом live-запуска нового deployment.
