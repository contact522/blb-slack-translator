# BLB ENT 워크스페이스용 번역기를 Railway 에 새 서비스로 띄운다.
# YWH 번역기(blb-slack-translator)와 같은 코드, 다른 Slack 앱·토큰·볼륨.
# 토큰은 화면에 보이지 않게 입력받고, 출력에 비밀값을 찍지 않는다.
$ErrorActionPreference = 'Stop'
$railway = 'C:\Users\PJH\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm\node_modules\@railway\cli\bin\railway.exe'
$project = '628b0b72-e0ba-40e7-9117-a79afb224484'
$source = 'blb-slack-translator'
$svc = 'blb-slack-translator-blbent'
Set-Location 'C:\Users\PJH\Documents\blb-slack-translator'

function Read-Secret($label, $prefix) {
  while ($true) {
    $s = Read-Host $label -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)).Trim()
    if ($plain.StartsWith($prefix)) { return $plain }
    Write-Host "  $prefix 로 시작하는 값이 아닙니다. 다시 붙여넣어 주세요." -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '1/5 Slack 토큰 입력 (붙여넣어도 화면에 안 보입니다)' -ForegroundColor Cyan
$bot = Read-Secret '  Bot User OAuth Token (xoxb-...)' 'xoxb-'
$app = Read-Secret '  App-Level Token (xapp-...)' 'xapp-'

Write-Host '2/5 Railway 서비스 만들기' -ForegroundColor Cyan
$existing = & $railway variable list --service $svc --json 2>$null
if ($LASTEXITCODE -ne 0) {
  & $railway add --service $svc | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '서비스를 만들지 못했습니다.' }
} else {
  Write-Host '  이미 있는 서비스라 그대로 씁니다.'
}
& $railway link -p $project -e production -s $svc | Out-Null
if ($LASTEXITCODE -ne 0) { throw '서비스 연결(link)에 실패했습니다.' }

Write-Host '3/5 볼륨 /data (사람별 기본 언어 저장)' -ForegroundColor Cyan
# 목록은 프로젝트 전체라 YWH·Lark 볼륨도 나온다. 이 서비스에 붙은 것만 본다.
$vols = & $railway volume list 2>$null | Out-String
if ($vols -notmatch "Attached to: $svc\s") {
  & $railway volume add -m /data | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '볼륨을 만들지 못했습니다.' }
} else {
  Write-Host '  이미 있습니다.'
}

Write-Host '4/5 환경변수 (OpenAI 키·한도는 YWH 번역기 값을 그대로 복사)' -ForegroundColor Cyan
$src = (& $railway variable list --service $source --json) | Out-String | ConvertFrom-Json
if (-not $src.OPENAI_API_KEY) { throw 'YWH 번역기에서 OPENAI_API_KEY 를 읽지 못했습니다.' }
$vars = @(
  "SLACK_BOT_TOKEN=$bot",
  "SLACK_APP_TOKEN=$app",
  'SLACK_TEAM_ID=T0ADPU28Y6R',
  'PAID_API_ENABLED=true',
  "OPENAI_API_KEY=$($src.OPENAI_API_KEY)",
  "OPENAI_MODEL=$($src.OPENAI_MODEL)",
  "RATE_LIMIT_PER_USER_PER_MINUTE=$($src.RATE_LIMIT_PER_USER_PER_MINUTE)",
  "RATE_LIMIT_PER_DAY=$($src.RATE_LIMIT_PER_DAY)",
  'TRANSLATE_REACTION=globe_with_meridians',
  'AUTO_JOIN_PUBLIC=true',
  'DATA_DIR=/data'
)
foreach ($v in $vars) {
  & $railway variable set $v --service $svc --skip-deploys | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ('변수 저장 실패: ' + $v.Split('=')[0]) }
}
Write-Host "  $($vars.Count)개 저장"

Write-Host '5/5 배포' -ForegroundColor Cyan
& $railway up --service $svc --detach
if ($LASTEXITCODE -ne 0) { throw '배포 업로드에 실패했습니다.' }

Write-Host ''
Write-Host '완료. 1~2분 뒤 Claude 에게 「배포했어」라고 알려 주세요. 로그로 확인합니다.' -ForegroundColor Green
