# BLB ENT 워크스페이스용 번역기를 Railway 서비스 blb-slack-translator-blbent 로 띄운다.
# 서비스·볼륨(/data)·일반 변수는 미리 만들어 두었다(10/2). 이 스크립트는 비밀값 3개만 넣고 배포한다.
# - Slack 토큰 2개: 화면에 보이지 않게 입력받는다.
# - OpenAI 키: YWH 번역기 서비스 값을 그대로 복사한다.
# Windows PowerShell 5.1 은 Stop 모드에서 외부 명령의 오류 출력만으로도 멈추므로, 성공 여부는 종료 코드로 판단한다.
$railway = 'C:\Users\PJH\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm\node_modules\@railway\cli\bin\railway.exe'
$project = '628b0b72-e0ba-40e7-9117-a79afb224484'
$source = 'blb-slack-translator'
$svc = 'blb-slack-translator-blbent'
Set-Location 'C:\Users\PJH\Documents\blb-slack-translator'

function Fail($msg) {
  Write-Host ''
  Write-Host "실패: $msg" -ForegroundColor Red
  Write-Host '이 화면을 캡처해서 Claude 에게 보여 주세요.'
  exit 1
}

# 콘솔 창은 Ctrl+V 붙여넣기가 안 되는 경우가 있어, 가려진 입력칸이 있는 작은 창으로 받는다.
Add-Type -AssemblyName System.Windows.Forms
function Read-Secret($label, $prefix) {
  $hint = ''
  while ($true) {
    $f = New-Object Windows.Forms.Form
    $f.Text = 'BLB Translator 토큰 입력'; $f.Width = 520; $f.Height = 190; $f.TopMost = $true; $f.StartPosition = 'CenterScreen'
    $l = New-Object Windows.Forms.Label
    $l.Text = "$label`r`n복사한 값을 아래 칸에 Ctrl+V 로 붙여넣고 확인을 누르세요. $hint"; $l.SetBounds(12, 10, 480, 50)
    $t = New-Object Windows.Forms.TextBox
    $t.UseSystemPasswordChar = $true; $t.SetBounds(12, 65, 480, 24)
    $b = New-Object Windows.Forms.Button
    $b.Text = '확인'; $b.SetBounds(392, 100, 100, 30); $b.DialogResult = 'OK'
    $f.Controls.AddRange(@($l, $t, $b)); $f.AcceptButton = $b
    $f.Add_Shown({ $f.Activate(); $t.Focus() })
    if ($f.ShowDialog() -ne 'OK') { Fail '입력을 취소했습니다.' }
    $plain = $t.Text.Trim()
    $f.Dispose()
    if ($plain.StartsWith($prefix)) { Write-Host "  $label 입력됨"; return $plain }
    $hint = "($prefix 로 시작하는 값이 아닙니다. 다시 복사해 주세요.)"
  }
}

Write-Host ''
Write-Host '1/3 Slack 토큰 입력 (붙여넣어도 화면에 안 보입니다)' -ForegroundColor Cyan
$bot = Read-Secret '  Bot User OAuth Token (xoxb-...)' 'xoxb-'
$app = Read-Secret '  App-Level Token (xapp-...)' 'xapp-'

Write-Host '2/3 비밀값 저장' -ForegroundColor Cyan
& $railway link -p $project -e production -s $svc *> $null
if ($LASTEXITCODE -ne 0) { Fail '서비스 연결(link)에 실패했습니다.' }
$json = & $railway variable list --service $source --json 2> $null | Out-String
if ($LASTEXITCODE -ne 0) { Fail 'YWH 번역기 설정을 읽지 못했습니다.' }
$key = ($json | ConvertFrom-Json).OPENAI_API_KEY
if (-not $key) { Fail 'YWH 번역기에서 OPENAI_API_KEY 를 찾지 못했습니다.' }
& $railway variable set "SLACK_BOT_TOKEN=$bot" "SLACK_APP_TOKEN=$app" "OPENAI_API_KEY=$key" --service $svc --skip-deploys *> $null
if ($LASTEXITCODE -ne 0) { Fail '비밀값 저장에 실패했습니다.' }
Write-Host '  3개 저장'

Write-Host '3/3 배포' -ForegroundColor Cyan
& $railway up --service $svc --detach
if ($LASTEXITCODE -ne 0) { Fail '배포 업로드에 실패했습니다.' }

Write-Host ''
Write-Host '완료. Claude 에게 「완료」라고 알려 주세요. 이 창은 닫아도 됩니다.' -ForegroundColor Green
