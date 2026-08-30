# ============================================================
#  DSH 手机控制台 —— Tailscale 版一键启动（Windows）
#  免域名：只需 Tailscale（PC 与手机登录同一账号），无需 cloudflared/域名
#  启动：dsh web + 桥接(node src/index.js) + tailscale serve(HTTPS)
#  幂等：已运行的自动跳过；末尾可询问开机自启
#  用法：右键"使用 PowerShell 运行"，或 .\start-all.ps1
#  前提：本机已装并登录 Tailscale；手机装 Tailscale 并登录同一账号
# ============================================================
param([switch]$Silent)

$ErrorActionPreference = 'SilentlyContinue'

# ---- 路径配置（换机器时改这里）----
$BridgeDir = "D:\Software\AI Tools\DeepSeek Harness\dsh-roam"

# 端口是否在监听
function Test-Port([int]$Port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

Write-Host "`n========== DSH 手机控制台（Tailscale 版）一键启动 ==========" -ForegroundColor Cyan

# ---- 1. DSH web (3080) ----
if (Test-Port 3080) {
  Write-Host "[1/3] DSH web      已在运行 (3080)" -ForegroundColor Green
} else {
  Write-Host "[1/3] 启动 DSH web ..." -ForegroundColor Yellow
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c","dsh web" -WindowStyle Minimized
  Start-Sleep -Seconds 2
}

# ---- 2. 桥接 (8787，监听所有网卡，Tailscale 可连) ----
if (Test-Port 8787) {
  Write-Host "[2/3] 桥接          已在运行 (8787)" -ForegroundColor Green
} else {
  Write-Host "[2/3] 启动桥接 ..." -ForegroundColor Yellow
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c","cd /d `"$BridgeDir`" && node src/index.js" -WindowStyle Minimized
  Start-Sleep -Seconds 2
}

# ---- 3. Tailscale Serve（HTTPS：ts.net → 127.0.0.1:8787）----
$serveActive = $false
try {
  $out = tailscale serve status 2>&1 | Out-String
  if ($out -match '8788') { $serveActive = $true }
} catch {}
if ($serveActive) {
  Write-Host "[3/3] Tailscale Serve  已启用" -ForegroundColor Green
} else {
  Write-Host "[3/3] 启用 Tailscale Serve（HTTPS 代理 8787）..." -ForegroundColor Yellow
  tailscale serve --bg 8788 2>&1 | Select-Object -First 6
  Start-Sleep -Seconds 3
}

# ---- 健康报告 ----
Write-Host "`n---------- 健康检查 ----------" -ForegroundColor Cyan
$dshOk = Test-Port 3080
$bridgeOk = Test-Port 8787
Write-Host ("  DSH web (3080) : " + $(if ($dshOk) { 'OK' } else { '未就绪' })) -ForegroundColor $(if ($dshOk) { 'Green' } else { 'Yellow' })
Write-Host ("  桥接    (8787) : " + $(if ($bridgeOk) { 'OK' } else { '未就绪' })) -ForegroundColor $(if ($bridgeOk) { 'Green' } else { 'Yellow' })
Write-Host "`n  手机访问：先 `tailscale status` 看本机名字，再用" -ForegroundColor Green
Write-Host "    https://<机器名>.<你的tailnet>.ts.net/   （输入 WEB_PASSWORD）" -ForegroundColor Green
Write-Host "  提示：PC 与手机必须登录同一个 Tailscale 账号。`n" -ForegroundColor DarkGray

# ---- 开机自启询问（交互式；自启用 -Silent 跳过）----
if (-not $Silent) {
  $RunKey   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $RunName  = "DSHMobileConsole-Tailscale"
  $RunValue = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$PSScriptRoot\start-all.ps1`" -Silent"
  $choice = Read-Host "`n是否添加至开机自启？(Y=添加 / N=移除 / 回车跳过)"
  if ($choice -match '^[Yy]$') {
    New-Item -Path $RunKey -Force | Out-Null
    Set-ItemProperty -Path $RunKey -Name $RunName -Value $RunValue
    Write-Host "  已添加到开机自启。" -ForegroundColor Green
  } elseif ($choice -match '^[Nn]$') {
    Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
    Write-Host "  已从开机自启移除。" -ForegroundColor Green
  } else {
    Write-Host "  未更改开机自启。" -ForegroundColor DarkGray
  }
}
