<#
.SYNOPSIS
  Tests de Deploy-Plan.ps1 : la décision « redémarrer ou remplacer la page » et le remplacement à chaud.
.DESCRIPTION
  La décision est testée sur des listes de fichiers ET sur de vrais écarts de l'historique du dépôt ; le remplacement
  sur une copie FACTICE (dossier temporaire) : ni la copie de production, ni son serveur, ni aucune tâche ne sont
  touchés. Se lance depuis un clone complet (l'historique sert de jeu de données).
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deploy-Plan.ps1')
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

$script:fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host "ok   $name" } else { $script:fail++; Write-Host "FAIL $name $detail" }
}

# ── Décision sur des listes ──
Check 'page seule ⇒ page' ((Get-DeployPlan @('page/app.js', 'page/app.css')) -eq 'page')
Check 'page + tests ⇒ page (les tests ne sont pas dans la copie)' ((Get-DeployPlan @('page/app.js', 'server/test/x.test.ts')) -eq 'page')
Check 'code du serveur ⇒ restart' ((Get-DeployPlan @('page/app.js', 'server/src/http.ts')) -eq 'restart')
Check 'package.json du serveur ⇒ restart' ((Get-DeployPlan @('server/package.json')) -eq 'restart')
Check 'watchdog ⇒ restart' ((Get-DeployPlan @('server/watchdog/Deploy.ps1')) -eq 'restart')
Check 'scripts ⇒ restart' ((Get-DeployPlan @('server/scripts/guard.mjs')) -eq 'restart')
Check 'pilote ⇒ restart' ((Get-DeployPlan @('driver/src/Procs.cs')) -eq 'restart')
Check 'tests, README seuls ⇒ none' ((Get-DeployPlan @('server/test/a.test.ts', 'README.md', '.github/workflows/ci.yml')) -eq 'none')
Check 'rien ⇒ none' ((Get-DeployPlan @()) -eq 'none')
Check 'séparateurs Windows acceptés' ((Get-DeployPlan @('server\src\http.ts')) -eq 'restart')
Check 'préfixe trompeur (server/srcx) ⇒ pas restart' ((Get-DeployPlan @('server/srcx/a.ts')) -eq 'none')

# ── Décision sur de vrais écarts de l'historique ──
function Plan([string]$a, [string]$b) { Get-DeployPlan @(git -C $repo diff --name-only $a $b) }
$have = { param($c) git -C $repo cat-file -e "$c^{commit}" 2>$null; -not $LASTEXITCODE }
if ((& $have '681f35c') -and (& $have 'ecb83b3') -and (& $have 'e56ea97') -and (& $have '3b94614')) {
    Check 'historique : correctif de page (#12) ⇒ page' ((Plan '681f35c' 'ecb83b3') -eq 'page')
    Check 'historique : page + serveur (#14) ⇒ restart' ((Plan 'e56ea97' '681f35c') -eq 'restart')
    Check 'historique : tests seuls (#11) ⇒ none' ((Plan '3b94614' 'e56ea97') -eq 'none')
} else { Write-Host 'skip historique (clone incomplet)' }

# ── DEPLOYED.txt ──
$fake = (New-Item -ItemType Directory -Force (Join-Path ([IO.Path]::GetTempPath()) "sd-deploy-plan-$PID")).FullName
try {
    Check 'pas de DEPLOYED.txt ⇒ $null' ($null -eq (Get-DeployedCommit $fake))
    Set-Content (Join-Path $fake 'DEPLOYED.txt') 'commit abc'
    Check 'DEPLOYED.txt illisible ⇒ $null' ($null -eq (Get-DeployedCommit $fake))

    # ── Remplacement à chaud sur une copie factice : page de 681f35c → page de ecb83b3 ──
    if ((& $have '681f35c') -and (& $have 'ecb83b3')) {
        $from = (git -C $repo rev-parse 681f35c).Trim(); $to = (git -C $repo rev-parse ecb83b3).Trim()
        $zip = Join-Path $fake 'p.zip'
        git -C $repo archive --format=zip -o $zip $from page; Expand-Archive $zip $fake -Force; Remove-Item $zip
        Set-Content (Join-Path $fake 'page\obsolete.js') 'retiré par le commit suivant'
        Set-Content (Join-Path $fake 'DEPLOYED.txt') @("commit $from (origin/main)", 'posé le …', 'mode PRIMARY')
        Check 'DEPLOYED.txt ⇒ commit lu' ((Get-DeployedCommit $fake) -eq $from)

        Update-RunCopy -Repo $repo -Head $to -RunDir $fake -Plan 'page' -Running $from
        $want = (git -C $repo show "${to}:page/app.js") -join "`n"
        $got = (Get-Content (Join-Path $fake 'page\app.js')) -join "`n"
        Check 'app.js remplacé par celui du nouveau commit' ($got -eq $want)
        Check 'fichier disparu du commit retiré' (-not (Test-Path (Join-Path $fake 'page\obsolete.js')))
        Check 'aucun .tmp ni page.new laissé' (-not (Get-ChildItem $fake -Recurse -Filter '*.tmp') -and -not (Test-Path (Join-Path $fake 'page.new')))
        Check 'DEPLOYED.txt pointe le nouveau commit' ((Get-DeployedCommit $fake) -eq $to)
        Check 'DEPLOYED.txt garde le commit de démarrage du serveur' ((Get-Content (Join-Path $fake 'DEPLOYED.txt') -Raw) -match "page remplacée à chaud .*serveur démarré sur $($from.Substring(0, 10))")
    } else { Write-Host 'skip remplacement (clone incomplet)' }
} finally { Remove-Item $fake -Recurse -Force -ErrorAction SilentlyContinue }

if ($script:fail) { Write-Host "$($script:fail) échec(s)"; exit 1 }
Write-Host 'tous les tests passent'
