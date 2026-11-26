"""Check the published mobile pairing UI without connecting a wallet or creating an order."""
import re
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

SHOPS = (
    ("https://testnet.coolbears-nfts.com/#mint", "Testnet", 320, "ru-RU", "Открыть"),
    ("https://coolbears-nfts.com/xrpl/#mint", "Mainnet", 390, "en-US", "Open"),
    ("https://testnet.coolbears-nfts.com/#mint", "Testnet", 375, "zh-CN", "打开"),
)


def check_page(page, url, network, label):
    posts = []
    page.on("request", lambda req: posts.append(urlparse(req.url).path)
            if req.method == "POST" and "/xrpl/api/" in req.url else None)
    page.goto(url, wait_until="domcontentloaded")
    status = page.evaluate("async () => (await fetch('/xrpl/api/status')).json()")
    assert status["network"] == network
    page.locator("#walletBtn").click()
    dialog = page.locator("#walletDialog")
    assert dialog.locator("[data-wallet]").evaluate_all("(items) => items.map(x => x.dataset.wallet)") == [
        "xaman", "gem", "cross", "wc"]
    page.locator("#wcWallet").click()
    page.locator("#wcJoey[href]").wait_for(state="visible", timeout=55000)
    links = []
    for selector, name, scheme, host, path in (
            ("#wcJoey", "Joey", "joey", "settings", "/wc"),
            ("#wcOpen", "Bifrost", "bifrostwallet", "wc", "")):
        link = page.locator(selector)
        assert link.text_content() == label + " " + name
        target = urlparse(link.get_attribute("href"))
        assert (target.scheme, target.netloc, target.path) == (scheme, host, path)
        query = parse_qs(target.query, strict_parsing=True)
        assert list(query) == ["uri"] and len(query["uri"]) == 1
        links.append(query["uri"][0])
        assert link.bounding_box()["height"] >= 44
    assert links[0] == links[1]
    assert re.match(r"^wc:[a-f0-9]{64}@2\?", links[0])
    params = parse_qs(urlparse(links[0]).query)
    assert "symKey" in params and "relay-protocol" in params
    assert page.locator("#wcQR").get_attribute("src").startswith("data:image/png")
    assert dialog.evaluate("d => d.scrollWidth <= d.clientWidth")
    page.locator("#wcCopy").click()
    field = page.locator("#wcLink")
    field.wait_for(state="visible")
    assert field.input_value() == links[0]
    assert field.evaluate("n => n.selectionStart === 0 && n.selectionEnd === n.value.length")
    page.locator("#closeWallet").click()
    page.locator("#wcJoey[href]").wait_for(state="detached")
    assert field.input_value() == "" and page.locator("#wcOpen").get_attribute("href") is None
    page.locator("#walletBtn").click()
    assert page.locator("#wcWallet").is_enabled() and page.locator("#wcPair").is_hidden()
    assert not posts, posts
    print(f"{network} {label}: both mobile links, QR, manual copy, cancellation and existing wallet options passed", flush=True)


def verify(browser):
    for url, network, width, locale, label in SHOPS:
        with browser.new_context(locale=locale, viewport={"width": width, "height": 720},
                                 is_mobile=True, has_touch=True) as context:
            context.add_init_script("""Object.defineProperty(navigator, 'clipboard', {
                value: {writeText: async () => {throw new DOMException('Clipboard denied', 'NotAllowedError')}}
            })""")
            check_page(context.new_page(), url, network, label)


if __name__ == "__main__":
    with sync_playwright() as playwright, playwright.chromium.launch() as browser:
        verify(browser)
