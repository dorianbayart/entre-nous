// Groups of equal devices. The shared state (members, settings) is signed by the member
// who changed it and stored encrypted on the relay; every device keeps its own copy.
import { b64, concat, fromUtf8, toJSON, fromJSON, unb64, utf8 } from './bytes.ts';
import {
  type KemKeys,
  type SignKeys,
  deviceIdOf,
  hash,
  kdf,
  kemKeygen,
  open,
  randomBytes,
  randomId,
  seal,
  sign,
  verify,
} from './crypto.ts';

export type Platform = 'mac' | 'linux' | 'windows' | 'android' | 'ios' | 'desktop';

export const DAY = 24 * 3600;
export const DEFAULT_TTL = DAY;

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  sign: SignKeys;
}

export interface Member {
  id: string;
  name: string;
  platform: Platform;
  signPk: Uint8Array;
  addedBy: string;
  addedAt: number;
}

export interface GroupState {
  v: number;
  name: string;
  nameAt: number;
  members: Record<string, Member>;
  removed: string[];
  ttl: number; // relay retention, seconds
  ttlAt: number;
  maxItems?: number; // history size kept by the relay, 0 = unlimited (default DEFAULT_MAX_ITEMS)
  maxItemsAt?: number;
  autoMax?: number; // largest content shared automatically, bytes (default DEFAULT_AUTO_MAX)
  autoMaxAt?: number;
  localOnly?: boolean; // contents only travel directly between devices on the same network
  localOnlyAt?: number;
  updatedBy: string;
  updatedAt: number;
}

export const DEFAULT_MAX_ITEMS = 10;
export const DEFAULT_AUTO_MAX = 1024 * 1024;
export const maxItemsOf = (s: GroupState) => s.maxItems ?? DEFAULT_MAX_ITEMS;
export const autoMaxOf = (s: GroupState) => s.autoMax ?? DEFAULT_AUTO_MAX;
export const localOnlyOf = (s: GroupState) => s.localOnly ?? false;

export interface Prekey extends KemKeys {
  createdAt: number;
  supersededAt?: number;
}

export interface LocalGroup {
  id: string; // stable local id (survives key rotations)
  secret: Uint8Array;
  relay: string;
  state: GroupState;
  prekeys: Prekey[];
}

export function newDevice(name: string, platform: Platform, sign: SignKeys): Device {
  return { id: deviceIdOf(sign.pk), name, platform, sign };
}

export const memberOf = (d: Device, addedBy: string): Member => ({
  id: d.id,
  name: d.name,
  platform: d.platform,
  signPk: d.sign.pk,
  addedBy,
  addedAt: Date.now(),
});

export function newGroup(device: Device, name: string, relay: string): LocalGroup {
  const now = Date.now();
  return {
    id: randomId(),
    secret: randomBytes(32),
    relay,
    prekeys: [],
    state: {
      v: 1,
      name,
      nameAt: now,
      members: { [device.id]: memberOf(device, device.id) },
      removed: [],
      ttl: DEFAULT_TTL,
      ttlAt: now,
      updatedBy: device.id,
      updatedAt: now,
    },
  };
}

// ---------------------------------------------------------------- keys derived from the group secret

export const roomKey = (g: LocalGroup) => b64(kdf(g.secret, 'room'));
const stateKey = (g: LocalGroup) => kdf(g.secret, 'state');
/** Binds prekey signatures to this group (the relay could otherwise replay them elsewhere). */
const groupTag = (g: LocalGroup) => hash(kdf(g.secret, 'room'));

// ---------------------------------------------------------------- shared state

function serializeState(s: GroupState): Uint8Array {
  return utf8(toJSON(s));
}

/** Encrypted, signed state blob for the relay. */
export function sealState(g: LocalGroup, device: Device): string {
  // The signer is always the author of record of what it publishes.
  if (g.state.updatedBy !== device.id) g.state = { ...g.state, updatedBy: device.id, updatedAt: Date.now() };
  const body = serializeState(g.state);
  const sig = sign(device.sign.sk, 'state', concat(groupTag(g), body));
  const wrapped = utf8(JSON.stringify({ body: b64(body), sig: b64(sig) }));
  return b64(seal(stateKey(g), wrapped, utf8('state')));
}

/**
 * Opens a state blob from the relay. It must be signed by a device that is a member in
 * the state we already trust (a newcomer cannot sign itself in).
 */
export function openState(g: LocalGroup, blob: string): GroupState {
  const wrapped = JSON.parse(fromUtf8(open(stateKey(g), unb64(blob), utf8('state'))));
  const body = unb64(wrapped.body);
  const state = fromJSON<GroupState>(fromUtf8(body));
  const signer = state.members[state.updatedBy] ?? g.state.members[state.updatedBy];
  if (!signer || g.state.removed.includes(signer.id) || !isVouched(g.state, state, signer.id)) {
    throw new Error('state signed by a non-member');
  }
  const known = g.state.members[signer.id]?.signPk ?? signer.signPk;
  if (!verify(known, 'state', concat(groupTag(g), body), unb64(wrapped.sig))) throw new Error('bad state signature');
  return state;
}

/**
 * A signer is accepted if we already know it, or if it was added (possibly through a
 * chain of invitations made while we were offline) by a member we know.
 */
function isVouched(trusted: GroupState, incoming: GroupState, id: string): boolean {
  for (let depth = 0; depth < 16; depth++) {
    if (trusted.members[id]) return true;
    const m = incoming.members[id];
    if (!m || m.addedBy === id) return false;
    id = m.addedBy;
  }
  return false;
}

/** Merges two versions of the shared state. Returns the merged state (version not bumped). */
export function mergeState(a: GroupState, b: GroupState): GroupState {
  const removed = [...new Set([...a.removed, ...b.removed])];
  const members: Record<string, Member> = {};
  for (const m of [...Object.values(a.members), ...Object.values(b.members)]) {
    if (removed.includes(m.id)) continue;
    const prev = members[m.id];
    // device renames: keep the most recent entry
    if (!prev || m.addedAt >= prev.addedAt) members[m.id] = m;
  }
  const named = a.nameAt >= b.nameAt ? a : b;
  const timed = a.ttlAt >= b.ttlAt ? a : b;
  const latest = a.updatedAt >= b.updatedAt ? a : b;
  // optional settings: the most recent change wins (absent = never changed)
  const pick = <K extends 'maxItems' | 'autoMax' | 'localOnly'>(key: K) => {
    const at = (key + 'At') as 'maxItemsAt' | 'autoMaxAt' | 'localOnlyAt';
    const w = (a[at] ?? -1) >= (b[at] ?? -1) ? a : b;
    return w[at] === undefined ? {} : { [key]: w[key], [at]: w[at] };
  };
  return {
    ...pick('maxItems'),
    ...pick('autoMax'),
    ...pick('localOnly'),
    v: Math.max(a.v, b.v),
    name: named.name,
    nameAt: named.nameAt,
    members,
    removed,
    ttl: timed.ttl,
    ttlAt: timed.ttlAt,
    updatedBy: latest.updatedBy,
    updatedAt: latest.updatedAt,
  };
}

/** Same content, ignoring version and authorship. */
export function sameState(a: GroupState, b: GroupState): boolean {
  const strip = (s: GroupState) => {
    const o: Record<string, unknown> = { ...s, v: 0, updatedBy: '', updatedAt: 0 };
    return toJSON(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
  };
  return strip(a) === strip(b);
}

// ---------------------------------------------------------------- prekeys

export interface PrekeyBundle {
  device: string;
  pk: Uint8Array;
  at: number;
}

const bundleBytes = (g: LocalGroup, device: string, pk: Uint8Array, at: number) =>
  concat(groupTag(g), utf8(device), utf8(String(at)), pk);

export function signedBundle(g: LocalGroup, device: Device, p: Prekey): string {
  const sig = sign(device.sign.sk, 'prekey', bundleBytes(g, device.id, p.pk, p.createdAt));
  return JSON.stringify({ device: device.id, pk: b64(p.pk), at: p.createdAt, sig: b64(sig) });
}

export function openBundle(g: LocalGroup, raw: string): PrekeyBundle | null {
  try {
    const b = JSON.parse(raw);
    const member = g.state.members[b.device];
    if (!member) return null;
    const pk = unb64(b.pk);
    if (!verify(member.signPk, 'prekey', bundleBytes(g, b.device, pk, b.at), unb64(b.sig))) return null;
    return { device: b.device, pk, at: b.at };
  } catch {
    return null;
  }
}

/**
 * Rotates the prekey once a day and forgets old secret keys once nothing encrypted to
 * them can still be on the relay: superseded + retention (+1 h of margin).
 * Returns the new prekey when one was created (it must be published).
 */
export function maintainPrekeys(g: LocalGroup, now = Date.now()): Prekey | null {
  const keepMs = (g.state.ttl + 3600) * 1000;
  g.prekeys = g.prekeys.filter((p) => !p.supersededAt || p.supersededAt + keepMs > now);
  const current = g.prekeys.find((p) => !p.supersededAt);
  if (current && now - current.createdAt < DAY * 1000) return null;
  if (current) current.supersededAt = now;
  const fresh: Prekey = { ...kemKeygen(), createdAt: now };
  g.prekeys.push(fresh);
  return fresh;
}

export const currentPrekey = (g: LocalGroup) => g.prekeys.find((p) => !p.supersededAt) ?? null;

/** Short identifier of a prekey, so the recipient knows which secret key to use. */
export const prekeyTag = (pk: Uint8Array) => b64(hash(pk).subarray(0, 8));
