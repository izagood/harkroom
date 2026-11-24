# harkroom 임베딩 서비스(기억 벡터 검색) — python + onnxruntime + tokenizers 만 담는다.
# 모델은 공개 가중치 BAAI/bge-m3(MIT)의 ONNX 를 **빌드할 때** 받아 체크섬을 보고 int8 로 양자화한다. 실행 중에는 밖으로 나가지 않는다.
# 컨텍스트는 저장소 루트다: docker build -f ops/embed/Dockerfile .
FROM python:3.13-slim-trixie@sha256:1b5c0692836eae9b028cc352d7146872f36939aa1fb0de24d3ef6df307b956c9 AS base

FROM base AS model
ARG BGE_M3_REV=5617a9f61b028005a4858fdac845db406aefb181
WORKDIR /build
COPY ops/embed/requirements-build.txt ./
RUN pip install --no-cache-dir --no-deps --require-hashes --only-binary :all: -r requirements-build.txt
COPY ops/embed/fetch.py ops/embed/SHA256SUMS ./
RUN python fetch.py "$BGE_M3_REV" /fp32
COPY ops/embed/server.py ops/embed/quantize.py ./
RUN mkdir /model && cp /fp32/tokenizer.json /model/ && python quantize.py /fp32 /model

FROM base AS runtime
COPY ops/embed/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --no-deps --require-hashes --only-binary :all: -r /tmp/requirements.txt && rm /tmp/requirements.txt
COPY --from=model /model /model
COPY ops/embed/server.py /app/server.py
ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
USER 65532:65532
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"]
ENTRYPOINT ["python", "/app/server.py"]
