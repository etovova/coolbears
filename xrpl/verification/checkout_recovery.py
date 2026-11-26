"""Check the deployed purchase gate and buyer recovery without asking for a wallet signature."""
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright

from walletconnect_checkout import SITE, confirm_in_storefront


def get_json(request):
    try:
        reply = urlopen(request, timeout=35)
    except HTTPError as error:
        reply = error
    with reply:
        return reply.status, json.load(reply)


def check_gate():
    http, status = get_json(SITE + "/xrpl/api/status")
    assert http == 200 and status["network"] == "Testnet"
    state = status["serviceState"]
    assert state in ("ready", "network-unavailable", "collection-unavailable"), state
    assert status["open"] is (state == "ready")
    if not status["open"]:
        for endpoint in ("challenge", "mint"):
            request = Request(SITE + "/xrpl/api/" + endpoint, data=b"{}",
                              headers={"Origin": SITE, "Content-Type": "application/json"})
            http, data = get_json(request)
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
    state = check_gate()
    record = json.loads(Path(__file__).with_name("walletconnect-testnet-sale.json").read_text())
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_BIN"))
        for outcome in ("complete", "expired"):
            check_browser(browser, record, outcome)
        if state != "ready":
            page = browser.new_page(locale="ru-RU")
            page.goto(SITE + "/#mint", wait_until="domcontentloaded")
            expect(page.locator("#buy")).to_contain_text("временно недоступна", timeout=35000)
            expect(page.locator("#buy")).to_be_disabled()
        browser.close()
    if "GITHUB_OUTPUT" in os.environ:
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            print("ready=" + ("true" if state == "ready" else "false"), file=output)
    if state != "ready":
        print("New purchases and settlement checks on the live chain are deferred by the published Testnet gate.")
