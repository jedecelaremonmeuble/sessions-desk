using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

namespace SessionsDesk.Driver;

/// <summary>
/// Amène au premier plan l'onglet Windows Terminal qui héberge une session — portage de <c>legacy/focus-session.ps1</c>.
/// Windows Terminal n'expose pas le lien process → onglet. (1) Si UN SEUL onglet porte le titre actuel de la console
/// (témoin d'activité ✳ ◐ … ignoré), c'est lui. (2) Sinon titre-marqueur unique posé une seconde sur la console,
/// cherché parmi les onglets par UI Automation, puis titre d'origine remis.
/// Codes : 0 ok · 2 console inaccessible · 3 onglet introuvable. Les onglets sont énumérés par ItemContainerPattern
/// (barre d'onglets virtualisée, voir <see cref="Tabs"/>).
/// Différence avec le script : le pilote ne reste attaché à la console que le temps de lire / poser le titre
/// (sous ConScreen.Gate), pas pendant la recherche des onglets — les lectures d'écran ne l'attendent pas.
/// </summary>
static class Focus
{
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetConsoleTitleW(StringBuilder sb, uint n);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool SetConsoleTitleW(string t);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    static readonly Regex Activity = new(@"^\S\s+", RegexOptions.CultureInvariant);
    static string Strip(string? t) => Activity.Replace(t ?? "", "", 1);

    // Même nouvel essai que ConScreen.Attach : refus passager (code 1) quand un thread du process naît ou meurt.
    static bool Attach(uint pid)
    {
        for (int i = 0; ; i++)
        {
            if (AttachConsole(pid)) return true;
            if (Marshal.GetLastWin32Error() != 1 || i == 4) return false;
            System.Threading.Thread.Sleep(i);
        }
    }

    static string? GetTitle(uint pid)
    {
        lock (ConScreen.Gate)
        {
            FreeConsole();
            if (!Attach(pid)) return null;
            try { var sb = new StringBuilder(2048); GetConsoleTitleW(sb, 2048); return sb.ToString(); } finally { FreeConsole(); }
        }
    }
    static bool SetTitle(uint pid, string title)
    {
        lock (ConScreen.Gate)
        {
            FreeConsole();
            if (!Attach(pid)) return false;
            try { return SetConsoleTitleW(title); } finally { FreeConsole(); }
        }
    }

    static void Foreground(IntPtr h)
    {
        if (IsIconic(h)) ShowWindow(h, 9);                 // SW_RESTORE
        keybd_event(0x12, 0, 0, UIntPtr.Zero);             // Alt « à vide » : lève le verrou de premier plan
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(h);
    }

    static readonly Condition IsTab = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem);
    static readonly Condition IsWt = new PropertyCondition(AutomationElement.ClassNameProperty, "CASCADIA_HOSTING_WINDOW_CLASS");

    static readonly Condition IsTabList = new PropertyCondition(AutomationElement.AutomationIdProperty, "TabListView");

    // Tous les onglets, MÊME non matérialisés. La barre d'onglets (TabListView, ListView WinUI) est virtualisée :
    // passé une vingtaine d'onglets, seuls ceux autour de la zone visible existent dans l'arbre et FindAll ignore
    // les autres (22 trouvés sur 87 le 19/11/2026 : « onglet introuvable » pour 36 sessions sur 58).
    // ItemContainerPattern énumère tous les éléments, titre lisible compris ; repli sur FindAll sans ce motif.
    static IEnumerable<(AutomationElement win, AutomationElement tab)> Tabs()
    {
        foreach (AutomationElement win in AutomationElement.RootElement.FindAll(TreeScope.Children, IsWt))
        {
            var list = win.FindFirst(TreeScope.Descendants, IsTabList);
            if (list == null || !list.TryGetCurrentPattern(ItemContainerPattern.Pattern, out var p))
            {
                foreach (AutomationElement tab in win.FindAll(TreeScope.Descendants, IsTab)) yield return (win, tab);
                continue;
            }
            var ic = (ItemContainerPattern)p;
            AutomationElement? it = null;
            for (int n = 0; n < 1000 && (it = ic.FindItemByProperty(it, null, null)) != null; n++) yield return (win, it);
        }
    }

    static void ShowTab(AutomationElement win, AutomationElement tab, bool noActivate)
    {
        if (noActivate) return;
        // Un onglet non matérialisé n'est pas sélectionnable de façon fiable : on le matérialise d'abord.
        if (tab.TryGetCurrentPattern(VirtualizedItemPattern.Pattern, out var v)) ((VirtualizedItemPattern)v).Realize();
        ((SelectionItemPattern)tab.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();
        Foreground(new IntPtr(win.Current.NativeWindowHandle));
    }

    public static int Run(uint pid, bool noActivate)
    {
        var old = GetTitle(pid);
        if (old == null) return 2;

        // 1) Par le titre actuel : si UN SEUL onglet le porte, c'est lui — sans toucher au titre.
        var want = Strip(old);
        if (want.Length > 0)
        {
            var hits = new List<(AutomationElement, AutomationElement)>();
            foreach (var (win, tab) in Tabs()) if (Strip(tab.Current.Name) == want) hits.Add((win, tab));
            if (hits.Count == 1) { ShowTab(hits[0].Item1, hits[0].Item2, noActivate); return 0; }
        }

        // 2) Titre absent ou porté par plusieurs onglets : titre-marqueur temporaire.
        var marker = $"cc-focus-{pid}-{Guid.NewGuid():N}"[..(9 + pid.ToString().Length + 7)];
        int code = 3;
        try
        {
            if (!SetTitle(pid, marker)) return 2;
            for (int i = 0; i < 12 && code != 0; i++)
            {
                Thread.Sleep(200);
                foreach (var (win, tab) in Tabs())
                {
                    if (!(tab.Current.Name ?? "").Contains(marker, StringComparison.OrdinalIgnoreCase)) continue;
                    ShowTab(win, tab, noActivate);
                    code = 0; break;
                }
            }
        }
        finally { SetTitle(pid, old); }
        return code;
    }
}
