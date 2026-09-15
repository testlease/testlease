"""Minimal TestLease client for Python test suites, standard library only.

Shows that the lease protocol is three HTTP calls: acquire, renew (heartbeat), release.
"""
from __future__ import annotations

import json
import os
import socket
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional


class TestLeaseError(Exception):
    def __init__(self, code: str, message: str, details: Optional[dict] = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.details = details or {}


@dataclass
class Lease:
    client: "TestLeaseClient"
    view: dict
    _timer: Optional[threading.Timer] = field(default=None, repr=False)

    @property
    def lease_id(self) -> str:
        return self.view["leaseId"]

    @property
    def resource_id(self) -> str:
        return self.view["resourceId"]

    @property
    def metadata(self) -> dict:
        return self.view["resource"]["metadata"]

    @property
    def tags(self) -> dict:
        return self.view["resource"]["tags"]

    def start_heartbeat(self) -> None:
        interval = max(1.0, min(self.view["ttlMs"] / 3000.0, 60.0))

        def tick() -> None:
            try:
                self.view = self.client.renew(self.lease_id)["lease"]
            except TestLeaseError as err:
                if err.code in ("LEASE_EXPIRED", "LEASE_NOT_ACTIVE", "LEASE_NOT_FOUND"):
                    return  # lease is gone; stop
            self._timer = threading.Timer(interval, tick)
            self._timer.daemon = True
            self._timer.start()

        self._timer = threading.Timer(interval, tick)
        self._timer.daemon = True
        self._timer.start()

    def stop_heartbeat(self) -> None:
        if self._timer:
            self._timer.cancel()
            self._timer = None

    def secrets(self) -> dict:
        return self.client.resolve_secrets(self.lease_id)["secrets"]

    def release(self) -> dict:
        self.stop_heartbeat()
        return self.client.release(self.lease_id)

    def quarantine(self, reason: str) -> dict:
        self.stop_heartbeat()
        return self.client.quarantine(self.lease_id, reason)


class TestLeaseClient:
    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None, owner: Optional[str] = None):
        self.base_url = (base_url or os.environ.get("TESTLEASE_URL", "http://127.0.0.1:4747")).rstrip("/")
        self.token = token or os.environ.get("TESTLEASE_TOKEN")
        # A stable logical owner: pytest-xdist worker id when present, else the process id.
        worker = os.environ.get("PYTEST_XDIST_WORKER", f"pid-{os.getpid()}")
        self.owner = owner or os.environ.get("TESTLEASE_OWNER") or f"pytest/{socket.gethostname()}/{worker}"

    def _request(self, method: str, path: str, body: Any = None, timeout: float = 15.0) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("accept", "application/json")
        if data is not None:
            req.add_header("content-type", "application/json")
        if self.token:
            req.add_header("authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read() or b"null")
        except urllib.error.HTTPError as err:
            try:
                payload = json.loads(err.read())["error"]
            except Exception:  # noqa: BLE001
                raise TestLeaseError("INTERNAL_ERROR", f"HTTP {err.code}") from err
            raise TestLeaseError(payload["code"], payload["message"], payload.get("details")) from None

    def acquire(self, pool: str, tags: Optional[dict] = None, wait_seconds: float = 60, ttl_seconds: Optional[int] = None, purpose: Optional[str] = None) -> Lease:
        body = {"pool": pool, "owner": self.owner, "tags": tags or {}, "waitTimeoutMs": int(wait_seconds * 1000), "clientRequestId": f"{self.owner}#{pool}"}
        if ttl_seconds:
            body["ttlMs"] = ttl_seconds * 1000
        if purpose:
            body["purpose"] = purpose
        res = self._request("POST", "/v1/leases/acquire", body, timeout=wait_seconds + 15)
        lease = Lease(self, res["lease"])
        lease.start_heartbeat()
        return lease

    def renew(self, lease_id: str) -> dict:
        return self._request("POST", f"/v1/leases/{lease_id}/renew", {"owner": self.owner})

    def release(self, lease_id: str) -> dict:
        return self._request("POST", f"/v1/leases/{lease_id}/release", {"owner": self.owner})

    def quarantine(self, lease_id: str, reason: str) -> dict:
        return self._request("POST", f"/v1/leases/{lease_id}/quarantine", {"owner": self.owner, "reason": reason})

    def resolve_secrets(self, lease_id: str) -> dict:
        return self._request("POST", f"/v1/leases/{lease_id}/secrets", {"owner": self.owner})

    def pool(self, name: str) -> dict:
        return self._request("GET", f"/v1/pools/{name}")
