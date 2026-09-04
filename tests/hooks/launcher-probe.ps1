param(
  [Parameter(Mandatory = $true)]
  [string] $OutputPath
)

$ErrorActionPreference = "Stop"
$source = @'
using System;

public static class HookLauncherProbe
{
    public static int Main(string[] args)
    {
        if (args.Length != 2 || !args[0].EndsWith("resources\\app.asar\\dist\\main.js", StringComparison.OrdinalIgnoreCase) || !args[1].StartsWith("--hook-event=", StringComparison.Ordinal))
        {
            return 41;
        }

        Console.Out.WriteLine("{\"continue\":true,\"probe\":\"" + args[1].Substring(13) + "\"}");
        string configuredExit = Environment.GetEnvironmentVariable("CODEX_HOOK_PROBE_EXIT");
        return String.IsNullOrEmpty(configuredExit) ? 0 : Int32.Parse(configuredExit);
    }
}
'@

Add-Type `
  -TypeDefinition $source `
  -Language CSharp `
  -OutputAssembly $OutputPath `
  -OutputType ConsoleApplication
