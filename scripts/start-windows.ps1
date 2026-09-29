# BLB Translator 설치·실행 (Windows)
# 토큰은 화면에 표시되지 않고 이 폴더의 .env 에만 저장된다. 채팅·메신저에 붙여넣지 않는다.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($msg) {
  Write-Host ""
  Write-Host "[중단] $msg" -ForegroundColor Red
  exit 1
}

function Read-Secret($label, $prefix) {
  while ($true) {
    $secure = Read-Host "$label 붙여넣기 후 Enter" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($value.StartsWith($prefix)) { return $value }
    Write-Host "  $prefix 로 시작하는 값이 아닙니다. 다시 복사해 주세요." -ForegroundColor Yellow
  }
}

# 1. Node.js 22 이상
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Start-Process 'https://nodejs.org/'
  Fail 'Node.js 가 없습니다. 열린 페이지에서 LTS 를 설치하고, 이 창을 닫은 뒤 다시 실행하세요.'
}
$version = (& node -v).Trim().TrimStart('v')
if ([int]$version.Split('.')[0] -lt 22) {
  Start-Process 'https://nodejs.org/'
  Fail "Node.js $version 입니다. 22 이상 LTS 를 설치하고 다시 실행하세요."
}

# 2. 처음 한 번만: 토큰 입력 → .env
if (-not (Test-Path '.env')) {
  Write-Host ''
  Write-Host '처음 실행입니다. Slack 토큰 두 개를 입력합니다. (입력한 글자는 화면에 보이지 않습니다)' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '[1/2] 방금 열린 페이지의 "Bot User OAuth Token" (xoxb-...) 을 Copy 하세요.'
  Start-Process 'https://api.slack.com/apps/A0C4PUE07ST/oauth'
  $bot = Read-Secret 'Bot 토큰' 'xoxb-'

  Write-Host ''
  Write-Host '[2/2] 방금 열린 페이지 아래쪽 "App-Level Tokens" 에서'
  Write-Host '      blb-translator-local 이 있으면 눌러서 Copy,'
  Write-Host '      없으면 Generate Token and Scopes → 이름 blb-translator-local, scope 는 connections:write 하나만 → Generate → Copy'
  Start-Process 'https://api.slack.com/apps/A0C4PUE07ST/general'
  $app = Read-Secret '앱 토큰' 'xapp-'

  $lines = Get-Content '.env.example' -Encoding UTF8 | ForEach-Object {
    if ($_ -like 'SLACK_BOT_TOKEN=*') { "SLACK_BOT_TOKEN=$bot" }
    elseif ($_ -like 'SLACK_APP_TOKEN=*') { "SLACK_APP_TOKEN=$app" }
    else { $_ }
  }
  $path = Join-Path (Get-Location) '.env'
  [IO.File]::WriteAllText($path, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
  $bot = $null; $app = $null
  Write-Host '.env 저장 완료. (토큰을 바꾸려면 .env 를 지우고 다시 실행)' -ForegroundColor Green
}

# 3. 처음 한 번만: 패키지 설치
if (-not (Test-Path 'node_modules')) {
  Write-Host ''
  Write-Host '패키지 설치 중…'
  & npm.cmd ci --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Fail 'npm 설치에 실패했습니다. 위 오류 문구를 알려 주세요.' }
}

# 4. 실행 (이 창을 닫으면 번역도 멈춘다)
Write-Host ''
Write-Host '시작합니다. SLACK_SOCKET_CONNECTED 가 보이면 Slack 에서 메시지 ⋯ → 번역 / Translate 를 눌러 보세요.' -ForegroundColor Cyan
Write-Host '멈추려면 Ctrl+C 또는 창 닫기.'
Write-Host ''
& npm.cmd start
