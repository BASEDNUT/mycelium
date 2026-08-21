// Mycelium Notes — shared Note/Create builders (federated wire format).
// Used by both the outbox dispatcher and the local API fan-out so replies,
// titles, and mentions actually federate.
// Original code. MIT license.

import { Create, Mention, Note, PUBLIC_COLLECTION } from "@fedify/vocab";
import type { PostRecord } from "./store.ts";

interface UriCtx {
  getActorUri: (id: string) => URL;
}

export interface NoteExtras {
  mentionTags?: Mention[]; // Mention tags for tagged actors
  extraCcs?: URL[]; // additional CC targets (e.g. mentioned actors)
}

// Local mentions are @name (resolved against local actors).
const MENTION_RE = /@([a-z0-9_]{1,64})(?:@([a-z0-9.-]+))?/gi;

export function parseMentions(
  content: string,
): { name: string; host: string | null }[] {
  const out: { name: string; host: string | null }[] = [];
  for (const m of content.matchAll(MENTION_RE)) {
    out.push({ name: m[1].toLowerCase(), host: m[2]?.toLowerCase() ?? null });
  }
  return out;
}

/** Mention tags for LOCAL actors only; remote @name@host stays plain text
 *  until the remote actor is resolvable (future: webfinger lookup). */
export function buildLocalMentionTags(
  ctx: UriCtx,
  content: string,
  localActors: Set<string>,
): Mention[] {
  const tags: Mention[] = [];
  const seen = new Set<string>();
  for (const m of parseMentions(content)) {
    if (m.host != null) continue;
    if (!localActors.has(m.name) || seen.has(m.name)) continue;
    seen.add(m.name);
    tags.push(
      new Mention({ href: ctx.getActorUri(m.name), name: `@${m.name}` }),
    );
  }
  return tags;
}

export function buildNote(
  ctx: UriCtx,
  post: PostRecord,
  extras?: NoteExtras,
): Note {
  const actorUri = ctx.getActorUri(post.identifier);
  const id = post.isRemote === true && /^https?:\/\//.test(post.id)
    ? new URL(post.id)
    : new URL(`/ap/actor/${post.identifier}/p/${post.id}`, actorUri);
  const ccs = [new URL(`${actorUri.href}/followers`)];
  if (extras?.extraCcs != null) ccs.push(...extras.extraCcs);
  return new Note({
    id,
    attribution: actorUri,
    name: post.title,
    content: post.content,
    published: Temporal.Instant.from(post.published),
    replyTarget: post.inReplyTo != null && /^https?:\/\//.test(post.inReplyTo)
      ? new URL(post.inReplyTo)
      : undefined, // legacy plain ids do not federate a replyTarget
    tags: extras?.mentionTags,
    tos: [PUBLIC_COLLECTION],
    ccs,
  });
}

export function buildCreate(
  ctx: UriCtx,
  post: PostRecord,
  extras?: NoteExtras,
): Create {
  const note = buildNote(ctx, post, extras);
  const actorUri = ctx.getActorUri(post.identifier);
  const createId = /^https?:\//.test(post.id)
    ? new URL(`${post.id}#create`)
    : new URL(`/ap/actor/${post.identifier}/p/${post.id}#create`, actorUri);
  const ccs = [new URL(`${actorUri.href}/followers`)];
  if (extras?.extraCcs != null) ccs.push(...extras.extraCcs);
  return new Create({
    id: createId,
    actor: actorUri,
    object: note,
    tos: [PUBLIC_COLLECTION],
    ccs,
  });
}


// Remote visibility classification (audit CRITICAL fix).
// ActivityPub: only content addressed to as:Public is inherently public.
const AP_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

export function classifyVisibility(
  jsonLd: Record<string, unknown>,
): "public" | "unlisted" | "followers" | "direct" {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : v != null ? [String(v)] : [];
  const to = arr(jsonLd.to);
  const cc = arr(jsonLd.cc);
  if (to.includes(AP_PUBLIC)) return "public";
  if (cc.includes(AP_PUBLIC)) return "unlisted";
  return "followers"; // safest default for non-public addressing
}
