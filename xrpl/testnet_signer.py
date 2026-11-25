"""Local Testnet signing agent. The storefront receives only signatures on approved NFT operations."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import hashlib
import tempfile
import time
import sqlite3

from xrpl.core.addresscodec import is_valid_classic_address
from xrpl.core.binarycodec import encode_for_signing
from xrpl.core.keypairs import derive_classic_address, is_valid_message
from xrpl.models.transactions import Transaction
from xrpl.transaction import sign
from xrpl.wallet import Wallet

from first_mint import rpc
from testnet_mint import ISSUER, PRICE, RPC, snapshot
from testnet_reservations import BUYERS, CANCEL, LIST, MINT, read_offer, snapshot_read

BASE = {"Account","TransactionType","Sequence","LastLedgerSequence","Fee"}
EXTRA = {MINT:{"NFTokenTaxon","TransferFee","Flags","URI","Amount","Destination","Expiration"},
         LIST:{"NFTokenID","Flags","Amount","Destination","Expiration"}, CANCEL:{"NFTokenOffers"}}
METADATA = re.compile(r"https://coolbears-nfts\.com/xrpl/metadata/(\d{4})\.json",re.ASCII)


def read_slot(uri):
    value = METADATA.fullmatch(bytes.fromhex(uri).decode("ascii"))
    if not value:
        raise ValueError("Wrong metadata URL")
    return int(value[1])


def buyer_allowed(buyer, open_buyers):
    return buyer != ISSUER and (buyer in BUYERS or (open_buyers and is_valid_classic_address(buyer)))


def policy(draft, first, last, open_buyers=False):
    kind = draft.get("TransactionType")
    if kind not in EXTRA or draft.keys() != BASE | EXTRA[kind] or draft["Account"] != ISSUER:
        raise ValueError("Unauthorized Testnet operation")
    if draft["Fee"] not in map(str,range(1,101)):
        raise ValueError("Fee exceeds signing policy")
    if kind == CANCEL:
        offers = draft["NFTokenOffers"]
        if not isinstance(offers,list) or len(offers)!=1 or not re.fullmatch("[0-9A-F]{64}",offers[0]):
            raise ValueError("Expected one expired offer")
        return None
    if not buyer_allowed(draft["Destination"],open_buyers) or draft["Amount"] != PRICE:
        raise ValueError("Unapproved buyer or price")
    if kind == LIST:
        if draft["Flags"] != 1 or not re.fullmatch("[0-9A-F]{64}",draft["NFTokenID"]):
            raise ValueError("Invalid sell offer")
        return None
    slot = read_slot(draft["URI"])
    if not first <= slot <= last or (draft["Flags"],draft["TransferFee"],draft["NFTokenTaxon"]) != (8,7000,20270201):
        raise ValueError("NFT outside the authorized allocation")
    return slot


def owned_slot(token, ledger):
    args = dict(account=ISSUER, limit=400)
    seen = set()
    while True:
        page = snapshot_read("account_nfts",ledger["hash"],**args)
        for n in page["account_nfts"]:
            if n["NFTokenID"] == token:
                if (n["Issuer"],n["NFTokenTaxon"],n["Flags"],n["TransferFee"]) != (ISSUER,20270201,8,7000):
                    raise ValueError("NFT does not match the collection")
                return read_slot(n["URI"])
        marker = page.get("marker")
        if not marker or json.dumps(marker,sort_keys=True) in seen:
            raise ValueError("NFT ownership could not be verified")
        args["marker"] = marker
        seen.add(json.dumps(marker,sort_keys=True))


def good_window(draft, ledger, seq):
    if draft["Sequence"] != seq or not ledger["seq"] < draft["LastLedgerSequence"] <= ledger["seq"]+40:
        raise ValueError("Invalid issuer sequence or ledger window")
    close = snapshot_read("ledger",ledger["hash"],transactions=False)["ledger"]["close_time"]
    if draft["TransactionType"] != CANCEL and not close+60 < draft["Expiration"] <= close+605:
        raise ValueError("Invalid expiration")
    return close


def authorize(db, wallet, draft, first, last, open_buyers=False):
    slot = policy(draft,first,last,open_buyers)
    encoded = json.dumps(draft,sort_keys=True)
    saved = db.execute("SELECT * FROM approval WHERE draft=?", (encoded,)).fetchone()
    if saved:
        return json.loads(saved["tx"])
    if db.execute("SELECT COUNT(*) FROM approval").fetchone()[0] >= 12 * (last-first+1):
        raise ValueError("Testnet signing budget exhausted")
    ledger = snapshot()
    account = snapshot_read("account_info",ledger["hash"],account=ISSUER)["account_data"]
    if account["Account"] != ISSUER:
        raise ValueError("Wrong issuer")
    close = good_window(draft,ledger,account["Sequence"])
    kind = draft["TransactionType"]
    if kind == CANCEL:
        o = read_offer(ledger["hash"],draft["NFTokenOffers"][0])
        if (not o or o["Owner"] != ISSUER or not buyer_allowed(o["Destination"],open_buyers) or o["Amount"] != PRICE
            or o["Flags"] != 1 or o["Expiration"] > close or not first <= owned_slot(o["NFTokenID"],ledger) <= last):
            raise ValueError("Expected expired sale from this inventory")
    if kind == LIST and not first <= owned_slot(draft["NFTokenID"],ledger) <= last:
        raise ValueError("Unapproved inventory")
    # A signed response may have been lost. Permit a replacement only on affirmative proof of non-application.
    conflicts = db.execute("SELECT * FROM approval WHERE active=1 AND (seq=? OR slot=?)",(draft["Sequence"],slot)).fetchall()
    for old in conflicts:
        previous = json.loads(old["tx"])
        deadline = previous["LastLedgerSequence"]
        if ledger["seq"] <= deadline:
            raise ValueError("A conflicting signature is still live")
        result = rpc(RPC,"tx",transaction=old["hash"],min_ledger=old["first_ledger"],max_ledger=deadline)
        failed = result.get("validated") and result.get("hash")==old["hash"] and result["meta"]["TransactionResult"]!="tesSUCCESS"
        absent = result.get("error")=="txnNotFound" and result.get("searched_all") is True
        if not (failed or absent):
            raise ValueError("Prior signature may already have applied")
    tx = sign(Transaction.from_xrpl(draft),wallet)
    for old in conflicts:
        db.execute("UPDATE approval SET active=0 WHERE hash=?",(old["hash"],))
    db.execute("INSERT INTO approval VALUES(?,?,?,?,?,?,1)",(encoded,tx.get_hash(),draft["Sequence"],slot,
               ledger["seq"],json.dumps(tx.to_xrpl())))
    db.commit()
    return tx.to_xrpl()


def exchange_path():
    path=Path(os.environ["CB_SIGNER_INBOX"]).resolve(strict=True)
    if not path.is_dir() or path.stat().st_mode & 0o077:
        raise ValueError("A private signing inbox is required")
    return path


def publish(path, data):
    with tempfile.NamedTemporaryFile(mode="wb",dir=path.parent,delete=False) as f:
        tmp=Path(f.name)
        try:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp,path)
    finally:
        tmp.unlink(missing_ok=True)


def request_signature(draft):
    inbox=exchange_path()
    body=json.dumps(draft,sort_keys=True).encode()
    key=hashlib.sha256(body).hexdigest()
    response=inbox/(key+".reply")
    publish(inbox/(key+".request"),body)
    until=time.monotonic()+105
    while not response.exists():
        if time.monotonic()>=until:
            raise TimeoutError("Signing agent did not answer")
        time.sleep(0.15)
    out=json.loads(response.read_bytes())
    if "signed" not in out:
        raise ValueError(out.get("error","Signer unavailable"))
    signed = out["signed"]
    pub, sig = signed["SigningPubKey"], signed["TxnSignature"]
    if ({k:v for k,v in signed.items() if k not in ("SigningPubKey","TxnSignature")} != draft
        or derive_classic_address(pub) != ISSUER or not is_valid_message(bytes.fromhex(encode_for_signing(signed)),
                                                                       bytes.fromhex(sig),pub)):
        raise ValueError("Signature does not authorize the requested transaction")
    return Transaction.from_xrpl(signed)


def serve(args):
    os.umask(0o077)
    state=Path(args.state).resolve(strict=True)
    seed=Path(args.seed).resolve(strict=True)
    inbox=exchange_path()
    if not state.is_dir() or not seed.is_file() or any(p.stat().st_mode & 0o077 for p in (state,seed,inbox)):
        raise ValueError("Private signer directories and seed file are required")
    if not 0 <= args.first <= args.last < 10000:
        raise ValueError("Invalid permitted slot range")
    lock=(state/"agent.lock").open("a")
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    w=Wallet.from_seed(seed.read_text().strip())
    if w.address!=ISSUER:
        raise ValueError("The signer accepts only the disposable Testnet issuer")
    db=sqlite3.connect(state/'signatures.sqlite')
    db.row_factory=sqlite3.Row
    db.execute("CREATE TABLE IF NOT EXISTS settings(first INTEGER,last INTEGER)")
    db.execute("CREATE TABLE IF NOT EXISTS approval(draft TEXT UNIQUE,hash TEXT PRIMARY KEY,seq INTEGER,"
               "slot INTEGER,first_ledger INTEGER,tx TEXT,active INTEGER)")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS live_seq ON approval(seq) WHERE active=1")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS live_slot ON approval(slot) WHERE active=1 AND slot IS NOT NULL")
    if not any(r[1]=="open_buyers" for r in db.execute("PRAGMA table_info(settings)")):
        db.execute("ALTER TABLE settings ADD COLUMN open_buyers INTEGER NOT NULL DEFAULT 0")
    settings=db.execute("SELECT first,last,open_buyers FROM settings").fetchone()
    if settings is None:
        l=snapshot()
        root=snapshot_read("account_info",l["hash"],account=ISSUER)["account_data"]
        if root.get("MintedNFTokens",0)!=args.first:
            raise ValueError("New signing journal requires the verified next unused slot")
        db.execute("INSERT INTO settings VALUES(?,?,?)",(args.first,args.last,int(args.all_test_buyers)))
        db.commit()
    elif tuple(settings)!=(args.first,args.last,int(args.all_test_buyers)):
        raise ValueError("Signing budget differs from the recorded authorization")
    while True:
        for request in inbox.glob("*.request"):
            if not re.fullmatch("[0-9a-f]{64}",request.stem):
                continue
            try:
                with request.open("rb") as f:
                    raw=f.read(4097)
                if len(raw)>4096 or hashlib.sha256(raw).hexdigest()!=request.stem:
                    raise ValueError("Invalid signing request")
                draft=json.loads(raw)
                answer={"signed":authorize(db,w,draft,args.first,args.last,args.all_test_buyers)}
            except OSError:
                db.rollback()
                time.sleep(1)
                continue
            except (TypeError,KeyError,ValueError) as error:
                db.rollback()
                answer={"error":str(error)[:160]}
            publish(request.with_suffix(".reply"),json.dumps(answer).encode())
            request.unlink(missing_ok=True)
        time.sleep(0.15)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    for k in ("state","seed"):
        parser.add_argument("--"+k,required=True)
    for k in ("first","last"):
        parser.add_argument("--"+k,required=True,type=int)
    parser.add_argument("--all-test-buyers",action="store_true")
    serve(parser.parse_args())
