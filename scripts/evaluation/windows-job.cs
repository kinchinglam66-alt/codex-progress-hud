using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Experiment-only console owner. The child starts suspended; no model code runs
// before assignment to a kill-on-close job. The job handle is never inherited.
internal static class WindowsJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorking, MaxWorking; public uint Active;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic; public Io Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;
    public ushort Show,ReservedSize; public IntPtr ReservedBytes,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process,Thread; public uint Pid,Tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {public Startup Startup;public IntPtr Attributes;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string executable,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static string Quote(string arg) {
    var text=new StringBuilder("\"");int slashes=0;
    foreach(char c in arg) {
      if(c=='\\'){slashes++;continue;}
      if(c=='\"'){text.Append('\\',slashes*2+1);text.Append(c);slashes=0;continue;}
      text.Append('\\',slashes);slashes=0;text.Append(c);
    }
    text.Append('\\',slashes*2);text.Append('"');return text.ToString();
  }
  static IntPtr Inherit(int id) {
    IntPtr value;
    if(!DuplicateHandle(GetCurrentProcess(),GetStdHandle(id),GetCurrentProcess(),out value,0,true,2))throw new Exception();
    return value;
  }
  static int Main(string[] args) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero;
    IntPtr attributes=IntPtr.Zero,jobList=IntPtr.Zero,handleList=IntPtr.Zero;bool attributesReady=false;
    ProcessInfo child=new ProcessInfo();bool resumed=false;
    try {
      int pid;
      if(args.Length<2 || !int.TryParse(args[0],out pid) || pid<=0 || !Path.IsPathRooted(args[1]))return 121;
      // A replacement process with the reused PID must not be mistaken for the
      // original owner after it died. The original parent predates this helper.
      var parentProcess=Process.GetProcessById(pid);
      if(parentProcess.StartTime.ToUniversalTime()>Process.GetCurrentProcess().StartTime.ToUniversalTime())return 122;
      parent=OpenProcess(0x00100000,false,pid);
      if(parent==IntPtr.Zero || WaitForSingleObject(parent,0)!=258)return 122;
      job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception();
      var limits=new Extended();limits.Basic.Flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))))throw new Exception();
      input=Inherit(-10);output=Inherit(-11);error=Inherit(-12);
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
      if(size==IntPtr.Zero)throw new Exception();attributes=Marshal.AllocHGlobal(size);
      if(!InitializeProcThreadAttributeList(attributes,2,0,ref size))throw new Exception();attributesReady=true;
      jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST: atomically assign during CreateProcess.
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x0002000D),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw new Exception();
      handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
      Marshal.WriteIntPtr(handleList,0,input);Marshal.WriteIntPtr(handleList,IntPtr.Size,output);Marshal.WriteIntPtr(handleList,IntPtr.Size*2,error);
      // Only the three stdio duplicates may be inherited, never job/parent handles.
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new Exception();
      var startup=new StartupEx();startup.Startup.Size=(uint)Marshal.SizeOf(typeof(StartupEx));startup.Attributes=attributes;
      startup.Startup.Flags=0x100;startup.Startup.Input=input;startup.Startup.Output=output;startup.Startup.Error=error;
      var command=new StringBuilder();for(int i=1;i<args.Length;i++){if(i>1)command.Append(' ');command.Append(Quote(args[i]));}
      if(command.Length>30000)throw new Exception();
      if(!CreateProcess(args[1],command,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,Directory.GetCurrentDirectory(),ref startup,out child))throw new Exception();
      IntPtr watchedParent=parent,watchedJob=job;
      var monitor=new Thread(delegate(){if(WaitForSingleObject(watchedParent,0xffffffff)==0){TerminateJobObject(watchedJob,123);Environment.Exit(123);}});
      monitor.IsBackground=true;monitor.Start();
      if(WaitForSingleObject(parent,0)!=258 || ResumeThread(child.Thread)==0xffffffff)throw new Exception();
      resumed=true;
      if(WaitForSingleObject(child.Process,0xffffffff)!=0)throw new Exception();
      uint exit;if(!GetExitCodeProcess(child.Process,out exit))throw new Exception();
      return unchecked((int)exit);
    }catch{Console.Error.WriteLine("EXPERIMENT_JOB_OWNER_FAILED");return 122;}
    finally {
      if(child.Process!=IntPtr.Zero&&!resumed)TerminateProcess(child.Process,122);
      if(job!=IntPtr.Zero)CloseHandle(job);
      if(child.Thread!=IntPtr.Zero)CloseHandle(child.Thread);
      if(child.Process!=IntPtr.Zero)CloseHandle(child.Process);
      if(input!=IntPtr.Zero)CloseHandle(input);if(output!=IntPtr.Zero)CloseHandle(output);if(error!=IntPtr.Zero)CloseHandle(error);
      if(attributesReady)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);
      if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);if(handleList!=IntPtr.Zero)Marshal.FreeHGlobal(handleList);
      // Parent wait owns its handle until process exit. Closing it under a
      // pending native wait would be undefined; OS teardown releases it.
    }
  }
}
