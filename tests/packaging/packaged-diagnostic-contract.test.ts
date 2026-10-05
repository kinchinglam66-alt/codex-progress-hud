import {describe,expect,it} from 'vitest';
import {renderDiagnosticReport,type DiagnosticReportInput} from '../../src/diagnostics/report.js';

const load=()=>import(new URL('../../scripts/packaged-diagnostic-contract.mjs',import.meta.url).href);
const leaseReport='- Hook trust/activity: not reported\n- MCP lease: connected (1)\n- Tracking (current MCP lease only): 0 task(s)\n';

describe('packaged MCP diagnostic scope',()=>{
  it('accepts the actual lease-scoped report without inventing global trust',async()=>{
    const input:DiagnosticReportInput={directory:'unused',generatedAt:'2026-10-04T00:00:00.000Z',
      versions:{plugin:'0.2.1',mcp:'0.2.1',companion:'0.2.1',protocol:1},
      lifecycle:{observedState:'running'},paths:{installManifestExists:true,dataDirectoryExists:true},
      endpoint:{host:'127.0.0.1',port:17837},errors:[],lease:{active:true,count:1},
      tracking:{taskCount:0,lateAttached:false,scope:'lease'}};
    const {assertLeaseScopedDiagnosticReport:check}=await load();
    expect(()=>check(renderDiagnosticReport(input))).not.toThrow();
    expect(()=>check(leaseReport.replaceAll('\n','\r\n'))).not.toThrow();
  });
  it.each(['trusted; no activity','trusted; activity seen','not trusted; no activity',
    'expected; trust not confirmed; no activity','not expected by this plugin build'])
    ('rejects unsupported global Hook conclusions: %s',async value=>{
      const {assertLeaseScopedDiagnosticReport:check}=await load();
      expect(()=>check(leaseReport.replace('not reported',value))).toThrow(/global Hook/);
    });
  it.each([undefined,'',leaseReport.replace('- MCP lease: connected (1)','- MCP lease: disconnected'),
    leaseReport.replace('connected (1)','connected (2)'),leaseReport.replace(' (current MCP lease only)',''),
    leaseReport.replace('0 task(s)','1 task(s)'),leaseReport+'- Hook trust/activity: trusted; activity seen\n'])
    ('rejects missing, contradictory or cross-scope diagnostics %#',async value=>{
      const {assertLeaseScopedDiagnosticReport:check}=await load();
      expect(()=>check(value)).toThrow();
    });
});
