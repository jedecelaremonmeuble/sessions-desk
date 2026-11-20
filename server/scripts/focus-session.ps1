<#
.SYNOPSIS
  Amène au premier plan l'onglet Windows Terminal qui héberge une session Claude Code.
.DESCRIPTION
  Windows Terminal n'expose pas le lien process -> onglet. On le retrouve en posant, le temps
  d'une seconde, un titre-marqueur unique sur la console de la session (AttachConsole +
  SetConsoleTitle) : l'onglet qui affiche ce marqueur est le bon. On le sélectionne par UI
  Automation, on passe la fenêtre au premier plan, puis on remet le titre d'origine.
  Codes de sortie : 0 ok · 2 console inaccessible · 3 onglet introuvable.
#>
param([int]$TargetPid, [switch]$NoActivate,
      # Forme « cc-focus://<pid> » : c'est ce que reçoit le script au clic sur une notification.
      [string]$Uri)

$ErrorActionPreference = 'Stop'
if ($Uri -match '^cc-focus:/*(\d{1,9})/?$') { $TargetPid = [int]$Matches[1] }
if ($TargetPid -le 0) { exit 2 }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class ConTitle {
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetConsoleTitleW(StringBuilder sb, uint n);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool SetConsoleTitleW(string t);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    public static bool Attach(uint pid) { FreeConsole(); return AttachConsole(pid); }
    public static string Get() { var sb = new StringBuilder(2048); GetConsoleTitleW(sb, 2048); return sb.ToString(); }
    public static void Set(string t) { SetConsoleTitleW(t); }
    public static void Foreground(IntPtr h) {
        if (IsIconic(h)) ShowWindow(h, 9);                 // SW_RESTORE
        keybd_event(0x12, 0, 0, UIntPtr.Zero);             // Alt « à vide » : lève le verrou de premier plan
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(h);
    }
}
'@
if (-not [ConTitle]::Attach([uint32]$TargetPid)) { exit 2 }

$old = [ConTitle]::Get()
$marker = "cc-focus-$TargetPid-$([guid]::NewGuid().ToString('N').Substring(0, 6))"
$code = 3
$AE = [System.Windows.Automation.AutomationElement]
$isTab = [System.Windows.Automation.PropertyCondition]::new($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$isWt = [System.Windows.Automation.PropertyCondition]::new($AE::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
# Tous les onglets d'une fenêtre, MÊME non matérialisés. La barre d'onglets (TabListView, ListView WinUI)
# est virtualisée : passé une vingtaine d'onglets, seuls ceux autour de la zone visible existent dans l'arbre
# (FindAll les ignore — 22 trouvés sur 87 le 19/11/2026 : « onglet introuvable » pour 36 sessions sur 58).
# ItemContainerPattern énumère tous les éléments, titre lisible compris ; repli sur FindAll sans ce motif.
$isList = [System.Windows.Automation.PropertyCondition]::new($AE::AutomationIdProperty, 'TabListView')
function Get-Tabs($win) {
    $list = $win.FindFirst('Descendants', $isList)
    $ic = $null
    if ($list) { try { $ic = $list.GetCurrentPattern([System.Windows.Automation.ItemContainerPattern]::Pattern) } catch {} }
    if (-not $ic) { foreach ($t in $win.FindAll('Descendants', $isTab)) { $t }; return }
    $it = $null
    for ($n = 0; $n -lt 1000; $n++) { $it = $ic.FindItemByProperty($it, $null, $null); if (-not $it) { break }; $it }
}
function Show-Tab($win, $tab) {
    if (-not $NoActivate) {
        # Un onglet non matérialisé n'est pas sélectionnable de façon fiable : on le matérialise d'abord.
        try { $tab.GetCurrentPattern([System.Windows.Automation.VirtualizedItemPattern]::Pattern).Realize() } catch {}
        $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        [ConTitle]::Foreground([IntPtr]$win.Current.NativeWindowHandle)
    }
}

# 1) Par le titre actuel de la console : si UN SEUL onglet le porte, c'est lui — sans toucher au titre.
#    Le premier caractère est le témoin d'activité de Claude Code (✳ ◐ ◑…), qui change en continu : on l'ignore.
$strip = { param($t) "$t" -replace '^\S\s+', '' }
$want = & $strip $old
if ($want) {
    $hits = @(foreach ($win in $AE::RootElement.FindAll('Children', $isWt)) {
        foreach ($tab in Get-Tabs $win) { if ((& $strip $tab.Current.Name) -eq $want) { , @($win, $tab) } }
    })
    if ($hits.Count -eq 1) { Show-Tab $hits[0][0] $hits[0][1]; exit 0 }
}

# 2) Titre absent ou porté par plusieurs onglets : titre-marqueur temporaire. (Ne suffit pas seul : sur
#    certains onglets le titre posé de l'extérieur n'est pas répercuté.)
try {
    [ConTitle]::Set($marker)
    foreach ($try in 1..12) {
        Start-Sleep -Milliseconds 200
        foreach ($win in $AE::RootElement.FindAll('Children', $isWt)) {
            foreach ($tab in Get-Tabs $win) {
                if ($tab.Current.Name -notlike "*$marker*") { continue }
                Show-Tab $win $tab
                $code = 0; break
            }
            if ($code -eq 0) { break }
        }
        if ($code -eq 0) { break }
    }
} finally { [ConTitle]::Set($old) }
# Clic sur une notification : la session est « vue », on le dit à la page de suivi (au mieux).
# Pas quand c'est le serveur lui-même qui nous appelle : il attend notre fin et ne répondrait pas.
if ($Uri -and $code -eq 0) {
    try { $null = Invoke-RestMethod "http://localhost:8765/api/ack?pid=$TargetPid" -Method Post -Headers @{ Origin = 'http://localhost:8765' } -TimeoutSec 3 } catch {}
}
exit $code
