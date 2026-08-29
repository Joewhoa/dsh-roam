<#
  One-shot setup for a Cloudflare named tunnel (for the WeCom callback).
  Prerequisite: already authorized via `cloudflared tunnel login` (so ~/.cloudflared/cert.pem exists).

  Usage:
    .\scripts\setup-tunnel.ps1 -Domain "dsh.example.com" [-TunnelName "dsh-bridge"] [-LocalPort 8787]

  It will:
    1. create (or reuse) the named tunnel
    2. route DNS (CNAME -> cfargotunnel)
    3. write ~/.cloudflared/config-dsh.yml (ingress -> local bridge port)
  and print the run command plus the WeCom callback URL.
#>
param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [string]$TunnelName = "dsh-bridge",
  [int]$LocalPort = 8787,
  [string]$Cloudflared = "C:\Users\Joe\cloudflared\cloudflared.exe"
)

$ErrorActionPreference = "Stop"
$CFDIR = Join-Path $HOME ".cloudflared"

# 1) authorization check
$cert = Join-Path $CFDIR "cert.pem"
if (-not (Test-Path $cert)) {
  Write-Host "ERROR: cloudflared is not authorized yet." -ForegroundColor Red
  Write-Host "  Run first: & '$Cloudflared' tunnel login   and authorize in the browser."
  exit 1
}

# 2) create / reuse tunnel
$list = & $Cloudflared tunnel list 2>$null | Out-String
if ($list -match [regex]::Escape($TunnelName)) {
  Write-Host "OK: tunnel '$TunnelName' already exists, reusing"
} else {
  Write-Host "Creating tunnel '$TunnelName' ..."
  & $Cloudflared tunnel create $TunnelName
}

# 3) DNS route
Write-Host "Routing DNS for $Domain ..."
& $Cloudflared tunnel route dns $TunnelName $Domain

# 4) locate credentials file (~/.cloudflared/<uuid>.json; newest one)
$cred = Get-ChildItem (Join-Path $CFDIR "*.json") | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $cred) {
  Write-Host "ERROR: no tunnel credentials file found (~/.cloudflared/*.json)." -ForegroundColor Red
  exit 1
}

# 5) write config
$config = @"
tunnel: $TunnelName
credentials-file: $($cred.FullName)
protocol: http2
ingress:
  - hostname: $Domain
    service: http://127.0.0.1:$LocalPort
  - service: http_status:404
"@
$configPath = Join-Path $CFDIR "config-dsh.yml"
Set-Content -Path $configPath -Value $config -Encoding UTF8
Write-Host "OK: wrote $configPath"

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Start the tunnel:"
Write-Host "  & '$Cloudflared' tunnel --config '$configPath' run $TunnelName"
Write-Host ""
Write-Host "WeCom callback URL:"
Write-Host "  https://$Domain/wecom/callback"
