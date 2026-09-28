import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/connect/server_url.dart';

/// 계획서 §4 — iOS ATS 는 사유 없는 "연결 실패" 만 돌려주므로, 앱이 저장하기 전에
/// 먼저 말해야 한다. 그 판정이 여기 있다.
void main() {
  group('거절', () {
    test('빈 값', () {
      expect(validateServerUrl('').problem, ServerUrlProblem.empty);
      expect(validateServerUrl('   ').problem, ServerUrlProblem.empty);
    });

    test('평문 http 는 고쳐 주지 않고 거절한다', () {
      // 조용히 https 로 바꾸면 그 주소는 붙지 않고, 그때 실패는 다시 사유를 잃는다.
      expect(validateServerUrl('http://example.com').problem,
          ServerUrlProblem.insecure);
      expect(validateServerUrl('  http://192.168.0.2:8080  ').problem,
          ServerUrlProblem.insecure);
    });

    test('주소 모양이 아닌 것', () {
      expect(validateServerUrl('https://').problem, ServerUrlProblem.malformed);
      expect(validateServerUrl('ws://example.com').problem,
          ServerUrlProblem.malformed);
    });
  });

  group('받아들임', () {
    test('스킴이 없으면 https 를 붙인다', () {
      final r = validateServerUrl('example.com');
      expect(r.isOk, isTrue);
      expect(r.normalized, 'https://example.com');
    });

    test('끝 슬래시를 뗀다', () {
      // 안 떼면 모든 경로가 `//channels` 가 된다(데스크탑 ApiClient 도 같은 일을 한다).
      expect(validateServerUrl('https://example.com/').normalized,
          'https://example.com');
    });

    test('포트는 지킨다', () {
      expect(validateServerUrl('https://example.com:8443').normalized,
          'https://example.com:8443');
    });

    test('경로·질의는 떨어져 나간다', () {
      // 남겨 두면 `https://h/x` + `/channels` 가 되어 조용히 404 가 난다.
      expect(validateServerUrl('https://example.com/x?y=1#z').normalized,
          'https://example.com');
    });

    test('앞뒤 공백은 오류가 아니다', () {
      expect(validateServerUrl('  https://example.com  ').normalized,
          'https://example.com');
    });
  });
}
