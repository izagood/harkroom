import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';

/// 나 · 연결.
///
/// **데스크탑 설정의 대부분이 여기 없다**(계획서 §6): 에이전트 등록, Claude 계정,
/// 오퍼레이터, MCP, 스킬. 폰에서 **할 수 없는 일**이지 잠긴 일이 아니므로 회색으로도
/// 그리지 않는다 — 회색 항목은 "언젠가 열린다"는 거짓 약속이다.
class MeScreen extends StatelessWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final me = app.me;

    return Scaffold(
      appBar: AppBar(title: Text(t.tabMe)),
      body: SafeArea(
        child: ListView(
          children: [
            if (me != null)
              ListTile(
                key: const Key('me-handle'),
                leading: const Icon(Icons.person_outline),
                title: Text(t.meSignedInAs.replaceFirst('{handle}', me.handle)),
                subtitle: Text(me.displayName),
              ),
            if (app.baseUrl != null)
              ListTile(
                leading: const Icon(Icons.dns_outlined),
                title: Text(app.baseUrl!),
              ),
            const Divider(),
            ListTile(
              key: const Key('me-sign-out'),
              leading: const Icon(Icons.logout),
              title: Text(t.signOut),
              onTap: () => app.signOut(),
            ),
          ],
        ),
      ),
    );
  }
}
