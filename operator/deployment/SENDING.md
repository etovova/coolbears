# PR33: одна отправка и восстановление по журналу

`sender.mjs` добавляет явную отправку **одной уже подписанной** попытки Devnet.
Модуль не открывает кошелёк, не расшифровывает vault, не подписывает, не меняет
blockhash, не выполняет очередь и не открывает продажи. PR33 подготовлен и
проверяется на одноразовых fixture-ключах. Реальные custody/endpoint ещё не
настроены; никаких реальных транзакций этим этапом не выполнено.

## Порядок

1. Проверить существующий приватный bundle, canonical manifest, текущий шаг и
   состояние `signed`. Сверить все сохранённые подписи и bytes.
2. Выполнить свежие preflight и **signed simulation** точных bytes, включая
   проверку Devnet genesis, предшествующих accounts, fee, blockhash/height.
   Это проверка текущего шага, не полный бюджет всего выпуска.
3. Связать transport с единственными signed bytes и minimum slot. Повторно
   проверить genesis и неизменность журнала. До dispatch — максимум 30 секунд
   с начала проверки. Действительность hash в момент доставки не гарантируется.
4. Сохранить `claim-send` на диск через CAS/fsync **до** сетевой отправки.
   Другая копия процесса не может занять ту же попытку в том же журнале.
5. Вызвать `sendTransaction` один раз: `encoding=base64`, `skipPreflight=false`,
   `preflightCommitment=confirmed`, `maxRetries=0`, точный `minContextSlot`.
   Обычный `createDeploymentRpc` и scoped read RPC остаются без send-доступа.
6. Только точное совпадение возвращённой signature позволяет записать
   `accepted`. Это не подтверждение выполнения. Ошибка HTTP/RPC, 429, потеря
   ответа или ошибка диска после отправки возвращает `unknown`; claim остаётся.
   `submissionAttempts` считает вызовы отправки текущим процессом, а не
   подтверждённые транзакции. После dispatch `transactionsSent=null` намеренно.
7. Отдельный `resume` только читает сеть. Нужны finalized receipt с точными
   bytes/signature и проверенное состояние всех предшествующих accounts/config
   lines. Только после этого CAS записывает `verified`. Повторный resume уже
   записанного шага возвращает `already-recorded`, без обещания свежего чтения.

## Приватный gateway

У `makeGateway` новый **отключённый по умолчанию** compile-time параметр
`allowSubmission`. Подготовка с обоими флагами записывает его в приватный entry:

```sh
node operator/deployment/gateway/prepare.mjs private/DEPLOYMENT/journal --allow-simulation --allow-submission
```

Команда только готовит файлы, не развёртывает Worker и не устанавливает secrets.
Существующий результат не перезаписывается. Рабочий лабораторный Worker не
используется и не изменяется; нужна отдельная приватная установка по PR31.

Сервер разрешает только 1431 message identity утверждённого canonical плана,
проверяет payer, v0, отсутствие ALT и все подписи строгим Ed25519 verifier.
Он сохраняет в Durable Object/SQLite постоянный claim по message identity
**до** upstream. Другая подпись, новый blockhash, restart, новые сутки и смена
Bearer token не освобождают этот claim. Повтор получает HTTP 409. Никакого
сетевого сброса, таймера удаления или автоматического повторения нет.

При claim сохраняется связка signature → message identity. Только такие
signature (либо прежний compile-time recovery allowlist) разрешены для
`getSignatureStatuses`/`getTransaction`; переустановка Worker после каждой
подписи не нужна. Это разрешение чтения, не доказательство исполнения.
Основной ledger сохраняет квоты/интервал/429 cooldown. Каждый upstream-вызов,
включая дополнительную проверку genesis перед отправкой, учитывается отдельно.

## Явные команды владельца

После отдельной реальной настройки gateway и существующего signed bundle:

```sh
node operator/deployment/send-cli.mjs send-one private/DEPLOYMENT collection-create --devnet-send
node operator/deployment/send-cli.mjs resume private/DEPLOYMENT collection-create
```

Обе команды берут `COOLBEARS_RPC_URL` и `COOLBEARS_OPERATOR_RPC_TOKEN` только из
приватного окружения. Пароль vault не нужен, owner signature уже должна быть
сохранена. Команда без явного флага не отправляет. Примеры здесь не являются
указанием запускать новую реальную операцию или повторять лабораторию 2/2.

## Границы восстановления

Нет автоматического доказательства `failed`/`expired`, снятия server claim,
повторной подписи или пакетной очереди. Даже ошибка до фактического upstream
после сохранения claim оставляет операцию заблокированной для отдельной
проверки. Это осознанное ограничение первой версии, а не готовый retry-процесс.
Нулевой `getTransaction`, истёкшее время или 429 не доказывают отсутствие
транзакции. Не удалять журнал, DO/SQLite, lock или bundle для обхода блокировки.
Копии bundle нельзя запускать параллельно; серверный claim — дополнительный
барьер, не замена единственному актуальному журналу.

Реальные Phantom/Solflare/телефоны, выпуск всех позиций и buyer flow 1–50
ещё не проверены. Mainnet, открытие продаж и изменения лабораторного RPC,
Helius-тарифа, DNS или сайта не входят в этот этап.

Основа wire-протокола проверена 23 сентября 2026:
[Solana sendTransaction](https://solana.com/docs/rpc/http/sendtransaction),
[SendOptions](https://solana-foundation.github.io/solana-web3.js/types/SendOptions.html).
RPC-ответ о приёме не гарантирует подтверждения в кластере.
