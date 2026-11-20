<#
.SYNOPSIS
  Décision du déploiement (pure, sans effet) : faut-il redémarrer le serveur, ou suffit-il de remplacer la page ?
.DESCRIPTION
  Le serveur de production tourne sur une COPIE d'un commit (Install-NodeWatchdog.ps1, git archive) et relit la page
  (page/) sur disque à chaque requête ; la page ouverte repère que ses fichiers ont changé et se recharge seule. Un
  déploiement qui ne touche que page/ n'a donc pas à arrêter le serveur — l'arrêter, c'est une coupure pour rien.

  Est « du serveur » tout ce que la copie contient en dehors de page/, plus le pilote (compilé dans la copie) :
  server/src, server/package.json, server/watchdog, server/scripts, driver, legacy. Le reste (tests, README,
  workflows…) n'est pas dans la copie : il ne compte pas.
#>

$script:ServerPaths = @('server/src/', 'server/package.json', 'server/watchdog/', 'server/scripts/', 'driver/', 'legacy/')

<# Fichiers modifiés entre deux commits → 'none' (rien qui concerne la copie), 'page' (page seule) ou 'restart'. #>
function Get-DeployPlan([string[]]$Changed) {
    $files = @($Changed | Where-Object { $_ } | ForEach-Object { $_.Trim().Replace('\', '/') })
    foreach ($f in $files) { foreach ($p in $script:ServerPaths) { if ($f -eq $p.TrimEnd('/') -or $f.StartsWith($p)) { return 'restart' } } }
    if ($files | Where-Object { $_.StartsWith('page/') }) { return 'page' }
    return 'none'
}

<# Commit inscrit dans DEPLOYED.txt de la copie (première ligne « commit <sha> … »), ou $null. #>
function Get-DeployedCommit([string]$RunDir) {
    $f = Join-Path $RunDir 'DEPLOYED.txt'
    if (-not (Test-Path $f)) { return $null }
    $first = @(Get-Content $f -TotalCount 1)[0]
    if ("$first" -match '^commit ([0-9a-f]{40})\b') { return $Matches[1] }
    return $null
}

<# Met la copie en service au niveau de $Head sans arrêter le serveur : page/ remplacée (plan 'page'), puis
   DEPLOYED.txt réécrit — la copie correspond désormais à $Head, base du prochain déploiement. #>
function Update-RunCopy([string]$Repo, [string]$Head, [string]$RunDir, [string]$Plan, [string]$Running) {
    if ($Plan -eq 'page') {
        $zip = Join-Path $env:TEMP "sessions-desk-page-$($Head.Substring(0, 7)).zip"; $tmp = Join-Path $RunDir 'page.new'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        git -C $Repo archive --format=zip -o $zip $Head page
        if ($LASTEXITCODE -ne 0) { throw 'git archive en échec' }
        Expand-Archive $zip $tmp -Force; Remove-Item $zip
        $new = Join-Path $tmp 'page'; $dst = Join-Path $RunDir 'page'
        # Fichier par fichier, écrit à côté puis renommé : le serveur ne sert jamais un app.js à moitié copié.
        foreach ($f in Get-ChildItem $new -File -Recurse) {
            $t = Join-Path $dst $f.FullName.Substring($new.Length + 1)
            $null = New-Item -ItemType Directory -Force (Split-Path $t -Parent)
            Copy-Item $f.FullName "$t.tmp" -Force
            for ($i = 0; ; $i++) { try { Move-Item "$t.tmp" $t -Force; break } catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 100 } }
        }
        foreach ($f in Get-ChildItem $dst -File -Recurse) { if (-not (Test-Path (Join-Path $new $f.FullName.Substring($dst.Length + 1)))) { Remove-Item $f.FullName -Force } }
        Remove-Item $tmp -Recurse -Force
    }
    # La copie correspond désormais à $Head : c'est la base du prochain déploiement.
    $onMain = (git -C $Repo rev-parse origin/main).Trim() -eq $Head
    $lines = @(Get-Content (Join-Path $RunDir 'DEPLOYED.txt'))
    $lines[0] = "commit $Head$(if ($onMain) { ' (origin/main)' } else { ' (PAS origin/main)' })"
    $lines += "$(if ($Plan -eq 'page') { 'page remplacée à chaud' } else { 'rien à remplacer' }) le $(Get-Date -Format s) (serveur démarré sur $($Running.Substring(0, 10)))"
    Set-Content (Join-Path $RunDir 'DEPLOYED.txt') $lines
}
