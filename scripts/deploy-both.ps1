# 번역기 두 서비스(YWH: blb-slack-translator, BLB ENT: blb-slack-translator-blbent)에 같은 코드를 올린다.
# GitHub 에서 브랜치 코드를 내려받아 임시 폴더에 풀고 그 폴더를 올린다. 대표 PC 의 번역기 폴더(.env 등)는 건드리지 않는다.
# 비밀값·변수는 Railway 에 이미 있으므로 입력할 것이 없다(2026-10-06, 채널+스레드 표시·다국어 공지 수정 배포용).
$railway = 'C:\Users\PJH\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm\node_modules\@railway\cli\bin\railway.exe'
$project = '628b0b72-e0ba-40e7-9117-a79afb224484'
$branch = 'claude/friendly-allen-epwlnd'
$services = @('blb-slack-translator', 'blb-slack-translator-blbent')

function Fail($msg) {
  Write-Host ''
  Write-Host "실패: $msg" -ForegroundColor Red
  Write-Host '이 화면을 캡처해서 Claude 에게 보여 주세요.'
  exit 1
}

if (-not (Test-Path $railway)) {
  $cmd = Get-Command railway -ErrorAction SilentlyContinue
  if ($cmd) { $railway = $cmd.Source } else { Fail 'Railway 프로그램을 찾지 못했습니다.' }
}

Write-Host ''
Write-Host '1/3 GitHub 에서 코드 받기' -ForegroundColor Cyan
$work = Join-Path $env:TEMP ('blb-translator-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $work | Out-Null
$zip = Join-Path $work 'code.zip'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/contact522/blb-slack-translator/archive/refs/heads/$branch.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $work
} catch { Fail '코드를 내려받지 못했습니다(인터넷 확인).' }
$src = Get-ChildItem -Path $work -Directory | Select-Object -First 1
if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'src\handlers.mjs'))) { Fail '받은 코드가 이상합니다.' }
Set-Location $src.FullName
Write-Host "  받음: $($src.Name)"

Write-Host '2/3 Railway 연결' -ForegroundColor Cyan
& $railway link -p $project -e production -s $services[0] *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Railway 연결(link)에 실패했습니다. railway login 이 필요할 수 있습니다.' }

Write-Host '3/3 배포 (두 서비스)' -ForegroundColor Cyan
foreach ($svc in $services) {
  Write-Host "  $svc"
  & $railway up --service $svc --detach
  if ($LASTEXITCODE -ne 0) { Fail "$svc 배포 업로드에 실패했습니다." }
}

Write-Host ''
Write-Host '완료. 1~2분 뒤 Slack 에서 🌐 로 시험해 보세요. Claude 에게 「완료」라고 알려 주세요.' -ForegroundColor Green
