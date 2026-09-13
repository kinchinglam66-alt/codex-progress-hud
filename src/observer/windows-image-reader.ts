import {spawn} from 'node:child_process';
import {join} from 'node:path';

export type WindowsImageReaderCode='REPARSE'|'PERMISSION'|'NOT_REGULAR'|'CAPACITY'|'READ_FAILED'|'CANCELLED';

export class WindowsImageReaderError extends Error {
  constructor(readonly code:WindowsImageReaderCode){super(code);this.name='WindowsImageReaderError';}
}

const powershellScript=String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CodexImageReader {
  const uint FILE_READ_DATA=0x0001;
  const uint FILE_READ_ATTRIBUTES=0x0080;
  const uint SYNCHRONIZE=0x00100000;
  const uint FILE_SHARE_READ=0x00000001;
  const uint FILE_OPEN=0x00000001;
  const uint FILE_NON_DIRECTORY_FILE=0x00000040;
  const uint FILE_SYNCHRONOUS_IO_NONALERT=0x00000020;
  const uint FILE_OPEN_FOR_BACKUP_INTENT=0x00004000;
  const uint FILE_OPEN_REPARSE_POINT=0x00200000;
  const uint FILE_ATTRIBUTE_REPARSE_POINT=0x00000400;
  const uint FILE_TYPE_DISK=0x00000001;
  const uint OBJ_CASE_INSENSITIVE=0x00000040;
  const uint OBJ_DONT_REPARSE=0x00001000;
  const uint STATUS_SUCCESS=0x00000000;
  const uint STATUS_NO_SUCH_FILE=0xC000000F;
  const uint STATUS_OBJECT_NAME_NOT_FOUND=0xC0000034;
  const uint STATUS_OBJECT_PATH_NOT_FOUND=0xC000003A;
  const uint STATUS_ACCESS_DENIED=0xC0000022;
  const uint STATUS_PRIVILEGE_NOT_HELD=0xC0000061;
  const uint STATUS_REPARSE_POINT_ENCOUNTERED=0xC000050B;
  const uint STATUS_IO_REPARSE_TAG_NOT_HANDLED=0xC0000279;
  const uint STATUS_FILE_IS_A_DIRECTORY=0xC00000BA;
  const uint STATUS_NOT_A_DIRECTORY=0xC0000103;
  const uint STATUS_NAME_TOO_LONG=0xC0000106;
  const int FileStandardInformation=1;
  const int FileAttributeTagInformation=9;

  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status; public IntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct FILE_STANDARD_INFORMATION { public long AllocationSize; public long EndOfFile; public uint NumberOfLinks; public byte DeletePending; public byte Directory; }
  [StructLayout(LayoutKind.Sequential)] struct FILE_ATTRIBUTE_TAG_INFORMATION { public uint FileAttributes; public uint ReparseTag; }

  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr fileHandle,uint desiredAccess,ref OBJECT_ATTRIBUTES objectAttributes,out IO_STATUS_BLOCK ioStatusBlock,IntPtr allocationSize,uint fileAttributes,uint shareAccess,uint createDisposition,uint createOptions,IntPtr eaBuffer,uint eaLength);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle,int fileInformationClass,out FILE_STANDARD_INFORMATION fileInformation,uint bufferSize);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle,int fileInformationClass,out FILE_ATTRIBUTE_TAG_INFORMATION fileInformation,uint bufferSize);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr handle,IntPtr buffer,uint bytesToRead,out uint bytesRead,IntPtr overlapped);

  static bool Invalid(IntPtr handle){ return handle==IntPtr.Zero || handle==new IntPtr(-1); }
  static string Status(uint status){
    if(status==STATUS_NO_SUCH_FILE || status==STATUS_OBJECT_NAME_NOT_FOUND || status==STATUS_OBJECT_PATH_NOT_FOUND)return "missing";
    if(status==STATUS_ACCESS_DENIED || status==STATUS_PRIVILEGE_NOT_HELD)return "permission";
    if(status==STATUS_REPARSE_POINT_ENCOUNTERED || status==STATUS_IO_REPARSE_TAG_NOT_HANDLED)return "reparse";
    if(status==STATUS_FILE_IS_A_DIRECTORY || status==STATUS_NOT_A_DIRECTORY || status==STATUS_NAME_TOO_LONG)return "not_regular";
    return "read_failed";
  }
  static bool Attributes(IntPtr handle,out bool reparse,out bool directory){
    reparse=false;directory=false;
    FILE_ATTRIBUTE_TAG_INFORMATION tag;
    if(!GetFileInformationByHandleEx(handle,FileAttributeTagInformation,out tag,(uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFORMATION))))return false;
    reparse=(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)!=0;
    FILE_STANDARD_INFORMATION standard;
    if(!GetFileInformationByHandleEx(handle,FileStandardInformation,out standard,(uint)Marshal.SizeOf(typeof(FILE_STANDARD_INFORMATION))))return false;
    directory=standard.Directory!=0;
    return true;
  }
  static bool OpenExact(string path,out IntPtr handle,out uint status){
    handle=IntPtr.Zero;status=STATUS_SUCCESS;
    string nativePath="\\??\\"+path;
    if(nativePath.Length>32766){status=STATUS_NAME_TOO_LONG;return false;}
    IntPtr nameBuffer=Marshal.StringToHGlobalUni(nativePath);
    IntPtr unicodeBuffer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
    try{
      UNICODE_STRING unicode=new UNICODE_STRING{Length=(ushort)(nativePath.Length*2),MaximumLength=(ushort)(nativePath.Length*2+2),Buffer=nameBuffer};
      Marshal.StructureToPtr(unicode,unicodeBuffer,false);
      OBJECT_ATTRIBUTES attributes=new OBJECT_ATTRIBUTES{Length=(uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),RootDirectory=IntPtr.Zero,ObjectName=unicodeBuffer,Attributes=OBJ_CASE_INSENSITIVE|OBJ_DONT_REPARSE};
      IO_STATUS_BLOCK io;
      uint access=FILE_READ_DATA|FILE_READ_ATTRIBUTES|SYNCHRONIZE;
      uint options=FILE_SYNCHRONOUS_IO_NONALERT|FILE_OPEN_FOR_BACKUP_INTENT|FILE_OPEN_REPARSE_POINT|FILE_NON_DIRECTORY_FILE;
      status=unchecked((uint)NtCreateFile(out handle,access,ref attributes,out io,IntPtr.Zero,0,FILE_SHARE_READ,FILE_OPEN,options,IntPtr.Zero,0));
      if(status!=STATUS_SUCCESS){if(!Invalid(handle))CloseHandle(handle);handle=IntPtr.Zero;return false;}
      bool reparse,isDirectory;
      if(!Attributes(handle,out reparse,out isDirectory)){status=(uint)Marshal.GetLastWin32Error();CloseHandle(handle);handle=IntPtr.Zero;return false;}
      if(reparse || isDirectory){status=reparse?STATUS_REPARSE_POINT_ENCOUNTERED:STATUS_FILE_IS_A_DIRECTORY;CloseHandle(handle);handle=IntPtr.Zero;return false;}
      return true;
    }finally{Marshal.FreeHGlobal(unicodeBuffer);Marshal.FreeHGlobal(nameBuffer);}
  }
  public static string Read(string path,long maxEncodedBytes){
    if(maxEncodedBytes<=23)return "capacity";
    IntPtr fileHandle=IntPtr.Zero;
    try{
      uint status;if(!OpenExact(path,out fileHandle,out status))return Status(status);
      if(GetFileType(fileHandle)!=FILE_TYPE_DISK)return "not_regular";
      FILE_STANDARD_INFORMATION standard;
      if(!GetFileInformationByHandleEx(fileHandle,FileStandardInformation,out standard,(uint)Marshal.SizeOf(typeof(FILE_STANDARD_INFORMATION))))return "read_failed";
      long size=standard.EndOfFile;if(size<0 || size>Int32.MaxValue)return "capacity";
      long base64Length=checked(((size+2)/3)*4);if(base64Length>maxEncodedBytes-23)return "capacity";
      byte[] bytes=new byte[(int)size];var pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
      try{
        int offset=0;while(offset<bytes.Length){uint wanted=(uint)Math.Min(1048576,bytes.Length-offset);uint received;IntPtr destination=IntPtr.Add(pinned.AddrOfPinnedObject(),offset);if(!ReadFile(fileHandle,destination,wanted,out received,IntPtr.Zero)||received==0)return "read_failed";offset+=checked((int)received);}
      }finally{pinned.Free();}
      return "available|"+Convert.ToBase64String(bytes);
    }catch(OutOfMemoryException){return "capacity";}catch(OverflowException){return "capacity";}catch{return "read_failed";}
    finally{
      if(!Invalid(fileHandle))CloseHandle(fileHandle);
    }
  }
}
'@
$request = [Console]::In.ReadLine() | ConvertFrom-Json
try {
  $result = [CodexImageReader]::Read([string]$request.path,[long]$request.maxEncodedBytes)
  [Console]::Out.WriteLine($result)
} catch {
  [Console]::Out.WriteLine('read_failed')
}
[Console]::Out.Flush()
`;

function powerShellPath():string {
  return process.env.SystemRoot===undefined?'powershell.exe':join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
}
// A failed cleanup retains ownership until the actual close event. No replacement
// helpers are admitted while any abandoned native reader may still hold a lock.
const unconfirmedHelpers=new Set<object>();

export async function readWindowsImage(path:string,options:{signal:AbortSignal;maxEncodedBytes:number}):Promise<Buffer|null>{
  const {signal,maxEncodedBytes}=options;
  if(process.platform!=='win32')throw new WindowsImageReaderError('READ_FAILED');
  if(!Number.isSafeInteger(maxEncodedBytes)||maxEncodedBytes<=0)throw new WindowsImageReaderError('CAPACITY');
  if(signal.aborted)throw new WindowsImageReaderError('CANCELLED');
  if(unconfirmedHelpers.size>0)throw new WindowsImageReaderError('READ_FAILED');
  const encoded=Buffer.from(powershellScript,'utf16le').toString('base64');
  const maximumOutputBytes=maxEncodedBytes+128;
  return await new Promise<Buffer|null>((resolve,reject)=>{
    const child=spawn(powerShellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encoded],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    let output='';let settled=false,stopping:Error|undefined,cleanupTimeout:ReturnType<typeof setTimeout>|undefined;
    const timeout=setTimeout(()=>stop(new WindowsImageReaderError('READ_FAILED')),30_000);
    const finish=(error?:Error,value?:Buffer|null)=>{if(settled)return;settled=true;clearTimeout(timeout);clearTimeout(cleanupTimeout);signal.removeEventListener('abort',onAbort);if(error)reject(error);else resolve(value??null);};
    const stop=(error:Error)=>{
      if(settled||stopping)return;stopping=error;clearTimeout(timeout);
      cleanupTimeout=setTimeout(()=>{unconfirmedHelpers.add(child);finish(error);},2000);
      try{child.kill();}catch{/* retained until close or explicit unconfirmed-cleanup state */}
    };
    const onAbort=()=>stop(new WindowsImageReaderError('CANCELLED'));
    signal.addEventListener('abort',onAbort,{once:true});
    child.on('error',()=>stop(new WindowsImageReaderError('READ_FAILED')));
    child.stdin.on('error',()=>stop(new WindowsImageReaderError('READ_FAILED')));
    child.stdout.on('error',()=>stop(new WindowsImageReaderError('READ_FAILED')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{
      if(settled||stopping)return;output+=chunk;
      if(Buffer.byteLength(output,'utf8')>maximumOutputBytes)stop(new WindowsImageReaderError('READ_FAILED'));
    });
    child.on('close',code=>{
      unconfirmedHelpers.delete(child);
      if(settled)return;
      if(stopping)return finish(stopping);
      if(signal.aborted)return finish(new WindowsImageReaderError('CANCELLED'));
      if(code!==0)return finish(new WindowsImageReaderError('READ_FAILED'));
      const line=output.trim();
      if(line==='missing')return finish(undefined,null);
      if(line==='reparse')return finish(new WindowsImageReaderError('REPARSE'));
      if(line==='permission')return finish(new WindowsImageReaderError('PERMISSION'));
      if(line==='not_regular')return finish(new WindowsImageReaderError('NOT_REGULAR'));
      if(line==='capacity')return finish(new WindowsImageReaderError('CAPACITY'));
      if(line==='read_failed')return finish(new WindowsImageReaderError('READ_FAILED'));
      if(line.startsWith('available|')){
        const base64=line.slice('available|'.length);
        if(base64.length+23>maxEncodedBytes||base64.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))return finish(new WindowsImageReaderError('READ_FAILED'));
        try{const bytes=Buffer.from(base64,'base64');if(bytes.toString('base64')!==base64)return finish(new WindowsImageReaderError('READ_FAILED'));return finish(undefined,bytes);}catch{return finish(new WindowsImageReaderError('READ_FAILED'));}
      }
      finish(new WindowsImageReaderError('READ_FAILED'));
    });
    if(signal.aborted)onAbort();
    if(!stopping)try{child.stdin.end(JSON.stringify({path,maxEncodedBytes})+'\n');}catch{stop(new WindowsImageReaderError('READ_FAILED'));}
  });
}
