"""Check the deployed purchase gate and buyer recovery without asking for a wallet signature."""
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

from walletconnect_checkout import ISSUER, PRICE, SITE, confirm_in_storefront


def check_gate(page):
    page.goto(SITE + "/#mint", wait_until="domcontentloaded")
    def endpoint(name, post=False):
        return page.evaluate("""async ([name,post])=>{
          const init=post?{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}:{};
          const r=await fetch('/xrpl/api/'+name,{cache:'no-store',...init});
          if (!r.headers.get('content-type')?.includes('application/json'))
            throw Error('Unexpected storefront response '+r.status+' on '+name);
          return [r.status,await r.json()];
        }""", [name, post])
    http, status = endpoint("status")
    assert http == 200 and (status["network"], status["issuer"], status["price"]) == ("Testnet", ISSUER, PRICE)
    quantities = {"en": "one NFT at a time", "ru": "один NFT за раз", "zh": "每次可购买 1 个 NFT"}
    fees = {"en": "10 test XRP", "ru": "10 тестовых XRP", "zh": "10 测试 XRP"}
    original_language = page.locator("html").get_attribute("lang")
    for language, quantity in quantities.items():
        page.locator(f"[data-lang={language}]").click()
        expect(page.locator("[data-i18n=mintText]")).to_contain_text(quantity)
        expect(page.locator("[data-i18n=mintFeeNote]")).to_contain_text(fees[language])
        expect(page.locator("#qty")).to_have_value("1")
        expect(page.locator("#plus")).to_be_disabled()
        if status["open"]:
            expect(page.locator("#buy")).to_contain_text(fees[language])
    page.locator(f"[data-lang={original_language}]").click()
    state = status["serviceState"]
    assert state in ("ready", "network-unavailable", "collection-unavailable"), state
    assert status["open"] is (state == "ready")
    if not status["open"]:
        for name in ("challenge", "mint"):
            http, data = endpoint(name, post=True)
            assert (http, data) == (503, {"state": "maintenance", "serviceState": state}), (http, data)
        print("Live Testnet reports", state, "and refuses both reservation routes before signing.")
    return state


def check_browser(browser, sale, outcome):
    pending = {"network": "Testnet", "buyer": sale["buyer"], "offer": sale["offer"], "hash": sale["payment"]}
    with browser.new_context(locale="ru-RU", viewport={"width": 375, "height": 760}) as ctx:
        page = ctx.new_page()
        page.add_init_script("localStorage.setItem('coolbears.xrpl.pending.Testnet'," +
                             json.dumps(json.dumps(pending)) + ")")
        writes, reads = [], []
        page.on("request", lambda req: writes.append(req.url)
                if req.method == "POST" and "/xrpl/api/" in req.url else None)

        def receipt(route):
            reads.append(route.request.url)
            if len(reads) == 1:
                route.fulfill(status=503, json={"error": "Temporary read failure"})
            elif outcome == "complete":
                route.fulfill(json={"state": "complete", "token": sale["token"], "hash": sale["payment"]})
            else:
                route.fulfill(json={"state": "expired"})

        page.route("**/xrpl/api/receipt?*", receipt)
        page.goto(SITE + "/#mint", wait_until="domcontentloaded")
        if outcome == "complete":
            confirm_in_storefront(page, sale["payment"])
        else:
            expect(page.locator("#message")).to_contain_text("срок истёк", timeout=45000)
            expect(page.locator("#receipt")).to_be_hidden()
        assert len(reads) == 2 and not writes, (reads, writes)
        assert page.evaluate("JSON.parse(localStorage.getItem('coolbears.xrpl.pending.Testnet'))") is None
        print("Live storefront, simulated receipt responses: 503 then", outcome, "without clicks or writes.")


def check_startup_recovery(browser, sale, config, scenario):
    pending = {"network": "Testnet", "buyer": sale["buyer"], "offer": sale["offer"]}
    if scenario == "unknown-hash":
        pending["last"] = sale["ledger"] + 5
    else:
        pending["hash"] = sale["payment"]
    callback = scenario == "login-cancelled"
    url = SITE + ("/xrpl/?error=access_denied&state=buyer-test" if callback else "/#mint")
    with browser.new_context(locale="ru-RU") as ctx:
        page = ctx.new_page()
        page.add_init_script("localStorage.setItem('coolbears.xrpl.pending.Testnet'," +
                             json.dumps(json.dumps(pending)) + ")")
        if callback:
            assert config["xamanClientId"]
            login = {"state": "buyer-test", "client": config["xamanClientId"]}
            page.add_init_script("localStorage.setItem('coolbears.xaman.Testnet.login', JSON.stringify(" +
                                 "Object.assign(" + json.dumps(login) + ", {started: Date.now()})))")
        status_reads, receipt_reads, writes = [], [], []

        def status(route):
            status_reads.append(route.request.method)
            if scenario == "status-offline" and len(status_reads) == 1:
                route.abort("internetdisconnected")
            else:
                route.fulfill(json=config)

        def receipt(route):
            receipt_reads.append(route.request.url)
            if scenario == "unknown-hash" and len(receipt_reads) == 1:
                route.fulfill(status=202, json={"state": "pending"})
            else:
                route.fulfill(json={"state": "complete", "token": sale["token"], "hash": sale["payment"]})

        page.on("request", lambda req: writes.append(req.url)
                if req.method == "POST" and "/xrpl/api/" in req.url else None)
        page.route("**/xrpl/api/**", lambda route: route.abort())
        page.route("**/xrpl/api/status", status)
        path = "reconcile" if scenario == "unknown-hash" else "receipt"
        page.route("**/xrpl/api/" + path + "?*", receipt)
        page.goto(url, wait_until="domcontentloaded")
        expected = "https://testnet.xrpl.org/transactions/" + sale["payment"]
        expect(page.locator("#receipt")).to_have_attribute("href", expected, timeout=18000)
        assert len(status_reads) == (2 if scenario == "status-offline" else 1), status_reads
        assert len(receipt_reads) == (2 if scenario == "unknown-hash" else 1), receipt_reads
        expected_query = {"buyer": [sale["buyer"]], "offer": [sale["offer"]]}
        if scenario == "unknown-hash":
            expected_query["last"] = [str(pending["last"])]
        else:
            expected_query["hash"] = [sale["payment"]]
        assert all(parse_qs(urlsplit(url).query) == expected_query for url in receipt_reads)
        assert not writes and page.locator("#receipt").is_visible()
        assert page.evaluate("JSON.parse(localStorage.getItem('coolbears.xrpl.pending.Testnet'))") is None


if __name__ == "__main__":
    record = json.loads(Path(__file__).with_name("walletconnect-testnet-sale.json").read_text())
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_BIN"))
        page = browser.new_page(locale="ru-RU")
        state = check_gate(page)
        for outcome in ("complete", "expired"):
            check_browser(browser, record, outcome)
        config = page.evaluate("async () => (await fetch('/xrpl/api/status')).json()")
        for scenario in ("status-offline", "login-cancelled", "unknown-hash"):
            check_startup_recovery(browser, record, config, scenario)
        if state != "ready":
            expect(page.locator("#buy")).to_contain_text("временно недоступна", timeout=35000)
            expect(page.locator("#buy")).to_be_disabled()
        browser.close()
    if "GITHUB_OUTPUT" in os.environ:
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            print("ready=" + ("true" if state == "ready" else "false"), file=output)
    if state != "ready":
        print("New purchases and settlement checks on the live chain are deferred by the published Testnet gate.")
