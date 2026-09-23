# PR33: sender и восстановление после отправки

Продолжение PR32, 23 сентября 2026. Добавлен отдельный `sender.mjs` и
`send-cli.mjs`: send-one требует явный `--devnet-send`, сохранённый signed
bundle и свежую симуляцию. Resume сверяет receipt/accounts и записывает
verified через CAS без повторного запроса подписи или отправки.

Private gateway остаётся read-only по умолчанию. Compile-time send opt-in
проверяет полные подписи/1431 intent identities и сохраняет постоянный claim
в SQLite до upstream. Новый blockhash или restart не обходит блокировку.
Сохранённые сервером signature доступны для ограниченного recovery без
пересборки Worker после каждой подписи. Удаления/снятия claims нет.

На момент checkpoint: 12 gateway-тестов прошли. Runtime workerd + SQLite
прошёл 10 сценариев, 15 перехваченных запросов, 2 fixture submissions,
0 реальных транзакций. Первичная интеграция sender обнаружила ошибку fixture:
account verifier импортировался до установки тестового owner; загрузка
перенесена после неё. Производственная проверка owner не ослаблялась.
Финальный sender/regression CI фиксируется в описании PR и актуальном
`CoolBears_Collection(1).md`, а не заявляется заранее в этом checkpoint.

Следующие зависимости: реальная приватная настройка, проверяемые исходы
failed/expired и управляемый retry, удобная очередь подписей владельца,
публичный buyer RPC/путь 1–50, реальные кошельки/телефоны. Самостоятельно
создавать custody/password владельца, реальные signatures, новый mint или
Mainnet этим продолжением не разрешено. Пароль/ключи не просить в чате.

Продажи закрыты, цена 0,2 SOL. Старую лабораторию 2/2 не повторять. Основной
сайт, оригиналы, домен/DNS, Cloudflare-защита, действующий lab RPC/его secrets,
CORS/ledger и Helius-план не менялись. Приватное распределение/ID/rank/CID
и атрибуты не публиковать. Детали: `operator/deployment/SENDING.md`.
