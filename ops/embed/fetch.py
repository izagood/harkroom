"""이미지 빌드 때 한 번: 고정한 rev 의 공개 파일(모델이 낸 int8 ONNX·토크나이저)을 받고 sha256 을 대조한다."""

import hashlib
import os
import shutil
import sys
import urllib.request

REPO = "Snowflake/snowflake-arctic-embed-m-v2.0"

# sha256sum 꼴(해시, 저장소 안 경로). 없는 이름은 받지 않는다. 받은 파일은 `out/<파일 이름>` 에 둔다.
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "SHA256SUMS")) as f:
    FILES = [line.split() for line in f]


def main(rev, out):
    os.makedirs(out, exist_ok=True)
    for want, name in FILES:
        url = f"https://huggingface.co/{REPO}/resolve/{rev}/{name}"
        path = os.path.join(out, os.path.basename(name))
        with urllib.request.urlopen(url, timeout=120) as r, open(path, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
        with open(path, "rb") as f:
            got = hashlib.file_digest(f, "sha256").hexdigest()
        if got != want:
            sys.exit(f"{name}: sha256 mismatch ({got})")
        print(f"fetched {name}", flush=True)


main(sys.argv[1], sys.argv[2])
