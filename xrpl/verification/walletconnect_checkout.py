"""Buy one NFT on the published Testnet site using an independent WalletConnect peer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright
from xrpl.core.binarycodec import encode, encode_for_signing
from xrpl.core.keypairs import sign
from xrpl.wallet import Wallet

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gemwallet_browser import read_json
from testnet_mint import PRICE, ISSUER, RPC, get, rpc, snapshot
from verify_testnet_sale import verify

SITE = "https://testnet.coolbears-nfts.com"
METHOD = "xrpl_signTransaction"
CHAIN = "xrpl:1"

# The peer runs in a separate browser storage partition and pairs via the actual relay.
START_PEER = """async ({projectId, address, uri}) => {
  const {SignClient} = await import('/xrpl/walletconnect-sdk.mjs');
  const client = await SignClient.init({projectId, logger:'fatal', telemetryEnabled:false,
    metadata:{name:'CoolBears Testnet verification',description:'Independent signing test',
              url:location.origin, icons:[location.origin+'/xrpl/brand-logo.png']}});
  window.peer = client;
  window.requests = [];
  client.on('session_request', request => requests.push(request));
  client.on('session_proposal', async ({id, params}) => {
    try {
      if (params.proposer.metadata.url !== location.origin) throw Error('Unexpected storefront');
      const ns = {...params.optionalNamespaces, ...params.requiredNamespaces};
      const xrpl = ns.xrpl || ns['xrpl:1'];
      if (!xrpl?.methods.includes('xrpl_signTransaction') ||
          !(xrpl.chains || Object.keys(ns)).includes('xrpl:1')) throw Error('Unexpected proposal');
      const session = await client.approve({id, namespaces:{xrpl:{chains:['xrpl:1'],
        accounts:['xrpl:1:'+address], methods:['xrpl_signTransaction'], events:[]}}});
      window.approvedTopic = session.topic;
      await session.acknowledged();
    } catch (e) { window.pairError = e.message; }
  });
  await client.core.pairing.pair({uri});
}"""


def fund(address):
    snapshot()
    read_json("https://faucet.altnet.rippletest.net/accounts",
              {"destination": address, "usageContext": "CoolBears WalletConnect Testnet verification"})
    for _ in range(25):
        result = rpc(RPC, "account_info", account=address, ledger_index="validated")
        if result.get("validated") and int(result.get("account_data", {}).get("Balance", 0)) > int(PRICE) + 2000000:
            return
        assert result.get("error") in (None, "actNotFound"), result.get("error")
        time.sleep(2)
    raise TimeoutError("Testnet faucet balance pending")


def handle_request(wallet, request, seen, purchase):
    tx = request["tx_json"]
    assert tx["Account"] == wallet.address
    if not purchase:
        proof = seen["challenge"]["message"]
        assert proof.startswith(f"CoolBears Testnet reservation\nSite {SITE}\nWallet {wallet.address}\nOrder ")
        assert "\nMaximum NFT price 10 test XRP\n" in proof
        assert tx == {"TransactionType": "AccountSet", "Account": wallet.address, "Fee": "0", "Sequence": 0,
                      "LastLedgerSequence": 1, "Memos": [{"Memo": {"MemoData": proof.encode().hex().upper()}}]}
        assert request["submit"] is False and request["autofill"] is False
    else:
        order, quote = seen["mint"], seen["offer"]
        assert order["state"] == "open" and (order["id"], order["token"]) == (quote["id"], quote["token"])
        assert quote["price"] == PRICE and re.fullmatch("[0-9A-F]{64}", quote["id"])
        assert request["submit"] is True and request["autofill"] is True
        assert tx == {"TransactionType": "NFTokenAcceptOffer", "Account": wallet.address,
                      "NFTokenSellOffer": quote["id"], "LastLedgerSequence": quote["validThrough"]}
        ledger = snapshot()
        assert ledger["seq"] < quote["validThrough"]
        offer = get("ledger_entry", index=quote["id"], ledger_hash=ledger["hash"])["node"]
        fields = ("LedgerEntryType", "Flags", "Owner", "Destination", "Amount", "NFTokenID")
        assert tuple(offer[field] for field in fields) == ("NFTokenOffer", 1, ISSUER, wallet.address, PRICE, quote["token"])
        root = get("account_info", account=wallet.address, ledger_hash=ledger["hash"])["account_data"]
        fee = max(12, int(get("fee")["drops"]["open_ledger_fee"]))
        assert fee <= 100
        tx = {**tx, "Fee": str(fee), "Sequence": root["Sequence"]}
    signed = {**tx, "SigningPubKey": wallet.public_key}
    signed["TxnSignature"] = sign(bytes.fromhex(encode_for_signing(signed)), wallet.private_key)
    if purchase:
        blob = encode(signed)
        tx_hash = hashlib.sha512(b"TXN\0" + bytes.fromhex(blob)).hexdigest()[:64].upper()
        print("Testnet purchase", tx_hash, flush=True)
        result = get("submit", tx_blob=blob)
        assert result["engine_result"] in ("tesSUCCESS", "terQUEUED"), result["engine_result"]
        signed["hash"] = tx_hash
    return {"tx_json": signed}


def checkout(browser, wallet):
    buyer = browser.new_context(locale="en-US").new_page()
    peer = browser.new_context(locale="en-US").new_page()
    seen = {}

    def observe(response):
        endpoint = response.url.split("?")[0].removeprefix(SITE + "/xrpl/api/")
        if response.status == 200 and endpoint in ("challenge", "mint", "offer", "receipt"):
            seen[endpoint] = response.json()

    buyer.on("response", observe)
    buyer.goto(SITE + "/#mint", wait_until="domcontentloaded")
    status = buyer.evaluate("async () => (await fetch('/xrpl/api/status')).json()")
    assert (status["network"], status["issuer"], status["open"], status["price"]) == ("Testnet", ISSUER, True, PRICE)
    print("Published Testnet storefront ready", flush=True)
    buyer.locator("#walletBtn").click()
    buyer.locator("#wcWallet").click()
    buyer.locator("#wcOpen").wait_for(state="visible", timeout=55000)
    uri = parse_qs(urlparse(buyer.locator("#wcOpen").get_attribute("href")).query)["uri"][0]
    assert uri.startswith("wc:") and buyer.locator("#wcQR").get_attribute("src").startswith("data:image/png")
    print("Received WalletConnect pairing QR", flush=True)
    peer_url = SITE + "/__test_wallet__"
    peer.route(peer_url, lambda route: route.fulfill(content_type="text/html", body="<title>Testnet peer</title>"))
    peer.goto(peer_url)
    peer.evaluate(START_PEER, {"projectId": status["walletConnectProjectId"], "address": wallet.address, "uri": uri})
    peer.wait_for_function("window.approvedTopic || window.pairError", timeout=45000)
    assert not peer.evaluate("window.pairError"), "Peer could not approve the storefront proposal"
    expect(buyer.locator("#walletBtn")).to_contain_text(wallet.address[:6], timeout=45000)
    print("Testnet wallet paired", wallet.address, flush=True)
    fund(wallet.address)
    buyer.locator("#buy").click()
    payment = None
    for purchase in (False, True):
        try:
            peer.wait_for_function("requests.length > 0", timeout=100000)
        except Exception as exc:
            raise RuntimeError(f"Signature request missing. Received endpoints {list(seen)}. "
                               f"Storefront: {buyer.locator('#message').inner_text()}") from exc
        req = peer.evaluate("requests.shift()")
        assert req["topic"] == peer.evaluate("approvedTopic")
        assert req["params"]["chainId"] == CHAIN and req["params"]["request"]["method"] == METHOD
        response = handle_request(wallet, req["params"]["request"]["params"], seen, purchase)
        if purchase:
            payment = response["tx_json"]["hash"]
        peer.evaluate("""async ({topic, id, result}) => await peer.respond({
            topic, response:{id, jsonrpc:'2.0', result}})""", {"topic": req["topic"], "id": req["id"], "result": response})
        print("WalletConnect accepted", "purchase" if purchase else "reservation proof", flush=True)
    confirm_in_storefront(buyer, payment)
    receipt = seen["receipt"]
    assert receipt["state"] == "complete" and receipt["hash"] == payment
    assert peer.evaluate("requests.length") == 0
    settlement = verify(seen["mint"]["mint"], payment)
    assert settlement["buyer"] == wallet.address and settlement["token"] == receipt["token"]
    return {**settlement, "offer": seen["offer"]["id"], "client": "Independent WalletConnect SignClient",
            "network": "XRPL Testnet", "site": SITE}


def confirm_in_storefront(page, payment):
    link = page.locator("#receipt")
    expected = "https://testnet.xrpl.org/transactions/" + payment
    expect(link).to_have_attribute("href", expected, timeout=100000)
    assert link.is_visible()



def check_saved_receipt(browser, record):
    sale = json.loads(record.read_text())
    settlement = verify(sale["mint"], sale["payment"])
    assert all(sale[key] == value for key, value in settlement.items())
    tx = get("tx", transaction=sale["payment"])["tx_json"]
    assert tx["NFTokenSellOffer"] == sale["offer"]
    pending = {"network": "Testnet", "buyer": sale["buyer"], "offer": sale["offer"],
               "hash": sale["payment"], "last": tx["LastLedgerSequence"]}
    page = browser.new_context(locale="en-US").new_page()
    # Restore exactly the public transaction pointer saved by the checkout before its first receipt check.
    page.add_init_script("localStorage.setItem('coolbears.xrpl.pending.Testnet', " +
                         json.dumps(json.dumps(pending)) + ")")
    # Interrupt the first read after reopening the tab. The site must recover without a second click.
    interrupted = []
    def interrupt_first(route):
        interrupted.append(True)
        route.fulfill(status=503, json={"error": "Temporarily unavailable"})
    page.route("**/xrpl/api/receipt?*", interrupt_first, times=1)
    writes = []
    page.on("request", lambda req: writes.append(req.url)
            if req.method == "POST" and "/xrpl/api/" in req.url else None)
    with page.expect_response(lambda r: r.url.startswith(SITE + "/xrpl/api/receipt?") and r.status == 200,
                              timeout=75000) as response:
        page.goto(SITE + "/#mint", wait_until="domcontentloaded")
        confirm_in_storefront(page, sale["payment"])
    assert interrupted == [True] and not writes
    receipt = response.value.json()
    assert (receipt["state"], receipt["hash"], receipt["token"]) == ("complete", sale["payment"], sale["token"])
    assert page.evaluate("JSON.parse(localStorage.getItem('coolbears.xrpl.pending.Testnet'))") is None
    return settlement


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path, help="Reopen an existing Testnet receipt without making a purchase")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_BIN"))
        try:
            result = check_saved_receipt(browser, args.receipt) if args.receipt else checkout(browser, Wallet.create())
            print(json.dumps(result, indent=2), flush=True)
        finally:
            browser.close()
