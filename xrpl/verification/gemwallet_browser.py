"""Exercise the published Testnet checkout with an unmodified official GemWallet."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from zipfile import ZipFile

from playwright.sync_api import sync_playwright
from xrpl.wallet import Wallet

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from testnet_mint import PRICE, ISSUER, get, snapshot
from verify_testnet_sale import verify

SITE = "https://testnet.coolbears-nfts.com"
PACKAGE = ("https://clients2.google.com/service/update2/crx?response=redirect"
           "&prodversion=158.0.0.0&acceptformat=crx3"
           "&x=id%3Degebedonbdapoieedfcfkofloclfghab%26installsource%3Dondemand%26uc")
# SHA-256 of the Chrome Store CRX whose publisher key was verified for this ID.
DIGEST = "a14b315e436e128b0c9653d779269b8983d1e69e3009b1787ea41cdeeb0cd0b3"


def read_json(url, data=None):
    body = None if data is None else json.dumps(data).encode()
    with urlopen(Request(url, data=body, headers={"Content-Type": "application/json"}), timeout=35) as response:
        return json.load(response)


def button(page, label):
    return page.get_by_role("button", name=label, exact=True)


def configure(page, buyer, password):
    button(page, "Import a wallet").click()
    page.get_by_text("Family Seed", exact=True).click()
    page.locator("#seed").fill(buyer.seed)
    button(page, "Next").click()
    page.locator("#password").fill(password)
    page.locator("#confirm-password").fill(password)
    button(page, "Next").click()
    button(page, "Finish").click()
    indicator = page.get_by_test_id("network-indicator")
    indicator.click()
    page.get_by_text("Testnet", exact=True).click()
    page.wait_for_function("document.querySelector('[data-testid=network-indicator]')?.textContent === 'Testnet'", timeout=45000)


def checkout(context, base, buyer, password):
    site = context.new_page()
    observed = {}
    stages = []
    clicked = set()

    def observe(response):
        parsed = urlparse(response.url)
        if parsed.netloc != urlparse(SITE).netloc or response.status != 200:
            return
        endpoint = parsed.path.removeprefix("/xrpl/api/")
        if endpoint in ("challenge", "mint", "offer", "receipt"):
            observed[endpoint] = response.json()

    site.on("response", observe)
    site.goto(SITE, wait_until="domcontentloaded")
    button(site, "Mint · 10 test XRP").wait_for()
    site.locator("#walletBtn").click()
    site.locator("[data-wallet=gem]").click()

    def handle_popup(popup):
        if not popup.url.startswith(base + "/") or popup in clicked:
            return
        action = popup.get_by_role("button", name=re.compile("^(Share|Sign|Submit|Unlock)$"))
        if not action.count() or not action.first.is_visible() or not action.first.is_enabled():
            return
        name = action.first.inner_text().strip().lower()
        if name == "unlock":
            popup.locator('input[type="password"]').fill(password)
            action.first.click()
            return
        origin = parse_qs(urlparse(popup.url).query).get("url", [""])[0]
        assert origin in (SITE, SITE + "/", urlparse(SITE).netloc), "Unexpected wallet request origin"
        if name == "sign":
            challenge = observed["challenge"]["message"]
            assert "Wallet " + buyer.address + "\n" in challenge
            assert "Site " + SITE + "\n" in challenge and "\nMaximum NFT price 10 test XRP\n" in challenge
            assert popup.get_by_text(challenge, exact=True).count(), "Wrong reservation displayed"
        elif name == "submit":
            order, offer = observed["mint"], observed["offer"]
            assert order["state"] == "open" and order["id"] == offer["id"] and order["token"] == offer["token"]
            assert offer["price"] == PRICE and re.fullmatch("[0-9A-F]{64}", offer["id"])
            current = snapshot()
            entry = get("ledger_entry", index=offer["id"], ledger_hash=current["hash"])["node"]
            assert (entry["LedgerEntryType"], entry["Owner"], entry["Amount"], entry["Destination"],
                    entry["NFTokenID"], entry["Flags"]) == ("NFTokenOffer", ISSUER, PRICE, buyer.address, offer["token"], 1)
            assert "Accept NFT Offer" in popup.locator("body").inner_text()
            assert "submit" not in stages, "Only one purchase is allowed"
        else:
            assert name == "share"
        clicked.add(popup)
        stages.append(name)
        print("GemWallet:", name, flush=True)
        action.first.click()

    deadline = time.monotonic() + 155
    requested = False
    while time.monotonic() < deadline:
        for popup in context.pages:
            if popup != site and popup.url != base + "/index.html":
                handle_popup(popup)
        if not requested and buyer.address[:6] in site.locator("#walletBtn").inner_text():
            site.locator("#buy").click()
            requested = True
        if "receipt" in observed and observed["receipt"].get("state") == "complete":
            receipt = observed["receipt"]
            assert site.locator("#receipt").get_attribute("href") == "https://testnet.xrpl.org/transactions/" + receipt["hash"]
            assert "sign" in stages and "submit" in stages
            return verify(observed["mint"]["mint"], receipt["hash"])
        if requested and site.locator("#buy").is_enabled() and site.locator("#buy").inner_text() == "Check transaction":
            site.locator("#buy").click()
        site.wait_for_timeout(180)
    details = [(urlparse(p.url).path, p.get_by_role("button").all_text_contents()) for p in context.pages if not p.is_closed()]
    raise RuntimeError(f"Checkout incomplete. Stages {stages}, endpoints {list(observed)}, pages {details}, site {site.locator('#walletInfo').inner_text()} {site.locator('#message').inner_text()}")


def main():
    status = read_json(SITE + "/xrpl/api/status")
    assert (status["network"], status["issuer"], status["open"], status["price"]) == ("Testnet", ISSUER, True, PRICE)
    snapshot()
    buyer = Wallet.create()
    password = secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory() as root, sync_playwright() as p:
        extension = Path(root) / "gemwallet"
        with urlopen(PACKAGE, timeout=45) as response:
            crx = response.read()
        assert hashlib.sha256(crx).hexdigest() == DIGEST, "Review the new GemWallet package before running"
        with ZipFile(io.BytesIO(crx)) as archive:
            archive.extractall(extension)
        version = json.loads((extension / "manifest.json").read_text())["version"]
        context = p.chromium.launch_persistent_context(
            str(Path(root) / "profile"), channel="chromium", headless=False, locale="en-US",
            args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"])
        try:
            worker = next(iter(context.service_workers), None) or context.wait_for_event("serviceworker")
            base = "chrome-extension://" + urlparse(worker.url).netloc
            wallet = context.new_page()
            wallet.goto(base + "/index.html")
            configure(wallet, buyer, password)
            print("Installed GemWallet", version, "on Testnet", flush=True)
            read_json("https://faucet.altnet.rippletest.net/accounts", {"destination":buyer.address,"usageContext":"CoolBears Testnet browser checkout"})
            funded = get("account_info", account=buyer.address, ledger_index="validated")
            assert funded.get("validated") and int(funded["account_data"]["Balance"]) > int(PRICE) + 2000000
            print("Test buyer", buyer.address, flush=True)
            result = checkout(context, base, buyer, password)
            print(json.dumps({"gemwallet": version, **result}, indent=2), flush=True)
        finally:
            context.close()


if __name__ == "__main__":
    main()
