<#
.SYNOPSIS
  Chien de garde du serveur Node À CÔTÉ du .ps1 (http://localhost:8767/, LECTURE SEULE) — lot 2b, étape 4.
.DESCRIPTION
  Lancé par la tâche planifiée « sessions-desk - Node 8767 (watchdog) » à l'ouverture de session et toutes les
  2 minutes (posée par Install-NodeWatchdog.ps1). Si /api/ping ne répond pas, ou répond 503 (boucle du serveur
  figée), il arrête le serveur figé s'il vit encore — seulement si c'est bien un serveur Node de ce port —, puis le
  relance sans fenêtre. Sorties dans <StateDir>\sessions-desk-node-<port>.{out,err}.log, relances tracées dans
  <StateDir>\sessions-desk-node-watchdog.log.

  Indépendant du watchdog du .ps1 (sessions-dashboard-watchdog.ps1, tâche « Claude - suivi sessions (watchdog) ») :
  autre tâche, autre port, autres fichiers. Lecture seule par défaut : il ne passe --allow-write au serveur que
  sous -AllowWrite (posé par Install-NodeWatchdog.ps1 -AllowWrite). Sur 8765 seulement sous -Primary (posé par
  Install-NodeWatchdog.ps1 -Primary, via Switch-SessionsDesk.ps1) : Node y prend le rôle primary de lui-même.

  Le serveur lancé est celui du dossier qui contient ce script (<racine>\server\src\main.ts) : le dossier
  d'exécution posé par Install-NodeWatchdog.ps1, ou un checkout pour les tests.
#>
param(
    [int]$Port = 8767,
    [string]$Node = '',
    [string]$StateDir = $env:TEMP,
    [switch]$AllowWrite,
    [switch]$Primary
)

if ($Port -eq 8765 -and -not $Primary) { throw 'Port 8765 = production : -Primary requis (posé par Switch-SessionsDesk.ps1 -To node).' }

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$main = Join-Path $root 'server\src\main.ts'
$log = Join-Path $StateDir 'sessions-desk-node-watchdog.log'
$outLog = Join-Path $StateDir "sessions-desk-node-$Port.out.log"
$errLog = Join-Path $StateDir "sessions-desk-node-$Port.err.log"
$pidFile = Join-Path $StateDir "sessions-desk-node-$Port.pid"
$ping = "http://localhost:$Port/api/ping"

function Write-Log([string]$m) { Add-Content $log "$(Get-Date -Format s) [$Port] $m" }
function Test-Up { try { $null = Invoke-RestMethod $ping -TimeoutSec 5; $true } catch { $false } }
# Un serveur Node DE CE PORT lancé depuis n'importe quel dossier (main.ts, et --port <Port> ou port par défaut 8767).
function Test-OurServer($p) {
    if (-not $p -or $p.Name -ne 'node.exe' -or $p.CommandLine -notmatch 'server[\\/]src[\\/]main\.ts') { return $false }
    if ($p.CommandLine -match '--port\s+(\d+)') { return [int]$Matches[1] -eq $Port }
    return $Port -eq 8767
}

if (Test-Up) { return }
# Un démarrage peut être en cours (quelques secondes) : on recontrôle avant de relancer.
Start-Sleep -Seconds 5
if (Test-Up) { return }

if (-not (Test-Path $main)) { Write-Log "serveur absent : $main"; return }
$driver = Join-Path $root '.build\driver\sessions-desk-driver.exe'
if (-not (Test-Path $driver)) { Write-Log "pilote non compilé : $driver"; return }
if (-not $Node -or -not (Test-Path $Node)) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node) { Write-Log 'node introuvable'; return }

# Serveur vivant mais figé : Node tient lui-même le port, une relance échouerait. Candidats : le pid noté au
# dernier lancement, et le process qui écoute sur le port (un serveur lancé à la main). Chacun n'est arrêté que si
# sa ligne de commande est bien celle d'un serveur Node de ce port.
$cands = @()
$old = 0
if ((Test-Path $pidFile) -and [int]::TryParse("$(Get-Content $pidFile -Raw)".Trim(), [ref]$old)) { $cands += $old }
$cands += @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object OwningProcess)
foreach ($id in ($cands | Sort-Object -Unique)) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if (Test-OurServer $p) {
        Write-Log "serveur figé ou muet (pid $id) => arrêt"
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}
$holder = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object OwningProcess) | Select-Object -First 1
if ($holder) { Write-Log "port $Port tenu par un autre process (pid $holder) : pas de relance"; return }

# Garder la trace de l'erreur du serveur précédent avant qu'elle soit écrasée.
if ((Test-Path $errLog) -and (Get-Item $errLog).Length -gt 0) {
    Add-Content $log "--- stderr du serveur précédent :"
    Get-Content $errLog -Tail 20 | Add-Content $log
}
Write-Log "serveur muet sur $ping => relance ($main$(if ($AllowWrite) { ', écriture permise' }))"

$nodeArgs = @("`"$main`"", '--port', $Port) + @(if ($AllowWrite) { '--allow-write' })
$p = Start-Process $Node -WindowStyle Hidden -WorkingDirectory $root -PassThru `
    -ArgumentList $nodeArgs `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Set-Content $pidFile $p.Id
