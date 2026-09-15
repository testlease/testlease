"""A session-scoped exclusive test account for the whole pytest process (one per xdist worker)."""
import pytest

from testlease_client import TestLeaseClient


@pytest.fixture(scope="session")
def buyer():
    client = TestLeaseClient()
    lease = client.acquire("premium-buyers", tags={"tier": "premium"}, wait_seconds=60, purpose="pytest example")
    try:
        yield lease
    finally:
        lease.release()
