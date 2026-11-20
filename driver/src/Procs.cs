using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Text.RegularExpressions;

namespace SessionsDesk.Driver;

/// <summary>
/// Process d'un nom donné — <c>Get-Process -Name claude</c> (sessions vivantes) et, avec <c>commandLine</c>,
/// <c>Get-CimInstance Win32_Process -Filter "Name='claude.exe'"</c> (runs du lanceur, reconnus à leur ligne de commande).
/// Résultat : [{pid, started (ms Unix)}] et, avec commandLine, la ligne de commande (null si illisible) et le pid du parent.
/// </summary>
static class Procs
{
    static readonly Regex SafeName = new(@"^[A-Za-z0-9._-]{1,64}$", RegexOptions.CultureInvariant);

    public static List<object?> List(string name, bool commandLine)
    {
        if (!SafeName.IsMatch(name)) throw new OpException("nom de process invalide");
        var r = new List<object?>();
        if (!commandLine)
        {
            foreach (var p in Process.GetProcessesByName(name))
            {
                using (p)
                {
                    long? started = null;
                    try { started = new DateTimeOffset(p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds(); } catch { }
                    r.Add(new Dictionary<string, object?> { ["pid"] = p.Id, ["started"] = started });
                }
            }
            return r;
        }
        using var q = new ManagementObjectSearcher($"SELECT ProcessId, ParentProcessId, CommandLine, CreationDate FROM Win32_Process WHERE Name='{name}.exe'");
        foreach (ManagementObject o in q.Get())
        {
            using (o)
            {
                long? started = null;
                try { started = new DateTimeOffset(ManagementDateTimeConverter.ToDateTime((string)o["CreationDate"]).ToUniversalTime()).ToUnixTimeMilliseconds(); } catch { }
                r.Add(new Dictionary<string, object?> { ["pid"] = Convert.ToInt32(o["ProcessId"]), ["started"] = started, ["commandLine"] = o["CommandLine"] as string, ["parent"] = Convert.ToInt32(o["ParentProcessId"]) });
            }
        }
        return r;
    }
}
