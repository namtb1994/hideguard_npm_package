import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {configureApiUrl, normalizeApiUrl} from '../scripts/config.mjs';

test('package URL config changes only the origin constant and rejects unsafe input before writes', async t => {
  const directory=await mkdtemp(join(tmpdir(),'hideguard-package-url-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=pathToFileURL(`${directory}/`);
  await mkdir(new URL('src/',root));
  const file=new URL('src/api-url.ts',root);
  await writeFile(file,"// Keep documentation\nexport const API_BASE_URL = 'https://hideguard.io';\n");
  assert.equal(await configureApiUrl('https://api-testing.example/',root),'https://api-testing.example');
  const source=await readFile(file,'utf8');
  assert.match(source,/Keep documentation/);assert.match(source,/API_BASE_URL = "https:\/\/api-testing.example"/);
  for(const value of ['http://api-testing.example','https://a:b@example.com','https://example.com/path','https://example.com?key=x','https://example.com/#x','https://example.com\\evil']) {
    assert.throws(()=>normalizeApiUrl(value));
    await assert.rejects(configureApiUrl(value,root));
    assert.equal(await readFile(file,'utf8'),source);
  }
});
