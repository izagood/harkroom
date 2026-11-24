"""임베딩 서비스 — OpenAI 호환 `POST /v1/embeddings` 와 `GET /health` 만 낸다.

harkroom 서버 옆에서만 쓴다(밖으로 포트를 열지 않는다). 받은 글은 로그·디스크 어디에도 남기지 않는다.
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIR = os.environ.get("EMBED_MODEL_DIR", "/model")
MODEL_NAME = os.environ.get("EMBED_MODEL", "bge-m3")
THREADS = int(os.environ.get("EMBED_THREADS", "4"))
MAX_TOKENS = int(os.environ.get("EMBED_MAX_TOKENS", "512"))
HOST = os.environ.get("EMBED_HOST", "0.0.0.0")
PORT = int(os.environ.get("EMBED_PORT", "8080"))

# 요청 상한 — 서버 클라이언트는 16개씩 보낸다.
MAX_INPUTS = 16
MAX_BODY = 256 * 1024
SOCKET_TIMEOUT = 30
# 동시에 처리·대기하는 요청 수. 넘으면 503 — 질의는 어차피 300ms 안에 못 받는다.
MAX_IN_FLIGHT = 8


class Embedder:
    def __init__(self, model_dir, model_file="model.onnx", threads=THREADS):
        self.tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self.tok.enable_truncation(max_length=MAX_TOKENS)
        self.tok.enable_padding(pad_id=1, pad_token="<pad>")
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(
            os.path.join(model_dir, model_file), so, providers=["CPUExecutionProvider"]
        )

    def embed(self, texts):
        enc = self.tok.encode_batch(texts)
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        out = self.sess.run(
            ["sentence_embedding"], {"input_ids": ids, "attention_mask": mask}
        )[0]
        return out / np.linalg.norm(out, axis=1, keepdims=True)


class BadRequest(Exception):
    pass


def parse_inputs(raw):
    try:
        req = json.loads(raw)
    except (ValueError, RecursionError):
        raise BadRequest("invalid json") from None
    inp = req.get("input") if isinstance(req, dict) else None
    inp = [inp] if isinstance(inp, str) else inp
    if not isinstance(inp, list) or not 1 <= len(inp) <= MAX_INPUTS:
        raise BadRequest(f"input must be 1..{MAX_INPUTS} strings")
    if not all(isinstance(s, str) and s.strip() for s in inp):
        raise BadRequest("input must be non-empty strings")
    try:
        "".join(inp).encode()
    except UnicodeEncodeError:
        raise BadRequest("input must be valid unicode") from None
    # 요청에 적힌 다른 모델 이름을 조용히 받아 주지 않는다 — 다른 공간의 벡터가 섞인다.
    if req.get("model", MODEL_NAME) != MODEL_NAME:
        raise BadRequest("unknown model")
    return inp


def make_handler(embedder):
    # 추론은 한 번에 하나(스레드 4개를 다 쓴다). 헬스 체크는 잠금 없이 답한다.
    lock = threading.Lock()
    slots = threading.BoundedSemaphore(MAX_IN_FLIGHT)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = SOCKET_TIMEOUT

        def log_message(self, *args):
            pass

        def reply(self, status, obj):
            body = json.dumps(obj).encode()
            # 본문을 읽지 않고 거절했을 수 있으니 연결을 이어 쓰지 않는다.
            if status != 200:
                self.close_connection = True
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            if status != 200:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def fail(self, status, message):
            self.reply(status, {"error": {"message": message}})

        def do_GET(self):
            if self.path == "/health":
                self.reply(200, {"status": "ok", "model": MODEL_NAME})
            else:
                self.fail(404, "not found")

        def do_POST(self):
            if self.path != "/v1/embeddings":
                return self.fail(404, "not found")
            length = self.headers.get("Content-Length", "")
            if "Transfer-Encoding" in self.headers or not (
                length.isascii() and length.isdigit()
            ):
                return self.fail(411, "content-length required")
            # 자릿수부터 본다 — 아주 긴 숫자를 int 로 바꾸다 예외가 나지 않게.
            if len(length) > 9 or int(length) > MAX_BODY:
                return self.fail(413, "body too large")
            # 본문을 다 받은 뒤에 자리를 잡는다 — 느리게 보내는 상대가 자리를 묶지 못하게.
            try:
                raw = self.rfile.read(int(length))
            except OSError:
                self.close_connection = True
                return None
            if not slots.acquire(blocking=False):
                return self.fail(503, "busy")
            try:
                inputs = parse_inputs(raw)
                with lock:
                    vecs = embedder.embed(inputs)
            except BadRequest as e:
                return self.fail(400, str(e))
            except Exception as e:
                # 예외 글에는 입력이 섞일 수 있어 종류만 적는다.
                print(f"embed failed: {type(e).__name__}", flush=True)
                return self.fail(500, "embed failed")
            finally:
                slots.release()
            data = [
                {"object": "embedding", "index": i, "embedding": v.tolist()}
                for i, v in enumerate(vecs)
            ]
            self.reply(200, {"object": "list", "data": data, "model": MODEL_NAME})

    return Handler


def main():
    embedder = Embedder(MODEL_DIR)
    # 첫 질의가 느리지 않게 한 번 돌린 뒤에 문을 연다 — /health 가 답하면 준비된 것이다.
    embedder.embed(["warm up"])
    server = ThreadingHTTPServer((HOST, PORT), make_handler(embedder))
    server.daemon_threads = True
    print(f"embed: ready model={MODEL_NAME} threads={THREADS}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
