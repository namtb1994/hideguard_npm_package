import policy from './verdict-policy.json' with {type: 'json'};

export type VerdictGroup = 'block' | 'challenge' | 'allow';

// The JSON file is the sole editable list. Reject ambiguous policies before use.
const groups: VerdictGroup[] = ['block', 'challenge', 'allow'];
const seen = new Set<string>();
if (Object.keys(policy).length !== groups.length) throw new Error('Invalid HideGuard verdict policy.');
for (const group of groups) {
  if (!Array.isArray(policy[group])) throw new Error('Invalid HideGuard verdict policy.');
  for (const value of policy[group]) {
    if (typeof value !== 'string' || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(value)?.[0] !== value
      || seen.has(value)) throw new Error('Invalid or duplicate HideGuard verdict.');
    seen.add(value);
  }
}
if (!seen.size || seen.size > 64) throw new Error('Invalid HideGuard verdict policy size.');

export const BLOCK_VERDICTS: readonly string[] = Object.freeze(policy.block);
export const CHALLENGE_VERDICTS: readonly string[] = Object.freeze(policy.challenge);
export const ALLOW_VERDICTS: readonly string[] = Object.freeze(policy.allow);

export function verdictGroupFor(verdict: unknown): VerdictGroup | undefined {
  if (typeof verdict !== 'string') return undefined;
  if (BLOCK_VERDICTS.includes(verdict)) return 'block';
  if (CHALLENGE_VERDICTS.includes(verdict)) return 'challenge';
  if (ALLOW_VERDICTS.includes(verdict)) return 'allow';
  return undefined;
}
