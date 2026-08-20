// Mycelium Knowledge Graph — entities (typed nodes) + edges (typed relations).
// Clean-room original code. MIT license.

export interface KgEntity {
  id: string;
  type: string; // topic | project | agent | skill | concept | resource | ...
  name: string;
  description: string;
  category: string; // visualization grouping
  tags: string[];
  linkedActor?: string;
  linkedPost?: string;
  created: string;
}

export interface KgEdge {
  id: string;
  fromId: string;
  toId: string;
  relation: string; // depends-on | member-of | about | built-by | uses | ...
  weight: number; // 1..10
  note: string;
  created: string;
}

export const ENTITY_TYPES = new Set([
  "topic", "project", "agent", "skill", "concept", "resource", "event", "place",
]);

const NS = ["_mycelium"];

export class KgStore {
  constructor(private kv: Deno.Kv) {}

  async putEntity(e: KgEntity): Promise<void> {
    await this.kv.set([...NS, "kg", "entity", e.id], e);
  }

  async getEntity(id: string): Promise<KgEntity | null> {
    return (await this.kv.get<KgEntity>([...NS, "kg", "entity", id])).value;
  }

  async listEntities(type: string | null): Promise<KgEntity[]> {
    const out: KgEntity[] = [];
    for await (
      const e of this.kv.list<KgEntity>({ prefix: [...NS, "kg", "entity"] })
    ) {
      if (type == null || type === "" || e.value.type === type) out.push(e.value);
    }
    return out;
  }

  async deleteEntity(id: string): Promise<void> {
    await this.kv.delete([...NS, "kg", "entity", id]);
    // cascade edges
    for await (const e of this.kv.list<KgEdge>({ prefix: [...NS, "kg", "edge"] })) {
      if (e.value.fromId === id || e.value.toId === id) {
        await this.kv.delete([...NS, "kg", "edge", e.value.id]);
      }
    }
  }

  async putEdge(edge: KgEdge): Promise<void> {
    await this.kv.set([...NS, "kg", "edge", edge.id], edge);
  }

  async listEdges(): Promise<KgEdge[]> {
    const out: KgEdge[] = [];
    for await (const e of this.kv.list<KgEdge>({ prefix: [...NS, "kg", "edge"] })) {
      out.push(e.value);
    }
    return out;
  }

  async deleteEdge(id: string): Promise<void> {
    await this.kv.delete([...NS, "kg", "edge", id]);
  }

  async graph(): Promise<{ entities: KgEntity[]; edges: KgEdge[] }> {
    return { entities: await this.listEntities(null), edges: await this.listEdges() };
  }
}
