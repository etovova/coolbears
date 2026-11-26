"""Buy a CoolBears Testnet NFT, then verify a direct resale between two fresh wallets."""
import json
import os
import time

from playwright.sync_api import sync_playwright
from xrpl.core.binarycodec import encode
from xrpl.models.transactions import Transaction
from xrpl.transaction import sign
from xrpl.wallet import Wallet

from walletconnect_checkout import checkout, fund
from testnet_mint import ISSUER, PRICE, RPC, get, rpc, snapshot


def submit(wallet, **fields):
    ledger = snapshot()
    root = get("account_info", account=wallet.address, ledger_hash=ledger["hash"])["account_data"]
    fee = max(12, int(get("fee")["drops"]["open_ledger_fee"]))
    assert fee <= 100 and root["Account"] == wallet.address
    tx = Transaction.from_xrpl({**fields, "Account": wallet.address, "Fee": str(fee),
                                "Sequence": root["Sequence"], "LastLedgerSequence": ledger["seq"] + 40})
    signed = sign(tx, wallet)
    tx_hash = signed.get_hash()
    print(fields["TransactionType"], tx_hash, flush=True)
    result = get("submit", tx_blob=encode(signed.to_xrpl()))
    assert result["engine_result"] in ("tesSUCCESS", "terQUEUED"), result["engine_result"]
    for _ in range(40):
        found = rpc(RPC, "tx", transaction=tx_hash)
        if found.get("validated"):
            assert found["hash"] == tx_hash and found["meta"]["TransactionResult"] == "tesSUCCESS"
            return found
        if found.get("error") not in (None, "txnNotFound"):
            raise ValueError(found["error"])
        time.sleep(2)
    raise TimeoutError("Look up the printed transaction hash for the final Testnet result")


def offer_fields(entry, seller, buyer, token):
    return all(entry.get(key) == value for key, value in
               {"Owner": seller, "Destination": buyer, "Amount": PRICE, "NFTokenID": token, "Flags": 1}.items())


def verify_resale(primary, listing, payment):
    seller, buyer = primary["buyer"], payment["tx_json"]["Account"]
    assert len({seller, buyer, ISSUER}) == 3
    token = primary["token"]
    offer_id = payment["tx_json"]["NFTokenSellOffer"]
    for tx in (listing, payment):
        assert tx["validated"] and tx["meta"]["TransactionResult"] == "tesSUCCESS"
    assert listing["tx_json"]["TransactionType"] == "NFTokenCreateOffer" and listing["tx_json"]["Account"] == seller
    assert payment["tx_json"]["TransactionType"] == "NFTokenAcceptOffer"
    assert (primary["ledger"] <= listing["ledger_index"] <= payment["ledger_index"])
    for tx, kind, fields in ((listing, "CreatedNode", "NewFields"), (payment, "DeletedNode", "FinalFields")):
        offer, = [n[kind] for n in tx["meta"]["AffectedNodes"] if n.get(kind, {}).get("LedgerIndex") == offer_id]
        assert offer["LedgerEntryType"] == "NFTokenOffer" and offer_fields(offer[fields], seller, buyer, token)

    snapshot_hash = get("ledger", ledger_index=payment["ledger_index"])["ledger_hash"]
    owner = get("account_nfts", account=buyer, ledger_hash=snapshot_hash)
    assert owner["validated"] and owner["ledger_hash"] == snapshot_hash
    nft, = [item for item in owner["account_nfts"] if item["NFTokenID"] == token]
    assert (nft["Issuer"], nft["TransferFee"], nft["NFTokenTaxon"]) == (ISSUER, 7000, 20270201)
    changes = {}
    for item in payment["meta"]["AffectedNodes"]:
        node = item.get("ModifiedNode", {})
        if node.get("LedgerEntryType") == "AccountRoot" and "Balance" in node.get("PreviousFields", {}):
            root = node["FinalFields"]
            changes[root["Account"]] = int(root["Balance"]) - int(node["PreviousFields"]["Balance"])
    royalty = int(PRICE) * nft["TransferFee"] // 100000
    network_fee = int(payment["tx_json"]["Fee"])
    assert changes == {ISSUER: royalty, seller: int(PRICE) - royalty, buyer: -int(PRICE) - network_fee}, changes
    return {"network": "XRPL Testnet", "slot": primary["slot"], "token": token, "mint": primary["mint"],
            "primary_purchase": primary["payment"], "sell_offer_transaction": listing["hash"], "offer": offer_id,
            "resale": payment["hash"], "ledger": payment["ledger_index"], "issuer": ISSUER, "seller": seller,
            "buyer": buyer, "price_drops": int(PRICE), "royalty_drops": changes[ISSUER], "seller_proceeds_drops": changes[seller],
            "buyer_fee_drops": network_fee, "listing_fee_drops": int(listing["tx_json"]["Fee"])}


def main():
    seller, buyer = Wallet.create(), Wallet.create()
    assert len({ISSUER, seller.address, buyer.address}) == 3
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_BIN"))
        try:
            primary = checkout(browser, seller)
        finally:
            browser.close()
    assert primary["buyer"] == seller.address
    print("Primary purchase confirmed", primary["payment"], flush=True)
    fund(buyer.address)
    ledger = snapshot()
    close = get("ledger", ledger_hash=ledger["hash"])["ledger"]["close_time"]
    listing = submit(seller, TransactionType="NFTokenCreateOffer", NFTokenID=primary["token"], Flags=1,
                     Amount=PRICE, Destination=buyer.address, Expiration=close + 600)
    offer, = [n["CreatedNode"] for n in listing["meta"]["AffectedNodes"]
              if n.get("CreatedNode", {}).get("LedgerEntryType") == "NFTokenOffer"]
    assert offer_fields(offer["NewFields"], seller.address, buyer.address, primary["token"])
    payment = submit(buyer, TransactionType="NFTokenAcceptOffer", NFTokenSellOffer=offer["LedgerIndex"])
    print(json.dumps(verify_resale(primary, listing, payment), indent=2), flush=True)


if __name__ == "__main__":
    main()
