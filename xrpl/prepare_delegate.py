"""Print an unsigned Mainnet DelegateSet for the collection owner's review."""
import argparse
import json
from pathlib import Path

from xrpl.core.addresscodec import is_valid_classic_address


def prepare(action, delegate):
    domain = json.loads((Path(__file__).with_name("launch") / "set-domain.json").read_text())
    issuer = domain["Account"]
    if not is_valid_classic_address(delegate) or delegate == issuer:
        raise ValueError("Use the separate signing account's public XRPL address.")
    if action not in ("authorize", "revoke"):
        raise ValueError("Choose authorize or revoke.")
    types = ("NFTokenMint", "NFTokenCreateOffer") if action == "authorize" else ()
    return {
        "TransactionType": "DelegateSet",
        "Account": issuer,
        "Authorize": delegate,
        "Permissions": [{"Permission": {"PermissionValue": name}} for name in types],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("authorize", "revoke"))
    parser.add_argument("delegate", help="public address of the Mainnet operational signer")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.action, args.delegate), indent=2))
    except ValueError as error:
        parser.error(str(error))
