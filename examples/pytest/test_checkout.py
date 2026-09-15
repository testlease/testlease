import json
import os
import time

from testlease_client import TestLeaseClient


def _record(lease, name: str) -> None:
    """Append usage evidence so a runner can prove no two workers shared an account."""
    path = os.environ.get("USAGE_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"test": name, "resourceId": lease.resource_id, "leaseId": lease.lease_id, "owner": lease.client.owner, "at": time.time()}) + "\n")


def test_login_uses_the_leased_account(buyer):
    assert buyer.metadata["email"].endswith("@example.test")
    assert "password" in buyer.view["resource"]["secretKeys"]  # name only; values via secrets()
    _record(buyer, "login")


def test_checkout_holds_the_same_account_for_the_session(buyer):
    pool = TestLeaseClient().pool("premium-buyers")
    mine = [r for r in pool["resources"] if r["id"] == buyer.resource_id][0]
    assert mine["state"] == "LEASED"
    assert mine["activeLease"]["leaseId"] == buyer.lease_id
    _record(buyer, "checkout")
