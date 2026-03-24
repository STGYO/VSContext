export const KNOWLEDGE_MODEL_VERSION = 1;

export const KNOWLEDGE_NODE_KINDS = [
  'file',
  'class',
  'function',
  'method',
  'variable',
  'test',
  'documentation',
  'api',
  'chunk',
  'issue',
] as const;

export type KnowledgeNodeKind = (typeof KNOWLEDGE_NODE_KINDS)[number];

export const KNOWLEDGE_RELATIONSHIP_KINDS = [
  'file-class',
  'file-method',
  'file-function',
  'file-variable',
  'class-method',
  'function-variable',
  'method-variable',
  'calls',
  'implements',
  'reads',
  'writes',
  'file-dependency',
  'contains',
  'covers',
  'documents',
  'imports',
  'references',
  'related-to',
] as const;

export type KnowledgeRelationshipKind = (typeof KNOWLEDGE_RELATIONSHIP_KINDS)[number];

export interface KnowledgeModelManifest {
  readonly version: number;
  readonly nodeKinds: readonly KnowledgeNodeKind[];
  readonly relationshipKinds: readonly KnowledgeRelationshipKind[];
}

export const KNOWLEDGE_MODEL_MANIFEST: KnowledgeModelManifest = {
  version: KNOWLEDGE_MODEL_VERSION,
  nodeKinds: KNOWLEDGE_NODE_KINDS,
  relationshipKinds: KNOWLEDGE_RELATIONSHIP_KINDS,
};