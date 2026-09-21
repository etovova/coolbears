# CoolBears — состояние обхода официальных сайтов

Дата: 21 сентября 2026 года.

Область исследования расширена на сайты целиком: документацию, связанные продукты, инфраструктуру, инструменты разработки, обучение и общие разделы. **Полный подробный обход пока не завершён.** Это контрольная точка с очередью продолжения.

## Проверяемые результаты

- 193 локальные проверки прошли; отчёт: [offline-gate.json](reports/offline-gate.json).
- Реальный RPC остаётся блокером; физический Phantom/Solflare ещё не прошёл полный сценарий.
- Новых транзакций и публикации сайта в этом этапе исследования нет.
- [База знаний](KNOWLEDGE.md) содержит выводы, ссылки, ограничения и матрицу проверки.

## Охват каталога

| Источник | Записей | Есть обзор текста/части текста | Только каталог | Не удалось прочитать |
| --- | ---: | ---: | ---: | ---: |
| Metaplex — английские исходники | 575 | 114 | 461 | 0 |
| Solana | 548 | 13 | 534 | 1 |
| Phantom | 94 | 26 | 65 | 3 |
| Solflare | 55 | 41 | 0 | 14 |

Дополнительно просмотрены 17 общих страниц/разделов вне первичных индексов. Первичные индексы содержат 1272 записи. Ни число найденных адресов, ни частичный обзор не означают полное чтение всех примеров. Указанные числа — консервативный учёт сохранённых результатов; отдельные более ранние чтения могут быть отражены только в SOURCES/KNOWLEDGE.

Каталоги: [Metaplex](reports/metaplex-documentation-catalogue.json), [Solana, Phantom, Solflare](reports/official-sites-catalogue.json).

## Пройденные направления

| Сайт | Направления обзора |
| --- | --- |
| Solana | Accounts/transactions/fees, SDK и миграция frontend, RPC, подписи, verified builds, Mollusk/Surfpool, Kora, payments/DeFi/tokenization/privacy, enterprise/products, validators/staking, templates и reports |
| Metaplex | Core и plugins, Core Candy Machine и 31 guard, Umi/CLI/DAS, Bubblegum, Genesis, Distro, Hybrid, Inscription, Agent Registry/Nori/Skill; legacy программы и mobile SDK |
| Phantom | Traditional Solana provider, Wallet Standard, ошибки и mobile debugging, Connect Browser/React/React Native, session/JWT/Portal, signing/Lighthouse/priority fees/Token22, EVM/Bitcoin/Sui статусы, documentation MCP, wallet MCP и CLI |
| Solflare | GitBook onboarding, hardware/import/derivation, adapter/SDK, deeplinks/signing/sessions, metadata/avatar/notifications; product/security/essentials/staking, Shield, Magic, resources/guides/glossary |

## Что уже изменило наши решения

1. Core Candy Machine остаётся основой нового выпуска. Legacy Candy Machine и deprecated mobile SDK не возвращаются.
2. Embedded Phantom и существующий injected Phantom требуют разных способов второй подписи. Выбор SDK определяется нашим сценарием и проверкой совместимости.
3. Даже официальные примеры содержат ошибки и пропуски: найдено обратное сравнение счётчика mintLimit; комиссии не всегда включены в пример, signAllTransactions доступен не каждому пути.
4. Сохранённая неизвестная попытка проверяется до нового mint; удаление интерфейса не должно уничтожать возможность восстановления.
5. Ни замена NFT стандарта, ни faucet, ни перезапуск кошелька сами по себе не исправляют 429 на RPC.
6. llms.txt недостаточен для всего сайта: Phantom CLI отсутствует в первичном списке; Solflare guides имеют пагинацию; Solana содержит отдельные динамические продукты/новости/отчёты.

## Точная очередь продолжения

1. Закончить оставшиеся Core guides и сопоставить каждый используемый пример с закреплёнными версиями SDK; остальные Metaplex разделы обходить по каталогу, сохраняя глубину проверки.
2. Пройти ещё не прочитанные Phantom recipes, SDK reference, Portal и расширенную навигацию; не ограничиваться llms.txt.
3. Для Solflare завершить доступные страницы notifications/profile APIs и оставшиеся ошибки получения текста. Продолжить все страницы App Guides и соседние разделы основного сайта.
4. Для Solana продолжить остальные core/CPI/PDA, RPC HTTP/WebSocket, token extensions, cookbook, tools и учебные главы; отдельно расширять каталог общих страниц и новостей.
5. После документального обзора и реализации — локальные проверки, затем полный read-only preflight на настроенном реальном RPC, затем физический кошелёк. Сетевой блокер не объявлять пройденным из-за успешной VM.

Страницы с ошибкой чтения не считаются изученными. Изображения, видео, интерактивные примеры и дочерние страницы не становятся прочитанными от чтения текста родительской страницы. Сведения о продуктах и версиях перепроверяются непосредственно перед применением.
