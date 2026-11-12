import {readFile, writeFile, rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';

export function normalizeApiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('url-api must be an HTTPS origin.'); }
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)
    || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('url-api must be an HTTPS origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

export async function configureApiUrl(value, root = new URL('../', import.meta.url)) {
  const url = normalizeApiUrl(value);
  const path = new URL('src/api-url.ts', root);
  const source = await readFile(path, 'utf8');
  const pattern = /^export const API_BASE_URL = .*;$/m;
  if (!pattern.test(source)) throw new Error('Cannot find the API_BASE_URL constant.');
  const temporary = new URL('src/api-url.ts.tmp', root);
  await writeFile(temporary, source.replace(pattern, `export const API_BASE_URL = ${JSON.stringify(url)};`));
  await rename(temporary, path);
  return url;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options: {'url-api': {type: 'string'}}});
    if (!values['url-api']) throw new Error('Usage: npm run config -- --url-api <HTTPS-origin>');
    const sourcePath = new URL('../src/api-url.ts', import.meta.url);
    const previousSource = await readFile(sourcePath, 'utf8');
    const url = await configureApiUrl(values['url-api']);
    const result = spawnSync('npm', ['run', 'build'], {cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit'});
    if (result.error || result.status !== 0) {
      await writeFile(sourcePath, previousSource);
      throw new Error('Package build failed. The previous API_BASE_URL source was restored.');
    }
    console.log(`API base URL configured: ${url}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
