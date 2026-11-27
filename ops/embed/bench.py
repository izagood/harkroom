"""임베딩 서비스 지연 측정 — 서버가 도는 호스트에서 돌린다(표준 라이브러리만 쓴다).

    python3 ops/embed/bench.py http://127.0.0.1:8080

합성 글만 보낸다. 질의는 서버 클라이언트와 같이 500자로 자르고 `query: ` 를 붙인다. 500자 p95 가 서버 시한(800ms)을 넘으면 종료 코드 1.
"""

import json
import statistics
import sys
import time
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8080"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "arctic-m-v2"
# 서버 `embed::query_prefix` 와 같아야 한다.
PREFIX = "query: " if MODEL == "arctic-m-v2" else ""
UNIT = "완료 보고를 올리기 전에 `git status` 와 CI 결과를 확인하고 head 를 적는다. "
QUERY_LIMIT_MS = 800


def text(n, seed):
    return (f"{seed} " + UNIT * (n // len(UNIT) + 1))[:n]


def call(inputs):
    body = json.dumps({"model": MODEL, "input": inputs}).encode()
    req = urllib.request.Request(
        f"{BASE}/v1/embeddings", body, {"Content-Type": "application/json"}
    )
    t = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as r:
        got = json.load(r)["data"]
    if len(got) != len(inputs):
        sys.exit("bad response")
    return (time.perf_counter() - t) * 1000


def main():
    call(["warm up"])
    p95_500 = 0.0
    for n in (90, 300, 500, 1000):
        ms = sorted(call([PREFIX + text(n, i)]) for i in range(40))
        p95 = ms[int(len(ms) * 0.95) - 1]
        if n == 500:
            p95_500 = p95
        print(f"query {n:>4} chars  p50 {statistics.median(ms):7.1f}ms  p95 {p95:7.1f}ms")
    total = [[text(600, b * 16 + i) for i in range(16)] for b in range(4)]
    t = time.perf_counter()
    for b in total:
        call(b)
    print(f"batch 16x600 chars  {64 / (time.perf_counter() - t):.1f} chunks/s")
    ok = p95_500 <= QUERY_LIMIT_MS
    print(f"500 chars p95 within {QUERY_LIMIT_MS}ms: {'yes' if ok else 'NO'}")
    sys.exit(0 if ok else 1)


main()
