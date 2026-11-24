"""이미지 빌드 때 한 번: fp32 ONNX → int8 동적 양자화 + 합성 문장으로 품질 확인."""

import sys

from onnxruntime.quantization import QuantType, quantize_dynamic
from server import Embedder

SAMPLES = [
    "완료 보고를 올리기 직전에 CI 결과를 먼저 확인한다",
    "the server falls back to word search when embeddings are slow",
    "git push 전에 브랜치 이름과 head 를 대조한다 " * 10,
]
MIN_COSINE = 0.93


def main(src, dst):
    quantize_dynamic(
        f"{src}/model.onnx", f"{dst}/model.onnx", weight_type=QuantType.QInt8
    )
    full = Embedder(src)
    want = [full.embed([s])[0] for s in SAMPLES]
    del full
    small = Embedder(dst)
    worst = min(float(small.embed([s])[0] @ w) for s, w in zip(SAMPLES, want))
    print(f"int8 vs fp32 worst cosine {worst:.4f}", flush=True)
    if worst < MIN_COSINE:
        sys.exit("int8 model drifted too far from fp32")


main(sys.argv[1], sys.argv[2])
