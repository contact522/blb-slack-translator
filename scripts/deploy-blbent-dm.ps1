# BLB ENT 번역기에 YWH 와 같은 「DM 연결」을 켠다 (DM 번역 결과를 댓글 창 안에).
# 입력은 Slack 앱의 Client ID·Client Secret 두 개뿐. 암호화 키·위조방지 값은 여기서 새로 만들어 넣고 화면에 찍지 않는다.
$railway = 'C:\Users\PJH\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm\node_modules\@railway\cli\bin\railway.exe'
$project = '628b0b72-e0ba-40e7-9117-a79afb224484'
$svc = 'blb-slack-translator-blbent'
$publicUrl = 'https://blb-slack-translator-blbent-production.up.railway.app'
Set-Location 'C:\Users\PJH\Documents\blb-slack-translator'

function Fail($msg) {
  Write-Host ''
  Write-Host "실패: $msg" -ForegroundColor Red
  Write-Host '이 화면을 캡처해서 Claude 에게 보여 주세요.'
  exit 1
}

# 콘솔 붙여넣기가 안 되는 경우가 있어 작은 입력창으로 받는다.
Add-Type -AssemblyName System.Windows.Forms
function Read-Value($label, $pattern, $masked) {
  $hint = ''
  while ($true) {
    $f = New-Object Windows.Forms.Form
    $f.Text = 'BLB Translator 설정 입력'; $f.Width = 520; $f.Height = 190; $f.TopMost = $true; $f.StartPosition = 'CenterScreen'
    $l = New-Object Windows.Forms.Label
    $l.Text = "$label`r`n복사한 값을 아래 칸에 Ctrl+V 로 붙여넣고 확인을 누르세요. $hint"; $l.SetBounds(12, 10, 480, 50)
    $t = New-Object Windows.Forms.TextBox
    $t.UseSystemPasswordChar = $masked; $t.SetBounds(12, 65, 480, 24)
    $b = New-Object Windows.Forms.Button
    $b.Text = '확인'; $b.SetBounds(392, 100, 100, 30); $b.DialogResult = 'OK'
    $f.Controls.AddRange(@($l, $t, $b)); $f.AcceptButton = $b
    $f.Add_Shown({ $f.Activate(); $t.Focus() })
    if ($f.ShowDialog() -ne 'OK') { Fail '입력을 취소했습니다.' }
    $v = $t.Text.Trim()
    $f.Dispose()
    if ($v -match $pattern) { Write-Host "  $label 입력됨"; return $v }
    $hint = '(형식이 맞지 않습니다. 다시 복사해 주세요.)'
  }
}

function New-Hex($bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return -join ($b | ForEach-Object { $_.ToString('x2') })
}

Write-Host ''
Write-Host '1/3 Slack 앱 값 입력 (Basic Information > App Credentials)' -ForegroundColor Cyan
$clientId = Read-Value 'Client ID' '^\d+\.\d+$' $false
$clientSecret = Read-Value 'Client Secret' '^[0-9a-f]{32}$' $true

Write-Host '2/3 설정 저장' -ForegroundColor Cyan
& $railway link -p $project -e production -s $svc *> $null
if ($LASTEXITCODE -ne 0) { Fail '서비스 연결(link)에 실패했습니다.' }
& $railway variable set "PUBLIC_URL=$publicUrl" "SLACK_CLIENT_ID=$clientId" "SLACK_CLIENT_SECRET=$clientSecret" "TOKEN_KEY=$(New-Hex 32)" "STATE_SECRET=$(New-Hex 32)" --service $svc --skip-deploys *> $null
if ($LASTEXITCODE -ne 0) { Fail '설정 저장에 실패했습니다.' }
Write-Host '  5개 저장'

Write-Host '3/3 배포' -ForegroundColor Cyan
& $railway up --service $svc --detach
if ($LASTEXITCODE -ne 0) { Fail '배포 업로드에 실패했습니다.' }

Write-Host ''
Write-Host '완료. Claude 에게 「완료」라고 알려 주세요. 이 창은 닫아도 됩니다.' -ForegroundColor Green
