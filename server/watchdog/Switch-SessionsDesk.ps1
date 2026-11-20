<#
.SYNOPSIS
  Bascule de la production http://localhost:8765/ entre le serveur Node et le .ps1 (lot 2b, étape 5).
.DESCRIPTION
  -To node : coupe le .ps1 (tâche « Claude - suivi sessions (watchdog) » DÉSACTIVÉE, puis /api/stop, puis arrêt du
             process s'il ne sort pas), pose Node sur 8765 en rôle primary par Install-NodeWatchdog.ps1 -Primary
             (tâche « sessions-desk - Node 8765 (watchdog) »), vérifie /api/ping, l'écriture et le relais 8766 de
             tailscale serve. En cas d'échec de Node : retour au .ps1 AUTOMATIQUE. Retire ensuite le serveur d'essai
             8767 (-KeepSide pour le garder : il resterait en rôle « side », à côté).
  -To ps1  : retour arrière en une commande — retire la tâche Node 8765 et l'arrête, réactive et relance la tâche du
             .ps1 (la copie déployée de ~/.claude/scripts, inchangée par la bascule), vérifie qu'il répond.
  -Status  : qui sert 8765, état des tâches, commit de chaque côté, relais 8766.

  Le hook Stop de ~/.claude/settings.json (http://localhost:8765/api/hook) et `tailscale serve` (→ 8766) ne
  bougent pas : celui qui tient le port les sert. Les tâches de l'étiqueteur et des réponses Teams sont
  indépendantes du serveur.

  À lancer depuis un checkout PROPRE et POUSSÉ du dépôt (le plus souvent main à jour) : c'est ce commit que Node
  servira. Après la bascule, `legacy/sessions-dashboard-tests.ps1 -Deploy` redéploie Node (il voit la tâche Node).
.EXAMPLE
  pwsh -NoProfile -File server/watchdog/Switch-SessionsDesk.ps1 -Status
  pwsh -NoProfile -File server/watchdog/Switch-SessionsDesk.ps1 -To node
  pwsh -NoProfile -File server/watchdog/Switch-SessionsDesk.ps1 -To ps1
#>
param(
    [ValidateSet('node', 'ps1')][string]$To,
    [switch]$Status,
    [switch]$KeepSide
)
$ErrorActionPreference = 'Stop'
$legacyTask = 'Claude - suivi sessions (watchdog)'
$nodeTask = 'sessions-desk - Node 8765 (watchdog)'
$install = Join-Path $PSScriptRoot 'Install-NodeWatchdog.ps1'
$legacyScript = Join-Path $env:USERPROFILE '.claude\scripts\sessions-dashboard.ps1'
$marker = Join-Path $env:LOCALAPPDATA 'sessions-desk\PRODUCTION.txt'

# Le relais de l'accès distant refuse (403) tout appel dont le Host n'est pas le nom du poste sur le tailnet :
# vu d'ici il est vivant dès qu'il RÉPOND en HTTP, quel que soit le code.
function Test-Relay([int]$P = 8766) {
    try { $null = Invoke-WebRequest "http://localhost:$P/api/ping" -TimeoutSec 3 -SkipHttpErrorCheck; $true } catch { $false }
}
function Test-Ping([int]$P = 8765) { try { $null = Invoke-RestMethod "http://localhost:$P/api/ping" -TimeoutSec 3; $true } catch { $false } }
# Qui sert 8765 : Node écoute en TCP (process node.exe) ; le .ps1 passe par http.sys (écouteur = System, pid 4).
function Get-Serving {
    if (-not (Test-Ping)) { return 'personne' }
    $owners = @(Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue | ForEach-Object OwningProcess | Sort-Object -Unique)
    foreach ($id in $owners) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'server[\\/]src[\\/]main\.ts') { return 'node' }
    }
    return 'ps1'
}
function Wait-Serving([string]$Who, [int]$Seconds) {
    for ($i = 0; $i -lt $Seconds * 2; $i++) { if ((Get-Serving) -eq $Who) { return $true }; Start-Sleep -Milliseconds 500 }
    $false
}
function Set-Marker([string]$Who, [string]$Detail) {
    $null = New-Item -ItemType Directory -Force (Split-Path $marker)
    Set-Content $marker "$Who`n$(Get-Date -Format s)`n$Detail" -Encoding utf8
}
function Stop-Legacy {
    if (Get-ScheduledTask -TaskName $legacyTask -ErrorAction SilentlyContinue) { $null = Disable-ScheduledTask -TaskName $legacyTask }
    if ((Get-Serving) -ne 'ps1') { return }
    Write-Host 'arrêt du .ps1 (/api/stop)…'
    try { $null = Invoke-RestMethod 'http://localhost:8765/api/stop' -TimeoutSec 3 } catch {}
    for ($i = 0; $i -lt 30 -and (Test-Ping); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Ping)) { return }
    $pidFile = Join-Path $env:TEMP 'sessions-dashboard-8765.pid'; $old = 0
    if ((Test-Path $pidFile) -and [int]::TryParse("$(Get-Content $pidFile -Raw)".Trim(), [ref]$old)) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$old" -ErrorAction SilentlyContinue
        if ($p -and $p.CommandLine -match 'sessions-dashboard\.ps1' -and $p.CommandLine -notmatch '-IndexSearch|-RefreshPrFrom|-RefreshGitFrom') {
            Write-Host "le .ps1 ne sort pas : arrêt du process $old"
            Stop-Process -Id $old -Force; Start-Sleep -Seconds 2
        }
    }
    if (Test-Ping) { throw 'le .ps1 répond encore sur 8765 après arrêt' }
}
function Start-Legacy {
    if (-not (Get-ScheduledTask -TaskName $legacyTask -ErrorAction SilentlyContinue)) { throw "tâche « $legacyTask » absente : relancer legacy/sessions-dashboard-tests.ps1 -Deploy" }
    $null = Enable-ScheduledTask -TaskName $legacyTask
    Start-ScheduledTask -TaskName $legacyTask
    if (-not (Wait-Serving 'ps1' 60)) { throw 'le .ps1 ne répond pas sur 8765 (voir %TEMP%\sessions-dashboard.err.log)' }
}
function Show-Status {
    $who = Get-Serving
    Write-Host "8765 servi par : $who"
    foreach ($t in $legacyTask, $nodeTask, 'sessions-desk - Node 8767 (watchdog)') {
        $x = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        Write-Host ("  tâche « $t » : " + $(if ($x) { $x.State } else { 'absente' }))
    }
    $d1 = Join-Path $env:USERPROFILE '.claude\scripts\DEPLOYED.txt'; $d2 = Join-Path $env:LOCALAPPDATA 'sessions-desk\node-8765\DEPLOYED.txt'
    if (Test-Path $d1) { Write-Host "  .ps1 déployé : $((Get-Content $d1 -TotalCount 1))" }
    if (Test-Path $d2) { Write-Host "  Node 8765    : $((Get-Content $d2 -TotalCount 1))" }
    Write-Host "  relais 8766 (tailscale serve) : $(if (Test-Relay 8766) { 'répond' } else { 'MUET' })"
    if (Test-Path $marker) { Write-Host "  dernière bascule : $((Get-Content $marker) -join ' · ')" }
}

if ($Status -or -not $To) { Show-Status; return }

if ($To -eq 'node') {
    if ((Get-Serving) -eq 'node' -and (Get-ScheduledTask -TaskName $nodeTask -ErrorAction SilentlyContinue)) {
        Write-Host 'Node sert déjà 8765 (pour le mettre à jour : legacy/sessions-dashboard-tests.ps1 -Deploy).'; Show-Status; return
    }
    Stop-Legacy
    try {
        & $install -Port 8765 -Primary
        if (-not (Wait-Serving 'node' 20)) { throw 'Node ne sert pas 8765' }
        $w = Invoke-RestMethod 'http://localhost:8765/api/whoami' -TimeoutSec 5
        if (-not $w.write) { throw 'Node sur 8765 en lecture seule' }
        if (-not (Test-Relay 8766)) { throw 'relais 8766 (tailscale serve) muet' }
    } catch {
        Write-Host "⛔ bascule vers Node en échec : $($_.Exception.Message) — retour au .ps1" -ForegroundColor Red
        try { & $install -Port 8765 -Primary -Uninstall } catch {}
        Start-Legacy
        Set-Marker 'ps1' "retour automatique après échec de la bascule : $($_.Exception.Message)"
        exit 2
    }
    $sha = (git -C (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) rev-parse --short HEAD).Trim()
    Set-Marker 'node' "commit $sha"
    if (-not $KeepSide -and (Get-ScheduledTask -TaskName 'sessions-desk - Node 8767 (watchdog)' -ErrorAction SilentlyContinue)) {
        & $install -Port 8767 -Uninstall
    }
    Write-Host "✅ 8765 = Node (primary, commit $sha). Retour arrière : pwsh -NoProfile -File `"$PSCommandPath`" -To ps1" -ForegroundColor Green
    Show-Status
    return
}

# -To ps1
if (Get-ScheduledTask -TaskName $nodeTask -ErrorAction SilentlyContinue) { & $install -Port 8765 -Primary -Uninstall }
elseif ((Get-Serving) -eq 'node') { throw "un Node sert 8765 sans sa tâche : l'arrêter à la main" }
if (-not (Test-Path $legacyScript)) { throw "$legacyScript absent : relancer legacy/sessions-dashboard-tests.ps1 -Deploy" }
Start-Legacy
Set-Marker 'ps1' 'retour arrière'
Write-Host '✅ 8765 = .ps1 (copie de ~/.claude/scripts).' -ForegroundColor Green
Show-Status
