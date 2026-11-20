<#
.SYNOPSIS
  Met à jour l'installation du poste depuis ce clone : le serveur Node de production (8765), l'étiqueteur de tags,
  le surveillant des réponses Teams et les scripts d'accompagnement.

.DESCRIPTION
  1. refuse de partir si le clone a des modifications non commitées ou si le commit n'est sur aucune branche distante :
     ce qui tourne sur le poste doit pouvoir être retrouvé ;
  2. copie vers -Target (~/.claude/scripts) l'étiqueteur (session-tagger/), le surveillant Teams (teams-watcher/) et
     restart-idle-sessions.ps1, et pose leurs tâches planifiées si elles n'existent pas encore ;
  3. réinstalle le serveur Node de production par Install-NodeWatchdog.ps1 -Port 8765 -Primary — SAUF si, depuis le
     commit en service (DEPLOYED.txt de sa copie), seule la page a changé : la page est alors remplacée dans la copie,
     le serveur continue de tourner (aucune coupure) et les pages ouvertes se rechargent seules. Décision :
     Deploy-Plan.ps1.

  -SkipServer : les étapes 1 et 2 seulement (le serveur n'est ni arrêté ni relancé).
  -Restart    : redémarre le serveur même si seule la page a changé.

.EXAMPLE
  pwsh -NoProfile -File server/watchdog/Deploy.ps1
#>
param([string]$Target = (Join-Path $env:USERPROFILE '.claude\scripts'), [switch]$SkipServer, [switch]$Restart)
$ErrorActionPreference = 'Stop'

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$top = git -C $repo rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -or -not $top) { throw "Deploy.ps1 se lance depuis un clone du dépôt, pas depuis $PSScriptRoot." }
$dirty = git -C $repo status --porcelain
if ($dirty) { throw "déploiement refusé : modifications non commitées dans le clone :`n$($dirty -join "`n")" }
$head = git -C $repo rev-parse HEAD
if (-not (git -C $repo branch -r --contains $head)) { throw "déploiement refusé : le commit $($head.Substring(0, 10)) n'est sur aucune branche distante (git push d'abord)." }
$branch = git -C $repo rev-parse --abbrev-ref HEAD

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw 'node introuvable dans le PATH.' }
$src = Join-Path $repo 'server\src'
# Scripts d'accompagnement : legacy/ tant que le serveur historique est dans le dépôt, sinon server/scripts/.
$scripts = if (Test-Path (Join-Path $repo 'legacy')) { Join-Path $repo 'legacy' } else { Join-Path $repo 'server\scripts' }
$null = New-Item -ItemType Directory -Force $Target

function Register-HiddenNodeTask([string]$Name, [string]$Script, [int]$EveryMinutes, [int]$LimitMinutes, [string]$Description) {
    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) { return }
    # conhost --headless : aucune fenêtre ne s'ouvre à chaque passe.
    $act = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$nodeExe`" `"$Script`"" -WorkingDirectory (Split-Path $Script -Parent)
    $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
    $set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes $LimitMinutes) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $null = Register-ScheduledTask -TaskName $Name -Action $act -Trigger $trg -Settings $set -Description $Description
    Write-Host "Tâche « $Name » créée (toutes les $EveryMinutes min)." -ForegroundColor Green
}

# Étiqueteur des sessions : fichier autonome et ses règles.
$tTag = Join-Path $Target 'session-tagger'; $null = New-Item -ItemType Directory -Force $tTag
foreach ($f in 'tagger.ts', 'tagger-config.json') { Copy-Item (Join-Path $src $f) (Join-Path $tTag $f) -Force }
Register-HiddenNodeTask 'Claude - étiqueteur des sessions' (Join-Path $tTag 'tagger.ts') 5 30 'Tags des sessions Claude Code (sessions-desk) : ~/.claude/state/session-tags'

# Surveillant des réponses Teams : fichier autonome, hook ajouté une fois à ~/.claude/settings.json. La passe ne lit
# rien tant que « login » n'a pas été fait.
$tTw = Join-Path $Target 'teams-watcher'; $null = New-Item -ItemType Directory -Force $tTw
Copy-Item (Join-Path $src 'teams-watcher.ts') (Join-Path $tTw 'teams-watcher.ts') -Force
& $nodeExe (Join-Path $tTw 'teams-watcher.ts') install-hook
Register-HiddenNodeTask 'Claude - réponses Teams des sessions' (Join-Path $tTw 'teams-watcher.ts') 2 10 'Réponses Teams attendues par les sessions Claude Code (sessions-desk) : ~/.claude/state/teams-waits'

Copy-Item (Join-Path $scripts 'restart-idle-sessions.ps1') (Join-Path $Target 'restart-idle-sessions.ps1') -Force
"commit $head`nbranche $branch`ndéployé $(Get-Date -Format s)`ndepuis $repo" | Set-Content (Join-Path $Target 'DEPLOYED.txt') -Encoding utf8
Write-Host "Étiqueteur, surveillant Teams et scripts copiés vers $Target (commit $($head.Substring(0, 10)), $branch)." -ForegroundColor Green

if ($SkipServer) { return }

# Page seule changée depuis le commit en service : on la remplace dans la copie, sans arrêter le serveur.
. (Join-Path $PSScriptRoot 'Deploy-Plan.ps1')
$runDir = Join-Path $env:LOCALAPPDATA 'sessions-desk\node-8765'
$plan = 'restart'; $why = '-Restart demandé'; $running = $null
if (-not $Restart) {
    $running = Get-DeployedCommit $runDir
    $alive = try { $null = Invoke-RestMethod 'http://localhost:8765/api/ping' -TimeoutSec 3; $true } catch { $false }
    if (-not $running) { $why = 'commit de la copie en service inconnu' }
    elseif (-not $alive) { $why = 'le serveur ne répond pas' }
    else {
        git -C $repo cat-file -e "$running^{commit}" 2>$null
        if ($LASTEXITCODE) { $why = "commit en service $($running.Substring(0, 10)) absent du clone" }
        else {
            $changed = @(git -C $repo diff --name-only $running $head)
            if ($LASTEXITCODE) { throw 'git diff en échec' }
            $plan = Get-DeployPlan $changed
            $why = 'le serveur a changé'
        }
    }
}
if ($plan -ne 'restart') {
    Update-RunCopy -Repo $repo -Head $head -RunDir $runDir -Plan $plan -Running $running
    $msg = if ($plan -eq 'page') { 'page remplacée à chaud, serveur NON redémarré (les pages ouvertes se rechargent seules)' } else { 'rien qui concerne le serveur ni la page, serveur NON redémarré' }
    Write-Host "Production (8765) sur le commit $($head.Substring(0, 10)) ($branch) : $msg." -ForegroundColor Green
    return
}
Write-Host "redémarrage du serveur : $why." -ForegroundColor Yellow
& (Join-Path $PSScriptRoot 'Install-NodeWatchdog.ps1') -Port 8765 -Primary
if (-not $?) { throw 'réinstallation du serveur Node en échec — voir ci-dessus.' }
Write-Host "Production (8765) redéployée sur le commit $($head.Substring(0, 10)) ($branch)." -ForegroundColor Green
