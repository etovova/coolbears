"""Check the deployed purchase gate and buyer recovery without asking for a wallet signature."""
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from walletconnect_checkout import SITE, confirm_in_storefront


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
    assert http == 200 and status["network"] == "Testnet"
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


if __name__ == "__main__":
    record = json.loads(Path(__file__).with_name("walletconnect-testnet-sale.json").read_text())
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_BIN"))
        page = browser.new_page(locale="ru-RU")
        state = check_gate(page)
        for outcome in ("complete", "expired"):
            check_browser(browser, record, outcome)
        if state != "ready":
            expect(page.locator("#buy")).to_contain_text("временно недоступна", timeout=35000)
            expect(page.locator("#buy")).to_be_disabled()
        browser.close()
    if "GITHUB_OUTPUT" in os.environ:
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            print("ready=" + ("true" if state == "ready" else "false"), file=output)
    if state != "ready":
        print("New purchases and settlement checks on the live chain are deferred by the published Testnet gate.")
