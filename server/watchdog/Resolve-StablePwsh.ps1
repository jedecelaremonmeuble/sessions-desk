# Chemin de pwsh à écrire dans une tâche planifiée : un chemin qui SURVIT aux mises à jour.
#
# PowerShell installé par le Store tourne depuis un dossier VERSIONNÉ
#   C:\Program Files\WindowsApps\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\pwsh.exe
# qui disparaît à la mise à jour suivante : une tâche qui le vise ne se lance plus, sans bruit. On écrit à la place
# l'alias d'exécution de l'application, stable (c'est ce que vise la tâche du .ps1) :
#   %LOCALAPPDATA%\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe
# à défaut l'alias générique %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe. Sans alias : refus, plutôt qu'une tâche
# qui cassera. Un pwsh hors Store (C:\Program Files\PowerShell\7\pwsh.exe…) est déjà stable : rendu tel quel.
function Resolve-StablePwsh {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$LocalAppData = $env:LOCALAPPDATA
    )
    if ($Path -notmatch '\\WindowsApps\\(Microsoft\.PowerShell(?:Preview)?)_[^_\\]+_[^_\\]*__([^_\\]+)\\pwsh\.exe$') { return $Path }
    $family = "$($Matches[1])_$($Matches[2])"
    $apps = Join-Path $LocalAppData 'Microsoft\WindowsApps'
    foreach ($c in (Join-Path $apps "$family\pwsh.exe"), (Join-Path $apps 'pwsh.exe')) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    throw "pwsh du Store au chemin versionné ($Path) et aucun alias d'exécution dans $apps : la tâche casserait à la prochaine mise à jour"
}
