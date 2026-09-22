(() => {
  const cfg = window.COOLBEARS_CONFIG || {};
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  const tr = {
    en: {
      prelaunchStatus:'NOT OPEN YET', prelaunchButton:'MINT COMING SOON', mintFeeNote:'The calculator shows the NFT price only. Creation costs and network fees are additional. The full amount will be shown before signing when mint opens.', navMint:'Mint', navReveal:'Reveal', navCollection:'Collection', navRarity:'Rarity', navFaq:'FAQ',
      connectWallet:'Connect wallet', connected:'Wallet connected', disconnectWallet:'Disconnect wallet', walletDisconnected:'Wallet disconnected.', disconnectFailed:'Could not disconnect. Please try again.', walletLoading:'Opening wallet…', walletFailed:'Could not open wallets. Please try again.', walletChoose:'Choose a wallet in the window.',
      kicker:'10,000 UNIQUE BEARS • BUILT ON Solana',
      heroLine1:'EVERYONE GETS A BEAR.', heroLine2:'NOT EVERYONE GETS A LEGEND.',
      heroText:'Mint is not open yet. Reveal is planned for January 1, 2027.',
      mintNow:'MINT COMING SOON', viewMarketplace:'VIEW ON MAGIC EDEN', statPrice:'Mint price', statSupply:'Total supply', statRoyalty:'Royalty', statTx:'Per order',
      burst:'COOL!', speech:'WHO DID YOU GET?',
      disclaimer1:'NO GUARANTEED VALUE.', disclaimer2:'NO PROMISE OF FINANCIAL RETURNS.', disclaimer3:'NO CELEBRITY BACKING.', disclaimer4:'DON’T BUY EXPECTING PROFIT.', disclaimer5:'JUST BEARS. JUST ART. JUST FOR FUN.',
      mintKicker:'PRIMARY MINT', mintTitle:'MINT IS<br>COMING SOON', mintText:'Choose between 1 and 50 NFTs. There is no lifetime wallet limit.',
      mintNoteLine:'NFTs are tradable immediately after mint.', mintedLabel:'MINT STATUS', quantity:'QUANTITY', total:'NFT PRICE', connectToMint:'CONNECT WALLET TO MINT', mintN:'MINT {n} NFT', mintFoot:'Up to 50 per order • no wallet limit',
      beforeReveal:'BEFORE REVEAL', revealKicker:'MYSTERY FIRST', revealTitle:'YOUR BEAR<br>IS HIDING.', revealText:'After mint, every NFT shows the official CoolBears GIF. Traits and rarity stay hidden, but the NFT can still be sold, transferred or gifted.',
      revealLabel:'REVEAL', revealDate:'JANUARY 1, 2027', revealFoot:'Reveal becomes available on January 1, 2027. After the reveal transaction, the same NFT shows its final artwork and traits. No reroll.',
      collectionKicker:'THE COLLECTION', collectionTitle:'DIFFERENT BEARS.<br>SAME VIBE.', collectionText:'10,000 unique combinations built from hand-drawn traits. Clean, weird, rare, legendary — every bear exists once.',
      rarityKicker:'AFTER REVEAL', rarityTitle:'RARITY WITH<br>REAL WEIGHT.', rarityText:'Every NFT receives a rarity score based on the actual frequency of its final traits across the full 10,000-piece collection.',
      commonLabel:'COMMON', commonTitle:'The base layer', commonText:'The most frequently appearing traits.', rareLabel:'RARE', rareTitle:'Harder to find', rareText:'Less common bodies, accessories and combinations.', legendaryLabel:'LEGENDARY', legendaryTitle:'The legends', legendaryText:'Gold, Crystal, Beer, Robot, Zombie and other top-tier traits.',
      top50Title:'TOP 50 RAREST COOLBEARS', top50Text:'Hidden until reveal. Ranked by final rarity score.', top50Stamp:'TOP 50',
      faqTitle:'QUICK<br>ANSWERS.', faq1q:'Can I sell my NFT before reveal?', faq1a:'Yes. The NFT is transferable and tradable immediately after mint. Before reveal, everyone sees the shared GIF.', faq2q:'When do my traits appear?', faq2a:'After the reveal transaction, no earlier than January 1, 2027.', faq3q:'Where can I trade?', faq3a:'After Magic Eden indexes the collection, owners can list and trade there. The official link will be added after deployment.', faq4q:'How is rarity calculated?', faq4a:'Rarity score is based on the real frequency of each final trait across all 10,000 CoolBears.',
      footerTag:'Everyone gets a bear. Not everyone gets a legend.', terms:'Terms', privacy:'Privacy', backTop:'Back to top',
      connectCancelled:'Wallet connection was cancelled.', walletUnavailable:'Solana wallet requires the deployed HTTPS site.', contractPending:'Mint contract will be activated after audited mainnet deployment.',
      pageTitle:'CoolBears — 10,000 Bears on Solana', pageDescription:'CoolBears — 10,000 unique bears. Mint coming soon. Reveal January 1, 2027.'
    },
    ru: {
      prelaunchStatus:'ЕЩЁ НЕ ОТКРЫТ', prelaunchButton:'МИНТ СКОРО', mintFeeNote:'Калькулятор показывает только стоимость NFT. Расходы на создание и комиссия сети оплачиваются дополнительно. После открытия минта полная сумма будет показана до подписи.', navMint:'Минт', navReveal:'Раскрытие', navCollection:'Коллекция', navRarity:'Редкость', navFaq:'Вопросы',
      connectWallet:'Подключить кошелёк', connected:'Кошелёк подключён', disconnectWallet:'Отключить кошелёк', walletDisconnected:'Кошелёк отключён.', disconnectFailed:'Не удалось отключить кошелёк. Попробуй ещё раз.', walletLoading:'Открываю кошелёк…', walletFailed:'Не удалось открыть кошельки. Нажми ещё раз.', walletChoose:'Выбери кошелёк в открывшемся окне.',
      kicker:'10 000 УНИКАЛЬНЫХ МЕДВЕДЕЙ • НА Solana',
      heroLine1:'МЕДВЕДЯ ПОЛУЧИТ КАЖДЫЙ.', heroLine2:'ЛЕГЕНДУ — НЕ КАЖДЫЙ.',
      heroText:'Минт ещё не открыт. Раскрытие запланировано на 1 января 2027 года.',
      mintNow:'МИНТ СКОРО', viewMarketplace:'СМОТРЕТЬ НА MAGIC EDEN', statPrice:'Цена минта', statSupply:'Всего', statRoyalty:'Роялти', statTx:'За покупку',
      burst:'КРУТО!', speech:'КТО ТЕБЕ ПОПАДЁТСЯ?',
      disclaimer1:'БЕЗ ГАРАНТИРОВАННОЙ ЦЕННОСТИ.', disclaimer2:'БЕЗ ОБЕЩАНИЙ ФИНАНСОВОЙ ДОХОДНОСТИ.', disclaimer3:'БЕЗ ПОДДЕРЖКИ ЗНАМЕНИТОСТЕЙ.', disclaimer4:'НЕ ПОКУПАЙ В ОЖИДАНИИ ПРИБЫЛИ.', disclaimer5:'ПРОСТО МЕДВЕДИ. ПРОСТО АРТ. ПРОСТО ДЛЯ УДОВОЛЬСТВИЯ.',
      mintKicker:'ПЕРВИЧНЫЙ МИНТ', mintTitle:'МИНТ<br>СКОРО', mintText:'Выбери от 1 до 50 NFT за одну покупку. Общего лимита на кошелёк нет.',
      mintNoteLine:'NFT можно перепродавать сразу после минта.', mintedLabel:'СТАТУС МИНТА', quantity:'КОЛИЧЕСТВО', total:'СТОИМОСТЬ NFT', connectToMint:'ПОДКЛЮЧИТЬ КОШЕЛЁК', mintN:'ЗАМИНТИТЬ {n} NFT', mintFoot:'До 50 за покупку • без лимита на кошелёк',
      beforeReveal:'ДО РАСКРЫТИЯ', revealKicker:'СНАЧАЛА ТАЙНА', revealTitle:'ТВОЙ МЕДВЕДЬ<br>ПОКА СКРЫТ.', revealText:'После минта каждый NFT показывает официальный GIF CoolBears. Характеристики и редкость скрыты, но NFT уже можно продавать, передавать или дарить.',
      revealLabel:'РАСКРЫТИЕ', revealDate:'1 ЯНВАРЯ 2027', revealFoot:'Раскрытие разрешено с 1 января 2027 года. После операции раскрытия тот же NFT покажет финального медведя и его атрибуты. Без повторного выбора.',
      collectionKicker:'КОЛЛЕКЦИЯ', collectionTitle:'РАЗНЫЕ МЕДВЕДИ.<br>ОДИН ХАРАКТЕР.', collectionText:'10 000 уникальных сочетаний из нарисованных характеристик. Обычные, странные, редкие и легендарные — каждый медведь существует только один раз.',
      rarityKicker:'ПОСЛЕ РАСКРЫТИЯ', rarityTitle:'РЕДКОСТЬ,<br>КОТОРАЯ ИМЕЕТ ВЕС.', rarityText:'Каждый NFT получает оценку редкости на основе реальной частоты его финальных характеристик во всей коллекции из 10 000 экземпляров.',
      commonLabel:'ОБЫЧНЫЕ', commonTitle:'Базовый уровень', commonText:'Самые часто встречающиеся характеристики.', rareLabel:'РЕДКИЕ', rareTitle:'Встречаются реже', rareText:'Более редкие тела, аксессуары и сочетания.', legendaryLabel:'ЛЕГЕНДАРНЫЕ', legendaryTitle:'Легенды', legendaryText:'Золотой, Кристальный, Пивной, Робот, Зомби и другие характеристики высшего уровня.',
      top50Title:'ТОП-50 САМЫХ РЕДКИХ COOLBEARS', top50Text:'Скрыт до раскрытия. Рейтинг строится по итоговой оценке редкости.', top50Stamp:'ТОП 50',
      faqTitle:'КОРОТКИЕ<br>ОТВЕТЫ.', faq1q:'Можно продать NFT до раскрытия?', faq1a:'Да. Сразу после минта NFT можно передавать и продавать. До раскрытия все видят общий GIF.', faq2q:'Когда появятся характеристики?', faq2a:'После операции раскрытия, не ранее 1 января 2027 года.', faq3q:'Где можно торговать?', faq3a:'После индексации коллекции на Magic Eden владельцы смогут выставлять и продавать NFT там. Официальная ссылка будет добавлена после запуска.', faq4q:'Как считается редкость?', faq4a:'Оценка редкости рассчитывается по реальной частоте каждой финальной характеристики во всех 10 000 CoolBears.',
      footerTag:'Медведя получит каждый. Легенду — не каждый.', terms:'Условия', privacy:'Конфиденциальность', backTop:'Наверх',
      connectCancelled:'Подключение кошелька отменено.', walletUnavailable:'Solana wallet требует размещённый HTTPS-сайт.', contractPending:'Минт будет активирован после проверенного развёртывания контракта в основной сети.',
      pageTitle:'CoolBears — 10 000 медведей на Solana', pageDescription:'CoolBears — 10 000 уникальных медведей. Минт скоро. Раскрытие 1 января 2027 года.'
    },
    zh: {
      prelaunchStatus:'尚未开放', prelaunchButton:'铸造即将开放', mintFeeNote:'计算器仅显示 NFT 价格。创建成本和网络费用另计。铸造开放后，签名前将显示完整金额。', navMint:'铸造', navReveal:'揭晓', navCollection:'系列', navRarity:'稀有度', navFaq:'常见问题',
      connectWallet:'连接钱包', connected:'钱包已连接', disconnectWallet:'断开钱包', walletDisconnected:'钱包已断开。', disconnectFailed:'无法断开钱包，请重试。', walletLoading:'正在打开钱包…', walletFailed:'无法打开钱包，请重试。', walletChoose:'请在窗口中选择钱包。',
      kicker:'10,000 只独特酷熊 • 基于 Solana',
      heroLine1:'每个人都能得到一只熊。', heroLine2:'但不是每个人都能得到传奇。',
      heroText:'铸造尚未开放。计划于 2027 年 1 月 1 日揭晓。',
      mintNow:'铸造即将开放', viewMarketplace:'在 MAGIC EDEN 查看', statPrice:'铸造价格', statSupply:'总量', statRoyalty:'版税', statTx:'每次购买',
      burst:'酷！', speech:'你会得到哪一只？',
      disclaimer1:'不保证任何价值。', disclaimer2:'不承诺任何经济回报。', disclaimer3:'没有名人背书。', disclaimer4:'不要以获利为目的购买。', disclaimer5:'只是熊。只是艺术。只是为了好玩。',
      mintKicker:'首次铸造', mintTitle:'铸造<br>即将开放', mintText:'每次可选择 1–50 个 NFT。钱包没有总数量限制。',
      mintNoteLine:'NFT 铸造后即可立即交易。', mintedLabel:'铸造状态', quantity:'数量', total:'NFT 价格', connectToMint:'连接钱包开始铸造', mintN:'铸造 {n} 个 NFT', mintFoot:'每次最多 50 个 • 钱包无总量限制',
      beforeReveal:'揭晓之前', revealKicker:'先保持神秘', revealTitle:'你的熊<br>还在隐藏。', revealText:'铸造后，每个 NFT 都显示官方 CoolBears GIF。属性和稀有度保持隐藏，但 NFT 已可出售、转移或赠送。', revealLabel:'揭晓', revealDate:'2027 年 1 月 1 日', revealFoot:'从 2027 年 1 月 1 日 起可执行揭晓。揭晓交易完成后，同一个 NFT 显示最终图像和属性，不会重新随机。',
      collectionKicker:'系列', collectionTitle:'不同的熊。<br>同一种感觉。', collectionText:'10,000 个由手绘属性组合而成的独特 CoolBears。普通、奇怪、稀有、传奇——每只熊都独一无二。',
      rarityKicker:'揭晓之后', rarityTitle:'真正有意义的<br>稀有度。', rarityText:'每个 NFT 都会根据最终属性在全部 10,000 件作品中的真实出现频率计算稀有度分数。',
      commonLabel:'普通', commonTitle:'基础层级', commonText:'出现频率最高的属性。', rareLabel:'稀有', rareTitle:'更难找到', rareText:'更少见的身体、配饰和组合。', legendaryLabel:'传奇', legendaryTitle:'传奇级', legendaryText:'黄金、水晶、啤酒、机器人、僵尸等顶级属性。',
      top50Title:'最稀有的 50 只 COOLBEARS', top50Text:'揭晓前保持隐藏，并按最终稀有度分数排名。', top50Stamp:'前 50',
      faqTitle:'快速<br>解答。', faq1q:'揭晓前可以出售 NFT 吗？', faq1a:'可以。NFT 铸造后即可转移和交易。揭晓前所有人看到同一个 GIF。', faq2q:'什么时候显示属性？', faq2a:'揭晓交易完成后，最早为 2027 年 1 月 1 日。', faq3q:'在哪里交易？', faq3a:'Magic Eden 完成系列索引后即可在那里上架和交易。正式链接将在部署后添加。', faq4q:'稀有度如何计算？', faq4a:'根据全部 10,000 个 CoolBears 中每个最终属性的真实出现频率计算。',
      footerTag:'每个人都能得到一只熊，但不是每个人都能得到传奇。', terms:'条款', privacy:'隐私', backTop:'返回顶部',
      connectCancelled:'已取消钱包连接。', walletUnavailable:'Solana wallet 需要已部署的 HTTPS 网站。', contractPending:'主网合约完成审计和部署后将启用铸造。',
      pageTitle:'CoolBears — Solana 上的 10,000 只酷熊', pageDescription:'CoolBears — 10,000 只独特酷熊。铸造即将开放。2027 年 1 月 1 日揭晓。'
    }
  };

  // Language persistence is optional; blocked storage must not disable the site.
  let lang = 'en';
  try { lang = localStorage.getItem('coolbears_lang') || 'en'; } catch {}
  if (!tr[lang]) lang = 'en';
  let connected = false;
  let wallet = null;
  let walletAddress = '';

  const t = k => tr[lang][k] ?? tr.en[k] ?? k;
  const qty = $('#qty');
  const total = $('#total');
  const unitPrice = $('#unitPrice');
  const walletBtn = $('#walletBtn');
  const mintBtn = $('#mintBtn');
  const note = $('#mintNote');
  const marketplace = $('#marketplaceTop');
  const backTop = $('#backTop');

  function renderConnectionState() {
    if (walletBtn) { walletBtn.textContent = connected ? walletAddress.slice(0, 4) + '…' + walletAddress.slice(-4) + '\n' + t('disconnectWallet') : t('connectWallet'); walletBtn.title = walletAddress; }
    if (mintBtn) { mintBtn.textContent = t('prelaunchButton'); mintBtn.disabled = true; }
    if ($('#minted')) $('#minted').textContent = t('prelaunchStatus');
  }

  function apply(l) {
    lang = tr[l] ? l : 'en';
    try { localStorage.setItem('coolbears_lang', lang); } catch {}
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    $$('[data-i18n]').forEach(el => { el.innerHTML = t(el.dataset.i18n); });
    $$('.bear-lang').forEach(btn => {
      const active = btn.dataset.lang === lang;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    document.title = t('pageTitle');
    const desc = $('meta[name="description"]');
    if (desc) desc.content = t('pageDescription');
    if (backTop) backTop.setAttribute('aria-label', t('backTop'));
    if (unitPrice) unitPrice.textContent = formatSol(cfg.priceSol) + ' SOL';
    clamp();
    renderConnectionState();
  }

  $$('.bear-lang').forEach(btn => {
    btn.addEventListener('click', () => apply(btn.dataset.lang));
  });

  function formatSol(value) {
    return Number(value) > 0
      ? Number(value).toLocaleString(lang === 'ru' ? 'ru-RU' : lang === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 9 })
      : '—';
  }

  function clamp() {
    if (!qty || !total) return;
    const max = Number(cfg.maxPerOrder || 50);
    let value = parseInt(qty.value || '1', 10);
    if (!Number.isFinite(value)) value = 1;
    value = Math.max(1, Math.min(max, value));
    qty.value = value;
    total.textContent = formatSol(value * Number(cfg.priceSol));
  }

  $('#minus')?.addEventListener('click', () => { qty.value = Number(qty.value) - 1; clamp(); });
  $('#plus')?.addEventListener('click', () => { qty.value = Number(qty.value) + 1; clamp(); });
  qty?.addEventListener('input', clamp);

  if (cfg.magicEdenUrl && marketplace) {
    marketplace.href = cfg.magicEdenUrl;
    marketplace.classList.remove('hidden-link');
  }

  let openingWallet = false;
  async function loadWalletUI() {
    let timer;
    try {
      return await Promise.race([
        import('./wallet-ui.mjs?v=wallet-reliability-20260922'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(t('walletFailed'))), 15000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  const walletStatus = document.createElement('div');
  walletStatus.id = 'walletStatus';
  walletStatus.setAttribute('role', 'status');
  walletStatus.setAttribute('aria-live', 'polite');
  walletStatus.hidden = true;
  document.body.append(walletStatus);
  let walletMessageTimer = null;
  let walletNoteText = '';
  function walletMessage(key) {
    clearTimeout(walletMessageTimer);
    walletMessageTimer = null;
    if (note && note.textContent === walletNoteText) note.textContent = t('mintFoot');
    walletNoteText = key ? t(key) : '';
    walletStatus.textContent = walletNoteText;
    walletStatus.hidden = !key;
    if (note && key) note.textContent = walletNoteText;
    if (key && key !== 'walletLoading') {
      walletMessageTimer = setTimeout(() => walletMessage(null), 3000);
    }
  }
  async function connect() {
    if (openingWallet) return;
    openingWallet = true;
    walletBtn?.setAttribute('aria-busy', 'true');
    try {
      if (!wallet) {
        const { createWalletUI } = await loadWalletUI();
        wallet = createWalletUI({
          language: () => lang,
          onChange: address => {
            walletAddress = address || '';
            connected = Boolean(walletAddress);
            renderConnectionState();
            walletMessage(null);
          }
        });
      }
      if (connected) {
        await wallet.disconnect();
        walletMessage('walletDisconnected');
      } else {
        await wallet.connect();
      }
    } catch (error) {
      walletMessage(error?.code === 4001 || error?.name === 'AbortError' ? 'connectCancelled' : 'walletFailed');
    } finally {
      openingWallet = false;
      walletBtn?.removeAttribute('aria-busy');
    }
  }

  walletBtn?.addEventListener('click', connect);
  if (backTop) {
    const updateBackTop = () => backTop.classList.toggle('show', window.scrollY > 500);
    window.addEventListener('scroll', updateBackTop, { passive:true });
    backTop.addEventListener('click', () => window.scrollTo({ top:0, behavior:'smooth' }));
    updateBackTop();
  }

  apply(lang);
})();
