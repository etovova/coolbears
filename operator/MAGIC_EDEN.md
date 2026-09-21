# Magic Eden: применимость к CoolBears

Проверено 21 сентября 2026 по присланным владельцем страницам и примеру кода.

| Материал | Что проверено | Вывод для проекта |
| --- | --- | --- |
| [Solana API Overview](https://docs.magiceden.io/reference/solana-overview) | API метаданных, коллекций и торговых операций; разные адреса Devnet/Mainnet | Использовать для проверки индексирования после настоящего минта. Это не Solana JSON-RPC и не создание Candy Machine. |
| [Solana API Keys](https://docs.magiceden.io/reference/solana-api-keys) | Instruction endpoints требуют Bearer API key; публичный лимит 120 запросов/мин, 2/сек | Ключ нужен для запрашивания торговых транзакций. Он не заменяет RPC и подпись владельца; доступ к ключу пока не предоставлен. |
| [Sell/list instruction](https://docs.magiceden.io/reference/get_instructions-sell) | seller, tokenMint, tokenAccount, price; endpoint Mainnet | Пример владельца выставляет готовый NFT на продажу. Совместимость именно этого endpoint с Core в прочитанной странице не оговорена. |
| [Token metadata](https://docs.magiceden.io/reference/get_tokens-token-mint) | Чтение метаданных по mint/asset ID; возможен Token not found | Ответ API нужно проверять отдельно от существования аккаунта в блокчейне. |
| [Core ecosystem support](https://www.metaplex.com/docs/smart-contracts/core/ecosystem-support) | Metaplex указывает поддержку Core у Magic Eden, Phantom и Solflare как Complete | Поддержка платформы подтверждена документацией. Это не доказательство совместимости каждого старого REST endpoint или индексирования конкретной новой коллекции. |

Присланный пример не запускался. В нём адреса демонстрационные, URL Mainnet, секретный ключ загружается из окружения. Для сайта остаётся подпись кошельком; приватный ключ и Bearer token в публичный frontend не переносить. Перед подписью сторонней транзакции нужно проверить сеть, продавца, NFT, цену, получателей и инструкции. После confirmTransaction обязательно проверять value.err: положительный слот сам по себе не доказывает успешного исполнения. При неизвестном результате сохранять подпись и проверять её, не создавать замену автоматически.

API-ключ не запрашивался через формы и не использовался; торговые операции не отправлялись. Прочитаны указанные страницы и индекс документации, а не весь сайт Magic Eden.

После finalized минта нового J3kTD8CvWZgrKjW3EQ9UceYXVqvBRHJEQDK4PrE5xx57 выполнен один GET по описанному в Overview Devnet адресу /v2/tokens/{asset}. 2026-09-21T20:12Z сервер ответил HTTP 404 с `no Route matched with those values`. Это ошибка маршрута API, не подтверждение отсутствия NFT или несовместимости Core. Индексирование Magic Eden не подтверждено. Полный небольшой ответ: reports/magic-eden-devnet.json. Mainnet и торговый sell endpoint не вызывались.
