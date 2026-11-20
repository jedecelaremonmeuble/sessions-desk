<#
.SYNOPSIS
  Pose (ou met à jour) le serveur Node À CÔTÉ du .ps1 sur 8767, en LECTURE SEULE (ou en écriture sous -AllowWrite),
  sous son propre watchdog.
.DESCRIPTION
  Depuis un checkout PROPRE dont le commit est poussé (le plus souvent main à jour) :
    1. compile le pilote et extrait le commit (git archive : server/, legacy/) dans un dossier neuf ;
    2. arrête le serveur Node de ce port (et seulement lui), remplace le dossier d'exécution
       %LOCALAPPDATA%\sessions-desk\node-<port> (l'ancien est gardé en .previous), écrit DEPLOYED.txt ;
    3. pose la tâche planifiée « sessions-desk - Node <port> (watchdog) » : à l'ouverture de session et toutes les
       2 minutes, sessions-desk-node-watchdog.ps1 relance le serveur s'il ne répond plus ;
    4. lance la tâche et attend que /api/ping réponde.

  Le serveur tourne donc sur une COPIE d'un commit : il ne suit pas main tout seul. Pour le mettre à jour, relancer
  ce script depuis un checkout de main à jour (comme -Deploy pour le .ps1).

  Ne touche ni au .ps1 de production (8765, ~/.claude/scripts), ni à son watchdog, ni à sa tâche, ni à
  tailscale serve. Sur 8765 il exige -Primary et que le port soit LIBRE : la bascule (étape 5), retour arrière
  compris, passe par server/watchdog/Switch-SessionsDesk.ps1, qui coupe le .ps1 avant de l'appeler.

  -Primary (8765 seulement) : rôle de production — écriture, notifications, alertes du lanceur et de Teams, index de
  recherche, état des PR, « vu », relais 8766 de tailscale serve.

  -AllowWrite : le serveur est lancé avec --allow-write (favoris, masquage, envois dans les sessions…), et le reste
  à chaque relance du watchdog. Relancer sans -AllowWrite le repasse en lecture seule. Favoris et masquées sont
  PARTAGÉS avec le .ps1, qui les relit quand ils changent et avant chaque écriture (une fois son correctif déployé) :
  un changement fait sur 8767 s'affiche sur 8765 et n'y est pas écrasé.

  -Uninstall : retire la tâche et arrête le serveur Node du port (le dossier d'exécution reste).
.EXAMPLE
  pwsh -NoProfile -File server/watchdog/Install-NodeWatchdog.ps1
#>
param(
    [int]$Port = 8767,
    [switch]$AllowWrite,
    [switch]$Primary,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
if ($Port -eq 8765 -and -not $Primary) { throw 'Port 8765 = production : -Primary requis (bascule par server/watchdog/Switch-SessionsDesk.ps1).' }
if ($Primary -and $Port -ne 8765) { throw '-Primary : port 8765 seulement.' }
if ($Primary) { $AllowWrite = [switch]$true }   # le rôle primary écrit toujours (config.ts)
$role = if ($Primary) { 'PRIMARY (production 8765)' } elseif ($AllowWrite) { 'ÉCRITURE (--allow-write)' } else { 'lecture seule' }

$taskName = "sessions-desk - Node $Port (watchdog)"
$runDir = Join-Path $env:LOCALAPPDATA "sessions-desk\node-$Port"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

function Stop-NodeServer {
    $ids = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object OwningProcess)
    $pidFile = Join-Path $env:TEMP "sessions-desk-node-$Port.pid"
    $old = 0
    if ((Test-Path $pidFile) -and [int]::TryParse("$(Get-Content $pidFile -Raw)".Trim(), [ref]$old)) { $ids += $old }
    $ours = @(foreach ($id in ($ids | Sort-Object -Unique)) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if (-not $p -or $p.Name -ne 'node.exe' -or $p.CommandLine -notmatch 'server[\\/]src[\\/]main\.ts') { continue }
        $pp = if ($p.CommandLine -match '--port\s+(\d+)') { [int]$Matches[1] } else { 8767 }
        if ($pp -eq $Port) { $id }
    })
    # ARRÊT PROPRE d'abord (/api/stop) : le serveur refuse les nouvelles requêtes, va au bout de celles reçues (8 s
    # au plus) et sort de lui-même. La force — qu'aucun process ne peut intercepter sous Windows — ne sert plus qu'au
    # serveur figé ou muet.
    if ($ours) {
        $t0 = Get-Date
        try { $null = Invoke-RestMethod "http://localhost:$Port/api/stop" -TimeoutSec 5; $asked = $true } catch { $asked = $false }
        if ($asked) {
            foreach ($id in $ours) { Wait-Process -Id $id -Timeout 12 -ErrorAction SilentlyContinue }
            $left = @($ours | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
            if (-not $left) { Write-Host "serveur Node arrêté proprement (pid $($ours -join ', '), $([int]((Get-Date) - $t0).TotalMilliseconds) ms)" }
        }
    }
    foreach ($id in $ours) {
        if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { continue }
        Write-Host "arrêt FORCÉ du serveur Node (pid $id) : il n'a pas répondu à /api/stop ou n'est pas sorti à temps"
        Stop-Process -Id $id -Force
    }
    for ($i = 0; $i -lt 20 -and (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "port $Port toujours tenu par un process qui n'est pas un serveur Node de ce port" }
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "tâche retirée : $taskName" }
    Stop-NodeServer
    return
}

# 1. Commit propre et poussé : le serveur doit toujours correspondre à un commit du dépôt.
$dirty = git -C $repo status --porcelain
if ($dirty) { throw "checkout modifié ($repo) : committer et pousser d'abord" }
$sha = (git -C $repo rev-parse HEAD).Trim()
git -C $repo fetch -q origin
$remote = git -C $repo branch -r --contains $sha
if (-not $remote) { throw "commit $sha non poussé" }
$onMain = (git -C $repo rev-parse origin/main).Trim() -eq $sha
if (-not $onMain) { Write-Warning "commit $sha ≠ origin/main : le serveur tournera sur une autre version que main" }

$node = (Get-Command node).Source
$v = [version]((& $node --version).TrimStart('v'))
if ($v -lt [version]'22.18.0') { throw "Node $v : 22.18+ requis (TypeScript exécuté directement)" }
. (Join-Path $PSScriptRoot 'Resolve-StablePwsh.ps1')
$pwsh = Resolve-StablePwsh (Get-Process -Id $PID).Path

$stage = "$runDir.new"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
$zip = Join-Path $env:TEMP "sessions-desk-node-$Port-$($sha.Substring(0,7)).zip"
# Page et scripts d'accompagnement : legacy/ tant que le serveur historique est dans le dépôt, sinon page/ et server/scripts/.
[string[]]$extra = if (Test-Path (Join-Path $repo 'legacy')) { 'legacy' } else { 'page', 'server/scripts' }
git -C $repo archive --format=zip -o $zip $sha server/src server/package.json server/watchdog @extra
if ($LASTEXITCODE -ne 0) { throw 'git archive en échec' }
Expand-Archive $zip $stage -Force; Remove-Item $zip
dotnet build (Join-Path $repo 'driver\SessionsDesk.Driver.csproj') -c Release -o (Join-Path $stage '.build\driver') --nologo -v q
if ($LASTEXITCODE -ne 0) { throw 'compilation du pilote en échec' }
Set-Content (Join-Path $stage 'DEPLOYED.txt') @(
    "commit $sha$(if ($onMain) { ' (origin/main)' } else { ' (PAS origin/main)' })"
    "posé le $(Get-Date -Format s) depuis $repo"
    "node $node ($v)"
    "mode $role"
)

# 2. Remplacer le dossier d'exécution, tâche désactivée pour que le watchdog ne relance pas en plein échange.
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { $null = Disable-ScheduledTask -TaskName $taskName }
Stop-NodeServer
# Sur 8765, http.sys (le .ps1) ne figure pas comme écouteur TCP d'un process : on vérifie qu'aucun serveur ne répond.
if ($Port -eq 8765) {
    try { $null = Invoke-RestMethod "http://localhost:$Port/api/ping" -TimeoutSec 2; $busy = $true } catch { $busy = $false }
    if ($busy) { if ($existing) { $null = Enable-ScheduledTask -TaskName $taskName }; throw "un serveur répond encore sur $Port (le .ps1 ?) : passer par Switch-SessionsDesk.ps1 -To node" }
}
if (Test-Path $runDir) {
    if (Test-Path "$runDir.previous") { Remove-Item "$runDir.previous" -Recurse -Force }
    Move-Item $runDir "$runDir.previous"
}
Move-Item $stage $runDir

# 3. Tâche : mêmes réglages que celle du .ps1 (ouverture de session + toutes les 2 min, sans fenêtre).
$watchdog = Join-Path $runDir 'server\watchdog\sessions-desk-node-watchdog.ps1'
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$pwsh`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$watchdog`" -Port $Port -Node `"$node`"$(if ($Primary) { ' -Primary' } elseif ($AllowWrite) { ' -AllowWrite' })"
$user = "$env:USERDOMAIN\$env:USERNAME"
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $user),
    (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2))
)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
    -Description "Serveur Node sessions-desk $(if ($Primary) { 'de PRODUCTION (primary)' } else { "à côté du .ps1, $role" }) (port $Port). Posé par server/watchdog/Install-NodeWatchdog.ps1 ; dossier $runDir." -Force
# Relecture : l'action posée ne doit viser aucun dossier versionné du Store.
$posed = (Get-ScheduledTask -TaskName $taskName).Actions[0].Arguments
if ($posed -match '\\Program Files\\WindowsApps\\') { throw "action de la tâche sur un chemin versionné : $posed" }

# 4. Lancer et attendre le serveur.
Start-ScheduledTask -TaskName $taskName
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 500
    try { $null = Invoke-RestMethod "http://localhost:$Port/api/ping" -TimeoutSec 3; $up = $true } catch {}
}
if (-not $up) { throw "le serveur ne répond pas sur $Port (voir $env:TEMP\sessions-desk-node-watchdog.log et sessions-desk-node-$Port.err.log)" }
$w = Invoke-RestMethod "http://localhost:$Port/api/whoami"
if ([bool]$w.write -ne [bool]$AllowWrite) { throw "serveur en $(if ($w.write) { 'écriture' } else { 'lecture seule' }) alors que demandé : $(if ($AllowWrite) { 'écriture' } else { 'lecture seule' })" }
Write-Host "Serveur Node sur http://localhost:$Port/ ($role), commit $($sha.Substring(0,7)), tâche « $taskName »"
