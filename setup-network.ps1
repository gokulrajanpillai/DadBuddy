# One-time network setup for the baby tracker. Run in an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\setup-network.ps1
#
# 1. Marks your Wi-Fi as a Private network (home network; lets other devices reach this PC).
# 2. Opens TCP 443 (the app, HTTPS), TCP 80 (phone setup page) and UDP 5353 (mDNS, so phones can find
#    baby.local) on Private networks only.

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'Please run this from an Administrator PowerShell.'
}

$wifi = Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -match 'Wi-?Fi|Ethernet' }
foreach ($p in $wifi) {
    if ($p.NetworkCategory -ne 'Private') {
        Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private
        Write-Host "Set '$($p.Name)' ($($p.InterfaceAlias)) to Private"
    }
}

$rules = @(
    @{ DisplayName = 'Baby Tracker (HTTPS 443)'; Protocol = 'TCP'; LocalPort = 443 },
    @{ DisplayName = 'Baby Tracker (HTTP 80)'; Protocol = 'TCP'; LocalPort = 80 },
    @{ DisplayName = 'Baby Tracker (mDNS 5353)'; Protocol = 'UDP'; LocalPort = 5353 }
)
foreach ($r in $rules) {
    Get-NetFirewallRule -DisplayName $r.DisplayName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $r.DisplayName -Direction Inbound -Action Allow `
        -Protocol $r.Protocol -LocalPort $r.LocalPort -Profile Private | Out-Null
    Write-Host "Firewall rule added: $($r.DisplayName)"
}
Write-Host 'Done.'
