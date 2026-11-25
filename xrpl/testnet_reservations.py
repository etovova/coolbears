"""Buyer-bound, expiring reservations for the loopback Testnet storefront."""
import fcntl
import json
import sqlite3
import sys

from xrpl.core.binarycodec import encode
from xrpl.models.transactions import Transaction
from xrpl.transaction import sign
from xrpl.wallet import Wallet

from first_mint import rpc, successful
from testnet_mint import BUYER, ISSUER, PRICE, RPC, directed_offer, get, private_paths, snapshot, validated_transaction

BUYERS = (BUYER, "rDT2EnyrhJ6hPQfAGnMLfbnqTxeENhB4zr")
SLOT = 2
URI = f"https://coolbears-nfts.com/xrpl/metadata/{SLOT:04d}.json".encode().hex().upper()
LEASE_SECONDS = 180
MAX_OFFERS = 6
MINT = "NFTokenMint"
LIST = "NFTokenCreateOffer"
CANCEL = "NFTokenCancelOffer"


def snapshot_read(method, ledger_hash, **params):
    answer = get(method, ledger_hash=ledger_hash, **params)
    if not answer.get("validated") or answer.get("ledger_hash") != ledger_hash:
        raise ValueError("Unconfirmed ledger response")
    return answer


def holds_token(ledger_hash, token):
    data = snapshot_read("account_nfts", ledger_hash, account=ISSUER, limit=400)
    if data.get("marker"):
        raise ValueError("Unexpected inventory size for the isolated Testnet issuer")
    for item in data["account_nfts"]:
        if item["NFTokenID"] == token:
            if (item["Issuer"], item["NFTokenTaxon"], item["URI"].upper(), item["Flags"], item["TransferFee"]) != (
                ISSUER, 20270201, URI, 8, 7000
            ):
                raise ValueError("Unexpected NFT properties")
            return True
    return False


def read_offer(ledger_hash, offer_id):
    result = rpc(RPC, "ledger_entry", ledger_hash=ledger_hash, index=offer_id)
    if result.get("error") == "entryNotFound":
        if result.get("ledger_hash", ledger_hash) != ledger_hash:
            raise ValueError("Unexpected ledger for missing offer")
        return None
    successful(result)
    if not result.get("validated") or result["ledger_hash"] != ledger_hash:
        raise ValueError("Unconfirmed offer")
    return result["node"]


def removal_type(row, ledger):
    """Distinguish a confirmed cancellation from a sale followed by a transfer back."""
    start, end = row["ledger"], ledger["seq"]
    params = {"account": ISSUER, "ledger_index_min": start, "ledger_index_max": end, "limit": 200}
    for _ in range(5):
        page = get("account_tx", **params)
        if not page.get("validated") or page["ledger_index_min"] > start or page["ledger_index_max"] < end:
            break
        for tx in page["transactions"]:
            meta = tx.get("meta", {})
            if not any(n.get("DeletedNode", {}).get("LedgerIndex") == row["offer"]
                       for n in meta.get("AffectedNodes", [])):
                continue
            kind = tx["tx_json"]["TransactionType"]
            if meta["TransactionResult"] == "tesSUCCESS":
                return kind
            if meta["TransactionResult"] == "tecEXPIRED" and kind == "NFTokenAcceptOffer":
                return CANCEL
            return None
        if not page.get("marker"):
            break
        params["marker"] = page["marker"]
    return None


def check_effect(meta, draft):
    if draft["TransactionType"] == CANCEL:
        deleted = [n["DeletedNode"]["LedgerIndex"] for n in meta["AffectedNodes"]
                   if n.get("DeletedNode", {}).get("LedgerEntryType") == "NFTokenOffer"]
        if deleted != draft["NFTokenOffers"]:
            raise ValueError("Cancellation did not remove the expected offer")
        return None
    offer = directed_offer(meta, draft["Destination"])
    fields = next(n["CreatedNode"]["NewFields"] for n in meta["AffectedNodes"]
                  if n.get("CreatedNode", {}).get("LedgerEntryType") == "NFTokenOffer")
    if fields["Expiration"] != draft["Expiration"] or (draft.get("NFTokenID", offer["token"]) != offer["token"]):
        raise ValueError("Unexpected token or reservation deadline")
    return offer


def stage(db, seed, ledger, fields):
    root = snapshot_read("account_info", ledger["hash"], account=ISSUER)["account_data"]
    expected = SLOT if fields["TransactionType"] == MINT else SLOT + 1
    if root["Account"] != ISSUER or root.get("MintedNFTokens") != expected:
        raise ValueError("Unexpected Testnet issuer mint count")
    fee = int(get("fee")["drops"]["open_ledger_fee"])
    if not 0 < fee <= 100:
        raise ValueError("Testnet fee outside pilot limits")
    wallet = Wallet.from_seed(seed.read_text().strip())
    if wallet.address != ISSUER:
        raise ValueError("Wrong Testnet issuer")
    draft = {**fields, "Account": ISSUER, "Sequence": root["Sequence"], "Fee": str(fee),
             "LastLedgerSequence": ledger["seq"] + 35}
    sim = get("simulate", tx_json=draft)
    if sim.get("applied") is not False or sim.get("engine_result") != "tesSUCCESS":
        raise ValueError("Unexpected simulation result")
    check_effect(sim["meta"], draft)
    tx = sign(Transaction.from_xrpl(draft), wallet)
    db.execute("INSERT INTO action(hash,blob,draft) VALUES(?,?,?)",
               (tx.get_hash(), encode(tx.to_xrpl()), json.dumps(draft)))
    db.commit()


def finish(db, row):
    draft = json.loads(row["draft"])
    tx = validated_transaction(row["hash"], row["blob"], draft["LastLedgerSequence"])
    if any(tx["tx_json"].get(k) != v for k, v in draft.items()):
        raise ValueError("Validated transaction differs from the journal")
    offer = check_effect(tx["meta"], draft)
    db.execute("UPDATE action SET ledger=?,offer=?,token=? WHERE hash=?",
               (tx["ledger_index"], offer["id"] if offer else None, offer["token"] if offer else None, row["hash"]))
    db.commit()


def reserve(db, seed, buyer):
    while True:
        last = db.execute("SELECT * FROM action ORDER BY rowid DESC LIMIT 1").fetchone()
        if last and not last["ledger"]:
            finish(db, last)
            continue
        ledger = snapshot()
        if last and ledger["seq"] < last["ledger"]:
            raise ValueError("Validated snapshot lags the journal")
        founded = db.execute("SELECT token FROM action ORDER BY rowid LIMIT 1").fetchone()
        token = founded["token"] if founded else None
        if token and not holds_token(ledger["hash"], token):
            return {"error": "This test NFT is no longer in the issuer wallet.", "status": 410}
        close = snapshot_read("ledger", ledger["hash"], transactions=False)["ledger"]["close_time"]
        if last and last["offer"]:
            draft = json.loads(last["draft"])
            node = read_offer(ledger["hash"], last["offer"])
            if node is None:
                removed_by = removal_type(last, ledger)
                if removed_by == "NFTokenAcceptOffer":
                    return {"error": "This test NFT has already sold.", "status": 410}
                if removed_by != CANCEL:
                    return {"error": "Offer history could not be confirmed. Retry after reconciliation.", "status": 409}
            else:
                if (node["LedgerEntryType"], node["Owner"], node["Flags"], node["Destination"], node["Amount"],
                    node["NFTokenID"], node["Expiration"]) != (
                        "NFTokenOffer", ISSUER, 1, draft["Destination"], PRICE, token, draft["Expiration"]):
                    raise ValueError("Offer differs from the journal")
                if close < node["Expiration"]:
                    if buyer != node["Destination"] or node["Expiration"] <= close + 60:
                        return {"error": "This NFT is reserved. Try again after expiry.", "status": 409,
                                "expires": node["Expiration"]}
                    return {"id": last["offer"], "token": token, "expires": node["Expiration"]}
                stage(db, seed, ledger, {"TransactionType": CANCEL, "NFTokenOffers": [last["offer"]]})
                continue
        count = db.execute("SELECT COUNT(*) FROM action WHERE offer IS NOT NULL").fetchone()[0]
        if count >= MAX_OFFERS:
            return {"error": "Test reservation limit reached.", "status": 409}
        fields = {"Amount": PRICE, "Destination": buyer, "Expiration": close + LEASE_SECONDS}
        if token:
            fields.update(TransactionType=LIST, Flags=1, NFTokenID=token)
        else:
            fields.update(TransactionType=MINT, Flags=8, NFTokenTaxon=20270201, URI=URI, TransferFee=7000)
        stage(db, seed, ledger, fields)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in BUYERS:
        sys.exit("Unknown Testnet buyer")
    state, seed = private_paths()
    # Serialize decisions across processes. A restart releases the lock and resumes the signed journal.
    with (state / "reservations.lock").open("a") as lock, sqlite3.connect(state / "reservations.sqlite") as db:
        fcntl.flock(lock, fcntl.LOCK_EX)
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE IF NOT EXISTS action(hash TEXT PRIMARY KEY,blob TEXT NOT NULL,"
                   "draft TEXT NOT NULL,ledger INTEGER,offer TEXT,token TEXT)")
        print(json.dumps(reserve(db, seed, sys.argv[1])))


if __name__ == "__main__":
    main()
