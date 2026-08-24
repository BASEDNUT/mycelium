// Mycelium Actors — bootstrap + AP actor doc construction.
// Original code. MIT license.

import {
  Application,
  Endpoints,
  Group,
  Person,
  Service,
} from "@fedify/vocab";
import { exportJwk, generateCryptoKeyPair, type ActorKeyPair } from "@fedify/fedify";
import type { ActorClass, ActorRecord, MyceliumStore, StoredKeyPair } from "./store.ts";

type ActorConstructor = new (
  options: Record<string, unknown>,
) => InstanceType<typeof Person>;

const CLASS_MAP: Record<ActorClass, ActorConstructor> = {
  person: Person as unknown as ActorConstructor,
  // Agents are autonomous software: AP Service, not Person (audit fix).
  agent: Service as unknown as ActorConstructor,
  service: Service as unknown as ActorConstructor,
  group: Group as unknown as ActorConstructor,
  application: Application as unknown as ActorConstructor,
  instance: Application as unknown as ActorConstructor,
};

export async function bootstrapActors(store: MyceliumStore, host: string): Promise<void> {
  const existing = new Map((await store.listActors()).map((a) => [a.identifier, a]));
  if (!existing.has("__instance__")) {
    await store.putActor({
      identifier: "__instance__",
      actorClass: "instance",
      name: `${host} node`,
      summary: "Internal instance actor for node-level signing.",
      created: new Date().toISOString(),
      discoverable: false,
    });
  }
  // v0.13.0: system "anonymous" actor — shared identity for anonymous board
  // posting (docs/subroots-identity-v1.md). No account, no tokens, never in
  // actor directory listings (discoverable: false).
  if (!existing.has("anonymous")) {
    await store.putActor({
      identifier: "anonymous",
      actorClass: "person",
      name: "Anonymous",
      summary: "Shared system actor for anonymous board posts.",
      created: new Date().toISOString(),
      discoverable: false,
    });
  }
  if (!existing.has("bot")) {
    await store.putActor({
      identifier: "bot",
      actorClass: "service",
      name: `${host} Bot`,
      summary: "The first Mycelium actor on this node.",
      created: new Date().toISOString(),
      discoverable: true,
    });
  }
}

export async function ensureKeyPairs(
  store: MyceliumStore,
  identifier: string,
): Promise<StoredKeyPair | null> {
  let keys = await store.getKeys(identifier);
  if (keys == null) {
    const rsa = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
    const ed = await generateCryptoKeyPair("Ed25519");
    keys = {
      rsa: {
        privateKey: await exportJwk(rsa.privateKey),
        publicKey: await exportJwk(rsa.publicKey),
      },
      ed25519: {
        privateKey: await exportJwk(ed.privateKey),
        publicKey: await exportJwk(ed.publicKey),
      },
    };
    await store.putKeys(identifier, keys);
  }
  return keys;
}

export interface ActorDocContext {
  getActorUri: (id: string) => URL;
  getInboxUri: (id?: string) => URL;
  getOutboxUri: (id: string) => URL;
  // Optional so framework users without collection dispatchers still build
  // valid actor docs (audit v0.9.1: missing followers/following).
  getFollowersUri?: (id: string) => URL;
  getFollowingUri?: (id: string) => URL;
}

export function buildActorDoc(
  record: ActorRecord,
  ctx: ActorDocContext,
  keyPairs: ActorKeyPair[],
): InstanceType<typeof Person> {
  const Cls = CLASS_MAP[record.actorClass] ?? Person;
  const actorUri = ctx.getActorUri(record.identifier);
  return new Cls({
    id: actorUri,
    preferredUsername: record.identifier,
    name: record.name,
    summary: record.summary,
    inbox: ctx.getInboxUri(record.identifier),
    outbox: ctx.getOutboxUri(record.identifier),
    followers: ctx.getFollowersUri?.(record.identifier),
    following: ctx.getFollowingUri?.(record.identifier),
    endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
    publicKey: keyPairs[0]?.cryptographicKey,
    assertionMethods: keyPairs.map((p) => p.multikey),
    discoverable: record.discoverable,
  });
}
