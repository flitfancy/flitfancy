/* Build-time orthographic planet renderer. The website only loads the resulting WebP files.
 * Run with Node + sharp available: node scripts/render-planets.cjs <texture-cache-directory>
 * Source maps and attribution: docs/assets/planets/CREDITS.txt. No runtime GPU or 3D dependency.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const cache = process.argv[2];
if (!cache) throw new Error('Provide a texture cache directory outside the published website');
const output = path.resolve(__dirname, '../docs/assets/planets');
const mirror = 'https://media.githubusercontent.com/media/TanvirAhmedArnab/SolarSystem/main/SourceAssets/ThirdParty/Textures/SolarSystemScope/';
const original = 'https://edu.solarsystemscope.com/textures/download/';
const textures = {
  mercury: '2k_mercury.jpg', venus: '2k_venus_atmosphere.jpg', earth: '2k_earth_daymap.jpg',
  clouds: '2k_earth_clouds.jpg', mars: '2k_mars.jpg', jupiter: '2k_jupiter.jpg',
  saturn: '2k_saturn.jpg', ring: '2k_saturn_ring_alpha.png', uranus: '2k_uranus.jpg',
  neptune: '2k_neptune.jpg', moon: '2k_moon.jpg',
  pluto: 'https://d2pn8kiwq2w21t.cloudfront.net/original_images/jpegPIA11707.jpg',
};
const models = [
  { id: 'mercury', longitude: 0.6, tilt: -0.12 },
  { id: 'venus', longitude: 1.7, tilt: -0.12 },
  { id: 'earth', longitude: 0.55, tilt: -0.22 },
  { id: 'mars', longitude: 1.2, tilt: -0.15 },
  { id: 'jupiter', longitude: -1.2, tilt: -0.12 },
  { id: 'saturn', longitude: 1.3, tilt: -0.3 },
  { id: 'uranus', longitude: 1.2, tilt: 1.25 },
  { id: 'neptune', longitude: 0.8, tilt: -0.2 },
  { id: 'pluto', longitude: 0, tilt: -0.15, latitude: 0.55 },
  { id: 'moon', longitude: 0, tilt: -0.12 },
];
const sourceRecords = {};
async function loadTexture(id, name) {
  const url = name.startsWith('https:') ? name : mirror + name;
  const filename = path.join(cache, id + (id === 'ring' ? '.png' : '.jpg'));
  let bytes;
  try { bytes = await fs.readFile(filename); await sharp(bytes).metadata(); }
  catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(id + ': HTTP ' + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
    await sharp(bytes).metadata(); // Reject HTML error pages or Git LFS pointers before caching.
    await fs.writeFile(filename, bytes);
  }
  sourceRecords[id] = { source: name.startsWith('https:') ? name : original + name,
    mirror: name.startsWith('https:') ? null : url,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const clamp = (x, a=0, b=1) => Math.min(b, Math.max(a, x));
function sample(map, u, v) {
  const x = ((u % 1 + 1) % 1) * (map.width - 1), y = clamp(v) * (map.height - 1);
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const at = (dx, dy, c) => map.data[(Math.min(iy+dy,map.height-1)*map.width + Math.min(ix+dx,map.width-1))*4+c];
  return [0,1,2,3].map(c => ((at(0,0,c)*(1-fx)+at(1,0,c)*fx)*(1-fy)
    +(at(0,1,c)*(1-fx)+at(1,1,c)*fx)*fy)/255);
}
function shade(color, illumination) {
  return color.slice(0,3).map(c => Math.round(255 * Math.pow(Math.pow(c,2.2)*illumination,1/2.2)));
}
function render(model, maps) {
  const size = 768, radius = model.id === 'saturn' ? 176 : 302;
  const pixels = Buffer.alloc(size*size*4);
  const ct = Math.cos(model.tilt), st = Math.sin(model.tilt);
  const lat = model.latitude || 0, cl = Math.cos(lat), sl = Math.sin(lat);
  const light = [-0.57, 0.45, 0.69];
  for(let py=0;py<size;py++) for(let px=0;px<size;px++) {
    const x=(px+.5-size/2)/radius, y=(size/2-py-.5)/radius;
    const distance=x*x+y*y, z=Math.sqrt(Math.max(0,1-distance));
    let rgba = [0,0,0,0], surfaceDepth = -Infinity;
    if(distance<=1) {
      // Rotate the globe, then sample an equirectangular map on its curved surface.
      const nx=x*ct-y*st, ny=x*st+y*ct;
      const ty=ny*cl+z*sl, tz=z*cl-ny*sl;
      const u=.5+(Math.atan2(nx,tz)+model.longitude)/(2*Math.PI), v=.5-Math.asin(clamp(ty,-1,1))/Math.PI;
      let color = sample(maps[model.id],u,v);
      if(model.id==='earth') {
        const cloud=sample(maps.clouds,u,v)[0]*.82;
        color=color.map((c,i)=>i===3?1:c*(1-cloud)+.92*cloud);
      }
      // Diffuse sunlight, with a small fill only to keep the dark limb legible on this site.
      const sunlight=Math.max(0,x*light[0]+y*light[1]+z*light[2]);
      const rgb=shade(color,.003+.997*sunlight);
      rgba=[...rgb,255]; surfaceDepth=z;
    }
    if(model.id==='saturn') {
      // Ring plane tilted toward the viewer. Per-pixel depth keeps the far arc behind the globe.
      const rx=x*ct-y*st, ry=x*st+y*ct;
      const ringY=ry/.43, ringRadius=Math.hypot(rx,ringY), ringZ=-ringY*.903;
      if(ringRadius>1.23 && ringRadius<2.1 && ringZ>surfaceDepth) {
        const color=sample(maps.ring,(ringRadius-1.23)/.87,.5);
        const point=[x,y,ringZ], along=point.reduce((sum,p,i)=>sum+p*light[i],0);
        const shadow=along<0 && point.reduce((sum,p)=>sum+p*p,0)-along*along<1;
        const rgb=shade(color,shadow?.11:.78), alpha=color[3];
        const destAlpha=rgba[3]/255, outAlpha=alpha+destAlpha*(1-alpha);
        rgba=[...rgb.map((c,i)=>(c*alpha+rgba[i]*destAlpha*(1-alpha))/(outAlpha||1)),255*outAlpha];
      }
    }
    for(let c=0;c<4;c++) pixels[(py*size+px)*4+c]=Math.round(rgba[c]);
  }
  return { pixels, size };
}
(async()=>{
  await fs.mkdir(cache,{recursive:true}); await fs.mkdir(output,{recursive:true});
  const entries=await Promise.all(Object.entries(textures).map(async([id,name])=>[id,await loadTexture(id,name)]));
  const maps=Object.fromEntries(entries);
  for(const model of models) {
    const {pixels,size}=render(model,maps);
    const destination=path.join(output,model.id+'.webp');
    await sharp(pixels,{raw:{width:size,height:size,channels:4}}).resize(512,512).webp({quality:92,alphaQuality:100}).toFile(destination);
    console.log(model.id, (await fs.stat(destination)).size, 'bytes');
  }
  const orderedSources=Object.fromEntries(Object.keys(textures).map(id=>[id,sourceRecords[id]]));
  await fs.writeFile(path.join(output,'sources.json'),JSON.stringify({sources:orderedSources,models},null,2)+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
