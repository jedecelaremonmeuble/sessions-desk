using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace SessionsDesk.Driver;

/// <summary>
/// CONSOLE DE TEST (<c>--fake-console</c>) : tient le rôle d'une session Claude Code pour les tests du pilote, qui ne
/// lisent et n'écrivent JAMAIS dans une vraie session (un envoi y écrirait un message).
/// Affiche un écran connu et une invite « ❯ » dans l'un des trois états que ConScreen distingue — vide (curseur
/// juste après « ❯ »), avec une proposition grisée (même curseur), avec un brouillon (curseur déplacé) — puis
/// journalise chaque touche reçue dans <c>--log</c> (une ligne JSON par touche enfoncée), sans rien afficher : le
/// curseur ne bouge pas, l'invite reste dans son état.
/// Lancée dans SA console (<c>cmd /c start</c>) ; écrit son pid dans <c>--pidfile</c> une fois l'écran prêt ;
/// s'arrête seule après <c>--ttl</c> secondes (120 par défaut) pour ne jamais laisser de fenêtre derrière un test cassé.
/// </summary>
static class FakeConsole
{
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public int bKeyDown;
        [FieldOffset(8)] public ushort wRepeatCount;
        [FieldOffset(10)] public ushort wVirtualKeyCode;
        [FieldOffset(12)] public ushort wVirtualScanCode;
        [FieldOffset(14)] public char UnicodeChar;
        [FieldOffset(16)] public uint dwControlKeyState;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ReadConsoleInputW(IntPtr h, [Out] INPUT_RECORD[] buf, uint len, out uint read);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint mode);

    static string? Opt(List<string> a, string name)
    {
        int i = a.IndexOf(name);
        return i >= 0 && i + 1 < a.Count ? a[i + 1] : null;
    }

    public static int Run(List<string> args)
    {
        string log = Opt(args, "--log") ?? throw new ArgumentException("--log manquant");
        string? pidfile = Opt(args, "--pidfile");
        string mode = Opt(args, "--mode") ?? "empty";
        string suggestion = Opt(args, "--suggestion") ?? "ouvre la PR";
        int ttl = int.TryParse(Opt(args, "--ttl"), out var t) ? t : 120;
        string title = Opt(args, "--title") ?? $"sessions-desk-test-{Environment.ProcessId}";

        new Thread(() => { Thread.Sleep(ttl * 1000); Environment.Exit(0); }) { IsBackground = true }.Start();

        Console.OutputEncoding = new UTF8Encoding(false);
        Console.Title = title;
        Console.Clear();
        // --no-banner : écran de démonstration (npm run demo), sans les deux lignes de test.
        if (!args.Contains("--no-banner"))
        {
            Console.WriteLine("Console de test du pilote sessions-desk — à ne pas utiliser.");
            Console.WriteLine("Ligne accentuée : é à ç ✓ « guillemets »");
        }
        // --text-file : lignes affichées avant l'invite (dialogue à choix, indicateur « ✻ Verbe… (12s · esc to interrupt) »).
        string? textFile = Opt(args, "--text-file");
        if (textFile != null) foreach (var l in File.ReadAllLines(textFile)) Console.WriteLine(l);
        Console.WriteLine(new string('─', 40));
        int y = Console.CursorTop;
        switch (mode)
        {
            case "suggestion": Console.Write("❯ " + suggestion); break;
            case "draft": Console.Write("❯ brouillon en cours"); break;
            default: Console.Write("❯ "); break;
        }
        Console.WriteLine();
        Console.WriteLine(new string('─', 40));
        Console.WriteLine("  ? for shortcuts");
        Console.SetCursorPosition(mode == "draft" ? 20 : 2, y);

        IntPtr hin = GetStdHandle(-10);
        SetConsoleMode(hin, 0);              // ni écho, ni ligne : on lit les touches brutes
        using var w = new StreamWriter(log, append: true, new UTF8Encoding(false)) { AutoFlush = true };
        if (pidfile != null) File.WriteAllText(pidfile, Environment.ProcessId.ToString());

        var buf = new INPUT_RECORD[64];
        while (true)
        {
            if (!ReadConsoleInputW(hin, buf, (uint)buf.Length, out var n)) return 2;
            for (int i = 0; i < n; i++)
            {
                var r = buf[i];
                if (r.EventType != 1 || r.bKeyDown == 0) continue;
                if (r.UnicodeChar == '\u0011') return 0;     // Ctrl+Q : sortie PROPRE (un onglet Windows Terminal se ferme seul)
                w.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object>
                {
                    ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ["vk"] = (int)r.wVirtualKeyCode,
                    ["ch"] = r.UnicodeChar.ToString(),
                    ["ctrl"] = (long)r.dwControlKeyState,
                }));
            }
        }
    }
}
