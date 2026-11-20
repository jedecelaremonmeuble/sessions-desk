<#
.SYNOPSIS
  Fait /exit sur les sessions Claude Code « idle » et les relance à l'identique
  (mêmes arguments + --resume <sessionId>), dans le MÊME onglet de terminal.

.DESCRIPTION
  Utile quand un MCP (Microsoft 365, …) ne se reconnecte qu'au redémarrage du process.

  Source de vérité : ~/.claude/sessions/<pid>.json (status, sessionId, cwd).
  Seul le statut « idle » est touché : « busy », « waiting » (question en attente) et
  « shell » (commande d'arrière-plan en cours) sont laissés tranquilles.

  Mécanisme : un process auxiliaire s'attache à la console de la session
  (AttachConsole) et y écrit les touches (WriteConsoleInput) : « /exit », puis, une fois
  le process claude terminé et le shell parent revenu à son invite, la ligne de relance.

  Une session dont l'invite contient un brouillon est ignorée (lu sur l'écran : le curseur
  n'est pas juste après « ❯ »), pour ne pas envoyer « brouillon/exit » au modèle.

  Limite connue : un prompt passé en argument positionnel au lancement serait rejoué.

.EXAMPLE
  restart-idle-sessions.ps1 -WhatIf              # liste ce qui serait relancé
  restart-idle-sessions.ps1                      # toutes les idle depuis >= 5 min
  restart-idle-sessions.ps1 -MinIdleMinutes 0 -Only backend-f1,117620
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Main')]
param(
    # Ancienneté minimale du statut idle (évite de couper une session qu'on vient de quitter des yeux).
    [Parameter(ParameterSetName = 'Main')][int]$MinIdleMinutes = 5,
    # Restreindre : noms de session, pids ou débuts de sessionId.
    [Parameter(ParameterSetName = 'Main')][string[]]$Only,
    [int]$ExitTimeoutSeconds = 30,

    # --- interne : mode auxiliaire, un process par session ---
    [Parameter(ParameterSetName = 'Worker', Mandatory)][int]$WorkerPid,
    [Parameter(ParameterSetName = 'Worker', Mandatory)][string]$WorkerSessionId,
    [Parameter(ParameterSetName = 'Worker', Mandatory)][string]$WorkerCommandB64
)

$ErrorActionPreference = 'Stop'
$sessionsDir = Join-Path $env:USERPROFILE '.claude\sessions'

function Read-SessionFile([int]$ProcessId) {
    $f = Join-Path $sessionsDir "$ProcessId.json"
    if (-not (Test-Path $f)) { return $null }
    try { Get-Content $f -Raw | ConvertFrom-Json } catch { $null }
}

# ───────────────────────────── mode auxiliaire ─────────────────────────────
if ($PSCmdlet.ParameterSetName -eq 'Worker') {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ConsoleTyper {
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public int bKeyDown;
        [FieldOffset(8)] public ushort wRepeatCount;
        [FieldOffset(10)] public ushort wVirtualKeyCode;
        [FieldOffset(12)] public ushort wVirtualScanCode;
        [FieldOffset(14)] public char UnicodeChar;
        [FieldOffset(16)] public uint dwControlKeyState;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tpl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    public static void Attach(uint pid) {
        FreeConsole();
        if (!AttachConsole(pid)) throw new Win32Exception(Marshal.GetLastWin32Error(), "AttachConsole");
    }
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct SCREEN_INFO { public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Win; public COORD Max; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out SCREEN_INFO i);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ReadConsoleOutputCharacterW(IntPtr h, System.Text.StringBuilder sb, uint len, COORD c, out uint read);

    // Invite vide = le curseur est juste après « ❯ » sur sa ligne. Un brouillon (même
    // multi-ligne) déplace le curseur ; une suggestion grisée ne le déplace pas.
    public static bool PromptIsEmpty() {
        IntPtr h = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) return false;
        try {
            SCREEN_INFO i;
            if (!GetConsoleScreenBufferInfo(h, out i)) return false;
            var sb = new System.Text.StringBuilder(8); uint r;
            if (!ReadConsoleOutputCharacterW(h, sb, 2, new COORD { X = 0, Y = i.Cursor.Y }, out r) || r < 1) return false;
            return sb[0] == '❯' && i.Cursor.X == 2;
        } finally { CloseHandle(h); }
    }
    public static void Type(string text) {
        IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CONIN$");
        try {
            var recs = new INPUT_RECORD[text.Length * 2];
            for (int i = 0; i < text.Length; i++) {
                char c = text[i];
                var r = new INPUT_RECORD { EventType = 1, wRepeatCount = 1, UnicodeChar = c };
                if (c == '\r') { r.wVirtualKeyCode = 0x0D; r.wVirtualScanCode = 0x1C; }
                r.bKeyDown = 1; recs[2 * i] = r;
                r.bKeyDown = 0; recs[2 * i + 1] = r;
            }
            uint n;
            if (!WriteConsoleInputW(h, recs, (uint)recs.Length, out n)) throw new Win32Exception(Marshal.GetLastWin32Error(), "WriteConsoleInput");
        } finally { CloseHandle(h); }
    }
}
'@
    # Re-vérification au plus près de l'envoi : la session a pu redevenir active.
    $s = Read-SessionFile $WorkerPid
    if (-not $s -or $s.status -ne 'idle' -or $s.sessionId -ne $WorkerSessionId) { exit 4 }
    $proc = Get-Process -Id $WorkerPid -ErrorAction SilentlyContinue
    if (-not $proc) { exit 4 }

    try { [ConsoleTyper]::Attach([uint32]$WorkerPid) } catch { exit 2 }
    if (-not [ConsoleTyper]::PromptIsEmpty()) { exit 5 }   # brouillon en cours, menu ou dialogue ouvert

    [ConsoleTyper]::Type('/exit')
    Start-Sleep -Milliseconds 500        # Entrée à part : sinon lue comme un collage multi-ligne
    [ConsoleTyper]::Type("`r")

    if (-not $proc.WaitForExit($ExitTimeoutSeconds * 1000)) { exit 3 }   # surtout NE PAS taper la relance dans claude

    Start-Sleep -Milliseconds 1500       # le shell parent reprend la main
    $cmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($WorkerCommandB64))
    [ConsoleTyper]::Type($cmd)
    Start-Sleep -Milliseconds 300
    [ConsoleTyper]::Type("`r")
    exit 0
}

# ───────────────────────────── mode principal ─────────────────────────────
$procs = @{}
Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }

# Ne jamais se couper soi-même : tout claude dans l'ascendance de ce script est exclu.
$ancestors = [System.Collections.Generic.HashSet[int]]::new()
$p = $PID
while ($p -and $procs.ContainsKey($p) -and $ancestors.Add($p)) { $p = [int]$procs[$p].ParentProcessId }

$shells = @{ 'pwsh.exe' = '& '; 'powershell.exe' = '& '; 'cmd.exe' = '' }
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$rows = foreach ($f in Get-ChildItem $sessionsDir -Filter '*.json') {
    $s = try { Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { continue }
    $cp = $procs[[int]$s.pid]
    if (-not $cp -or $cp.Name -ne 'claude.exe') { continue }           # fichier orphelin
    if ($Only -and -not ($Only | Where-Object { $_ -eq $s.name -or $_ -eq "$($s.pid)" -or $s.sessionId.StartsWith($_) })) { continue }

    $idleMin = [int][math]::Floor(($nowMs - $s.statusUpdatedAt) / 60000)
    $parent = $procs[[int]$cp.ParentProcessId]
    $relaunch = $null
    $skip =
        if ($ancestors.Contains([int]$s.pid)) { 'session courante' }
        elseif ($s.status -ne 'idle') { "statut $($s.status)" }
        elseif ($s.kind -ne 'interactive') { "kind $($s.kind)" }
        elseif ($idleMin -lt $MinIdleMinutes) { "idle < $MinIdleMinutes min" }
        elseif (-not $parent -or -not $shells.ContainsKey($parent.Name)) { "parent non géré ($($parent.Name))" }
        elseif ($cp.CommandLine -notmatch '^\s*("[^"]+"|\S+)(.*)$') { 'ligne de commande illisible' }
        else {
            $exe = $Matches[1]
            # On retire tout ce qui désigne une session : c'est --resume <id courant> qui fait foi.
            $rest = $Matches[2] -replace '\s(--resume|-r|--session-id)(=|\s+)("[^"]*"|[^-\s]\S*)', '' `
                                -replace '\s(--resume|-r|--continue|-c|--fork-session)(?=\s|$)', ''
            # Session sans aucun échange : pas de transcript, --resume échouerait (« No conversation found »).
            $hasTranscript = [bool](Get-ChildItem (Join-Path $env:USERPROFILE '.claude\projects') -Directory |
                Where-Object { Test-Path (Join-Path $_.FullName "$($s.sessionId).jsonl") } | Select-Object -First 1)
            $resume = if ($hasTranscript) { "--resume $($s.sessionId)" } else { '' }
            $relaunch = ("$($shells[$parent.Name])$exe $($rest.Trim()) $resume" -replace '\s{2,}', ' ').Trim()
            $null
        }

    [pscustomobject]@{
        Pid = [int]$s.pid; Name = $s.name; Status = $s.status; IdleMin = $idleMin
        Action = $(if ($skip) { "ignorée : $skip" } else { 'relance' })
        SessionId = $s.sessionId; Relaunch = $relaunch
    }
}

$rows = @($rows | Sort-Object { $_.Relaunch -eq $null }, IdleMin)
$rows | Format-Table Pid, Name, Status, IdleMin, Action -AutoSize | Out-Host

$self = (Get-Process -Id $PID).Path
$codes = @{ 0 = 'relancée'; 2 = 'console inaccessible'; 3 = "pas sortie en $ExitTimeoutSeconds s — relance NON tapée"; 4 = "n'est plus idle"; 5 = "ignorée : brouillon dans l'invite (ou dialogue ouvert)" }
$done = 0
foreach ($r in $rows | Where-Object Relaunch) {
    if (-not $PSCmdlet.ShouldProcess("$($r.Name) (pid $($r.Pid))", "/exit puis « $($r.Relaunch) »")) { continue }
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($r.Relaunch))
    $w = Start-Process $self -WindowStyle Hidden -PassThru -Wait -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
        '-WorkerPid', $r.Pid, '-WorkerSessionId', $r.SessionId, '-WorkerCommandB64', $b64,
        '-ExitTimeoutSeconds', $ExitTimeoutSeconds)
    $msg = $codes[[int]$w.ExitCode] ?? "échec (code $($w.ExitCode))"
    if ($w.ExitCode -eq 0) { $done++ }
    # Journal lu par la page de suivi (sessions-dashboard.ps1).
    [pscustomobject]@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); pid = $r.Pid; name = $r.Name
                       sessionId = $r.SessionId; code = [int]$w.ExitCode; result = $msg } |
        ConvertTo-Json -Compress | Add-Content (Join-Path $env:USERPROFILE '.claude\state\restart-idle-sessions.jsonl') -Encoding utf8
    Write-Host ("{0,-14} {1,-7} {2}" -f $r.Name, $r.Pid, $msg)
}
if (-not $WhatIfPreference) { Write-Host "$done session(s) relancée(s)." }
