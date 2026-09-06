// 배포 버전이 흩어진 세 파일에서 **함께** 움직이는지 고정하는 회귀선.
//
// ## 왜 이 회귀선이 있는가 — 그 실수가 이 저장소에서 이미 일어났다
//
// 버전이 세 곳에 있다(`tauri.conf.json`·`Cargo.toml`·`Cargo.lock`). 릴리즈마다 셋을 손으로
// 맞추면 언젠가 하나가 빠지는데, **그 어긋남은 아무것도 깨뜨리지 않는다** — 빌드는 통과하고
// `.dmg` 도 나온다. 다만 파일 이름과 `Info.plist` 와 크레이트 버전이 서로 다른 숫자를
// 말할 뿐이다. 그것을 알아차리는 자리는 이미 배포된 뒤다.
//
// 그리고 그 실수는 **이미 있었다**: `packages/desktop/package.json` 이 `0.0.0` 으로 남아
// 있다(다만 그것은 워크스페이스 자리채움이라 정본이 아니다 — `sync-version.mjs` 주석 참고).
//
// ## 무엇을 재는가
//
// 스크립트를 **실제로 돌려서** 잰다. 임시 디렉터리에 세 파일의 모형을 만들고 `writeAll` 을
// 돌린 뒤 셋을 다시 읽는다 — "셋이 같아졌는가"가 이 스크립트의 계약 전부이므로 그것을
// 그대로 잰다. 모형을 쓰는 이유는 저장소의 진짜 파일을 테스트가 건드리면 안 되기 때문이다.
//
// 마지막 한 항목만 **저장소의 진짜 파일**을 본다: 지금 커밋된 상태가 이미 일치하는지.
// 그것이 어긋나면 릴리즈가 어긋난 값으로 나가므로, 모형이 아니라 실물을 재는 것이 맞다.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { checkAll, readAll, readVersion, writeAll } from '../scripts/sync-version.mjs';

/**
 * 세 파일의 모형을 만든다. **서식을 실물과 똑같이 둔다** — 한 줄짜리 배열과 반복되는
 * 크레이트 블록이 이 스크립트가 조심해야 하는 것 전부이고, 모형이 그것을 안 닮으면
 * 테스트가 통과해도 실물에서 깨진다.
 */
function makeFixture(version: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'murmur-sync-version-'));

  writeFileSync(
    path.join(dir, 'tauri.conf.json'),
    // `icon` 을 한 줄로 둔다 — 실물이 그렇고, 재직렬화하면 이것이 펼쳐진다.
    `{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "murmur",
  "version": "${version}",
  "identifier": "app.murmur.desktop",
  "bundle": {
    "icon": ["icons/32x32.png", "icons/icon.icns"]
  }
}
`,
  );

  writeFileSync(
    path.join(dir, 'Cargo.toml'),
    // `[dependencies]` 에 `version = "2"` 를 둔다 — 전역 치환이면 이것도 바뀐다.
    `[package]
name = "murmur-desktop"
version = "${version}"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
version = "2"
`,
  );

  writeFileSync(
    path.join(dir, 'Cargo.lock'),
    // **다른 크레이트를 앞뒤로 둔다** — 이름으로 자리를 안 잡으면 남의 버전을 집는다.
    `version = 3

[[package]]
name = "aho-corasick"
version = "1.1.3"

[[package]]
name = "murmur-desktop"
version = "${version}"
dependencies = [
 "tauri",
]

[[package]]
name = "zerocopy"
version = "0.7.35"
`,
  );

  return dir;
}

describe('버전 동기화 — 세 자리가 함께 움직인다', () => {
  it('writeAll 이 세 파일을 모두 같은 값으로 맞춘다', () => {
    const dir = makeFixture('0.1.0');
    try {
      writeAll('0.2.0', dir);

      const found = readAll(dir);
      expect(found).toEqual({ tauri: '0.2.0', cargo: '0.2.0', lock: '0.2.0' });
      expect(checkAll(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('셋 중 하나만 어긋나 있으면 checkAll 이 그것을 잡는다', () => {
    // **이 회귀선의 핵심.** "하나만 갱신되는" 상태를 직접 만들어 보고 잡히는지 잰다 —
    // 잡히지 않으면 이 스크립트를 둘 이유가 없다.
    const dir = makeFixture('0.1.0');
    try {
      const toml = path.join(dir, 'Cargo.toml');
      writeFileSync(
        toml,
        readFileSync(toml, 'utf8').replace('version = "0.1.0"', 'version = "0.1.1"'),
      );

      const { ok, found } = checkAll(dir);
      expect(ok).toBe(false);
      expect(found.cargo).toBe('0.1.1');
      expect(found.tauri).toBe('0.1.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`Cargo.toml` 의 의존 버전을 건드리지 않는다', () => {
    // 전역 치환이면 `tauri = { version = "2" }` 까지 바뀐다 — 그러면 의존이 통째로 망가지고,
    // 그 고장은 `cargo` 가 해석할 때까지 안 보인다.
    const dir = makeFixture('0.1.0');
    try {
      writeAll('0.2.0', dir);

      const toml = readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
      expect(toml).toContain('tauri = { version = "2", features = [] }');
      expect(toml).toContain('version = "2"\n');
      expect(toml).toMatch(/^version = "0\.2\.0"$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`Cargo.lock` 에서 다른 크레이트의 버전을 건드리지 않는다', () => {
    const dir = makeFixture('0.1.0');
    try {
      writeAll('0.2.0', dir);

      const lock = readFileSync(path.join(dir, 'Cargo.lock'), 'utf8');
      expect(lock).toContain('name = "aho-corasick"\nversion = "1.1.3"');
      expect(lock).toContain('name = "zerocopy"\nversion = "0.7.35"');
      expect(lock).toContain('name = "murmur-desktop"\nversion = "0.2.0"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`tauri.conf.json` 의 서식을 바꾸지 않는다 — 버전 줄 하나만 바뀐다', () => {
    // **실측으로 배운 것.** 처음에는 `JSON.parse` → `JSON.stringify` 로 다시 썼는데,
    // 그러면 한 줄만 바뀌어야 할 자리에서 25 줄이 바뀌었다(한 줄짜리 배열이 펼쳐졌다).
    // 그 노이즈가 릴리즈 커밋마다 반복되므로 성질 자체를 고정한다.
    const dir = makeFixture('0.1.0');
    try {
      const before = readFileSync(path.join(dir, 'tauri.conf.json'), 'utf8');
      writeAll('0.2.0', dir);
      const after = readFileSync(path.join(dir, 'tauri.conf.json'), 'utf8');

      expect(after).toBe(before.replace('"version": "0.1.0"', '"version": "0.2.0"'));
      // 한 줄짜리 배열이 그대로다.
      expect(after).toContain('"icon": ["icons/32x32.png", "icons/icon.icns"]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('버전 형식이 X.Y.Z 가 아니면 파일을 건드리기 전에 멈춘다', () => {
    const dir = makeFixture('0.1.0');
    try {
      expect(() => writeAll('v0.2.0', dir)).toThrow(/X\.Y\.Z/);
      expect(() => writeAll('', dir)).toThrow(/X\.Y\.Z/);
      // 아무것도 안 바뀌었다 — 형식 확인이 **쓰기 전**이어야 이것이 성립한다.
      expect(readAll(dir)).toEqual({ tauri: '0.1.0', cargo: '0.1.0', lock: '0.1.0' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('저장소에 커밋된 세 파일이 지금 서로 일치한다', () => {
    // 위 항목들과 달리 **실물을 잰다.** 어긋난 채로 머지되면 릴리즈가 어긋난 값으로 나간다.
    const { ok, found } = checkAll();
    expect(ok, `버전이 어긋났다: ${JSON.stringify(found)}`).toBe(true);
    expect(found.tauri).toBe(readVersion());
  });
});
