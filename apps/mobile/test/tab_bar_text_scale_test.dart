import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/screens/home_screen.dart';
import 'package:harkroom/theme.dart';

/// n5: 큰 글자(접근성 글자 크기)에서 하단 탭 바가 넘치지 않는다.
///
/// 원인(실측): 탭 칸은 높이 48 고정에 아이콘 22·틈 2·라벨이 세로로 선다. 375 폭에서 칸 너비는
/// 약 68 이라 ×1.3 이면 「Agents」 같은 라벨이 **두 줄로 접혀** 22 + 2 + 20×2 = 64 → 16px 넘쳤다.
/// 한 줄 높이만으로는 ×1.3 에서 46 이라 넘치지 않는다 — 줄바꿈이 원인이다.
/// 막대 높이는 [floatingTabBarHeight] 가 고정으로 잡고 있어 칸을 키우지 않는다. 라벨을 한 줄로
/// 묶고(넓으면 줄여 맞춤), 탭 바 안에서만 배율 상한을 둔다. 앱의 다른 글자는 큰 글자를 그대로 따른다.
const _labels = {
  'ko': ['홈', 'DM', '인박스', '에이전트'],
  'en': ['Home', 'DMs', 'Inbox', 'Agents'],
};

/// 앱의 탭 바 줄과 같은 폭으로 세운다: 좌우 12 · 막대 · 틈 8 · 찾기 버튼 58.
Widget _bar({required double scale, required double width, String lang = 'en', Brightness b = Brightness.light}) {
  final l = _labels[lang]!;
  final items = [
    TabItem(key: const Key('tab-home'), icon: Icons.home_outlined, selectedIcon: Icons.home, label: l[0]),
    TabItem(key: const Key('tab-dms'), icon: Icons.mail_outline, selectedIcon: Icons.mail, label: l[1], badge: 3),
    TabItem(key: const Key('tab-inbox'), icon: Icons.inbox_outlined, selectedIcon: Icons.inbox, label: l[2], badge: 12),
    TabItem(key: const Key('tab-agents'), icon: Icons.smart_toy_outlined, selectedIcon: Icons.smart_toy, label: l[3]),
  ];
  return MaterialApp(
    theme: harkroomTheme(b),
    home: MediaQuery(
      data: MediaQueryData(size: Size(width, 667), textScaler: TextScaler.linear(scale)),
      child: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(children: [
              Expanded(child: FloatingTabBar(selected: 0, onSelect: (_) {}, items: items)),
              const SizedBox(width: 8),
              const SizedBox(width: 58, height: 58),
            ]),
          ),
        ),
      ),
    ),
  );
}

void main() {
  for (final lang in _labels.keys) {
    for (final width in [375.0, 320.0]) {
      for (final scale in [1.0, 1.3, 1.5, 2.0, 3.0]) {
        testWidgets('넘치지 않는다 — $lang, 폭 $width, 글자 ×$scale', (tester) async {
          await tester.binding.setSurfaceSize(Size(width, 667));
          addTearDown(() => tester.binding.setSurfaceSize(null));
          await tester.pumpWidget(_bar(scale: scale, width: width, lang: lang));
          expect(tester.takeException(), isNull);
          // 라벨은 한 줄이다 — 두 줄로 접히는 것이 넘침의 원인이었다.
          for (final label in _labels[lang]!) {
            expect(tester.widget<Text>(find.text(label)).maxLines, 1, reason: label);
          }
        });
      }
    }
  }

  testWidgets('×1.0 에서 막대 높이는 그대로 58(칸 48 + 위아래 5)', (tester) async {
    await tester.pumpWidget(_bar(scale: 1.0, width: 375));
    expect(tester.getSize(find.byType(FloatingTabBar)).height, 58);
    expect(tester.getSize(find.byKey(const Key('tab-home'))).height, 48);
  });

  testWidgets('큰 글자에서도 라벨은 어느 정도 커진다(통째로 끄지 않는다)', (tester) async {
    await tester.pumpWidget(_bar(scale: 1.0, width: 375));
    final small = tester.getSize(find.text('Home')).height;
    await tester.pumpWidget(_bar(scale: 2.0, width: 375));
    final big = tester.getSize(find.text('Home')).height;
    expect(big, greaterThan(small));
  });
}
