# Расчёт deployment и симуляция

Этап продолжает PR21. Он добавляет полный **модельный расчёт нового deployment**, получение свежих RPC-цен всех сообщений и симуляцию текущего шага. Продажи закрыты. Ключ владельца, окно кошелька и повторный минт лаборатории для этих проверок не нужны. Модуль ничего не отправляет и не записывает в журнал.

## Состав расходов

Размеры вычисляются сериализаторами установленных Core 1.10.0 и Core Candy Machine 0.3.0, после повторной проверки полного canonical manifest. Изменение версий SDK требует пересмотра модели.

| Статья | Размер аккаунта | Как считается |
| --- | ---: | --- |
| Коллекция с royalties 7% | 178 байт | Свежий rent quote для 178 байт. |
| Резервный NFT #0000 | 158 байт | Свежий rent quote плюс Core create fee. Роялти наследуются от коллекции. |
| Машина на 9999 позиций | 871827 байт | Свежий rent quote; до создания обязан совпадать с lamports в System Program instruction. |
| Guard: AddressGate + SolPayment | 157 байт | Header guard плюс размер данных именно из canonical create instruction. |
| UpdateDelegate коллекции | Рост 178 → 225 байт | Разница двух rent quotes. Это не второй полный rent коллекции. |
| Core create fee резервного NFT | 1500000 lamports | Модель по закреплённым исходникам и официальной документации. Не умножается на 10000. |
| Сетевые комиссии | 1431 сообщение; 1434 подписи | Отдельный `getFeeForMessage` для каждого сообщения, включая последнюю отличающуюся вставку. |

Создание коллекции, guard и машины не добавляет отдельную Core asset create fee. Authority PDA машины не создаётся как отдельный rent account. Канонический план не содержит ComputeBudget, tips или оплаты публичного минта. Цена продажи 0,5 SOL и роялти 7% не являются расходом автора на загрузку машины. Выпуск оставшихся 9999 NFT покупателями, раскрытие, хостинг, хранение, домен, RPC-подписки и курс SOL находятся вне этой оценки.

При обозначении свежих цен rent как R и комиссий сообщений как F:

`base = R(225) + R(158) + R(871827) + R(157) + 1500000 + sum(F[0..1430])`

Числа rent и F не зашиты в код. Все суммы складываются как BigInt и выводятся десятичными строками. Историческая лабораторная цена машины и ставки из fixtures не используются как свежая стоимость.

## API и команды

```js
await quoteDeploymentBudget({ directory, endpoint, fetchImpl?, timeoutMs?,
  concurrency: 8, bufferBasisPoints: 1000, retryTransactions: 10 });
await simulateDeploymentStep({ directory, stepId, mode: 'unsigned', endpoint });
await simulateDeploymentStep({ directory, stepId, mode: 'signed', endpoint });
```

`directory` — существующий журнал нового полного deployment, обычно `private/NEW_DEPLOYMENT/journal`. Endpoint подаётся явно. Для CLI он берётся из локальной переменной `COOLBEARS_RPC_URL`; не передавать API-ключ через чат или публичный отчёт.

```bash
node operator/deployment/check.mjs budget private/NEW_DEPLOYMENT/journal
node operator/deployment/check.mjs simulate-unsigned private/NEW_DEPLOYMENT/journal collection-create
node operator/deployment/check.mjs simulate-signed private/NEW_DEPLOYMENT/journal collection-create
```

`budget` проверяет canonical intent, genesis, программы, закрывающий guard и фактический завершённый префикс аккаунтов. RPC-цены rent запрашиваются для пяти размеров. Каждое из 1431 сообщений получает общий свежий blockhash только для **снимка оценки**. Это не очередь для подписи; сохранённые попытки не меняются. Одновременно выполняется максимум `concurrency` чтений (1–16), без автоматических повторов; при ошибке уже начатые чтения завершаются, новые не запускаются. Полный запрос ограничен 120 секундами и дополнительно проверяет срок blockhash, контекст ответов и неизменность manifest/revision/head.

`estimates.fullDeploymentLamports` — оценка всего нового deployment по текущим котировкам, включая уже завершённые шаги как сравнимую модель. `remainingLamports` исключает завершённый префикс. `incurred` отдельно повторно получает finalized receipts сохранённых подписей и проверяет точные bytes; фактические расходы берутся из payer pre/post balances и meta.fee. Комиссия завершившейся ошибкой попытки учитывается, а сам незавершённый шаг остаётся в прогнозе. Подписанная expired-попытка без доступного доказательства расходов остаётся непроверенной, не превращается в ноль. `unknown`, `send-claimed` и `accepted` требуют reconciliation.

Плановый запас выводится отдельно: по умолчанию 10% оставшейся базовой оценки с округлением вверх, плюс стоимость десяти сетевых повторов по максимальной комиссии оставшегося шага. Это выбранный сценарий, не прогноз числа ошибок и не разрешение повторов. Параметры можно явно поставить в ноль. Буфер и повторы не записываются как уже понесённые расходы. Остаток средств и оценочный дефицит не являются рекомендацией пополнения.

`modelComplete=true` означает покрытие статей указанного deployment; `quotesComplete=true` — наличие всех свежих сетевых котировок. **`budgetComplete=false` и `fundingRecommendationLamports=null` сохраняются**, пока не подтверждено соответствие реально развёрнутых программ исследованным размерам и protocol charges. Исходники SDK/программы сами по себе не доказывают версию исполняемого on-chain кода. `assumptions` явно сообщает эту границу. При недоступном RPC, null/устаревших ценах, расхождении rent машины, неопределённом прошлом исходе или изменении журнала полноценная котировка не выдаётся.

## Что именно доказывает симуляция

Оба режима сами выполняют preflight; произвольный JSON с `simulationVerified=true` не принимается. Для нового unsigned candidate preflight явно получает свежий blockhash. Для уже сохранённой partial/signed попытки используется существующий blockhash и точные сохранённые bytes.

- `unsigned`: владелец ещё не подписал; `sigVerify=false`, `signaturesVerified=false`. Сохранённые частичные подписи сохраняются. Результат проверяет исполнение сообщения, но не одобрение владельца.
- `signed`: допускается только сохранённая попытка `signed`; все Ed25519-подписи повторно проверяются локально, затем RPC вызывается с `sigVerify=true`.

`replaceRecentBlockhash=false` обязателен. Проверяются genesis, `context.slot`, явный `err=null`, отсутствие replacement blockhash, корректный unitsConsumed, действительность blockhash и высота после симуляции, возраст до 30 секунд, неизменность журнала. `logs`, `returnData`, произвольные ошибки RPC и endpoint не попадают в отчёт. `simulateTransaction` не сохраняет изменения в блокчейне; последующие зависимые шаги нельзя объявлять проверенными по симуляции первого. Все 1431 шага предстоит проверять по мере появления их зависимостей.

Handoff перед созданием нового wallet request теперь сам вызывает unsigned-симуляцию. При ошибке запрос не создаётся. Возвращаемое `simulationVerified=true` относится к `simulationMode='unsigned'` и текущему сообщению; после добавления подписи владельца, восстановления bytes или задержки требуется новая signed-симуляция. `readyToSubmit`, `lifetimeGuaranteed` и `salesOpen` остаются false. Будущий sender должен сохранить signature и `claim-send` до отправки и не повторять `unknown` автоматически.

## Проверенные источники и границы проверки

Исследованы 23 сентября 2026:

- [Solana simulateTransaction](https://solana.com/docs/rpc/http/simulatetransaction): неподписанный режим, sigVerify, minContextSlot и replacement blockhash.
- [Core FAQ](https://www.metaplex.com/docs/smart-contracts/core/faq) и [Protocol Fees](https://www.metaplex.com/docs/protocol-fees): protocol create fee и возможность изменения тарифов.
- [Core create](https://github.com/metaplex-foundation/mpl-core/blob/e72d63e4118a0a95ac9b40221e81b19d49e1e102/programs/mpl-core/src/processor/create.rs), [collection](https://github.com/metaplex-foundation/mpl-core/blob/e72d63e4118a0a95ac9b40221e81b19d49e1e102/programs/mpl-core/src/processor/create_collection.rs), [fee](https://github.com/metaplex-foundation/mpl-core/blob/e72d63e4118a0a95ac9b40221e81b19d49e1e102/programs/mpl-core/src/state/collect.rs), [reallocation](https://github.com/metaplex-foundation/mpl-core/blob/e72d63e4118a0a95ac9b40221e81b19d49e1e102/programs/mpl-core/src/utils/account.rs).
- [Machine initialize](https://github.com/metaplex-foundation/mpl-core-candy-machine/blob/ea3620b7436004f62e1e7bc3d69147f4feef2ae0/programs/candy-machine-core/program/src/instructions/initialize.rs), [delegate helper](https://github.com/metaplex-foundation/mpl-core-candy-machine/blob/ea3620b7436004f62e1e7bc3d69147f4feef2ae0/programs/candy-machine-core/program/src/utils.rs), [guard initialize](https://github.com/metaplex-foundation/mpl-core-candy-machine/blob/ea3620b7436004f62e1e7bc3d69147f4feef2ae0/programs/candy-guard/program/src/instructions/initialize.rs).

Локальные интеграционные тесты используют настоящий SDK, подписи временных тестовых ключей и файловый журнал, но синтетический RPC. Они не являются live-симуляцией нового deployment или проверкой всех 1431 операций на Solana. Production-bundle и отдельный разрешённый RPC этого deployment пока не созданы/не настроены; лабораторный RPC сайта рассчитан на завершённую машину 2/2. Свежей суммы для пополнения в этом этапе нет. Нельзя выдавать успешные fixtures или исходники за on-chain доказательство.
