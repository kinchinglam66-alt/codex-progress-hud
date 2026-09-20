using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class LauncherFailure : Exception
{
    internal readonly int ExitCode;
    internal LauncherFailure(int exitCode, string message) : base(message) { ExitCode = exitCode; }
}

public static class CodexProgressHudLauncher
{
    private static readonly HashSet<string> HookModes = new HashSet<string>(StringComparer.Ordinal) {
        "--hook-event=SessionStart", "--hook-event=UserPromptSubmit", "--hook-event=PostToolUse",
        "--hook-event=Stop", "--hook-event=Interrupt", "--hook-event=SessionEnd"
    };

    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }

    private static void CopyLines(Stream source, Stream destination, bool closeDestination)
    {
        try {
            using (var reader = new StreamReader(source, new UTF8Encoding(false), false, 4096, true))
            using (var writer = new StreamWriter(destination, new UTF8Encoding(false), 4096, true) { AutoFlush = true }) {
                string line;
                while ((line = reader.ReadLine()) != null) writer.WriteLine(line);
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally { if (closeDestination) destination.Close(); }
    }

    private static int Relay(string executable, string entryScript, string mode)
    {
        var start = new ProcessStartInfo {
            FileName = executable,
            Arguments = Quote(entryScript) + " " + Quote(mode),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        using (var child = new Process { StartInfo = start }) {
            child.Start();
            var input = new Thread(() => CopyLines(Console.OpenStandardInput(), child.StandardInput.BaseStream, true)) { IsBackground = true };
            var output = new Thread(() => CopyLines(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false)) { IsBackground = true };
            var error = new Thread(() => CopyLines(child.StandardError.BaseStream, Console.OpenStandardError(), false)) { IsBackground = true };
            input.Start(); output.Start(); error.Start();
            child.WaitForExit();
            output.Join(); error.Join();
            return child.ExitCode;
        }
    }

    private static int Run(string mode)
    {
        var dataDirectory = Environment.GetEnvironmentVariable("CODEX_PROGRESS_HUD_DATA_DIR");
        if (String.IsNullOrEmpty(dataDirectory)) {
            var profile = Environment.GetEnvironmentVariable("USERPROFILE");
            if (String.IsNullOrEmpty(profile)) profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (String.IsNullOrEmpty(profile)) throw new LauncherFailure(2, "COMPANION_NOT_INSTALLED: User profile is unavailable.");
            dataDirectory = Path.Combine(profile, ".codex-progress-hud");
        }
        if (!Path.IsPathRooted(dataDirectory)) throw new LauncherFailure(3, "INVALID_DATA_DIRECTORY: An absolute HUD directory is required.");
        var manifestPath = Path.Combine(dataDirectory, "install.json");
        if (!File.Exists(manifestPath)) throw new LauncherFailure(2, "COMPANION_NOT_INSTALLED: Install Codex Progress HUD and retry.");

        Dictionary<string, object> manifest;
        try { manifest = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifestPath, Encoding.UTF8)); }
        catch { throw new LauncherFailure(3, "INVALID_INSTALL_MANIFEST: Reinstall Codex Progress HUD."); }
        if (manifest == null || manifest.Count != 3 || !manifest.ContainsKey("executablePath") || !manifest.ContainsKey("installDirectory") || !manifest.ContainsKey("version"))
            throw new LauncherFailure(3, "INVALID_INSTALL_MANIFEST: Reinstall Codex Progress HUD.");

        var executableValue = manifest["executablePath"] as string;
        var installValue = manifest["installDirectory"] as string;
        var version = manifest["version"] as string;
        if (String.IsNullOrWhiteSpace(executableValue) || String.IsNullOrWhiteSpace(installValue) || String.IsNullOrWhiteSpace(version) || !Path.IsPathRooted(executableValue) || !Path.IsPathRooted(installValue))
            throw new LauncherFailure(3, "INVALID_INSTALL_MANIFEST: Reinstall Codex Progress HUD.");

        var installDirectory = Path.GetFullPath(installValue);
        var executable = Path.GetFullPath(executableValue);
        var expected = Path.GetFullPath(Path.Combine(installDirectory, "Codex Progress HUD.exe"));
        if (!String.Equals(executable, expected, StringComparison.OrdinalIgnoreCase))
            throw new LauncherFailure(3, "INVALID_INSTALL_MANIFEST: Executable is outside the install directory.");
        if (!Directory.Exists(installDirectory) || !File.Exists(executable))
            throw new LauncherFailure(4, "COMPANION_EXECUTABLE_MISSING: Reinstall Codex Progress HUD.");
        var archive = Path.Combine(installDirectory, "resources", "app.asar");
        if (!File.Exists(archive))
            throw new LauncherFailure(4, "COMPANION_EXECUTABLE_MISSING: Reinstall Codex Progress HUD.");
        var entryScript = Path.Combine(archive, "dist", "main.js");
        return Relay(executable, entryScript, mode);
    }

    public static int Main(string[] args)
    {
        var mode = args.Length == 1 ? args[0] : null;
        var isHook = mode != null && HookModes.Contains(mode);
        try {
            if (mode != "--mcp-stdio" && !isHook) throw new LauncherFailure(3, "INVALID_LAUNCH_MODE: Reinstall Codex Progress HUD.");
            return Run(mode);
        } catch (LauncherFailure failure) {
            if (isHook) {
                Console.Out.WriteLine(mode == "--hook-event=Interrupt" ? "{}" : "{\"continue\":true}");
                Console.Error.WriteLine("Codex Progress HUD Hook launcher skipped: unavailable");
                return 0;
            }
            Console.Error.WriteLine(failure.Message);
            return failure.ExitCode;
        } catch {
            if (isHook) {
                Console.Out.WriteLine(mode == "--hook-event=Interrupt" ? "{}" : "{\"continue\":true}");
                Console.Error.WriteLine("Codex Progress HUD Hook launcher skipped: unavailable");
                return 0;
            }
            Console.Error.WriteLine("INVALID_INSTALL_MANIFEST: Reinstall Codex Progress HUD.");
            return 3;
        }
    }
}
