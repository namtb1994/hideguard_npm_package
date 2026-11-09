import { Guard, SharedCircuitBreaker } from '../../dist/index.js';
import { sqliteStore } from './sqlite-store.mjs';
import { context, policy } from '../support.mjs';

const [path, mode, clock] = process.argv.slice(2);
const store = sqliteStore(path);
let release;
process.on('message', async (message) => {
  if (message === 'release') {release?.(); return;}
  if (message !== 'go') return;
  try {
    if (mode === 'circuit') {
      const circuit = new SharedCircuitBreaker({store, scopeId: 'tenant', failureThreshold: 1, now: () => Number(clock)});
      await circuit.execute('service', async () => {
        const wait = new Promise((resolve) => {release = resolve;});
        process.send({kind: 'probe'}); await wait;
        return 'recovered';
      });
    } else if (mode === 'reserve') {
      await new Guard(store, () => Number(clock), {atomic: true}).beginResourceCheck(context.scopeId, 'flow', context.actorId, policy());
    } else {
      const first = await store.read('cas');
      await new Promise((resolve) => {release = resolve; process.send({kind: 'read'});});
      if (!await store.replace('cas', first.version, {...first, version: first.version + 1})) throw new Error('CAS contention');
    }
    process.send({kind: 'result', ok: true});
  } catch (error) {process.send({kind: 'result', ok: false, error: error.name, status: error.verificationStatus});}
  finally {store.close(); process.disconnect();}
});
process.send({kind: 'ready'});
