import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const folder = new URL('../docs/resources/flitime/plants/', import.meta.url);
const terms = [];
for (let term = 0; term < 24; term += 1) {
  const path = new URL(`term-${String(term).padStart(2, '0')}.json`, folder);
  const bytes = await readFile(fileURLToPath(path));
  assert.ok(bytes.length < 1536);
  const data = JSON.parse(bytes.toString('utf8'));
  assert.equal(data.schema, 1);
  assert.equal(data.term, term);
  assert.equal(data.plants.length, 20);
  const ids = new Set();
  const habitats = [0, 0];
  for (const row of data.plants) {
    assert.equal(row.length, 6);
    const [id, name, habitat, style, color, days] = row;
    assert.ok(Number.isInteger(id) && id > 0 && id < 65536 && !ids.has(id));
    assert.ok(typeof name === 'string' && /^[\p{Script=Han}]+$/u.test(name));
    assert.ok(Buffer.byteLength(name, 'utf8') < 16);
    assert.ok(habitat === 0 || habitat === 1);
    assert.ok(Number.isInteger(style) && style >= 0 && style <= 6);
    assert.ok(Number.isInteger(color) && color >= 0 && color <= 5);
    assert.ok(Number.isInteger(days) && days >= 1 && days <= 2000);
    habitats[habitat] += 1; ids.add(id);
  }
  assert.deepEqual(habitats, [10, 10]);
  terms.push([...ids].sort((a, b) => a - b).join(','));
}
assert.ok(new Set(terms).size > 12);
console.log('24 seasonal plant manifests: schema, sizes, unique IDs and habitats passed');
