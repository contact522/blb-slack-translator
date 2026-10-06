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
| 실제 Slack 연결·모달 열기 | 확인 (2026-09-29, 대표 PC, Socket Mode) |
| 실제 번역 (OpenAI gpt-6-luna) | 확인 (한→영, 한→베트남어 모달에 표시) |
| 스레드 문맥 읽기 | 코드만 있음. 현재 권한 `commands` 만으로는 읽을 수 없어 "권한 없음" 안내 후 단문 번역 |

설치만으로 번역이 된다고 보지 마세요. 아래 "처음 실행" 5단계를 거쳐 모달이 뜨는 것까지 확인해야 합니다.

## 동작

1. 메시지 ⋯ → 앱에 연결 → 번역 / Translate. 처음 한 번만 내 언어를 고르는 창이 뜨고, 다음부터는 누르면 바로 그 언어로 번역된다.
2. 결과는 대화 안에 「나에게만 표시」로 나온다. 채널의 최상위 글이면 채널 본문과 그 글의 스레드 두 곳에, 스레드 댓글이면 그 스레드 안에만, DM 은 그 글의 스레드 안(2026-10-06 변경). 봇이 없는 대화방(사람끼리 DM 등)은 response_url 로 같은 방식으로 보낸다.
3. 결과 아래 「다른 언어로 보기」는 이번만 다른 언어로 바꾸고, 「⚙ 기본 언어」는 저장된 내 언어를 바꾼다.
4. 🌐(globe_with_meridians) 반응을 달아도 번역된다. 각자 Slack 설정에서 🌐를 마우스 올림 아이콘 줄(원클릭 반응)에 넣으면 한 번 클릭. 봇이 들어가 있는 채널에서만 된다(반응 이벤트가 그곳만 온다). 공개 채널은 봇이 자동으로 들어간다(시작 시 전체 + 새로 만든/보관 해제한 채널, `AUTO_JOIN_PUBLIC`). 비공개 채널은 Slack 구조상 봇이 스스로 들어갈 수 없어, 🌐 를 쓰려면 채널에서 `/invite @BLB Translator` 를 한 번 해야 한다. ⋯→번역은 봇 초대 없이 어디서나 된다.
5. 스레드 답글이면 같은 스레드 앞 메시지(최대 5개)를 뜻 파악에만 쓴다. 봇이 없는 곳은 이 메시지만 번역.
6. 다국어 공지(같은 내용을 여러 언어로 이어 쓴 글)는 내 언어로 쓴 부분만 그대로 보여 주고, 같은 내용의 다른 언어 부분은 다시 번역하지 않는다(2026-10-06). 같은 내용인지는 모델이 판단한다(영어·베트남어, 간체·번체는 글자로 구분이 안 됨). 그렇게 했으면 결과 아래에 안내 문구가 붙는다.
7. 번역은 OpenAI `gpt-6-luna` 한 모델. 사람별 기본 언어는 `DATA_DIR/prefs.json`(서버는 Railway 볼륨 `/data`). 원문 기록은 메모리 24시간이라 재시작 후 옛 결과의 버튼은 「다시 번역해 주세요」로 안내.

### DM 에서도 🌐 한 번 클릭 (사용자 연결)

DM·그룹DM 은 봇이 들어갈 수 없어, 본인이 한 번 「연결」하면 그때부터 본인 토큰으로 🌐 번역이 된다.
- 연결 링크: `PUBLIC_URL/slack/install` → Slack 허락 → 본인 토큰을 서버에 **암호화(AES-256-GCM)** 저장. 해독 키(`TOKEN_KEY`)는 환경변수에만.
- 사용자 스코프는 최소 4개: `im:history`, `mpim:history`, `reactions:read`, `chat:write`.
- 🌐 를 누르면 그 메시지만 읽어 번역하고, **읽을 때마다 감사 기록**(`DATA_DIR/audit.log`, 누가·언제·어느 대화방, 본문 없음)을 남긴다.
- 앱 제거(`tokens_revoked`)·계정 비활성화(`user_change`) 시 그 사람 토큰을 **즉시 삭제**한다.
- 보안 주의: 연결한 사람의 토큰은 그 사람의 **DM 전체를 읽을 수 있는 권한**이다. 서버가 이 토큰의 보관처가 되므로, `TOKEN_KEY` 는 볼륨과 분리해 환경변수로만 두고, 팀원에게 「연결하면 회사 번역 서버가 내 DM 을 읽을 수 있다」고 안내할 것.
- 이 5개 환경변수(`PUBLIC_URL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `TOKEN_KEY`, `STATE_SECRET`)가 모두 있어야 DM 기능이 켜진다. 없으면 채널 🌐 와 ⋯→번역만 동작한다.

필요한 Bot scope: `commands`, `chat:write`, `reactions:read`, `channels:history`, `groups:history`, `channels:read`, `channels:join`. Event Subscriptions 에 `reaction_added`, `tokens_revoked`, `user_change`, `channel_created`, `channel_unarchive`. DM 을 켜면 User scope 4개(`im:history`, `mpim:history`, `reactions:read`, `chat:write`).

## BLB ENT 워크스페이스 (2026-10-02 추가)

같은 코드를 Railway 서비스 `blb-slack-translator-blbent` 로 하나 더 띄운다. 워크스페이스마다 Slack 앱·토큰·볼륨이 따로다.
- Slack 앱: BLB ENT 에 `slack-manifest.blbent.json` 으로 만든 별도 앱. DM 연결(사용자 토큰)은 넣지 않았다(⋯→번역은 DM 에서도 된다).
- 배포: `scripts/deploy-blbent.ps1` (토큰 2개 입력 → 서비스·볼륨·변수·배포). OpenAI 키와 호출 한도는 YWH 서비스 값을 복사한다.
- `SLACK_TEAM_ID=T0ADPU28Y6R`. 공개 채널은 자동 참여, 비공개 채널은 `/invite @BLB Translator`.

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

- **OpenAI 월 예산 한도** — 번역은 켜져 있다 (`PAID_API_ENABLED=true`, `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-6-luna`). 키는 Lark 번역봇과 같은 키다. 이 앱의 호출 제한은 메모리 기준이라 재시작하면 초기화되므로, OpenAI 쪽 월 한도를 걸어야 한다.
  - 모델 비교(2026-09-29, 업무 문장 4건): gpt-6-luna 번역 1건 약 0.06원·평균 2.6초, gpt-5.6-luna 는 더 딱딱함, gpt-6-sol 은 약 20배 비싸고 느려 쓰지 않는다.
- **스레드 문맥** — 공개 채널은 `channels:history`, 비공개는 `groups:history` 등 권한 추가와 앱 재설치가 필요합니다. 봇이 해당 채널에 들어가 있어야 합니다. 권한 확장은 채널 기록을 읽는 범위가 넓어지는 결정입니다.
- **상시 서버 운영** — 비용·범위 제시 후 결정.

## 구조

- `src/app.mjs` — 진입점. 봇 토큰의 워크스페이스 검증, Socket Mode 연결, `/health`
- `src/handlers.mjs` — 메시지 바로가기·언어 선택 처리. 다른 워크스페이스 요청 무시, 늦게 끝난 번역이 최신 결과를 덮지 않게 처리
- `src/views.mjs` — 모달 Block Kit
- `src/core.mjs` — 언어 목록, 문맥 선택, 프롬프트(입력·지시 분리), 메타데이터 3000자 제한, 호출 제한
- `src/translator.mjs` — OpenAI Responses API 호출 (구조화 출력, 오염 출력 1회 재시도, 429 재시도, 키는 헤더로 전송)
- `src/config.mjs` — 환경변수 검증 (오류 메시지에 비밀값 없음)
- `start-windows.bat`, `scripts/start-windows.ps1` — Windows 설치·토큰 입력·실행

로그에는 메시지 본문과 토큰을 남기지 않습니다.
