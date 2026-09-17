import {afterEach,describe,expect,it} from "vitest";
import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createNativeSourceSnapshot} from "../../src/observer/native-source-snapshot.js";

const THREAD_ID="11111111-1111-4111-8111-111111111111";
const roots:string[]=[];

async function fixture(content:string|Buffer){
  const root=await fs.mkdtemp(join(tmpdir(),"hud-native-source-"));
  roots.push(root);
  const sourceRoot=join(root,"source-root");
  const destinationDirectory=join(root,"destination");
  const sourcePath=join(sourceRoot,"session.jsonl");
  await fs.mkdir(sourceRoot,{recursive:true});
  await fs.mkdir(destinationDirectory);
  await fs.writeFile(sourcePath,content);
  return {root,sourceRoot,destinationDirectory,sourcePath};
}

function metadata(id=THREAD_ID,extra:Record<string,unknown>={}):string{
  return `${JSON.stringify({type:"session_meta",payload:{id,...extra}})}\n`;
}

function options(fixtureValue:Awaited<ReturnType<typeof fixture>>,overrides:Record<string,unknown>={}){
  return {
    ...fixtureValue,
    sourceThreadId:THREAD_ID,
    sourceEpoch:7,
    revision:13,
    maxSourceBytes:1024*1024,
    signal:new AbortController().signal,
    verifyDestination:async()=>{},
    ...overrides
  };
}

afterEach(async()=>{
  for(const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true});
});

describe("createNativeSourceSnapshot",()=>{
  it('rejects unknown runtime/history envelopes under the native trial profile before creating a copy',async()=>{
    for(const extra of [{},{cli_version:'0.153.3'},{cli_version:'0.153.4',history_mode:'future_mode'}]){
      const f=await fixture(metadata(THREAD_ID,extra)+'opaque\n');
      await expect(createNativeSourceSnapshot(options(f,{sourceProfile:'codex-01534-legacy'})))
        .rejects.toMatchObject({code:'source_profile_unsupported'});
      expect(await fs.readdir(f.destinationDirectory)).toEqual([]);
    }
  });
  it('preserves supported trial-envelope bytes without claiming semantic completeness',async()=>{
    for(const extra of [{cli_version:'0.153.4'},{cli_version:'0.153.4',history_mode:'legacy'}]){
      const content=metadata(THREAD_ID,extra)+'opaque\n',f=await fixture(content);
      const snapshot=await createNativeSourceSnapshot(options(f,{sourceProfile:'codex-01534-legacy'}));
      expect(await fs.readFile(snapshot.path,'utf8')).toBe(content);await snapshot.close();
    }
  });
  it("copies exact opaque bytes through the fixed last complete newline and excludes later append",async()=>{
    const frozen=metadata()+"{\"type\":\"event\",\"value\":1}\n";
    const source=await fixture(frozen+"partial-tail");
    const snapshot=await createNativeSourceSnapshot(options(source));

    await fs.appendFile(source.sourcePath,"late-complete\nlate-partial");

    expect(snapshot).toMatchObject({
      kind:"native",
      sourceThreadId:THREAD_ID,
      sourceEpoch:7,
      revision:13,
      byteLength:Buffer.byteLength(frozen)
    });
    expect(await fs.readFile(snapshot.path)).toEqual(Buffer.from(frozen));
    await snapshot.close();
    await snapshot.close();
    await expect(fs.access(snapshot.path)).rejects.toMatchObject({code:"ENOENT"});
    expect(await fs.readdir(source.destinationDirectory)).toEqual([]);
  });

  it("does not semantically parse or rewrite bytes after the first metadata line",async()=>{
    const opaque=Buffer.from([0,255,10,1,2,3,10]);
    const source=await fixture(Buffer.concat([Buffer.from(metadata()),opaque]));
    const snapshot=await createNativeSourceSnapshot(options(source));

    expect(await fs.readFile(snapshot.path)).toEqual(Buffer.concat([Buffer.from(metadata()),opaque]));
    await snapshot.close();
  });

  it("supports metadata lines larger than 64KiB through the 1MiB reader bound",async()=>{
    const content=metadata(THREAD_ID,{dynamicToolDeclaration:"x".repeat(100_000)})+"record\n";
    expect(Buffer.byteLength(content)).toBeGreaterThan(64*1024);
    const source=await fixture(content);
    const snapshot=await createNativeSourceSnapshot(options(source));

    expect(await fs.readFile(snapshot.path)).toEqual(Buffer.from(content));
    await snapshot.close();
  });

  it("rejects metadata lines beyond the explicit 1MiB bound",async()=>{
    const content=metadata(THREAD_ID,{dynamicToolDeclaration:"x".repeat(1024*1024)})+"record\n";
    const source=await fixture(content);

    await expect(createNativeSourceSnapshot(options(source,{maxSourceBytes:Buffer.byteLength(content)+1})))
      .rejects.toMatchObject({code:"source_metadata_oversize"});
    expect(await fs.readdir(source.destinationDirectory)).toEqual([]);
  });

  it("rejects a source larger than the supported bound without truncating it",async()=>{
    const content=metadata()+"0123456789\n";
    const source=await fixture(content);

    await expect(createNativeSourceSnapshot(options(source,{maxSourceBytes:Buffer.byteLength(content)-1})))
      .rejects.toMatchObject({code:"source_over_limit"});
    expect(await fs.readdir(source.destinationDirectory)).toEqual([]);
    expect(await fs.readFile(source.sourcePath,"utf8")).toBe(content);
  });

  it("rejects a source outside the trusted source root",async()=>{
    const source=await fixture(metadata()+"record\n");
    const outside=join(source.root,"outside.jsonl");
    await fs.writeFile(outside,metadata()+"outside\n");

    await expect(createNativeSourceSnapshot(options({...source,sourcePath:outside})))
      .rejects.toMatchObject({code:"source_out_of_root"});
  });

  it("rejects a reparse point in the source path chain",async()=>{
    const source=await fixture(metadata()+"record\n");
    const outside=join(source.root,"outside");
    const link=join(source.sourceRoot,"linked");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside,"session.jsonl"),metadata()+"outside\n");
    await fs.symlink(outside,link,"junction");

    await expect(createNativeSourceSnapshot(options({...source,sourcePath:join(link,"session.jsonl")})))
      .rejects.toMatchObject({code:"source_reparse"});
  });

  it("rejects a reparse point in the destination path chain",async()=>{
    const source=await fixture(metadata()+"record\n");
    const outside=join(source.root,"destination-outside");
    const link=join(source.root,"destination-link");
    await fs.mkdir(outside);
    await fs.symlink(outside,link,"junction");

    await expect(createNativeSourceSnapshot(options({...source,destinationDirectory:link})))
      .rejects.toMatchObject({code:"destination_reparse"});
  });

  it("rejects a source truncated after copying and removes only its owned file",async()=>{
    const source=await fixture(metadata()+"record\nsecond\n");
    let calls=0;
    const verifyDestination=async()=>{
      calls+=1;
      if(calls===2) await fs.truncate(source.sourcePath,1);
    };

    await expect(createNativeSourceSnapshot(options(source,{verifyDestination})))
      .rejects.toMatchObject({code:"source_truncated"});
    expect(await fs.readdir(source.destinationDirectory)).toEqual([]);
  });

  it("rejects a source replaced at its path after copying",async()=>{
    const source=await fixture(metadata()+"record\n");
    let calls=0;
    const verifyDestination=async()=>{
      calls+=1;
      if(calls===2){
        await fs.rename(source.sourcePath,join(source.root,"original.jsonl"));
        await fs.writeFile(source.sourcePath,metadata()+"replacement\n");
      }
    };

    await expect(createNativeSourceSnapshot(options(source,{verifyDestination})))
      .rejects.toMatchObject({code:"source_identity_mismatch"});
    expect(await fs.readFile(source.sourcePath,"utf8")).toContain("replacement");
    expect(await fs.readdir(source.destinationDirectory)).toEqual([]);
  });

  it("rejects a rewrite within the copied prefix even when the file size is unchanged",async()=>{
    const original=metadata()+"record\n";
    const replacement=metadata()+"RECORD\n";
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    const source=await fixture(original);
    let calls=0;
    const verifyDestination=async()=>{
      calls+=1;
      if(calls===2){
        const handle=await fs.open(source.sourcePath,"r+");
        try{await handle.write(Buffer.from(replacement),0,Buffer.byteLength(replacement),0);}finally{await handle.close();}
      }
    };

    await expect(createNativeSourceSnapshot(options(source,{verifyDestination})))
      .rejects.toMatchObject({code:"source_content_changed"});
    expect(await fs.readdir(source.destinationDirectory)).toEqual([]);
  });

  it("cancels after an owned copy and removes only that copy",async()=>{
    const source=await fixture(metadata()+"record\n");
    const controller=new AbortController();
    let calls=0;
    const verifyDestination=async()=>{
      calls+=1;
      if(calls===2) controller.abort();
    };

    await expect(createNativeSourceSnapshot(options(source,{signal:controller.signal,verifyDestination})))
      .rejects.toMatchObject({code:"source_cancelled"});
    expect(await fs.readdir(source.destinationDirectory)).toEqual([]);
  });

  it("runs beforeCopy after exclusive empty creation and before any source bytes are copied",async()=>{
    const source=await fixture(metadata()+"record\n");
    let observedSize=-1;
    const failure=Object.assign(new Error("custody rejected"),{code:"CUSTODY_REJECTED"});

    await expect(createNativeSourceSnapshot(options(source,{beforeCopy:async(path:string)=>{
      observedSize=(await fs.stat(path)).size;
      expect(await fs.readFile(path)).toEqual(Buffer.alloc(0));
      throw failure;
    }}))).rejects.toBe(failure);

    expect(observedSize).toBe(0);
    expect(await fs.readdir(source.destinationDirectory)).toEqual([]);
  });

  it("settles the custody lifecycle after a successful copy or rejected beforeCopy",async()=>{
    const success=await fixture(metadata()+"record\n");
    const successEvents:string[]=[];
    let successPath="";
    const snapshot=await createNativeSourceSnapshot(options(success,{
      beforeCopy:async(path:string)=>{
        successPath=path;
        expect((await fs.stat(path)).size).toBe(0);
        successEvents.push("beforeCopy");
      },
      copySettled:()=>successEvents.push("copySettled")
    }));

    expect(successEvents).toEqual(["beforeCopy","copySettled"]);
    expect(successPath).toBe(snapshot.path);
    expect(await fs.readFile(snapshot.path,"utf8")).toContain("record\n");
    await snapshot.close();

    const failure=await fixture(metadata()+"record\n");
    const failureEvents:string[]=[];
    const rejection=Object.assign(new Error("custody rejected"),{code:"CUSTODY_REJECTED"});
    await expect(createNativeSourceSnapshot(options(failure,{
      beforeCopy:async(path:string)=>{
        expect((await fs.stat(path)).size).toBe(0);
        failureEvents.push("beforeCopy");
        throw rejection;
      },
      copySettled:()=>failureEvents.push("copySettled")
    }))).rejects.toBe(rejection);
    expect(failureEvents).toEqual(["beforeCopy","copySettled"]);
    expect(await fs.readdir(failure.destinationDirectory)).toEqual([]);
  });

  it("refuses to dispose a replaced snapshot path",async()=>{
    const source=await fixture(metadata()+"record\n");
    const snapshot=await createNativeSourceSnapshot(options(source));
    await fs.unlink(snapshot.path);
    await fs.writeFile(snapshot.path,"attacker-owned replacement");

    await expect(snapshot.close()).rejects.toMatchObject({code:"snapshot_ownership_mismatch"});
    expect(await fs.readFile(snapshot.path,"utf8")).toBe("attacker-owned replacement");
    await expect(snapshot.close()).rejects.toMatchObject({code:"snapshot_ownership_mismatch"});
    await fs.unlink(snapshot.path);
  });

  it("makes concurrent close callers join the same cleanup promise",async()=>{
    const source=await fixture(metadata()+"record\n");
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let blocked=false;
    const snapshot=await createNativeSourceSnapshot(options(source,{verifyDestination:async()=>{
      if(blocked) await gate;
    }}));
    blocked=true;

    const firstClose=snapshot.close();
    const secondClose=snapshot.close();
    expect(secondClose).toBe(firstClose);
    let settled=false;
    void firstClose.finally(()=>{settled=true;});
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await firstClose;
    await expect(fs.access(snapshot.path)).rejects.toMatchObject({code:"ENOENT"});
  });

  it("shares close failure with concurrent callers and allows a safe retry",async()=>{
    const source=await fixture(metadata()+"record\n");
    let fail=false;
    const failure=new Error("destination verification failed");
    const snapshot=await createNativeSourceSnapshot(options(source,{verifyDestination:async()=>{
      if(fail) throw failure;
    }}));
    fail=true;

    const firstClose=snapshot.close();
    const secondClose=snapshot.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toBe(failure);
    await expect(secondClose).rejects.toBe(failure);

    fail=false;
    await snapshot.close();
    await expect(fs.access(snapshot.path)).rejects.toMatchObject({code:"ENOENT"});
  });

  it("refuses disposal when the destination directory is replaced by a reparse point",async()=>{
    const source=await fixture(metadata()+"record\n");
    const snapshot=await createNativeSourceSnapshot(options(source));
    const moved=join(source.root,"destination-original");
    const outside=join(source.root,"destination-outside");
    await fs.mkdir(outside);
    await fs.rename(source.destinationDirectory,moved);
    await fs.symlink(outside,source.destinationDirectory,"junction");

    await expect(snapshot.close()).rejects.toMatchObject({code:"destination_reparse"});

    await fs.unlink(source.destinationDirectory);
    await fs.rename(moved,source.destinationDirectory);
    await snapshot.close();
    await expect(fs.access(snapshot.path)).rejects.toMatchObject({code:"ENOENT"});
  });
});
