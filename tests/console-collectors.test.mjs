import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor() { this.hidden=false; this.value='测试手机'; this.children=[]; this.handlers={}; this._text=''; }
  set textContent(value) { this._text=value; this.children=[]; }
  get textContent() { return this._text; }
  appendChild(child) { this.children.push(child); }
  addEventListener(name,callback) { this.handlers[name]=callback; }
}
const elements = Object.fromEntries(['name','body','locked','code','message','devices','pair','refresh'].map(name => [name,new Element()]));
let signedIn=true, deferred=null, job=null;
const window={};
vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/console-collectors.js',import.meta.url),'utf8'),{
  window,document:{createElement:()=>new Element()},Date,
});
const module=window.FlitFancyCollectors.create({
  query:selector=>elements[selector.match(/data-collector="([^"]+)"/)[1]],
  isAdmin:()=>signedIn,isServerOnline:()=>true,
  scheduler:{register(options){job=options;return {refresh:options.run,unregister(){}};},subscribe(){return ()=>{};}},
  request:async(path,options)=> {
    if(path.endsWith('/pairing')) {
      assert.equal(options.method,'POST');
      assert.equal(JSON.parse(options.body).name,'测试手机');
      return new Promise(resolve=>{deferred=resolve;});
    }
    if(path.endsWith('/revoke')) { assert.equal(options.method,'POST'); return {ok:true}; }
    return {devices:[{uid:'fixture-device',name:'测试手机',last_seen:1,revoked_at:null}]};
  },
});
module.start();
await module.refresh();
assert.equal(elements.devices.children.length,1);
assert.equal(elements.body.hidden,false);
const pairing=elements.pair.handlers.click();
await Promise.resolve();
signedIn=false; module.clearPrivate();
deferred({pairing_code:'ABCDEF123456'});
await pairing;
assert.equal(elements.code.textContent,'','late credentials must stay cleared after logout');
assert.equal(elements.devices.children.length,0);
assert.equal(elements.body.hidden,true);
assert.equal(job.enabled(),false);
module.dispose();
console.log('Collector UI: device list, auth gating and logout during pairing passed');
