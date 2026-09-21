# CoolBears — база проверенных сведений и карта исследования

Дата: 21 сентября 2026. Исследование продолжается. Владелец требует изучать сайты целиком, включая соседние разделы, максимально проверять изменения и часто сохранять работу. Этот документ фиксирует реально сделанное; это не заявление, что прочитана каждая страница всех четырёх сайтов.

## Как читать статусы

- **Каталог:** найден адрес/название страницы. Её содержание ещё не обязательно прочитано.
- **Обзор текста:** изучено назначение, ограничения и связи; отдельные примеры кода могут оставаться непроверенными.
- **Подробная проверка:** документация сопоставлена с выбранной реализацией и доступными проверками.
- **Исполнение:** есть результат конкретного запуска. Локальная VM, реальная сеть и физический кошелёк — разные этапы.

Нельзя складывать страницы, тесты и транзакции в единый показатель «всё работает». Нельзя считать сетевой таймаут доказательством сбоя самой Solana.

## Текущий результат и блокер

Общий локальный запуск `npm run --prefix release verify:offline` завершился успешно: **193 проверки**. Состав: настройки 6, реальные Core/Candy Machine программы в LiteSVM 72, журнал 12, Phantom flow 78, HTTP/RPC 25. Точный результат: [offline-gate.json](reports/offline-gate.json).

Предоставленный владельцем журнал [phantom-owner-diagnostic.json](reports/phantom-owner-diagnostic.json) показывает два HTTP/RPC 429 на `getGenesisHash`. Он заканчивается ожиданием третьей попытки. `lastError: null` здесь не означает успешную связь. `savedIntent: false` не подтверждает создание NFT или запрос подписи.

Последняя проверка официального публичного RPC из этой среды остановилась на таймауте первого чтения. OnFinality пропустил часть чтений, затем также ограничивал запросы; полный этап подготовки текущей страницы не завершён. Его адрес не установлен в публичной странице. dRPC вернул 403, Ankr — ошибку авторизации с требованием ключа. Эти результаты не оправдывают бесконечные повторы или обход ограничений. Отчёты: [официальный RPC](reports/phantom-live-rpc.json), [отклонённый кандидат](reports/phantom-live-rpc-onfinality.json).

Подпись владельца и отображение NFT в физическом Phantom ещё не пройдены. Solflare физически не проверялся. Ранее завершённый отдельный Devnet-лабораторный сценарий содержит 12 проверок и 8 finalized-транзакций; он не равен проверке телефона владельца. Новых транзакций при этом исследовании не отправлялось. Продажи закрыты.

## Карта сайтов

| Сайт/раздел | Что установлено | Текущий охват |
| --- | --- | --- |
| [Solana](https://solana.com/) | Сайт включает обучение, документацию, RPC, токены, платежи, DeFi, инфраструктуру, экосистему и новости | Главная/каталоги и выбранные технические главы просмотрены; полный обход ещё не окончен |
| [Solana NFT](https://solana.com/developers/nfts) | Вход в NFT-экосистему и стандарты | Обзор страницы и связанных стандартов |
| [Solana wallets](https://solana.com/wallets) | Каталог кошельков; присутствие в нём не сертифицирует нашу интеграцию | Основной каталог прочитан; URL с фильтром infrastructure не открылся |
| [Metaplex docs](https://www.metaplex.com/docs) | NFT — часть большого каталога: tokens, agents, smart contracts, dev tools, Solana | Полный Git-каталог исходников найден; обзор продолжается по всем направлениям |
| [Core](https://www.metaplex.com/docs/smart-contracts/core) | Аккаунт NFT, коллекции, плагины, полномочия | Основные операции и все видимые типы плагинов просмотрены; выбранные Core-операции сопоставлены с кодом |
| [Core Candy Machine](https://www.metaplex.com/docs/smart-contracts/core-candy-machine) | Выпуск Core-активов, скрытые метаданные и Candy Guards | Жизненный цикл и страницы всех 31 видимых guard просмотрены; реализация использует только утверждённые условия |
| [Phantom](https://docs.phantom.com/introduction) | Traditional provider, Wallet Standard, Connect SDK, deeplinks, Portal, MCP, инструменты проверки | Каталог найден; Solana-подключение, подпись, ошибки, mobile, sessions, Lighthouse и fees разобраны |
| [Solflare](https://www.solflare.com/) | Основной сайт, справка, интеграция, SDK, metadata, deeplinks, notifications | Главная/карта и каталог документации найдены; интеграция и мобильные методы изучаются |

Metaplex: дерево исходников `9b18df2d7fabc653f160c280f7d5c2b59336a3a9`, ответ GitHub `truncated=false`; 2304 Markdown-файла с переводами и служебными материалами, 575 файлов под `src/pages/en`. Это число файлов репозитория, не обещание 575 действующих публичных страниц. Список и состояния: [metaplex-documentation-catalogue.json](reports/metaplex-documentation-catalogue.json). Источник: [официальный Developer Hub](https://github.com/metaplex-foundation/developer-hub).

Полный Solana `llms-full.txt` превысил лимит веб-чтения; отдельная загрузка дала HTTP 502. Это не прочитанный корпус. Карты XML Metaplex/Solflare и часть Markdown URL не открылись; доступные обычные URL использованы там, где они сработали. Непрочитанные разделы остаются в очереди. Новости, цены и каталоги меняются: сохранённый обзор не заменяет проверку актуальности перед использованием.

## Архитектура выпуска

**Core + Core Candy Machine + Umi.** Обычная Candy Machine помечена deprecated и больше не служит основой новой разработки. Token Metadata остаётся отдельным стандартом; его аккаунты и инструкции нельзя смешивать с Core. Bubblegum — отдельная архитектура с деревьями и инфраструктурой индексирования; переход на неё не исправляет RPC-связь. [Candy Machine](https://www.metaplex.com/docs/smart-contracts/candy-machine), [Core](https://www.metaplex.com/docs/smart-contracts/core), [Bubblegum v2](https://www.metaplex.com/docs/smart-contracts/bubblegum-v2).

Закреплённые в проекте SDK: Core 1.10.0, Core Candy Machine 0.3.0, Umi 1.6.0, Web3.js 1.99.0. Новая документация может описывать дополнительные функции, отсутствующие в этих версиях. Перед применением сверять экспорты, типы, builder и реальное исполнение; примеры не копировать вслепую. Предупреждения peer-dependency сохранены в README.

Core хранит NFT в одном программном аккаунте. Владелец NFT, update authority и authority отдельного plugin — разные роли. Принадлежность к Core collection определяется on-chain связью, а не текстовым полем JSON. Перевод NFT не означает передачу авторских полномочий. [Assets](https://www.metaplex.com/docs/smart-contracts/core/what-is-an-asset), [Collections](https://www.metaplex.com/docs/smart-contracts/core/collections).

На текущих настройках: всего 10000 NFT, 9999 в машине и отдельно зарезервированный #0000; цена 0,5 SOL; роялти 700 bps; продажи закрыты. Значения берутся из `metadata/policy.json`. `startDate` в 2100 году — технический запрет текущей продажи, не дата раскрытия. Раскрытие не раньше 2027-01-01 — отдельное утверждённое правило.

## Core: полномочия, плагины и раскрытие

| Механизм | Практический вывод |
| --- | --- |
| Royalties | 700 bps означает 7%. Сумма долей получателей должна быть 100%. `RuleSet None` не гарантирует принудительный сбор любым внешним сервисом |
| UpdateDelegate | Делегирование изменения не делает делегата владельцем NFT; минимально нужные полномочия проверяются отдельно |
| Transfer/Freeze/BurnDelegate | Временные owner-managed права и их сброс после перевода отличаются от постоянных делегатов |
| Permanent delegates | Добавляются при создании; могут давать постоянные привилегии. Не включать без конкретного утверждённого требования |
| ImmutableMetadata | Блокирует изменение name/URI и помешает будущему раскрытию; не применять заранее |
| AddBlocker | Ограничивает добавление authority-managed plugins; не заменяет все остальные уровни неизменяемости |
| Attributes | Публичные on-chain данные; не место для приватных признаков и редкости до раскрытия |
| Edition / MasterEdition | Маркировка издания не должна приниматься за автоматическое соблюдение общего тиража |
| VerifiedCreators / Autograph | Верификация создателей и подписи отделены от распределения роялти |
| Oracle / AppData | Внешние проверки и данные добавляют собственные authority и зависимости; не нужны для обычного утверждённого выпуска |
| Groups / Bubblegum plugin / Asset signing | Другие возможности Core; изучены как отдельные механизмы, не включены в выпуск автоматически |

Основания: [Royalties](https://www.metaplex.com/docs/smart-contracts/core/plugins/royalties), [Plugins](https://www.metaplex.com/docs/smart-contracts/core/plugins), [Immutability](https://www.metaplex.com/docs/smart-contracts/core/guides/immutability).

Обновление списков plugins требует сохранения нужных существующих элементов. Удаление plugin удаляет его данные; постоянные plugins не снимаются. Снятие update authority не обязательно снимает отдельную plugin authority. Поэтому «сделать всё immutable» — отдельный процесс после раскрытия и проверки конечных данных. [Updating](https://www.metaplex.com/docs/smart-contracts/core/plugins/update-plugins), [Removing](https://www.metaplex.com/docs/smart-contracts/core/plugins/removing-plugins), [Immutability](https://www.metaplex.com/docs/smart-contracts/core/guides/immutability).

Hidden Settings сохраняет шаблон и commitment вместо финальных метаданных. Hash не раскрывает данные сам и не устанавливает timelock. URI, приватное соответствие индексов, хешируемая каноническая структура и резервные копии должны сохраняться совместно. Финальные изображения/traits/CID не публикуются до утверждённой даты. [Создание машины](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/create), [Hidden Settings guide](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guides/create-a-core-candy-machine-with-hidden-settings).

**Открытый вопрос:** утверждённый hidden name использует четырёхзначный индекс, а текущий native-шаблон `#$ID+1$` сам по себе не задаёт дополнение нулями. Перед production нужно доказать точное соответствие имён и индексов на границах 1/9/10/999/1000/9999 и отдельно #0000. Тексты и арт не менять без основания. Проверки 51 отдельных локальных mint не означают успешный мобильный заказ из 50 NFT.

## Candy Machine: жизненный цикл и все группы условий

Машина и Candy Guard — отдельные аккаунты. Guard становится mint authority; настройки нужно читать из обоих. `updateCandyGuard` заменяет всю конфигурацию. Группы наследуют default guards, но могут переопределять их; при наличии групп обязателен явный label. Для каждого label нужно проверить, что никакой путь не открывает закрытую продажу или другую цену. [Guards](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guards), [Groups](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guard-groups), [Updating](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/update).

| Guard | Назначение и важное различие |
| --- | --- |
| Address Gate | Только один разрешённый адрес |
| Allocation | Общий лимит группы/идентификатора; tracker предварительно инициализируется через route |
| Allow List | Merkle root и отдельная проверка proof; group/кошелёк должны совпадать |
| Asset Gate | Проверка владения Core Asset, без расходования |
| Asset Burn / Asset Burn Multi | Необратимо сжигает один/несколько Core Assets |
| Asset Payment / Asset Payment Multi | Передаёт один/несколько Core Assets получателю |
| Asset Mint Limit | Счётчик по адресу Core Asset, не по кошельку |
| NFT Gate / NFT Burn / NFT Payment | Аналогичные действия с Token Metadata NFT, не Core Assets |
| NFT Mint Limit | Лимит использования конкретного Token Metadata NFT |
| Mint Limit | Суммарный лимит кошелька по id; это не лимит количества в одном заказе |
| Redeemed Amount | Порог общего количества уже выпущенных машиной активов |
| Start Date / End Date | Время доступности нового mint; не раскрытие метаданных |
| Sol Payment | Утверждённая цена и точный адрес получения |
| Sol Fixed Fee | Дополнительный самостоятельный платёжный guard; совместное включение требует проверки суммарного списания |
| Token Gate | Проверяет баланс SPL-токенов, не переводит их |
| Token Burn | Сжигает SPL-токены |
| Token Payment / Token2022 Payment | Разные token programs; destination ATA и decimals нужно проверять явно |
| Freeze Sol Payment / Freeze Token Payment | Платёж через escrow и временная заморозка; initialize/thaw/unlock — отдельные этапы |
| Gatekeeper | Проверка gateway token; captcha провайдера — отдельная интеграция |
| Third Party Signer | Обязательная дополнительная подпись; для backend-схемы ключ хранится только на сервере |
| Program Gate | Ограничивает программы верхнего уровня транзакции; совместимость кошельков нужно проверять |
| Bot Tax | Может списать штраф при успешной транзакции без NFT; статус транзакции недостаточен |
| Edition | Назначает номера издания, не заменяет запрет продаж |
| Vanity Mint | Требует подходящий адрес; вычислительная работа и сложность для мобильного пользователя |

Каждая отдельная guard-страница есть в [каталоге источников](reports/metaplex-documentation-catalogue.json). Изучение guard не означает его включение. Утверждённый выпуск не получает новые платежи, burns, заморозки, captcha или серверного подписанта автоматически.

Особенно проверять Bot Tax: `lastInstruction=true` может конфликтовать с Lighthouse-инструкциями, добавляемыми Phantom/Solflare. Даже `err=null` не гарантирует mint: нужен сам корректный NFT-аккаунт. [Bot Tax](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guards/bot-tax), [Phantom Lighthouse](https://docs.phantom.com/developer-powertools/lighthouse).

Freeze payment не является блокировкой раскрытия до произвольной даты: документация ограничивает период 30 днями и описывает досрочные условия thaw. Удаление guard не равно thaw всех активов. Удаление машины необратимо и отдельно от удаления guard; это не способ ремонта HTTP 429. [Freeze SOL](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guards/freeze-sol-payment), [Withdrawal](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/withdrawing-a-candy-machine).

Anti-bot guide описывает placeholders, приватное заранее зафиксированное распределение и backend signer. Это архитектурные варианты. Случайный URI сам по себе не делает опубликованные данные приватными. Секретный backend signer несовместим с хранением ключа в статическом frontend; GitHub Pages сам не выполняет backend-функции. [Anti-bot](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/anti-bot-protection-best-practices).

## RPC и транзакции

1. Успешный `connect()` означает разрешение читать публичный ключ. Он не проверяет RPC, баланс, симуляцию или mint.
2. Проверка `getGenesisHash` устанавливает кластер только для ответившего RPC. Её один успех не доказывает доступность всей цепочки методов.
3. 429 требует соблюдения `Retry-After`; 401/403 — проверки доступа, а не новых агрессивных повторов. Публичный RPC имеет общие ограничения и не заменяет настроенную инфраструктуру.
4. Blockhash и `lastValidBlockHeight` принадлежат конкретной подписанной транзакции. После подписи менять сообщение нельзя. Для неподписанного нового сообщения нужны новые подписи всех участников.
5. При неизвестном ответе кошелька сохраняется адрес/intent; сначала читается результат. Повторный mint до разрешения неопределённости может дать второй NFT и повторный платёж.
6. Для доказательства истечения требуется finalized высота и отсутствие NFT на достаточно свежем RPC; одного таймера или отстающего узла недостаточно.
7. Сохранять подпись и подтверждать owner/program/name/URI/collection/royalties, а не только текст интерфейса.

Источники: [RPC](https://solana.com/rpc), [Clusters](https://solana.com/docs/references/clusters), [Confirmation](https://solana.com/developers/cookbook/transactions/confirmation), [Umi RPC](https://www.metaplex.com/docs/dev-tools/umi/rpc).

## Phantom и Solflare

Phantom traditional provider доступен внутри расширения и браузера кошелька на подходящем HTTPS-сайте. Обычный мобильный Chrome не становится кошельком после проверки RPC. `Browse` открывает страницу в другом браузерном контексте; сохранённые данные Chrome нельзя считать данными Phantom. Возврат, refresh, закрытие вкладки и уничтожение процесса ОС — отдельные тесты. [Provider](https://docs.phantom.com/solana/detecting-the-provider), [Connection](https://docs.phantom.com/solana/establishing-a-connection), [Deep links](https://docs.phantom.com/phantom-deeplinks/deeplinks-ios-and-android).

Используется официальный Umi adapter и sign-and-send. Нельзя требовать detached signing от всех Wallet Standard кошельков. Возвращённая signature означает результат отправки, не finalized создание актива. Если Phantom изменяет сообщение дополнительными инструкциями, on-chain транзакция может отличаться от подготовленной; фактическую совместимость частичной подписи Core нужно подтвердить на устройстве. [Sending](https://docs.phantom.com/solana/sending-a-transaction), [Lighthouse](https://docs.phantom.com/developer-powertools/lighthouse).

Автоматическое добавление priority fee Phantom имеет условия, включая отсутствие уже существующих подписей. Наш Core NFT требует частичной подписи нового asset, поэтому автоматически рассчитывать на эту функцию нельзя. Размер и compute budget проверяются до подписи; итоговая комиссия должна определяться актуальной подготовкой, не постоянным обещанием. [Priority fees](https://docs.phantom.com/developer-powertools/solana-priority-fees).

Phantom Connect/social login, MCP wallet и существующий кошелёк владельца — разные интеграционные пути. Их наличие в новой документации не является причиной заменять уже выбранный адрес владельца или запрашивать его seed. Deeplink sessions требуют отдельного хранения, проверки сети и обработки смены аккаунта; закрытие страницы не равно автоматическому исчезновению незавершённой транзакции. [Introduction](https://docs.phantom.com/introduction), [Sessions](https://docs.phantom.com/phantom-deeplinks/handling-sessions).

Solflare поддерживает официальный adapter и собственный SDK; sign-and-send, detached signing и обработка подключения описаны отдельно. Нельзя объявлять поддержку Solflare на основании теста Phantom. Deeplink `cluster` по умолчанию mainnet-beta: Devnet задаётся явно. Сохраняются session и ключи шифрования интеграции, но не приватный ключ пользователя. [Adapter](https://docs.solflare.com/solflare/technical/integrate-solflare/using-the-solana-wallet-adapter), [SDK](https://docs.solflare.com/solflare/technical/integrate-solflare/solflare-wallet-sdk), [Connect](https://docs.solflare.com/solflare/technical/deeplinks/provider-methods/connect).

Отображение metadata требует доступных JSON/image с подходящими MIME. Старое JSON-поле `collection.family` не доказывает принадлежность к Core collection. Страницы Solflare/Phantom о SPL Token Metadata полезны для отображения, но не заменяют спецификацию Core. Токен с названием «Devnet» в каталоге цен не является бесплатным native SOL тестовой сети. [Solflare schema](https://docs.solflare.com/solflare/technical/our-nft-standard/uri-json-schema), [Core ecosystem](https://www.metaplex.com/docs/smart-contracts/core/ecosystem-support).

## Следующие обязательные проверки

| Область | Имеющиеся проверки | Что ещё нужно |
| --- | --- | --- |
| Неудачи RPC до подписи | Genesis/balance/blockhash/simulation, 429/timeout/access/unavailable/abort | Та же подготовка на стабильном настоящем RPC |
| Подпись и журнал | Отмена, коды Phantom, атомарные вкладки, lost/late response, restart | Физический Android Phantom, выход/возврат, process kill |
| Finality | Processed/confirmed не принимаются за finalized; lagging RPC не разрешает retry | Полное реальное подтверждение операции владельца |
| Кошельки | Phantom provider/Wallet Standard моделируются локально | Solflare отдельно; смена аккаунта и сети на устройствах |
| Платёж и guards | Локальные цена, treasury, запрет/закрытие, unauthorized, дубликаты, sellout | Фактическая выбранная production конфигурация и все доступные группы |
| Коллекция | Архив 10000 PNG/JSON и 454 исходных слоя проверены ранее | Сохранение точного mapping при раскрытии, граничные имена |
| Заказ 50 | Есть отдельные локальные mints | Размеры пакетов, несколько подписей, частичный успех и продолжение без повторной оплаты |
| Отображение | Доступность публичных данных проверялась отдельно | NFT в физических кошельках и индексирование marketplace |
| Сохранения | Durable intent и отдельные отчёты | Сохранённые коммиты, актуальный checkpoint после каждого завершённого этапа |

Перед новой попыткой владельца устранить известный RPC-блокер. Если реализация требует нового начала, сохранить версию и журналы и пересобрать её; не стирать оригиналы, историю и неразрешённые операции. Разработка и тесты новых возможностей продолжаются только с чётко обозначенным статусом исследования и проверки.
