# ============================================================
#  tray.ps1 —— dsh-roam 系统托盘监控（Windows）
#  右键托盘图标：一键启动所有服务、开启/关闭监控、退出
#  监控开启时每 5 分钟静默巡检（不弹任何窗口），谁挂了拉起谁
#  用法：直接运行；建议通过开机自启（注册表 Run 键）启动（默认只驻留托盘，不自动拉起服务）
# ============================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir  = $PSScriptRoot
$ProjectDir = Split-Path $ScriptDir -Parent
$IntervalMs = 300000          # 巡检间隔：5 分钟
$StateFile  = Join-Path $ScriptDir '.monitor-state'   # 记住开关状态

# ---- 读取上次的开关状态（默认关：登录后不自动拉起服务，由托盘一键启动） ----
$script:Monitoring = $false
if (Test-Path $StateFile) {
  $script:Monitoring = ((Get-Content $StateFile -Raw).Trim() -eq 'on')
}
function Save-State {
  $state = if ($script:Monitoring) { 'on' } else { 'off' }
  $state | Set-Content $StateFile -Encoding ascii
}

# ---- 端口检查 ----
function Test-Port([int]$Port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

# ---- 静默启动（不弹窗口） ----
function Start-Hidden([string]$FilePath, [string]$ArgumentList) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = $ArgumentList
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.CreateNoWindow = $true
  [System.Diagnostics.Process]::Start($psi) | Out-Null
}

# ---- 巡检逻辑（读 watchdog.conf，静默拉起） ----
function Invoke-Check {
  $confPath = Join-Path $ScriptDir 'watchdog.conf'
  $watchDsh = $true; $watchBridge = $true; $tunnelMode = 'cloudflare'
  if (Test-Path $confPath) {
    Get-Content $confPath | ForEach-Object {
      if ($_ -match '^\s*([A-Za-z_]+)\s*=\s*(\S+)') {
        switch ($Matches[1]) {
          'DSH'          { $watchDsh    = ($Matches[2] -ne '0') }
          'BRIDGE'       { $watchBridge = ($Matches[2] -ne '0') }
          'WATCH_TUNNEL' { $tunnelMode  = $Matches[2] }
        }
      }
    }
  }

  # 1. DSH web (3080)
  if ($watchDsh -and -not (Test-Port 3080)) {
    Start-Hidden 'cmd.exe' '/c dsh web'
    Start-Sleep -Seconds 6
  }
  # 2. 桥接 (8787)
  if ($watchBridge -and -not (Test-Port 8787)) {
    Start-Hidden 'cmd.exe' "/c cd /d `"$ProjectDir`" && node src/index.js"
  }
  # 3. 隧道
  if ($tunnelMode -eq 'tailscale' -or $tunnelMode -eq 'both') {
    $serveOk = $false
    try { if ((tailscale serve status 2>&1 | Out-String) -match '8788') { $serveOk = $true } } catch {}
    if (-not $serveOk) { Start-Hidden 'cmd.exe' '/c tailscale serve --bg 8788' }
  }
  if ($tunnelMode -eq 'cloudflare' -or $tunnelMode -eq 'both') {
    if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
      Start-Hidden 'cmd.exe' "/c cloudflared tunnel --protocol http2 --edge-ip-version 4 --config `"$env:USERPROFILE\.cloudflared\config-dsh.yml`" run dsh-bridge"
    }
  }
}

# ---- 托盘图标 + 菜单 ----
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$iconPath = Join-Path $ScriptDir 'whale.ico'
if (Test-Path $iconPath) {
  $notifyIcon.Icon = New-Object System.Drawing.Icon($iconPath)
} else {
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}
$notifyIcon.Visible = $true

$menu       = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Enabled = $false
$toggleItem = New-Object System.Windows.Forms.ToolStripMenuItem
$startItem  = New-Object System.Windows.Forms.ToolStripMenuItem
$startItem.Text = '一键启动所有服务'
$exitItem   = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = '退出'
$sep = New-Object System.Windows.Forms.ToolStripSeparator
[void]$menu.Items.AddRange(@($statusItem, $startItem, $toggleItem, $sep, $exitItem))
$notifyIcon.ContextMenuStrip = $menu

function Update-Menu {
  if ($script:Monitoring) {
    $statusItem.Text = '监控状态：已开启'
    $toggleItem.Text = '关闭监控'
    $notifyIcon.Text = 'dsh-roam 监控（开）'
  } else {
    $statusItem.Text = '监控状态：已关闭'
    $toggleItem.Text = '开启监控'
    $notifyIcon.Text = 'dsh-roam 监控（关）'
  }
}

$toggleItem.Add_Click({ $script:Monitoring = -not $script:Monitoring; Save-State; Update-Menu })
$startItem.Add_Click({
  Invoke-Check
  $notifyIcon.ShowBalloonTip(2500, 'dsh-roam', '已检查并启动缺失的服务', 'Info')
})
Update-Menu

# ---- 定时巡检 ----
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $IntervalMs
$timer.Add_Tick({ if ($script:Monitoring) { Invoke-Check } })
$timer.Start()

# ---- 消息循环 ----
$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$form.Add_Shown({ $form.Hide() })
$exitItem.Add_Click({ $notifyIcon.Visible = $false; $timer.Stop(); $form.Close(); $notifyIcon.Dispose() })
[System.Windows.Forms.Application]::Run($form)

