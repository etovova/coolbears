// No wallet private key is read or stored. Operations are scoped to chain, owner,
// collection and target account. An uncertain submission is never silently retried.
export class Journal {
  constructor(storage, scope) { this.storage = storage; this.key = `coolbears-v2:${scope}`; }
  read() { return JSON.parse(this.storage.getItem(this.key) || '{"version":2,"operations":{}}'); }
  put(id, value) {
    const state = this.read(); state.operations[id] = { ...state.operations[id], ...value };
    this.storage.setItem(this.key, JSON.stringify(state));
    if (this.storage.getItem(this.key) !== JSON.stringify(state)) throw Error('Progress could not be saved');
    return state.operations[id];
  }
  get(id) { return this.read().operations[id]; }
}
export async function performOperation({ id, journal, inspect, prepare, submit, confirm }) {
  let previous = journal.get(id);
  if (previous?.state === 'confirmed') {
    if (await inspect(previous)) return previous;
    throw Error('Saved confirmation does not match chain state');
  }
  if (await inspect(previous)) return journal.put(id, { state: 'confirmed', reconciled: true });
  if (previous?.state === 'submitted' || previous?.state === 'submitting' || previous?.state === 'unknown') {
    if (previous.signature && await confirm(previous.signature)) {
      if (await inspect(previous)) return journal.put(id, { state: 'confirmed', reconciled: true });
    }
    throw Error('Operation is awaiting reconciliation; no new signature requested');
  }
  const prepared = await prepare(previous);
  // Storage failure prevents a wallet prompt. Persist before handing control away.
  journal.put(id, { ...prepared.record, state: 'submitting' });
  let signature;
  try { signature = await submit(prepared.transaction); }
  catch (error) {
    journal.put(id, { state: error?.code === 4001 ? 'cancelled' : 'unknown' });
    throw error;
  }
  journal.put(id, { state: 'submitted', signature });
  if (await confirm(signature) && await inspect(journal.get(id))) return journal.put(id, { state: 'confirmed' });
  throw Error('Confirmation pending; saved operation will be checked before continuing');
}
