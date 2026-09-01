# ============================================================
#  DSH 手机控制台 一键启动脚本（Windows PowerShell）
#  启动：dsh web + 桥接(node src/index.js) + cloudflared 隧道
#  幂等：已运行的进程会自动跳过，可随时重复运行
#  用法：右键"使用 PowerShell 运行"，或终端里  .\start-all.ps1
#  开机自启：脚本末尾会询问是否加入开机自启（自启用 -Silent 静默模式）
# ============================================================
param([switch]$Silent)

$ErrorActionPreference = 'SilentlyContinue'

# ---- 路径配置（换机器时改这里）----
$BridgeDir   = "D:\Software\AI Tools\DeepSeek Harness\dsh-roam"
$Cloudflared = "C:\Users\Joe\cloudflared\cloudflared.exe"
$TunnelCfg   = "C:\Users\Joe\.cloudflared\config-dsh.yml"
$TunnelName  = "dsh-bridge"
$MobileUrl   = "https://chat.your-domain.com"

# 端口是否在监听（快速判断进程是否在跑）
function Test-Port([int]$Port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

Write-Host "`n========== DSH 手机控制台 一键启动 ==========" -ForegroundColor Cyan

# ---- 1. DSH web (3080) ----
if (Test-Port 3080) {
  Write-Host "[1/3] DSH web      已在运行 (3080)" -ForegroundColor Green
} else {
  Write-Host "[1/3] 启动 DSH web ..." -ForegroundColor Yellow
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c","dsh web" -WindowStyle Minimized
  Start-Sleep -Seconds 2
}

# ---- 2. 桥接 (8787) ----
if (Test-Port 8787) {
  Write-Host "[2/3] 桥接          已在运行 (8787)" -ForegroundColor Green
} else {
  Write-Host "[2/3] 启动桥接 ..." -ForegroundColor Yellow
  Start-Process -FilePath "node" -ArgumentList "src/index.js" -WorkingDirectory $BridgeDir -WindowStyle Minimized
  Start-Sleep -Seconds 2
}

# ---- 3. cloudflared 隧道 ----
if (Get-Process cloudflared -ErrorAction SilentlyContinue) {
  Write-Host "[3/3] 隧道          已在运行" -ForegroundColor Green
} else {
  Write-Host "[3/3] 启动隧道 ..." -ForegroundColor Yellow
  Start-Process -FilePath $Cloudflared -ArgumentList "tunnel","--protocol","http2","--edge-ip-version","4","--config",$TunnelCfg,"run",$TunnelName -WindowStyle Minimized
  Start-Sleep -Seconds 2
}

# ---- 最终健康报告 ----
Write-Host "`n---------- 健康检查 ----------" -ForegroundColor Cyan
Start-Sleep -Seconds 3

$dshOk    = Test-Port 3080
$bridgeOk = Test-Port 8787
$tunnelOk = $null -ne (Get-Process cloudflared -ErrorAction SilentlyContinue)

Write-Host ("  DSH web (3080) : " + $(if ($dshOk) { 'OK' } else { '未就绪' })) -ForegroundColor $(if ($dshOk) { 'Green' } else { 'Yellow' })
Write-Host ("  桥接    (8787) : " + $(if ($bridgeOk) { 'OK' } else { '未就绪' })) -ForegroundColor $(if ($bridgeOk) { 'Green' } else { 'Yellow' })
Write-Host ("  隧道 (cloudflared) : " + $(if ($tunnelOk) { '运行中' } else { '未运行' })) -ForegroundColor $(if ($tunnelOk) { 'Green' } else { 'Yellow' })

Write-Host "`n  手机访问: $MobileUrl" -ForegroundColor Green
Write-Host "  注意：隧道连上云端约需 10~30 秒，稍后刷新即可。" -ForegroundColor DarkGray

# ---- 开机自启询问（仅交互式；自启运行时带 -Silent 跳过）----
if (-not $Silent) {
  $RunKey   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $RunName  = "DSHMobileConsole"
  $RunValue = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$PSScriptRoot\start-all.ps1`" -Silent"

  $choice = Read-Host "`n是否添加至开机自启？(Y=添加 / N=移除 / 回车跳过)"
  if ($choice -match '^[Yy]$') {
    New-Item -Path $RunKey -Force | Out-Null
    Set-ItemProperty -Path $RunKey -Name $RunName -Value $RunValue
    Write-Host "  已添加到开机自启（登录后自动静默拉起）。" -ForegroundColor Green
  } elseif ($choice -match '^[Nn]$') {
    Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
    Write-Host "  已从开机自启移除。" -ForegroundColor Green
  } else {
    Write-Host "  未更改开机自启。" -ForegroundColor DarkGray
  }
}
