// Isolated native bounds characterization. No server, hooks, login or inference.
const {app, BrowserWindow, screen} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-window-sizing-'));
app.setPath('userData', data);
let window;
const deadline = setTimeout(() => finish(2, {error:'WINDOW_SIZING_TIMEOUT'}), 15000);
function finish(code, result) {
  clearTimeout(deadline);
  try { window?.destroy(); } catch {}
  console.log(JSON.stringify(result));
  app.exit(code);
}
app.whenReady().then(async () => {
  const {hudBounds} = await import(pathToFileURL(path.resolve(__dirname, '../dist/desktop/hud-layout.js')).href);
  window = new BrowserWindow({width:340,height:146,minWidth:1,minHeight:1,
    frame:false,transparent:true,alwaysOnTop:true,resizable:false,skipTaskbar:true,show:false,
    backgroundColor:'#00000000',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const samples=[];
  for(let i=0;i<100;i++) {
    const before=window.getBounds();
    const display=screen.getDisplayMatching(before);
    const requested=hudBounds(before,display.workArea,1);
    window.setBounds(requested);
    await new Promise(resolve=>setTimeout(resolve,20));
    const actual=window.getBounds();
    if(i<3||i===99)samples.push({i,before,requested,actual,scaleFactor:display.scaleFactor});
  }
  const first=samples[0].actual,last=samples.at(-1).actual;
  const stable=first.height===last.height&&first.width===last.width;
  finish(stable?0:1,{stable,samples});
}).catch(error=>finish(2,{error:error.code??error.name}));
