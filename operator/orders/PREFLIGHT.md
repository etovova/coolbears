Текущий следующий этап: [отдельный gateway](gateway/README.md) связывает
prepared-byte checker с браузером через HTTPS. Это закрытый Devnet-кандидат,
не развёрнутый endpoint или разрешение отправки. Ниже — исходный preview.

# Проверка заказа до подписи

**PR41 update:** closed Devnet sign-only wallet handoff, prepared-request checks and atomic buyer-response evidence are implemented. See `WALLET.md`. The new internal prepared check can permit signing only; public purchase, sending and sales remain disabled. Earlier milestone notes below describe their original scope.

`preflight.mjs` добавляет сетевое чтение к офлайн-планировщику заказов 1–50.
Это **диагностика первого item нового заказа в закрытой Devnet-конфигурации**.
Сайт, публичный RPC и кошелёк к ней ещё не подключены. Продажи не открываются.

```sh
node operator/orders/check.mjs preflight /absolute/private/order.json
```

Нужен существующий JSON `createOrder` без попыток, с revision 0, без паузы,
реальными отдельно сохранёнными asset-адресами и адресами полной машины.
Команда не создаёт новый заказ или ключи. `COOLBEARS_BUYER_RPC_URL` — явно
настроенный отдельный HTTPS RPC; действующий лабораторный RPC не подходит.
Значения ключей не вставлять в чат, файл заказа или публичную конфигурацию.
Реальная приватная настройка полного выпуска всё ещё нужна.

API принимает `readOrder`, который читает текущий заказ заново. В начале
проверяется полная схема и сохраняется SHA-256 снимка. В конце проверяется тот
же снимок, включая revision, адреса и позиции. Изменение заказа во время RPC
блокирует результат. CLI читает ограниченный regular file до 256 KiB без
следования симлинкам; исходный файл не меняется. Диагностический JSON не
содержит RPC URL, путь к файлу или транзакционные bytes.

## Что проверяется

1. Только Devnet и новый заказ. Mainnet, существующие попытки, пауза, неверные
   параметры и адреса, которые не могут подписывать, блокируются до RPC.
2. Полный Devnet genesis. Затем одним finalized `getMultipleAccounts` читаются
   три программы, machine/guard/collection и все asset-адреса заказа. Последние
   должны отсутствовать; повторного создания существующего asset нет.
3. Program owner, discriminator, canonical encoding, authorities, collection,
   royalties, UpdateDelegate, размер машины и весь загруженный набор строк.
   Проверяется оставшаяся активная часть случайного списка индексов без
   повторов. Погашенная часть списка не используется как остаток. Счётчики
   collection согласуются с машиной; уменьшение currentSize после burn допустимо.
4. Принимается только существующий профиль закрытого guard: точные AddressGate
   и SolPayment, цена 0,2 SOL, утверждённый получатель, без групп/добавочных guards.
   Обычный покупатель получает `SALES_CLOSED` **до** quote/simulation. Удаление
   закрывающего guard не включает новый путь: такая конфигурация отклоняется.
   Успешная диагностика сейчас возможна только для разрешённого владельца.
5. Фактический остаток должен покрывать весь новый заказ. Значение
   `availableAtPlanning` не считается свежим доказательством и ничего не резервирует.
6. Новый blockhash, комиссия точного первого сообщения, базовый rent и баланс.
   Симуляция только первой unsigned-транзакции: исходный blockhash сохраняется,
   `sigVerify=false`, `replaceRecentBlockhash=false`; ошибка, подмена hash,
   неправильный context или превышение compute limit блокируют результат.
7. После симуляции повторно читаются весь набор accounts и баланс. Повторно
   проверяются остаток, правила, отсутствие assets, срок blockhash и заказ.
   Нужно не менее 80 оставшихся block heights. Finalized bank не обязан
   опережать confirmed simulation slot; у каждого чтения свой корректный
   minContextSlot. Согласованность между разными RPC-чтениями не атомарна.

Есть общий лимит 30 секунд, ограничения тела ответа и одного запроса; повторов,
redirects, fallback на другую сеть/RPC и отправки нет. Provider text и secrets
не попадают в ошибки. Все запросы строит этот модуль; это не публичный relay и
не новый endpoint для произвольных клиентских запросов.

## Как читать результат

`preflight-passed` подтверждает только описанную свежую проверку первого item.
`readyToSign=false`, `readyToSubmit=false`, `salesOpen=false` сохраняются.
Кандидат API полностью unsigned: наличие приватных asset signers этим не
подтверждается. CLI bytes не выводит. Snapshot/hash не являются разрешением
на подпись и не заменяют durable claim и повторную проверку будущего исполнителя.

В `budget` раздельно показаны цена всех NFT заказа, комиссия первого сообщения,
его базовый account rent и проверенный баланс. `nextItemKnownMinimumLamports`
включает номинальную цену SolPayment, fee и base rent; это не чистый расход,
если payer совпадает с получателем. Protocol charges и стоимость остальных
транзакций **не рассчитаны**: `complete=false`, `protocolChargesLamports=null`,
`fullOrderTotalLamports=null`. Не использовать этот результат как сумму
пополнения кошелька. Успешная unsigned simulation не проверяет подписи и не
гарантирует будущую доступность NFT, баланс, цену или исполнение.

Заказ на 50 означает проверку количества/остатка и первой транзакции, а не
симуляцию 50 зависимых операций или одну покупку одним подтверждением. Заказ
с любой историей требует будущего проверенного адаптера продолжения; текущий
модуль отказывается планировать его заново. Журнал заказов остаётся офлайн
моделью одного писателя. Ни CLI, ни API не меняют/очищают историю.

## Покрытие и дальнейшая работа

`order-preflight.test.mjs`: настоящие SDK accounts полного размера, unsigned
v0 сообщения, настоящий ограниченный RPC transport и файловый CLI; все RPC
ответы подменены. Сценарии 1/50, уже погашенные позиции, sold-out, закрытый
guard, изменения состояния во время чтения, ошибки комиссии/баланса/симуляции,
429, timeout и защита файла. Это не живой mint, телефон или настоящий кошелёк.

Нужны реальный deployment/custody и отдельный buyer gateway, хранение asset
signers, атомарный журнал с блокировкой, проверка signed bytes, sender,
finalized receipts, восстановление частичных заказов и интерфейс покупки.
Mainnet и открытие продаж потребуют отдельного указания владельца.

Источники: [Core mintV1](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/mint),
[Sol Payment](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guards/sol-payment),
[Address Gate](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guards/address-gate),
[Solana simulateTransaction](https://solana.com/docs/rpc/http/simulatetransaction).
Структуры и активная часть списка индексов дополнительно сверены с закреплённым
SDK 0.3.0 (`hooked/candyMachineAccountData.js`); SDK не заменяет независимую
проверку canonical bytes, владельцев программ и разрешённых условий.
