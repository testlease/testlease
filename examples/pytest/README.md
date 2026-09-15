# pytest example (framework independence)

The lease protocol is three HTTP calls, so any language can use it. `testlease_client.py` is a
~100-line client using only the Python standard library; `conftest.py` turns it into a
session-scoped `buyer` fixture: one exclusive premium-buyer account per pytest process (or per
pytest-xdist worker), heartbeated in a daemon thread, released at the end.

```bash
# terminal 1: server with the demo pool
export BUYER_01_PASSWORD=x BUYER_02_PASSWORD=y BUYER_03_PASSWORD=z
testlease serve --config ../playwright/testlease.yml

# terminal 2
pip install pytest
TESTLEASE_URL=http://127.0.0.1:4747 python -m pytest -q
```

CI runs exactly this against a server started by the CLI. With pytest-xdist
(`pytest -n 8`) eight workers share the three accounts and wait their turn, like the Playwright
demo.
