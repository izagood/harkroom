import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/mention/mention.dart';

/// **멘션 판정 계약.** 이 시험이 읽는 표는 TypeScript 쪽 시험
/// (`packages/shared/test/mentionCases.test.ts`)이 읽는 **바로 그 파일**이다.
///
/// 표가 `apps/mobile/test/` 안에 있지 않은 이유: **한쪽 안에 두면 공유가 아니다.**
/// 사본이 둘이 되는 순간 이 계약은 아무것도 지키지 못한다.
///
/// 이 경로는 저장소의 두 최상위를 건너뛴다(`apps/mobile/test` → `packages/shared/test`).
/// 지금 그 선을 넘는 자리는 여기와 `packages/shared/test/compat.test.ts` 둘뿐이고,
/// 둘 다 **의도한 것**이라 주석으로 못 박아 둔다.
File _fixtureFile() {
  // `flutter test` 의 작업 디렉터리는 패키지 루트(`apps/mobile`)다.
  final path = '../../packages/shared/test/fixtures/mentionCases.json';
  final file = File(path);
  if (!file.existsSync()) {
    fail('멘션 계약 표를 못 찾았다: $path\n'
        'TS 쪽에서 옮겼거나 지웠다면 이 시험도 함께 고쳐라 — '
        '표가 사라지면 Dart 포팅을 지키는 것이 아무것도 없다.');
  }
  return file;
}

void main() {
  final fixture = jsonDecode(_fixtureFile().readAsStringSync()) as Map<String, Object?>;
  final cases = (fixture['cases']! as List).cast<Map<String, Object?>>();

  test('표가 비어 있지 않다 — 비면 이 계약은 아무것도 지키지 않는다', () {
    expect(cases.length, greaterThan(20));
  });

  test('표가 지키는 갈래가 실제로 들어 있다', () {
    // "전부 빈 배열" 같은 시시한 표로 줄어들면 아래 시험은 초록인데 아무것도 못 지킨다.
    final found = cases.where((c) => (c['handles']! as List).isNotEmpty).length;
    final empty = cases.where((c) => (c['handles']! as List).isEmpty).length;
    expect(found, greaterThan(5));
    expect(empty, greaterThan(5));
  });

  group('Dart 포팅이 TS 원본과 같은 답을 낸다', () {
    for (final c in cases) {
      final body = c['body']! as String;
      final expected = (c['handles']! as List).cast<String>();
      // 이름에 본문을 싣는다 — 빨개졌을 때 어느 줄인지가 바로 보여야 한다.
      final label = body.isEmpty ? '(빈 본문)' : body.replaceAll('\n', '\\n');
      test(label, () {
        final actual = mentionedHandles(body)..sort();
        expect(actual, expected,
            reason: 'TS 원본(packages/shared/src/index.ts::mentionedHandles)과 갈라졌다. '
                '규칙을 일부러 바꿨다면 TS 를 고치고 표를 다시 뽑아라.');
      });
    }
  });
}
