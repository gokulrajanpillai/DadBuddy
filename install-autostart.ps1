# Starts DadBuddy automatically (hidden) whenever you log in to Windows.
#   powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
# Remove with:  Unregister-ScheduledTask -TaskName 'DadBuddy' -Confirm:$false

$dir  = $PSScriptRoot
$node = (Get-Command node).Source
$log  = Join-Path $dir 'data\server.log'
New-Item -ItemType Directory -Force (Join-Path $dir 'data') | Out-Null

$cmd = "cd /d `"$dir`" && `"$node`" --disable-warning=ExperimentalWarning server.js >> `"$log`" 2>&1"
$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $cmd" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# The task from before the app was renamed.
Unregister-ScheduledTask -TaskName 'Baby Tracker' -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName 'DadBuddy' -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'DadBuddy'
Write-Host "Installed. Logs: $log"
