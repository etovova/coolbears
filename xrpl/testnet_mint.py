"""Issue at most one buyer-directed NFT for the loopback Testnet pilot."""
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

from xrpl.core.binarycodec import encode
from xrpl.models.transactions import Transaction
from xrpl.transaction import sign
from xrpl.wallet import Wallet

from first_mint import rpc, successful

RPC = "https://s.altnet.rippletest.net:51234/"
ISSUER = "rEoKftiFRwknRDkbV2zURNc6KmhJoBxtaC"
BUYER = "rf2EoyM9uS2HqjS3ouFTzQrNg88LDLrN8a"
PRICE = "10000000"
URI = "https://coolbears-nfts.com/xrpl/metadata/0001.json".encode().hex().upper()


def get(method, **params):
    return successful(rpc(RPC, method, **params))


def snapshot():
    info = get("server_info")["info"]
    ledger = info["validated_ledger"]
    if info["network_id"] != 1 or ledger["age"] > 30:
        raise ValueError("Expected a current XRPL Testnet ledger")
    return ledger


def directed_offer(meta, buyer=BUYER):
    offers = [n["CreatedNode"] for n in meta["AffectedNodes"]
              if n.get("CreatedNode", {}).get("LedgerEntryType") == "NFTokenOffer"]
    if len(offers) != 1:
        raise ValueError("Expected one offer")
    fields = offers[0]["NewFields"]
    if (fields["Owner"], fields["Destination"], fields["Amount"], fields["Flags"]) != (ISSUER, buyer, PRICE, 1):
        raise ValueError("Unexpected sale terms")
    return {"id": offers[0]["LedgerIndex"], "token": fields["NFTokenID"]}


def prepare(db, seed):
    # Lock before any RPC or signing. Persist signed bytes before the first network submission.
    db.execute("BEGIN IMMEDIATE")
    saved = db.execute("SELECT hash, blob, deadline FROM mint WHERE slot=1").fetchone()
    if saved is None:
        ledger = snapshot()
        account = get("account_info", account=ISSUER, ledger_hash=ledger["hash"])
        root = account["account_data"]
        if not account.get("validated") or root["Account"] != ISSUER or root.get("MintedNFTokens", 0) != 1:
            raise ValueError("The issuer must have issued only the pilot predecessor")
        fee = int(get("fee")["drops"]["open_ledger_fee"])
        if not 0 < fee <= 100:
            raise ValueError("Testnet fee outside pilot limit")
        wallet = Wallet.from_seed(seed.read_text().strip())
        if wallet.address != ISSUER:
            raise ValueError("Wrong Testnet issuer")
        deadline = ledger["seq"] + 40
        draft = {"TransactionType": "NFTokenMint", "Account": ISSUER, "Destination": BUYER,
                 "Amount": PRICE, "URI": URI, "TransferFee": 7000, "Flags": 8, "NFTokenTaxon": 20270201,
                 "Fee": str(fee), "Sequence": root["Sequence"], "LastLedgerSequence": deadline}
        sim = get("simulate", tx_json=draft)
        if sim.get("applied") is not False or sim.get("engine_result") != "tesSUCCESS":
            raise ValueError("Testnet mint simulation failed")
        directed_offer(sim["meta"])
        tx = sign(Transaction.from_xrpl(draft), wallet)
        saved = (tx.get_hash(), encode(tx.to_xrpl()), deadline)
        db.execute("INSERT INTO mint(slot,hash,blob,deadline) VALUES(1,?,?,?)", saved)
    db.commit()
    return saved


def validated_transaction(tx_hash, blob, deadline):
    for attempt in range(16):
        tx = rpc(RPC, "tx", transaction=tx_hash)
        if tx.get("validated"):
            if tx.get("hash") != tx_hash or tx["meta"]["TransactionResult"] != "tesSUCCESS":
                raise ValueError("Testnet mint did not succeed")
            return tx
        if tx.get("error") and tx["error"] != "txnNotFound":
            successful(tx)
        if attempt % 4 == 0:
            if snapshot()["seq"] > deadline:
                raise ValueError("Mint window ended. Reconcile the saved hash before proceeding")
            get("submit", tx_blob=blob)
        time.sleep(1)
    raise TimeoutError("Mint awaiting validation. Retry to resume the same transaction")


def private_paths():
    state = Path(os.environ["CB_PILOT_STATE"]).resolve(strict=True)
    seed = Path(os.environ["CB_PILOT_SEED"]).resolve(strict=True)
    if not state.is_dir() or state.stat().st_mode & 0o077 or seed.stat().st_mode & 0o077:
        sys.exit("Pilot state and seed require owner-only permissions")
    os.umask(0o077)
    return state, seed


def issue(db, seed):
    tx = validated_transaction(*prepare(db, seed))
    return {**directed_offer(tx["meta"]), "mint": tx["hash"], "ledger": tx["ledger_index"]}


def main():
    if sys.argv[1:] != [BUYER]:
        sys.exit("Unknown pilot buyer")
    state, seed = private_paths()
    with sqlite3.connect(state / "on-demand.sqlite", timeout=90) as db:
        db.execute("CREATE TABLE IF NOT EXISTS mint(slot INTEGER PRIMARY KEY CHECK(slot=1),"
                   "hash TEXT NOT NULL,blob TEXT NOT NULL,deadline INTEGER NOT NULL)")
        print(json.dumps(issue(db, seed)))


if __name__ == "__main__":
    main()
