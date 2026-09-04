if (-not ("CodexProgressHudStdioRelay" -as [type])) {
  $relaySource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

public static class CodexProgressHudStdioRelay
{
    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    private static async Task PumpInput(Stream source, Stream destination)
    {
        try { await source.CopyToAsync(destination).ConfigureAwait(false); }
        finally { destination.Close(); }
    }
    public static int Run(string executable, string entryScript, string mode)
    {
        var start = new ProcessStartInfo {
            FileName = executable,
            Arguments = Quote(entryScript) + " " + mode,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        using (var child = new Process { StartInfo = start }) {
            child.Start();
            var input = PumpInput(Console.OpenStandardInput(), child.StandardInput.BaseStream);
            var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            child.WaitForExit();
            Task.WaitAll(output, error);
            try { input.Wait(1000); } catch { }
            return child.ExitCode;
        }
    }
}
'@
  Add-Type -TypeDefinition $relaySource -Language CSharp
}

function Invoke-CodexProgressHudNodeMode(
  [string] $Executable,
  [string] $EntryScript,
  [string] $Mode
) {
  return [CodexProgressHudStdioRelay]::Run($Executable, $EntryScript, $Mode)
}
