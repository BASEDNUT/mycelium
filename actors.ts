// Mycelium Actors — bootstrap + AP actor doc construction.
// Clean-room original code on Fedify 2.3.4.

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
  agent: Person as unknown as ActorConstructor,
  service: Service as unknown as ActorConstructor,
  group: Group as unknown as ActorConstructor,
  application: Application as unknown as ActorConstructor,
  instance: Application as unknown as ActorConstructor,
};

export async function bootstrapActors(store: MyceliumStore): Promise<void> {
  const existing = new Map((await store.listActors()).map((a) => [a.identifier, a]));
  if (!existing.has("__instance__")) {
    await store.putActor({
      identifier: "__instance__",
      actorClass: "instance",
      name: "taproot node",
      summary: "Internal instance actor for node-level signing.",
      created: new Date().toISOString(),
      discoverable: false,
    });
  }
  if (!existing.has("bot")) {
    await store.putActor({
      identifier: "bot",
      actorClass: "service",
      name: "taproot Bot",
      summary: "The first Mycelium actor on taproot.",
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

export function buildActorDoc(
  record: ActorRecord,
  ctx: { getActorUri: (id: string) => URL; getInboxUri: (id?: string) => URL },
  keyPairs: ActorKeyPair[],
): InstanceType<typeof Person> {
  const Cls = CLASS_MAP[record.actorClass] ?? Person;
  return new Cls({
    id: ctx.getActorUri(record.identifier),
    preferredUsername: record.identifier,
    name: record.name,
    summary: record.summary,
    inbox: ctx.getInboxUri(record.identifier),
    endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
    publicKey: keyPairs[0]?.cryptographicKey,
    assertionMethods: keyPairs.map((p) => p.multikey),
    discoverable: record.discoverable,
  });
}
