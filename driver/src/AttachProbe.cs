using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace SessionsDesk.Driver;

/// <summary>
/// DIAGNOSTIC (--test-ops seulement) : rejoue N fois la séquence de ConScreen.Title — FreeConsole, AttachConsole,
/// GetConsoleTitleW, FreeConsole — en alternant entre plusieurs consoles, et relève chaque refus d'attache avec son code
/// Win32, la console d'avant et le délai depuis le FreeConsole. <c>pauseMs</c> &gt; 0 : pause entre FreeConsole et
/// AttachConsole (hypothèse d'un détachement encore en cours côté conhost).
/// </summary>
static class AttachProbe
{
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetConsoleTitleW(StringBuilder sb, uint n);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    // À l'échelle du PROCESS (un process n'a qu'une console) : dernière console quittée et quand.
    static uint lastPid; static long lastFreeTicks;

    /// <summary>threads &gt; 1 : la boucle répartie sur plusieurs threads (comme les requêtes parallèles du pilote).</summary>
    public static Dictionary<string, object?> Run(uint[] pids, int n, int pauseMs, int threads)
    {
        if (threads <= 1) return RunCore(pids, n, pauseMs, 0);
        var parts = new Dictionary<string, object?>[threads];
        var ts = new Thread[threads];
        for (int t = 0; t < threads; t++) { int k = t; ts[t] = new Thread(() => parts[k] = RunCore(pids, n / threads, pauseMs, k)); ts[t].Start(); }
        foreach (var t in ts) t.Join();
        int ok = 0, failed = 0, retryOk = 0; var fails = new List<object?>(); var byErr = new Dictionary<string, int>();
        foreach (var p in parts)
        {
            ok += (int)p["ok"]!; failed += (int)p["failed"]!; retryOk += (int)p["retryOk"]!;
            foreach (var f in (List<object?>)p["fails"]!) if (fails.Count < 40) fails.Add(f);
            foreach (var kv in (Dictionary<string, object?>)p["byError"]!) byErr[kv.Key] = (byErr.TryGetValue(kv.Key, out var c) ? c : 0) + (int)kv.Value!;
        }
        var be = new Dictionary<string, object?>(); foreach (var kv in byErr) be[kv.Key] = kv.Value;
        return new Dictionary<string, object?> { ["n"] = n, ["threads"] = threads, ["ok"] = ok, ["failed"] = failed, ["retryOk"] = retryOk, ["byError"] = be, ["fails"] = fails };
    }

    /// <summary>Le vrai ConScreen.Title, en parallèle sur plusieurs threads : nombre de null (attache refusée).</summary>
    public static Dictionary<string, object?> TitleLoop(uint[] pids, int n, int threads)
    {
        int nulls = 0; var byPid = new Dictionary<string, int>(); var ts = new Thread[threads];
        for (int t = 0; t < threads; t++)
        {
            int k = t;
            ts[t] = new Thread(() =>
            {
                for (int i = 0; i < n / threads; i++)
                {
                    uint pid = pids[(i + k) % pids.Length];
                    if (ConScreen.Title(pid) == null) lock (byPid) { nulls++; byPid[pid.ToString()] = (byPid.TryGetValue(pid.ToString(), out var c) ? c : 0) + 1; }
                }
            });
            ts[t].Start();
        }
        foreach (var t in ts) t.Join();
        var bp = new Dictionary<string, object?>(); foreach (var kv in byPid) bp[kv.Key] = kv.Value;
        return new Dictionary<string, object?> { ["n"] = n, ["threads"] = threads, ["nulls"] = nulls, ["byPid"] = bp };
    }

    static Dictionary<string, object?> RunCore(uint[] pids, int n, int pauseMs, int offset)
    {
        var fails = new List<object?>();
        var byErr = new Dictionary<string, object?>();
        var byPid = new Dictionary<string, object?>();
        uint prev = 0; int okCount = 0; int retryOk = 0;
        var sw = new Stopwatch();
        for (int i = 0; i < n; i++)
        {
            uint pid = pids[(i + offset) % pids.Length];
            lock (ConScreen.Gate)
            {
                bool hadConsole = GetConsoleWindow() != IntPtr.Zero;
                uint procPrev = lastPid; double sinceFree = lastFreeTicks == 0 ? -1 : (Stopwatch.GetTimestamp() - lastFreeTicks) * 1000.0 / Stopwatch.Frequency;
                FreeConsole();
                sw.Restart();
                if (pauseMs > 0) Thread.Sleep(pauseMs);
                bool ok = AttachConsole(pid);
                int err = ok ? 0 : Marshal.GetLastWin32Error();
                double ms = sw.Elapsed.TotalMilliseconds;
                if (ok) { okCount++; var sb = new StringBuilder(256); GetConsoleTitleW(sb, 256); }
                FreeConsole(); lastPid = pid; lastFreeTicks = Stopwatch.GetTimestamp();
                if (!ok)
                {
                    // Nouvel essai immédiat, puis après 20 ms : l'échec est-il passager ?
                    bool again = AttachConsole(pid); int err2 = again ? 0 : Marshal.GetLastWin32Error(); FreeConsole();
                    bool later = false; int err3 = 0;
                    if (!again) { Thread.Sleep(20); later = AttachConsole(pid); err3 = later ? 0 : Marshal.GetLastWin32Error(); FreeConsole(); }
                    if (again || later) retryOk++;
                    fails.Add(new Dictionary<string, object?> { ["i"] = i, ["pid"] = (long)pid, ["prev"] = (long)prev, ["error"] = err, ["ms"] = ms,
                        ["hadConsole"] = hadConsole, ["procPrev"] = (long)procPrev, ["sinceLastFreeMs"] = sinceFree, ["retry"] = again ? 0 : err2, ["retry20ms"] = again ? null : (later ? 0 : err3) });
                    string k = err.ToString(); byErr[k] = (byErr.TryGetValue(k, out var c) ? (int)c! : 0) + 1;
                    string kp = pid.ToString(); byPid[kp] = (byPid.TryGetValue(kp, out var d) ? (int)d! : 0) + 1;
                }
            }
            prev = pid;
        }
        if (fails.Count > 40) fails = fails.GetRange(0, 40);
        return new Dictionary<string, object?> { ["n"] = n, ["ok"] = okCount, ["failed"] = n - okCount, ["retryOk"] = retryOk, ["byError"] = byErr, ["byPid"] = byPid, ["fails"] = fails, ["thread"] = Environment.CurrentManagedThreadId };
    }
    /// <summary>
    /// Ré-attache immédiate : FreeConsole puis AttachConsole, sans rien entre deux, sur la liste de consoles (même console
    /// répétée ou consoles différentes). handoff : chaque attache faite par l'autre thread (passage de relais).
    /// gapUs : attente active entre FreeConsole et l'attache suivante.
    /// </summary>
    public static Dictionary<string, object?> Tight(uint[] pids, int n, bool handoff, int gapUs, bool newThread = false)
    {
        if (newThread) return FreshThreads(pids, n);
        if (gapUs < 0) return Churn(pids, n, -gapUs == 1 || -gapUs == 3, -gapUs == 3);
        int fails = 0; var byErr = new Dictionary<string, object?>(); var gap = (long)(gapUs * (Stopwatch.Frequency / 1e6));
        void One(int i)
        {
            uint pid = pids[i % pids.Length];
            if (gap > 0) { long t = Stopwatch.GetTimestamp(); while (Stopwatch.GetTimestamp() - t < gap) { } }
            if (!AttachConsole(pid)) { fails++; string k = Marshal.GetLastWin32Error().ToString(); byErr[k] = (byErr.TryGetValue(k, out var c) ? (int)c! : 0) + 1; }
            FreeConsole();
        }
        lock (ConScreen.Gate)
        {
            FreeConsole();
            if (!handoff) for (int i = 0; i < n; i++) One(i);
            else
            {
                var turn = new SemaphoreSlim[] { new(1), new(0) };
                var ts = new Thread[2];
                for (int k = 0; k < 2; k++)
                {
                    int me = k;
                    ts[k] = new Thread(() => { for (int i = me; i < n; i += 2) { turn[me].Wait(); One(i); turn[1 - me].Release(); } });
                    ts[k].Start();
                }
                foreach (var t in ts) t.Join();
            }
        }
        return new Dictionary<string, object?> { ["n"] = n, ["handoff"] = handoff, ["gapUs"] = gapUs, ["failed"] = fails, ["byError"] = byErr };
    }
    /// <summary>Chaque attache sur un thread NEUF (créé, une attache, terminé), à la suite, sous le verrou.</summary>
    static Dictionary<string, object?> FreshThreads(uint[] pids, int n)
    {
        int fails = 0, failsSecond = 0; var byErr = new Dictionary<string, object?>(); var firstFailIdx = new List<object?>();
        lock (ConScreen.Gate)
        {
            FreeConsole();
            for (int i = 0; i < n; i++)
            {
                uint pid = pids[i % pids.Length]; bool ok = false; int err = 0; bool ok2 = true;
                var t = new Thread(() => {
                    ok = AttachConsole(pid); err = ok ? 0 : Marshal.GetLastWin32Error(); FreeConsole();
                    if (!ok) { ok2 = AttachConsole(pid); FreeConsole(); }   // 2e essai, sur le MÊME thread
                });
                t.Start(); t.Join();
                if (!ok) { fails++; if (!ok2) failsSecond++; string k = err.ToString(); byErr[k] = (byErr.TryGetValue(k, out var c) ? (int)c! : 0) + 1; if (firstFailIdx.Count < 10) firstFailIdx.Add(i); }
            }
        }
        return new Dictionary<string, object?> { ["n"] = n, ["newThread"] = true, ["failed"] = fails, ["failedAgainSameThread"] = failsSecond, ["byError"] = byErr, ["at"] = firstFailIdx };
    }
    /// <summary>
    /// Attaches en boucle sur un thread pendant que d'AUTRES threads, sans rien faire de la console, naissent et meurent en
    /// continu (churn = true) ou tournent sans s'arrêter (témoin : même charge, pas de création de thread).
    /// </summary>
    [DllImport("kernel32.dll")] static extern IntPtr CreateThread(IntPtr sa, UIntPtr stack, IntPtr start, IntPtr param, uint flags, out uint id);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr m, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);

    static Dictionary<string, object?> Churn(uint[] pids, int n, bool churn, bool native = false)
    {
        // Thread natif : point d'entrée = kernel32!GetCurrentThreadId (aucun code .NET, aucun runtime dans le thread).
        IntPtr noop = GetProcAddress(GetModuleHandleW("kernel32.dll"), "GetCurrentThreadId");
        int fails = 0, created = 0; var byErr = new Dictionary<string, object?>(); bool stop = false;
        var bg = new List<Thread>();
        for (int k = 0; k < 4; k++)
        {
            var t = new Thread(() => {
                while (!Volatile.Read(ref stop))
                {
                    if (churn && native) { var h = CreateThread(IntPtr.Zero, UIntPtr.Zero, noop, IntPtr.Zero, 0, out _); WaitForSingleObject(h, 5000); CloseHandle(h); Interlocked.Increment(ref created); }
                    else if (churn) { var x = new Thread(() => { }); x.Start(); x.Join(); Interlocked.Increment(ref created); }
                    else { Thread.SpinWait(2000); }
                }
            }) { IsBackground = true };
            t.Start(); bg.Add(t);
        }
        lock (ConScreen.Gate)
        {
            FreeConsole();
            for (int i = 0; i < n; i++)
            {
                uint pid = pids[i % pids.Length];
                if (!AttachConsole(pid)) { fails++; string k = Marshal.GetLastWin32Error().ToString(); byErr[k] = (byErr.TryGetValue(k, out var c) ? (int)c! : 0) + 1; }
                FreeConsole();
            }
        }
        Volatile.Write(ref stop, true); foreach (var t in bg) t.Join();
        return new Dictionary<string, object?> { ["n"] = n, ["churn"] = churn, ["native"] = native, ["threadsCreated"] = created, ["failed"] = fails, ["byError"] = byErr };
    }
    /// <summary>
    /// Le VRAI ConScreen.Title (et Read) pendant que d'autres threads naissent et meurent en continu (natifs) :
    /// nombre de null rendus sur une console vivante. Sert au test de non-régression du nouvel essai d'attache.
    /// </summary>
    public static Dictionary<string, object?> TitleChurn(uint[] pids, int n)
    {
        IntPtr noop = GetProcAddress(GetModuleHandleW("kernel32.dll"), "GetCurrentThreadId");
        bool stop = false; int created = 0, nullTitle = 0, nullRead = 0;
        var bg = new List<Thread>();
        for (int k = 0; k < 4; k++)
        {
            var t = new Thread(() => { while (!Volatile.Read(ref stop)) { var h = CreateThread(IntPtr.Zero, UIntPtr.Zero, noop, IntPtr.Zero, 0, out _); WaitForSingleObject(h, 5000); CloseHandle(h); Interlocked.Increment(ref created); } }) { IsBackground = true };
            t.Start(); bg.Add(t);
        }
        for (int i = 0; i < n; i++)
        {
            uint pid = pids[i % pids.Length];
            if (ConScreen.Title(pid) == null) nullTitle++;
            if (i % 10 == 0 && ConScreen.Read(pid) == null) nullRead++;
        }
        Volatile.Write(ref stop, true); foreach (var t in bg) t.Join();
        return new Dictionary<string, object?> { ["n"] = n, ["threadsCreated"] = created, ["nullTitle"] = nullTitle, ["nullRead"] = nullRead, ["reads"] = (n + 9) / 10 };
    }
}
