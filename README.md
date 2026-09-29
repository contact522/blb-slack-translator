# BLB Translator (Slack)

YWH Slack 워크스페이스에서 메시지 ⋯ → **번역 / Translate** → 개인 모달 → 언어 선택으로 번역합니다.
결과는 모달을 연 본인에게만 보이고, 채널에는 아무것도 올라가지 않습니다.

지원 언어: 한국어, ไทย, Tiếng Việt, English, 简体中文, 繁體中文 (우선순위 없음)

## 현재 상태 (2026-09-29 기준, 사실만)

| 항목 | 상태 |
|---|---|
| 단위 테스트 16개 (`npm test`) | 통과 |
| `node --check` | 통과 |
| 설정 누락·잘못된 토큰 시 비밀값 없이 종료 | 확인 |
| 실제 Slack 연결·모달 열기 | **미검증** (토큰 미발급, 개발 환경에서 slack.com 차단) |
| 실제 번역 품질 (Gemini) | **미검증** (유료 API 꺼짐) |
| 스레드 문맥 읽기 | 코드만 있음. 현재 권한 `commands` 만으로는 읽을 수 없어 "권한 없음" 안내 후 단문 번역 |

설치만으로 번역이 된다고 보지 마세요. 아래 "처음 실행" 5단계를 거쳐 모달이 뜨는 것까지 확인해야 합니다.

## 동작

1. 메시지 ⋯ → 번역 / Translate → 원문이 담긴 모달이 열립니다. (Slack 은 앱이 타인 메시지 안에 직접 번역을 펼치는 것을 허용하지 않아 모달 방식입니다.)
2. 언어를 고르면 바로 번역합니다. 다른 언어를 고르면 다시 번역합니다.
3. "스레드 문맥 참고"를 켜면 같은 스레드의 앞선 메시지(최대 5개, 2000자)를 뜻 파악에만 씁니다. 권한이 없거나 스레드가 아니면 그 사실을 표시하고 이 메시지만 번역합니다.
4. `PAID_API_ENABLED=false`(기본)면 외부 번역 호출 없이 "미리보기" 안내만 보입니다. UI 시험용입니다.

## 가장 쉬운 실행 (Windows)

1. GitHub 저장소 → Code → Download ZIP → 압축 풀기
2. 폴더 안 `start-windows.bat` 더블클릭
3. 처음 한 번만: 자동으로 열리는 Slack 설정 페이지에서 토큰 두 개를 복사해 창에 붙여넣기 (화면에 안 보임, `.env` 에만 저장)
4. `SLACK_SOCKET_CONNECTED` 가 보이면 Slack 메시지 ⋯ → 번역 / Translate

다음부터는 `start-windows.bat` 더블클릭만 하면 됩니다. 창을 닫으면 번역도 멈춥니다.
예전 Codex 폴더의 번역기가 켜져 있으면 먼저 끄세요. 같은 앱에 두 프로그램이 연결되면 요청이 둘 중 하나로 나뉩니다.
`start-windows.bat` 은 이 스크립트 한 번에 한해 PowerShell 실행 정책을 우회(`-ExecutionPolicy Bypass`)합니다. 시스템 설정은 바꾸지 않습니다.
(이 스크립트는 Windows 에서 실행해 보지 못했습니다. 오류가 나면 문구를 알려 주세요.)

## 수동 실행 (Windows, Node.js 22 이상)

1. **앱 토큰 확인/발급** — https://api.slack.com/apps/A0C4PUE07ST/general → App-Level Tokens.
   이미 `blb-translator-local` 이 있으면 새로 만들지 말고 그것을 씁니다. 없으면 scope `connections:write` **하나만** 넣어 발급합니다.
2. **설정 파일** — 이 폴더에서 `copy .env.example .env` 후 `.env` 에 봇 토큰(`xoxb-`, OAuth & Permissions)과 앱 토큰(`xapp-`)을 넣습니다. 토큰은 채팅·메신저·Git 에 붙여넣지 않습니다.
3. **설치·시작** — `npm.cmd install` → `npm.cmd start`
   정상이면 `SLACK_SOCKET_CONNECTED` 와 `BLB Translator 시작` 이 출력됩니다. 종료는 `Ctrl+C`.
4. **상태 확인** — 브라우저에서 http://127.0.0.1:3000/health → `"socketConnected": true`
5. **Slack 에서 확인** — 기존 메시지 ⋯ → 번역 / Translate → 모달, 언어 선택, 미리보기 안내가 보이면 성공.
   (메뉴에 안 보이면 앱이 그 채널에서 쓸 수 있는지, Slack 을 새로고침했는지 확인)

PC 를 끄거나 창을 닫으면 번역도 멈춥니다. 상시 운영은 서버 배포가 필요하며 별도 승인 사항입니다.

### 시작 오류

| 출력 | 조치 |
|---|---|
| `[config] ... xoxb- ...` | `.env` 의 SLACK_BOT_TOKEN 확인 |
| `[config] ... xapp- ...` | 앱 토큰 발급·입력 확인 |
| `봇 토큰의 워크스페이스(...)가 SLACK_TEAM_ID 와 다릅니다` | 다른 워크스페이스 토큰. YWH 설치 토큰으로 교체 |
| `invalid_auth` | 봇 토큰이 틀렸거나 앱 재설치로 바뀜 |
| `slack_webapi_request_error` | 인터넷·방화벽 확인 |

## Slack 앱 설정 (현재 설치된 값과 동일)

`slack-manifest.json` 참고. Bot scope `commands` 하나, Socket Mode 켜짐, 메시지 바로가기 callback_id `translate_message`.
기존 앱(A0C4PUE07ST)을 이 파일로 덮어쓸 필요는 없습니다. 설정 비교용입니다.

## 승인이 필요한 다음 단계 (아직 하지 않음)

- **유료 번역 켜기** — `PAID_API_ENABLED=true` + `GEMINI_API_KEY`. 모델 기본값 `gemini-2.5-flash-lite` 는 예제일 뿐, 태국어·베트남어·중국어 품질과 비용은 검증하지 않았습니다. 켜기 전에 API 제공사 쪽 월 예산 한도를 먼저 설정하세요. 이 앱의 호출 제한은 메모리 기준이라 재시작하면 초기화됩니다.
- **스레드 문맥** — 공개 채널은 `channels:history`, 비공개는 `groups:history` 등 권한 추가와 앱 재설치가 필요합니다. 봇이 해당 채널에 들어가 있어야 합니다. 권한 확장은 채널 기록을 읽는 범위가 넓어지는 결정입니다.
- **상시 서버 운영** — 비용·범위 제시 후 결정.

## 구조

- `src/app.mjs` — 진입점. 봇 토큰의 워크스페이스 검증, Socket Mode 연결, `/health`
- `src/handlers.mjs` — 메시지 바로가기·언어 선택 처리. 다른 워크스페이스 요청 무시, 늦게 끝난 번역이 최신 결과를 덮지 않게 처리
- `src/views.mjs` — 모달 Block Kit
- `src/core.mjs` — 언어 목록, 문맥 선택, 프롬프트(입력·지시 분리), 메타데이터 3000자 제한, 호출 제한
- `src/translator.mjs` — Gemini REST 호출 (키는 헤더로 전송)
- `src/config.mjs` — 환경변수 검증 (오류 메시지에 비밀값 없음)
- `start-windows.bat`, `scripts/start-windows.ps1` — Windows 설치·토큰 입력·실행

로그에는 메시지 본문과 토큰을 남기지 않습니다.
