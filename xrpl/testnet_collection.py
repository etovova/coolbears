"""Collection-sized Testnet storefront using the existing disposable issuer and canonical metadata."""
import os
import fcntl
import json
import re
import sys
import uuid

from xrpl.core.addresscodec import is_valid_classic_address
from xrpl.core.keypairs import derive_classic_address, is_valid_message

import inventory as inv
from first_mint import rpc, successful
from testnet_mint import ISSUER, PRICE, RPC, get, private_state, snapshot, validated_transaction
from testnet_reservations import BUYERS, CANCEL, LIST, MINT, check_effect, build_draft, sign_draft, read_offer, snapshot_read

PREVIOUS = 3  # Previously confirmed slots 0000, 0001 and 0002 on this isolated issuer.
LEASE = 600
ORIGIN = "http://127.0.0.1:18840"


def uri(n):
    return f"https://coolbears-nfts.com/xrpl/metadata/{n:04}.json".encode().hex().upper()


def ledger_time(ledger):
    return snapshot_read("ledger", ledger["hash"], transactions=False)["ledger"]["close_time"]


def authenticate(data):
    buyer = data["buyer"]
    key = data["request"]
    allowed = buyer in BUYERS or (os.getenv("CB_PILOT_OPEN_BUYERS") == "yes" and is_valid_classic_address(buyer))
    if not allowed or buyer == ISSUER or key != str(uuid.UUID(key)) or uuid.UUID(key).version != 4:
        raise inv.Conflict("Invalid Testnet request", 403)
    message, pub, sig = data["message"], data["publicKey"], data["signature"]
    # Node verified its expiring challenge MAC and exact origin/buyer/order before invoking this process.
    if (not message.startswith(f"CoolBears Testnet reservation\nSite {ORIGIN}\nWallet {buyer}\nOrder {key}\n") or
        not re.fullmatch(r"(?:ED|02|03)[0-9A-Fa-f]{64}", pub, re.IGNORECASE) or
        not re.fullmatch(r"[0-9A-Fa-f]{100,150}", sig)):
        raise inv.Conflict("Invalid wallet proof", 403)
    try:
        valid = derive_classic_address(pub) == buyer and is_valid_message(message.encode(), bytes.fromhex(sig), pub)
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise inv.Conflict("Wallet signature did not verify", 403)


def persist_result(db, record, tx):
    draft = json.loads(record["draft"])
    if tx["hash"] != record["hash"] or any(tx["tx_json"].get(k) != v for k, v in draft.items()):
        raise ValueError("Unexpected transaction in validated ledger")
    event = check_effect(tx["meta"], draft)
    key, ledger = record["request"], tx["ledger_index"]
    if draft["TransactionType"] == CANCEL:
        inv.close_order(db, key, "expired")
    else:
        row = inv.order(db, key)
        mint = row["mint"] if draft["TransactionType"] == LIST else tx["hash"]
        inv.offered(db, key, event["token"], mint, event["id"], ledger, draft["Expiration"])
    db.execute("UPDATE signed SET result='tesSUCCESS',ledger=? WHERE hash=?", (ledger, tx["hash"]))


def reconcile_signed(db):
    pending = db.execute("SELECT * FROM signed WHERE result IS NULL").fetchone()
    if not pending:
        return
    draft = json.loads(pending["draft"])
    deadline = draft["LastLedgerSequence"]
    tx = rpc(RPC, "tx", transaction=pending["hash"])
    if not tx.get("validated"):
        if tx.get("error") not in (None, "txnNotFound"):
            successful(tx)
        l = snapshot()
        if l["seq"] > deadline and tx.get("error") == "txnNotFound":
            history = rpc(RPC, "tx", transaction=pending["hash"], min_ledger=pending["first_ledger"],
                          max_ledger=deadline)
            if history.get("validated"):
                tx = history
            else:
                if history.get("error") != "txnNotFound" or history.get("searched_all") is not True:
                    raise inv.Conflict("Waiting for complete ledger history before retrying.")
                root = snapshot_read("account_info", l["hash"], account=ISSUER)["account_data"]
                if root["Sequence"] != draft["Sequence"]:
                    raise inv.Conflict("Issuer sequence changed. Operator reconciliation required.")
                db.execute("UPDATE signed SET result='notApplied' WHERE hash=?", (pending["hash"],))
                return
        else:
            tx = validated_transaction(pending["hash"], pending["blob"], deadline)
    if tx.get("hash") != pending["hash"]:
        raise ValueError("Transaction hash mismatch")
    code = tx["meta"]["TransactionResult"]
    if code != "tesSUCCESS":
        db.execute("UPDATE signed SET ledger=?,result=? WHERE hash=?", (tx["ledger_index"], code, pending["hash"]))
        raise inv.Conflict("Issuer transaction failed. Retry to reconcile the order.")
    inv.atomic(db, persist_result, pending, tx)


def save_signature(db, staged, signed):
    tx_hash, blob, draft = signed
    db.execute("INSERT INTO signed(hash,blob,draft,request,first_ledger) VALUES(?,?,?,?,?)",
               (tx_hash, blob, draft, staged["request"], staged["first_ledger"]))
    db.execute("DELETE FROM signing_draft WHERE singleton=1")


def resume_draft(db, seed):
    staged = db.execute("SELECT * FROM signing_draft WHERE singleton=1").fetchone()
    if not staged:
        return
    draft = json.loads(staged["draft"])
    l = snapshot()
    if l["seq"] > draft["LastLedgerSequence"]:
        # A draft in this table was never submitted by this service. Still require the original account sequence.
        root = snapshot_read("account_info", l["hash"], account=ISSUER)["account_data"]
        if root["Sequence"] != draft["Sequence"]:
            raise inv.Conflict("Issuer sequence changed while awaiting signature.")
        db.execute("DELETE FROM signing_draft WHERE singleton=1")
        return
    inv.atomic(db, save_signature, staged, sign_draft(seed, draft))


def issue(db, seed, ledger, row, fields):
    minted = db.execute("SELECT COUNT(*) FROM slot WHERE mint IS NOT NULL").fetchone()[0]
    draft = build_draft(ledger, fields, PREVIOUS + minted)
    db.execute("INSERT INTO signing_draft VALUES(1,?,?,?)", (row["id"], json.dumps(draft), ledger["seq"]))
    resume_draft(db, seed)
    reconcile_signed(db)


def verified_removal(row, ledger):
    marker = None
    seen = set()
    while True:
        params = dict(account=ISSUER, ledger_index_min=row["ledger"], ledger_index_max=ledger["seq"], limit=200)
        if marker is not None:
            params["marker"] = marker
        page = get("account_tx", **params)
        if not page.get("validated") or page["ledger_index_min"] > row["ledger"] or page["ledger_index_max"] < ledger["seq"]:
            break
        for t in page["transactions"]:
            meta = t["meta"]
            for wrapper in meta.get("AffectedNodes", []):
                n = wrapper.get("DeletedNode", {})
                if n.get("LedgerIndex") != row["offer"] or n.get("LedgerEntryType") != "NFTokenOffer":
                    continue
                match_offer(n["FinalFields"], row)
                body = t["tx_json"]
                if meta["TransactionResult"] == "tesSUCCESS" and body["TransactionType"] == CANCEL:
                    return "expired", None
                if meta["TransactionResult"] == "tecEXPIRED" and body["TransactionType"] == "NFTokenAcceptOffer":
                    return "expired", None
                if (meta["TransactionResult"] == "tesSUCCESS" and body["TransactionType"] == "NFTokenAcceptOffer"
                    and body["Account"] == row["buyer"] and body.get("NFTokenSellOffer") == row["offer"]
                    and not body.get("NFTokenBuyOffer") and not body.get("NFTokenBrokerFee")):
                    return "sold", t["hash"]
                raise inv.Conflict("Offer removal requires review.")
        marker = page.get("marker")
        if not marker or json.dumps(marker, sort_keys=True) in seen:
            break
        seen.add(json.dumps(marker, sort_keys=True))
    raise inv.Conflict("Waiting for validated offer history.")


def match_offer(fields, row):
    if (fields["Owner"], fields["Destination"], fields["Amount"], fields["NFTokenID"], fields["Flags"],
        fields["Expiration"]) != (ISSUER, row["buyer"], PRICE, row["token"], 1, row["expires"]):
        raise ValueError("Unexpected ledger offer")


def refresh(db, seed, row, ledger, close):
    if row["phase"] == "held" and row["expires"] <= close:
        inv.atomic(db, inv.close_order, row["id"], "expired")
    if row["phase"] != "open":
        return
    if ledger["seq"] < row["ledger"]:
        raise inv.Conflict("Ledger is catching up.")
    node = read_offer(ledger["hash"], row["offer"])
    if node is None:
        phase, payment = verified_removal(row, ledger)
        inv.atomic(db, inv.close_order, row["id"], phase, payment)
    else:
        match_offer(node, row)
        if close >= row["expires"]:
            issue(db, seed, ledger, row, {"TransactionType": CANCEL, "NFTokenOffers": [row["offer"]]})


def reserve(db, seed, data):
    resume_draft(db, seed)
    reconcile_signed(db)
    ledger = snapshot()
    close = ledger_time(ledger)
    buyer, key = data["buyer"], data["request"]
    account = snapshot_read("account_info", ledger["hash"], account=buyer)["account_data"]
    if account["Account"] != buyer or account["Flags"] & 0x00100000:
        raise inv.Conflict("This pilot requires an enabled master key.", 403)
    prior = inv.order(db, key)
    if prior and prior["buyer"] != buyer:
        raise inv.Conflict("Order belongs to a different wallet.", 403)
    # Recover the buyer's previous order before issuing a new one, including a lost payment response.
    active = db.execute("SELECT id FROM orders WHERE buyer=? AND phase IN ('open','held')", (buyer,)).fetchone()
    if active:
        refresh(db, seed, inv.order(db, active[0]), ledger, close)
    if not prior and not active:
        due = db.execute("SELECT id FROM orders WHERE phase IN ('open','held') AND expires<=? ORDER BY expires LIMIT 1",
                         (close,)).fetchone()
        if due:
            refresh(db, seed, inv.order(db, due[0]), ledger, close)
    row = inv.claim(db, buyer, key, close)
    if row["phase"] == "sold":
        return {"state":"sold","id":row["offer"],"token":row["token"],"hash":row["payment"],"slot":row["n"]}
    if row["phase"] == "expired":
        return {"state":"expired","error":"Reservation expired. Request a new mint.","status":410}
    if row["phase"] == "held":
        ledger = snapshot()
        fields = {"Amount": PRICE, "Destination": buyer, "Expiration": ledger_time(ledger) + LEASE}
        if row["token"]:
            fields.update(TransactionType=LIST, Flags=1, NFTokenID=row["token"])
        else:
            fields.update(TransactionType=MINT, Flags=8, TransferFee=7000, NFTokenTaxon=20270201, URI=uri(row["n"]))
        issue(db, seed, ledger, row, fields)
        row = inv.order(db, key)
        if row["phase"] != "open":
            raise inv.Conflict("Retry to resume the order.")
    if row["expires"] <= close + 60:
        raise inv.Conflict("Offer is near expiry. Retry after the deadline.")
    return {"state":"open","id":row["offer"],"token":row["token"],"mint":row["mint"],"slot":row["n"]}


def record_receipt(db, receipt):
    """The loopback Worker has checked the validated transaction, amount, issuer, buyer and exact offer."""
    row = db.execute("SELECT o.id,o.buyer,s.token FROM orders o JOIN slot s USING(n) WHERE o.offer=?",
                     (receipt["offer"],)).fetchone()
    if row:
        if (receipt["buyer"], receipt["token"]) != (row["buyer"], row["token"]) or not re.fullmatch("[A-F0-9]{64}", receipt["hash"]):
            raise ValueError("Receipt does not identify the recorded order")
        inv.close_order(db, row["id"], "sold", receipt["hash"])


def main():
    data = json.load(sys.stdin)
    if sys.argv[1:] == ["record-receipt"]:
        state = private_state()
        if (state / "collection.sqlite").exists():
            db = inv.connect(state / "collection.sqlite")
            try:
                inv.atomic(db, record_receipt, data)
            finally:
                db.close()
        print("{}")
        return
    try:
        authenticate(data)
        from testnet_signer import request_signature
        if not os.environ.get("CB_SIGNER_INBOX"):
            raise inv.Conflict("Testnet issuer agent is not configured.",503)
        state, seed = private_state(), request_signature
        with (state / "collection.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            db = inv.connect(state / "collection.sqlite")
            try:
                inv.initialize(db, PREVIOUS)
                result = reserve(db, seed, data)
            finally:
                db.close()
    except inv.Conflict as e:
        result = {"error": str(e), "status": e.status}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
