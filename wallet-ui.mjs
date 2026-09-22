import { getWalletOptions, createWalletSession, walletDeadline } from './wallet-core.mjs?v=wallet-reliability-20260922-2';

const text = {
  en: { title: 'Connect wallet', open: 'Open in {wallet}', install: 'Install {wallet}', close: 'Close' },
  ru: { title: 'Подключить кошелёк', open: 'Открыть в {wallet}', install: 'Установить {wallet}', close: 'Закрыть' },
  zh: { title: '连接钱包', open: '在 {wallet} 中打开', install: '安装 {wallet}', close: '关闭' }
};

export function createWalletUI({ language = () => 'en', onChange = () => {}, discover = () => import('./wallet-standard.js?v=wallet-standard-20260920') } = {}) {
  const session = createWalletSession(onChange);
  if (!document.querySelector('link[data-wallet-css]')) {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = new URL('./wallet.css', import.meta.url).href;
    style.dataset.walletCss = '';
    document.head.append(style);
  }
  let standard;
  const discovery = walletDeadline(Promise.resolve().then(discover), 15000).then(module => { standard = module; return module; }).catch(() => null);
  function choose(wallets, mobile) {
    return new Promise((resolve, reject) => {
      const t = text[language()] || text.en;
      const dialog = document.createElement('dialog');
      dialog.className = 'solana-wallet-dialog';
      dialog.setAttribute('aria-labelledby', 'solana-wallet-title');
      const heading = document.createElement('h2');
      heading.id = 'solana-wallet-title';
      heading.textContent = t.title;
      dialog.append(heading);
      let selected = false;
      const list = document.createElement('div'); dialog.append(list);
      function populate(options) {
      list.replaceChildren();
      for (const wallet of options) {
        if (!wallet.provider) {
          const link = document.createElement('a');
          link.textContent = (wallet.opensApp ? t.open : t.install).replace('{wallet}', wallet.name);
          const destination = new URL(location.href); destination.searchParams.set('connectWallet', wallet.name);
          link.href = wallet.opensApp ? getWalletOptions(window, destination.href, true).find(item => item.name === wallet.name).href : wallet.href;
          if (!wallet.opensApp) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
          list.append(link);
          continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = wallet.name;
        button.onclick = () => { selected = true; dialog.close(); resolve(wallet.provider); };
        list.append(button);
      }
      }
      populate(wallets);
      const stop = standard?.watchStandard(() => populate(getWalletOptions(window, location.href, mobile, standard.standardOptions())));
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'wallet-close';
      close.textContent = t.close;
      close.onclick = () => dialog.close();
      dialog.append(close);
      dialog.addEventListener('close', () => {
        stop?.();
        dialog.remove();
        if (!selected) reject(new DOMException('Wallet selection cancelled', 'AbortError'));
      }, { once: true });
      dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
      document.body.append(dialog);
      dialog.showModal();
    });
  }
  return {
    get address() { return session.address; },
    get provider() { return session.provider; },
    async connect() {
      const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      await discovery;
      const wallets = getWalletOptions(window, location.href, mobile, standard?.standardOptions() || []);
      const page = new URL(location.href);
      const requested = page.searchParams.get('connectWallet');
      if (requested) {
        page.searchParams.delete('connectWallet'); history.replaceState(null, '', page.href);
        const selected = wallets.find(wallet => wallet.name === requested && wallet.provider);
        if (selected) return session.connect(selected.provider);
      }
      const provider = await choose(wallets, mobile);
      return session.connect(provider);
    },
    disconnect: () => session.disconnect()
  };
}
