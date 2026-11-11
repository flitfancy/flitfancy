import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function element() {
  let text = '';
  return {children:[],dataset:{},style:{setProperty(){}},listeners:new Map(),hidden:false,
    classList:{toggle(){}},
    set textContent(value){text=value;this.children=[];},get textContent(){return text;},
    appendChild(child){this.children.push(child);child.parentNode=this;return child;},setAttribute(name,value){this[name]=value;},
    querySelectorAll(selector){return selector==='[data-star]' ? this.children.filter(child=>child.dataset.star) : [];},
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);},
    getAttribute(name){return name==='data-star' ? this.dataset.star : this[name];},
    addEventListener(name,fn){this.listeners.set(name,fn);},
    getBoundingClientRect(){return {width:800,height:600};},setPointerCapture(){}};
}
const parts = new Map();
const root = {querySelector(selector){if(!parts.has(selector))parts.set(selector,element());return parts.get(selector);},
  querySelectorAll(selector){return selector==='[data-star]' ? this.querySelector('[data-role="planets"]').children : [];}};
const document = {currentScript:{src:'https://flitfancy.com/assets/observations.js?v=1.0.0'},
  querySelector:()=>root, createElement:element, createElementNS:element};
let spec, data = {rows:[{uid:'star-fixture-0001',title:'Old',category:'理',summary:'summary',tags:[]}],links:[]};
let requested = '', offline = false, frames = [];
const window = {matchMedia:()=>({matches:true}),addEventListener(){},
  FlitFancyPublicRefresh:{register(value){spec=value;return {};}}};
const context = {window,document,location:{hostname:'127.0.0.1',href:'http://127.0.0.1/observations.html'},
  URL,AbortController,setTimeout,clearTimeout,performance,
  requestAnimationFrame(fn){frames.push(fn);return frames.length;},cancelAnimationFrame(){},
  fetch:async url=>{requested=url;if(offline)throw new Error('offline');return {ok:true,json:async()=>data};}};
vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/observations.js',import.meta.url),'utf8'),context);
const render = () => {const work=frames;frames=[];for(const fn of work)fn(0);};
await spec.run(); render();
assert.equal(requested,'https://api.flitfancy.com/observations');
const planets = root.querySelector('[data-role="planets"]');
const first = planets.children[0];
await spec.run(); render();
assert.equal(planets.children[0],first,'unchanged polls do not rebuild stars');
const viewport = root.querySelector('[data-role="viewport"]');
viewport.listeners.get('pointerdown')({target:{closest:()=>false},pointerId:1,clientX:0,clientY:0});
viewport.listeners.get('pointermove')({pointerId:1,clientX:100,clientY:0});
const moved = planets.children[0].style.left;
data = {rows:[{...data.rows[0],title:'New'}],links:[]};
await spec.run(); render();
assert.equal(planets.children[0],first,'updated stars keep their DOM and keyboard focus');
assert.equal(planets.children[0].style.left,moved,'new public data does not reset the camera');
assert.equal(planets.children[0].children[1].textContent,'New');
offline = true;
assert.equal((await spec.run()).ok,false);
assert.equal(planets.children.length,1,'offline retry retains the last star map');
assert.match(root.querySelector('[data-role="load-status"]').textContent,/上次内容/);
console.log('observations refresh: published source, stable map position and offline retention passed');
