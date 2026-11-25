"""Read-only verification of a buyer-directed CoolBears Testnet mint and primary sale."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import re

from testnet_mint import ISSUER, PRICE, directed_offer, get


def verify(mint_hash, payment_hash):
    if not all(re.fullmatch("[A-F0-9]{64}", h) for h in (mint_hash,payment_hash)):
        raise ValueError("Expected two transaction hashes")
    with ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(get,"tx",transaction=mint_hash)
        b=pool.submit(get,"tx",transaction=payment_hash)
        mint,pay=a.result(),b.result()
    for tx,h in ((mint,mint_hash),(pay,payment_hash)):
        if tx["hash"]!=h or not tx.get("validated") or tx["meta"]["TransactionResult"]!="tesSUCCESS":
            raise ValueError("Unconfirmed or unsuccessful transaction")
    source,buy=mint["tx_json"],pay["tx_json"]
    buyer=buy["Account"]
    if (source["TransactionType"],source["Account"],source["NFTokenTaxon"],source["Flags"],source["TransferFee"])!=(
        "NFTokenMint",ISSUER,20270201,8,7000
    ) or source["Amount"]!=PRICE or buy["TransactionType"]!="NFTokenAcceptOffer" or buy.get("NFTokenBuyOffer"):
        raise ValueError("Unexpected collection or checkout terms")
    metadata=bytes.fromhex(source["URI"]).decode("ascii")
    match=re.fullmatch(r"https://coolbears-nfts\.com/xrpl/metadata/([0-9]{4})\.json",metadata)
    if not match:
        raise ValueError("Unexpected metadata address")
    original=directed_offer(mint["meta"],source["Destination"])
    index=buy["NFTokenSellOffer"]
    paid=[a["DeletedNode"]["FinalFields"] for a in pay["meta"]["AffectedNodes"]
          if a.get("DeletedNode",{}).get("LedgerIndex")==index and a["DeletedNode"]["LedgerEntryType"]=="NFTokenOffer"]
    if len(paid)!=1 or (paid[0]["Amount"],paid[0]["Owner"],paid[0]["Destination"],paid[0]["NFTokenID"])!=(
            PRICE,ISSUER,buyer,original["token"]
    ):
        raise ValueError("Purchased offer does not match the minted token")
    changes={}
    for item in pay["meta"]["AffectedNodes"]:
        node=item.get("ModifiedNode",{})
        if node.get("LedgerEntryType")=="AccountRoot":
            fields=node["FinalFields"]
            before=node["PreviousFields"].get("Balance",fields["Balance"])
            changes[fields["Account"]]=int(fields["Balance"])-int(before)
    if changes.get(ISSUER)!=int(PRICE) or changes.get(buyer)!=-int(PRICE)-int(buy["Fee"]):
        raise ValueError("Unexpected settlement balances")
    params=dict(account=buyer,ledger_index=pay["ledger_index"],limit=400)
    seen=set()
    while True:
        page=get("account_nfts",**params)
        if not page.get("validated") or page["ledger_index"]!=pay["ledger_index"]:
            raise ValueError("Wrong ownership snapshot")
        if any(n["NFTokenID"]==original["token"] and n["URI"].upper()==source["URI"].upper() for n in page["account_nfts"]):
            break
        marker=page.get("marker")
        if not marker or json.dumps(marker,sort_keys=True) in seen:
            raise ValueError("Token not found in the buyer wallet at settlement")
        seen.add(json.dumps(marker,sort_keys=True))
        params["marker"]=marker
    return {"slot":match[1],"mint":mint_hash,"payment":payment_hash,"buyer":buyer,"token":original["token"],
            "ledger":pay["ledger_index"],"price_drops":int(PRICE),"buyer_fee_drops":int(buy["Fee"])}


if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("mint")
    p.add_argument("payment")
    args=p.parse_args()
    print(json.dumps(verify(args.mint,args.payment),indent=2))
