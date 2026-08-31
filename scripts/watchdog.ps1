# ============================================================
#  看门狗（Windows）：检查并自动拉起指定的服务
#  - 配置在同目录 watchdog.conf：DSH / BRIDGE / WATCH_TUNNEL
#  - 幂等：已运行的自动跳过，只重启挂掉的
#  - 建议用任务计划程序每 5 分钟跑一次（见 README「自动恢复」）
# ============================================================

$ScriptDir  = $PSScriptRoot
$ProjectDir = Split-Path $ScriptDir -Parent

# ---- 读取配置（默认：全监控 + tailscale）----
$watchDsh    = $true
$watchBridge = $true
$tunnelMode  = 'tailscale'
$confPath = Join-Path $ScriptDir 'watchdog.conf'
if (Test-Path $confPath) {
  Get-Content $confPath | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_]+)\s*=\s*(\S+)') {
      switch ($Matches[1]) {
        'DSH'           { $watchDsh    = ($Matches[2] -ne '0') }
        'BRIDGE'        { $watchBridge = ($Matches[2] -ne '0') }
        'WATCH_TUNNEL'  { $tunnelMode  = $Matches[2] }
      }
    }
  }
}

function Test-Port([int]$Port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

# ---- 1. DSH web (3080) ----
if ($watchDsh -and -not (Test-Port 3080)) {
  Write-Host "[watchdog] DSH web 未运行，拉起..." -ForegroundColor Yellow
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c","dsh web" -WindowStyle Minimized
}

# ---- 2. 桥接 (8787) ----
if ($watchBridge -and -not (Test-Port 8787)) {
  Write-Host "[watchdog] 桥接未运行，拉起..." -ForegroundColor Yellow
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c","cd /d `"$ProjectDir`" && node src/index.js" -WindowStyle Minimized
}

# ---- 3. 隧道（按模式） ----
if ($tunnelMode -eq 'tailscale') {
  $serveOk = $false
  try { if ((tailscale serve status 2>&1 | Out-String) -match '8788') { $serveOk = $true } } catch {}
  if (-not $serveOk) {
    Write-Host "[watchdog] tailscale serve 未生效，重新启用..." -ForegroundColor Yellow
    tailscale serve --bg 8788 2>&1 | Out-Null
  }
}
elseif ($tunnelMode -eq 'cloudflare') {
  if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "[watchdog] cloudflared 未运行，拉起..." -ForegroundColor Yellow
    $cf = "cloudflared tunnel --protocol http2 --edge-ip-version 4 --config `"$env:USERPROFILE\.cloudflared\config-dsh.yml`" run dsh-bridge"
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c",$cf -WindowStyle Minimized
  }
}
# none：跳过隧道守护
