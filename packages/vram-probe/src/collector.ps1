# VRAM collector: one JSON object per line on stdout, once per interval.
#
#   {"type":"adapters", ...}   once, from DXGI: LUID, name, vendor of every GPU
#   {"type":"proc", ...}       once per process (and its ancestors) the first time it holds GPU memory
#   {"type":"sample", ...}     every interval: dedicated GPU memory per adapter and per (process, adapter)
#
# Source: the Windows performance counters "GPU Process Memory" and "GPU Adapter Memory" (the data
# Task Manager shows), read through PDH. The query is rebuilt on every sample so processes that start
# while recording are picked up (Get-Counter -Continuous freezes its instance list at start).
# nvidia-smi cannot report per-process memory for WDDM processes; the Node side uses it only to
# cross-check the adapter total.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [double]$IntervalSec = 1,
  [double]$MinProcMB = 1
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

$src = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class AnimatusGpu {
  // ---- DXGI: adapters ------------------------------------------------------------------
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapters1Fn(IntPtr self, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDesc1Fn(IntPtr self, out DESC1 desc);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint ReleaseFn(IntPtr self);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct DESC1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  static IntPtr Vt(IntPtr obj, int idx) { IntPtr vtbl = Marshal.ReadIntPtr(obj); return Marshal.ReadIntPtr(vtbl, idx * IntPtr.Size); }
  public static string[] ListAdapters() {
    Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr f; int hr = CreateDXGIFactory1(ref iid, out f);
    if (hr != 0) throw new Exception("CreateDXGIFactory1 hr=" + hr);
    EnumAdapters1Fn enumFn = (EnumAdapters1Fn)Marshal.GetDelegateForFunctionPointer(Vt(f, 12), typeof(EnumAdapters1Fn));
    List<string> res = new List<string>();
    for (uint i = 0; ; i++) {
      IntPtr a; if (enumFn(f, i, out a) != 0) break;
      GetDesc1Fn getDesc1 = (GetDesc1Fn)Marshal.GetDelegateForFunctionPointer(Vt(a, 10), typeof(GetDesc1Fn));
      DESC1 d; getDesc1(a, out d);
      res.Add(string.Format("luid_0x{0:x8}_0x{1:x8}|{2}|0x{3:x4}|{4}|{5}", (uint)d.LuidHigh, d.LuidLow, d.Description, d.VendorId, ((ulong)d.DedicatedVideoMemory) / (1024 * 1024), d.Flags));
      ((ReleaseFn)Marshal.GetDelegateForFunctionPointer(Vt(a, 2), typeof(ReleaseFn)))(a);
    }
    ((ReleaseFn)Marshal.GetDelegateForFunctionPointer(Vt(f, 2), typeof(ReleaseFn)))(f);
    return res.ToArray();
  }

  // ---- PDH: GPU memory counters ------------------------------------------------------------
  const uint PDH_FMT_LARGE = 0x00000400;
  const uint PDH_MORE_DATA = 0x800007D2;
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQueryW(string src, IntPtr user, out IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr q, string path, IntPtr user, out IntPtr c);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr c, uint fmt, ref uint bufSize, ref uint count, IntPtr buf);
  [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr q);
  [StructLayout(LayoutKind.Sequential)] struct ITEM { public IntPtr Name; public uint CStatus; public long Value; }

  static readonly HashSet<int> seenPids = new HashSet<int>();
  static readonly List<int> newPids = new List<int>();

  static List<KeyValuePair<string, long>> ReadArray(IntPtr counter) {
    List<KeyValuePair<string, long>> res = new List<KeyValuePair<string, long>>();
    uint size = 0, count = 0;
    uint r = PdhGetFormattedCounterArrayW(counter, PDH_FMT_LARGE, ref size, ref count, IntPtr.Zero);
    if (r != PDH_MORE_DATA || size == 0) return res;
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    try {
      r = PdhGetFormattedCounterArrayW(counter, PDH_FMT_LARGE, ref size, ref count, buf);
      if (r != 0) return res;
      int step = Marshal.SizeOf(typeof(ITEM));
      for (int i = 0; i < count; i++) {
        ITEM it = (ITEM)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * step), typeof(ITEM));
        res.Add(new KeyValuePair<string, long>(Marshal.PtrToStringUni(it.Name), it.Value));
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return res;
  }

  static string Mb(long bytes) { return (bytes / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture); }

  // Returns one JSON line. Pids seen for the first time are queued for TakeNewPids().
  public static string SampleJson(double minProcBytes) {
    IntPtr q; IntPtr cProc, cAdapter;
    if (PdhOpenQueryW(null, IntPtr.Zero, out q) != 0) throw new Exception("PdhOpenQuery failed");
    try {
      if (PdhAddEnglishCounterW(q, "\\GPU Process Memory(*)\\Dedicated Usage", IntPtr.Zero, out cProc) != 0) throw new Exception("add process counter failed");
      if (PdhAddEnglishCounterW(q, "\\GPU Adapter Memory(*)\\Dedicated Usage", IntPtr.Zero, out cAdapter) != 0) throw new Exception("add adapter counter failed");
      PdhCollectQueryData(q);
      long t = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
      StringBuilder sb = new StringBuilder(4096);
      sb.Append("{\"type\":\"sample\",\"t\":").Append(t).Append(",\"adapters\":{");
      bool first = true;
      foreach (KeyValuePair<string, long> kv in ReadArray(cAdapter)) {
        string name = kv.Key;
        int p = name.IndexOf("_phys_", StringComparison.Ordinal);
        if (p > 0) name = name.Substring(0, p);
        if (!first) sb.Append(','); first = false;
        sb.Append('"').Append(name.ToLowerInvariant()).Append("\":").Append(Mb(kv.Value));
      }
      sb.Append("},\"procs\":[");
      first = true;
      foreach (KeyValuePair<string, long> kv in ReadArray(cProc)) {
        if (kv.Value < minProcBytes) continue;
        string n = kv.Key; // pid_1234_luid_0x00000000_0x000122ab_phys_0
        if (!n.StartsWith("pid_", StringComparison.Ordinal)) continue;
        int u = n.IndexOf('_', 4); if (u < 0) continue;
        int pid; if (!int.TryParse(n.Substring(4, u - 4), out pid)) continue;
        int l = n.IndexOf("luid_", u, StringComparison.Ordinal); if (l < 0) continue;
        int e = n.IndexOf("_phys_", l, StringComparison.Ordinal); if (e < 0) continue;
        string luid = n.Substring(l, e - l).ToLowerInvariant();
        if (seenPids.Add(pid)) newPids.Add(pid);
        if (!first) sb.Append(','); first = false;
        sb.Append("{\"pid\":").Append(pid).Append(",\"luid\":\"").Append(luid).Append("\",\"mb\":").Append(Mb(kv.Value)).Append('}');
      }
      sb.Append("]}");
      return sb.ToString();
    } finally { PdhCloseQuery(q); }
  }

  public static int[] TakeNewPids() { int[] a = newPids.ToArray(); newPids.Clear(); return a; }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

$adapters = @()
foreach ($line in [AnimatusGpu]::ListAdapters()) {
  $p = $line.Split('|')
  $adapters += @{ luid = $p[0]; name = $p[1]; vendor = $p[2]; dedicated_mb = [int]$p[3]; flags = [int]$p[4] }
}
Emit @{ type = 'adapters'; adapters = $adapters; interval_s = $IntervalSec }

# Process table: refreshed (one CIM call) only when a new pid shows up.
$emitted = @{}
function Emit-NewProcs([int[]]$pids) {
  $table = @{}
  Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine -ErrorAction SilentlyContinue |
    ForEach-Object { $table[[int]$_.ProcessId] = $_ }
  foreach ($start in $pids) {
    $procId = $start
    $depth = 0
    while ($procId -gt 4 -and -not $emitted.ContainsKey($procId) -and $depth -lt 12) {
      $emitted[$procId] = $true
      $info = $table[$procId]
      if (-not $info) { Emit @{ type = 'proc'; pid = $procId; gone = $true }; break }
      Emit @{ type = 'proc'; pid = $procId; ppid = [int]$info.ParentProcessId; name = [string]$info.Name; cmd = [string]$info.CommandLine }
      $procId = [int]$info.ParentProcessId
      $depth++
    }
  }
}

$minBytes = $MinProcMB * 1MB
$tick = [Diagnostics.Stopwatch]::StartNew()
$next = 0.0
while ($true) {
  $line = [AnimatusGpu]::SampleJson($minBytes)
  $new = [AnimatusGpu]::TakeNewPids()
  if ($new.Count -gt 0) { Emit-NewProcs $new }
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  $next += $IntervalSec
  $wait = $next - $tick.Elapsed.TotalSeconds
  if ($wait -gt 0.005) { Start-Sleep -Milliseconds ([int]($wait * 1000)) } elseif ($wait -lt -5) { $next = $tick.Elapsed.TotalSeconds }
}
