"""Read-only preflight for the issuer's first NFT. No wallet credentials required."""
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

MAINNET_RPC = "https://s1.ripple.com:51234/"
TEMPLATE = Path(__file__).with_name("launch") / "first-mint.json"


def rpc(endpoint, method, **params):
    data = json.dumps({"method": method, "params": [{"api_version": 2, **params}]}).encode()
    req = Request(endpoint, data=data, headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=20) as response:
        return json.load(response)["result"]


def successful(result):
    if result.get("status") != "success":
        raise ValueError(result.get("error_message") or result.get("error") or "Ledger RPC unavailable")
    return result


def prepare(template, endpoint=MAINNET_RPC, network_id=0):
    """Return an unsigned transaction only after simulating a mint with no sale."""
    if set(template) != {"TransactionType", "Account", "Flags", "NFTokenTaxon", "TransferFee", "URI"}:
        raise ValueError("Unexpected mint fields")
    if (template["TransactionType"], template["Flags"], template["NFTokenTaxon"], template["TransferFee"]) != (
        "NFTokenMint", 8, 20270201, 7000
    ):
        raise ValueError("Unexpected collection settings")
    info = successful(rpc(endpoint, "server_info"))["info"]
    ledger = info["validated_ledger"]
    if info["network_id"] != network_id or ledger["age"] > 30:
        raise ValueError("Expected a current validated ledger on the selected network")
    account = template["Account"]
    result = rpc(endpoint, "account_info", account=account, ledger_hash=ledger["hash"])
    summary = {"ledger": ledger["seq"], "issuer": account, "base_reserve_xrp": ledger["reserve_base_xrp"],
               "owner_reserve_xrp": ledger["reserve_inc_xrp"]}
    if result.get("error") == "actNotFound":
        return {**summary, "status": "account_not_activated"}
    successful(result)
    root = result["account_data"]
    if not result.get("validated") or result["ledger_hash"] != ledger["hash"] or root["Account"] != account:
        raise ValueError("Inconsistent account snapshot")
    if root.get("MintedNFTokens", 0) > 0:
        return {**summary, "status": "issuer_already_minted", "minted": root["MintedNFTokens"]}
    fee = int(successful(rpc(endpoint, "fee"))["drops"]["open_ledger_fee"])
    if not 0 < fee <= 100:
        return {**summary, "status": "review_network_fee", "fee_drops": fee}
    tx = {**template, "Sequence": root["Sequence"], "LastLedgerSequence": ledger["seq"] + 20, "Fee": str(fee)}
    sim = successful(rpc(endpoint, "simulate", tx_json=tx))
    if sim.get("applied") is not False or sim.get("engine_result") != "tesSUCCESS":
        return {**summary, "status": "simulation_failed", "result": sim.get("engine_result")}
    nodes = [next(iter(wrapper.values())) for wrapper in sim["meta"]["AffectedNodes"]]
    pages = [n for n in nodes if n["LedgerEntryType"] == "NFTokenPage"]
    if not pages or any(n["LedgerEntryType"] == "NFTokenOffer" for n in nodes):
        raise ValueError("Simulation has unexpected NFT or offer changes")
    if not any(t["NFToken"].get("URI") == tx["URI"]
               for page in pages for t in (page.get("NewFields") or page.get("FinalFields") or {}).get("NFTokens", [])):
        raise ValueError("The expected metadata URI is missing from the simulated NFT")
    return {**summary, "status": "ready_for_owner_review", "transaction": tx}


if __name__ == "__main__":
    try:
        report = prepare(json.loads(TEMPLATE.read_text()))
    except (OSError, ValueError, KeyError) as error:
        sys.exit(str(error))
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["status"] == "ready_for_owner_review" else 2)
