import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import 'server_url.dart';

/// 서버 주소를 받는 첫 화면.
///
/// **아직 붙지는 않는다** — 로그인과 세션 보관은 P0 의 일이다. 지금 이 화면이 하는 것은
/// 계획서의 두 결정을 코드로 세우는 것뿐이다: 문구는 전부 키로(§7-2), `http://` 는
/// 저장하기 전에 사유와 함께 거절한다(§4).
class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key});

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  final _controller = TextEditingController();
  ServerUrlProblem? _problem;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 사유 → 문구. **화면이 문장을 짓지 않는다** — 고르기만 한다.
  String _message(Strings t, ServerUrlProblem problem) => switch (problem) {
        ServerUrlProblem.empty => t.connectErrorEmpty,
        ServerUrlProblem.malformed => t.connectErrorMalformed,
        ServerUrlProblem.insecure => t.connectErrorInsecure,
      };

  void _submit() {
    final result = validateServerUrl(_controller.text);
    setState(() => _problem = result.problem);
    if (!result.isOk) return;
    // P0 에서 여기가 로그인으로 이어진다.
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final problem = _problem;

    return Scaffold(
      appBar: AppBar(title: Text(t.connectTitle)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                key: const Key('connect-server-url'),
                controller: _controller,
                autocorrect: false,
                keyboardType: TextInputType.url,
                textInputAction: TextInputAction.go,
                onSubmitted: (_) => _submit(),
                decoration: InputDecoration(
                  labelText: t.connectServerUrlLabel,
                  hintText: t.connectServerUrlHint,
                  errorText: problem == null ? null : _message(t, problem),
                ),
              ),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('connect-continue'),
                onPressed: _submit,
                child: Text(t.connectContinue),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
