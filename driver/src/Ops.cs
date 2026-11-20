using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Threading;

namespace SessionsDesk.Driver;

/// <summary>
/// Les opérations du protocole. Chacune reprend un appel du serveur PowerShell :
/// <list type="bullet">
/// <item><c>title</c>, <c>foregroundTitle</c>, <c>idleSeconds</c>, <c>read</c>, <c>suggestion</c>, <c>send</c>, <c>sendKeys</c> : <c>[ConScreen]::…</c>, mêmes valeurs de retour ;</item>
/// <item><c>focus</c> : <c>focus-session.ps1</c> (codes 0 ok · 2 console inaccessible · 3 onglet introuvable) ;</item>
/// <item><c>wt</c> : <c>Start-Process wt.exe -ArgumentList …</c> (ouverture d'onglet), lancé hors lecture d'écran ;</item>
/// <item><c>toast</c> : <c>Show-Toast</c>.</item>
/// </list>
/// </summary>
static class Ops
{
    public static object? Run(string op, JsonElement a, bool testOps)
    {
        switch (op)
        {
            case "ping": return new Dictionary<string, object?> { ["version"] = Program.Version, ["pid"] = Environment.ProcessId };
            case "title": return ConScreen.Title(Pid(a));
            case "foregroundTitle": return ConScreen.ForegroundTerminalTitle();
            case "idleSeconds": return ConScreen.IdleSeconds();
            case "read": return ConScreen.Read(Pid(a));
            case "suggestion": return ConScreen.Suggestion(Pid(a));
            case "send": return ConScreen.Send(Pid(a), Str(a, "line"));
            case "sendKeys": return ConScreen.SendKeys(Pid(a), StrArray(a, "items"));
            case "focus": return Focus.Run(Pid(a), Bool(a, "noActivate"));
            case "wt": return StartWt(Str(a, "args"));
            case "toast": Toast.Show(Str(a, "title"), Str(a, "text"), Str(a, "launch")); return true;
            case "procs": return Procs.List(Str(a, "name"), Bool(a, "commandLine"));
        }
        if (testOps)
        {
            // Opérations de test seulement (--test-ops) : simuler un pilote figé ou mort.
            switch (op)
            {
                case "test.sleep": Thread.Sleep(Int(a, "ms")); return true;
                case "test.holdGate": lock (ConScreen.Gate) Thread.Sleep(Int(a, "ms")); return true;
                case "test.exit": Environment.Exit(Int(a, "code")); return null;
                case "test.toastXml": return Toast.Xml(Str(a, "title"), Str(a, "text"), Str(a, "launch"));
                case "test.attachLoop":
                    {
                        var ps = new List<uint>();
                        foreach (var x in a.GetProperty("pids").EnumerateArray()) ps.Add(x.GetUInt32());
                        int th = a.TryGetProperty("threads", out var tv) ? tv.GetInt32() : 1;
                        if (a.TryGetProperty("titleChurn", out var tc) && tc.ValueKind == JsonValueKind.True) return AttachProbe.TitleChurn(ps.ToArray(), Int(a, "n"));
                        if (a.TryGetProperty("tight", out var tg) && tg.ValueKind == JsonValueKind.True) return AttachProbe.Tight(ps.ToArray(), Int(a, "n"), a.TryGetProperty("handoff", out var ho) && ho.ValueKind == JsonValueKind.True, a.TryGetProperty("gapUs", out var gu) ? gu.GetInt32() : 0, a.TryGetProperty("newThread", out var nt) && nt.ValueKind == JsonValueKind.True);
                        if (a.TryGetProperty("title", out var tt) && tt.ValueKind == JsonValueKind.True) return AttachProbe.TitleLoop(ps.ToArray(), Int(a, "n"), Math.Max(1, th));
                        return AttachProbe.Run(ps.ToArray(), Int(a, "n"), a.TryGetProperty("pauseMs", out var pm) ? pm.GetInt32() : 0, th);
                    }
                // Diagnostic : l'attache à une console réussit-elle, et sinon avec quel code Win32 ?
                case "test.attach":
                    lock (ConScreen.Gate)
                    {
                        FreeConsole();
                        bool ok = AttachConsole(Pid(a)); int err = ok ? 0 : System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                        FreeConsole();
                        return new Dictionary<string, object?> { ["ok"] = ok, ["error"] = err };
                    }
            }
        }
        throw new OpException("opération inconnue : " + op);
    }

    // Ouverture d'onglet : comme Invoke-GitQuiet, jamais pendant qu'une lecture d'écran est attachée à la console
    // d'une session (même verrou) — sinon le lancement échoue (« Descripteur non valide »).
    static object StartWt(string arguments)
    {
        var psi = new ProcessStartInfo("wt.exe", arguments) { UseShellExecute = true };
        Process? p;
        lock (ConScreen.Gate) p = Process.Start(psi);
        return new Dictionary<string, object?> { ["pid"] = p?.Id };
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool FreeConsole();
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);

    static uint Pid(JsonElement a)
    {
        if (a.ValueKind == JsonValueKind.Object && a.TryGetProperty("pid", out var v) && v.TryGetUInt32(out var pid) && pid > 0) return pid;
        throw new OpException("pid manquant ou invalide");
    }
    static string Str(JsonElement a, string name)
    {
        if (a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String) return v.GetString()!;
        throw new OpException(name + " manquant");
    }
    static string[] StrArray(JsonElement a, string name)
    {
        if (a.ValueKind != JsonValueKind.Object || !a.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Array) throw new OpException(name + " manquant");
        var r = new List<string>();
        foreach (var x in v.EnumerateArray())
        {
            if (x.ValueKind != JsonValueKind.String) throw new OpException(name + " : texte attendu");
            r.Add(x.GetString()!);
        }
        return r.ToArray();
    }
    static bool Bool(JsonElement a, string name) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
    static int Int(JsonElement a, string name)
    {
        if (a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.TryGetInt32(out var i)) return i;
        throw new OpException(name + " manquant");
    }
}
