import { detectWallets, createWalletSession, phantomBrowseUrl } from './wallet-core.mjs';

const text = {
  en: { title: 'Connect wallet', open: 'Open in Phantom', install: 'Install Phantom', close: 'Close' },
  ru: { title: 'Подключить кошелёк', open: 'Открыть в Phantom', install: 'Установить Phantom', close: 'Закрыть' },
  zh: { title: '连接钱包', open: '在 Phantom 中打开', install: '安装 Phantom', close: '关闭' }
};

export function createWalletUI({ language = () => 'en', onChange = () => {} } = {}) {
  const session = createWalletSession(onChange);
  if (!document.querySelector('link[data-wallet-css]')) {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = new URL('./wallet.css', import.meta.url).href;
    style.dataset.walletCss = '';
    document.head.append(style);
  }
  function choose(wallets) {
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
      for (const wallet of wallets) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = wallet.name;
        button.onclick = () => { selected = true; dialog.close(); resolve(wallet.provider); };
        dialog.append(button);
      }
      if (!wallets.some(wallet => wallet.name === 'Phantom')) {
        const link = document.createElement('a');
        const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        link.textContent = mobile ? t.open : t.install;
        link.href = mobile ? phantomBrowseUrl(location.href) : 'https://phantom.com/download';
        if (!mobile) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        dialog.append(link);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'wallet-close';
      close.textContent = t.close;
      close.onclick = () => dialog.close();
      dialog.append(close);
      dialog.addEventListener('close', () => {
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
      const wallets = detectWallets(window);
      const provider = wallets.length === 1 ? wallets[0].provider : await choose(wallets);
      return session.connect(provider);
    },
    disconnect: () => session.disconnect()
  };
}
