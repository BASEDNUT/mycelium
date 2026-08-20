// Mycelium Notes — shared Note/Create builders (federated wire format).
// Used by both the outbox dispatcher and the local API fan-out so replies
// and titles actually federate.
// Original code. MIT license.

import { Create, Note, PUBLIC_COLLECTION } from "@fedify/vocab";
import type { PostRecord } from "./store.ts";

interface UriCtx {
  getActorUri: (id: string) => URL;
}

export function buildNote(ctx: UriCtx, post: PostRecord): Note {
  const actorUri = ctx.getActorUri(post.identifier);
  const id = post.isRemote === true && /^https?:\/\//.test(post.id)
    ? new URL(post.id)
    : new URL(`/ap/actor/${post.identifier}/p/${post.id}`, actorUri);
  return new Note({
    id,
    attribution: actorUri,
    name: post.title,
    content: post.content,
    published: Temporal.Instant.from(post.published),
    replyTarget: post.inReplyTo == null ? undefined : new URL(post.inReplyTo),
    tos: [PUBLIC_COLLECTION],
    ccs: [new URL(`${actorUri.href}/followers`)],
  });
}

export function buildCreate(ctx: UriCtx, post: PostRecord): Create {
  const note = buildNote(ctx, post);
  const actorUri = ctx.getActorUri(post.identifier);
  const createId = /^https?:\/\//.test(post.id)
    ? new URL(`${post.id}#create`)
    : new URL(`/ap/actor/${post.identifier}/p/${post.id}#create`, actorUri);
  return new Create({
    id: createId,
    actor: actorUri,
    object: note,
    tos: [PUBLIC_COLLECTION],
    ccs: [new URL(`${actorUri.href}/followers`)],
  });
}
