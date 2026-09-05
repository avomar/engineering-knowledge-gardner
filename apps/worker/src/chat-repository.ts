import {
  chatMessageSchema,
  citationSchema,
  messageSchema,
  type ChatMessage,
  type Citation,
  type Confidence,
  type Message,
  type SourceCard,
} from "@knowledge-gardener/domain";

export interface RetrievedChunk {
  chunkId: string;
  content: string;
  source: SourceCard;
}

interface ConversationRow {
  id: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  citation_json: string;
  confidence: string | null;
  unanswered_questions_json: string;
  created_at: string;
}

interface ChunkRow {
  chunk_id: string;
  content: string;
  document_id: string;
  source_page_id: string;
  title: string;
  breadcrumb_json: string;
  source_url: string | null;
  last_edited_at: string;
}

export interface StoredTurnInput {
  conversationId: string;
  knowledgeSpaceId: string;
  ownerSessionId: string;
  createConversation: boolean;
  user: {
    id: string;
    content: string;
    createdAt: string;
  };
  assistant: {
    id: string;
    content: string;
    citations: Citation[];
    confidence: Confidence;
    unansweredQuestions: string[];
    createdAt: string;
  };
}

export class ChatRepository {
  constructor(private readonly database: D1Database) {}

  async conversationExists(
    conversationId: string,
    ownerSessionId: string,
    knowledgeSpaceId: string,
  ): Promise<boolean> {
    const row = await this.database
      .prepare(
        `SELECT id FROM conversations
         WHERE id = ? AND owner_session_id = ? AND knowledge_space_id = ?`,
      )
      .bind(conversationId, ownerSessionId, knowledgeSpaceId)
      .first<ConversationRow>();
    return row !== null;
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    const result = await this.database
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .bind(conversationId)
      .all<MessageRow>();
    return result.results.map(mapMessage);
  }

  async listRecentMessages(
    conversationId: string,
    limit: number,
  ): Promise<Message[]> {
    const result = await this.database
      .prepare(
        `SELECT * FROM (
           SELECT messages.*, rowid AS sequence FROM messages
           WHERE conversation_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
         ) ORDER BY created_at ASC, sequence ASC`,
      )
      .bind(conversationId, limit)
      .all<MessageRow>();
    return result.results.map(mapMessage);
  }

  async listChunks(knowledgeSpaceId: string): Promise<RetrievedChunk[]> {
    const result = await this.database
      .prepare(
        `SELECT c.id AS chunk_id, c.content, d.id AS document_id,
                d.source_page_id, d.title, d.breadcrumb_json,
                d.source_url, d.last_edited_at
         FROM document_chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE d.knowledge_space_id = ? AND d.index_status = 'indexed'
         ORDER BY d.title ASC, c.ordinal ASC`,
      )
      .bind(knowledgeSpaceId)
      .all<ChunkRow>();
    return result.results.map(mapChunk);
  }

  async saveTurn(input: StoredTurnInput): Promise<void> {
    const user = messageSchema.parse({
      id: input.user.id,
      conversationId: input.conversationId,
      role: "user",
      content: input.user.content,
      citations: [],
      confidence: null,
      unansweredQuestions: [],
      createdAt: input.user.createdAt,
    });
    const assistant = messageSchema.parse({
      id: input.assistant.id,
      conversationId: input.conversationId,
      role: "assistant",
      content: input.assistant.content,
      citations: input.assistant.citations,
      confidence: input.assistant.confidence,
      unansweredQuestions: input.assistant.unansweredQuestions,
      createdAt: input.assistant.createdAt,
    });
    const statements: D1PreparedStatement[] = [];
    if (input.createConversation) {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO conversations (
              id, knowledge_space_id, owner_session_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            input.conversationId,
            input.knowledgeSpaceId,
            input.ownerSessionId,
            user.createdAt,
            assistant.createdAt,
          ),
      );
    } else {
      statements.push(
        this.database
          .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
          .bind(assistant.createdAt, input.conversationId),
      );
    }
    statements.push(insertMessage(this.database, user));
    statements.push(insertMessage(this.database, assistant));

    const results = await this.database.batch(statements);
    for (const result of results) {
      if (!result.success) throw new Error("D1 write failed.");
    }
  }

  async hydrateMessages(messages: readonly Message[]): Promise<ChatMessage[]> {
    const chunkIds = [
      ...new Set(
        messages.flatMap((message) => message.citations.map((c) => c.chunkId)),
      ),
    ];
    const chunks = new Map<string, RetrievedChunk>();
    if (chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => "?").join(", ");
      const result = await this.database
        .prepare(
          `SELECT c.id AS chunk_id, c.content, d.id AS document_id,
                  d.source_page_id, d.title, d.breadcrumb_json,
                  d.source_url, d.last_edited_at
           FROM document_chunks c
           JOIN documents d ON d.id = c.document_id
           WHERE c.id IN (${placeholders})`,
        )
        .bind(...chunkIds)
        .all<ChunkRow>();
      for (const row of result.results) {
        const chunk = mapChunk(row);
        chunks.set(chunk.chunkId, chunk);
      }
    }

    return messages.map((message) =>
      chatMessageSchema.parse({
        ...message,
        citations: message.citations.map((citation) => {
          const source = chunks.get(citation.chunkId)?.source;
          if (source === undefined) {
            throw new Error("A stored citation source is unavailable.");
          }
          return { ...citation, source };
        }),
      }),
    );
  }
}

function insertMessage(
  database: D1Database,
  message: Message,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO messages (
        id, conversation_id, role, content, citation_json,
        confidence, unanswered_questions_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      message.id,
      message.conversationId,
      message.role,
      message.content,
      JSON.stringify(message.citations),
      message.confidence,
      JSON.stringify(message.unansweredQuestions),
      message.createdAt,
    );
}

function mapMessage(row: MessageRow): Message {
  return messageSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    citations: citationSchema.array().parse(JSON.parse(row.citation_json)),
    confidence: row.confidence,
    unansweredQuestions: JSON.parse(row.unanswered_questions_json) as unknown,
    createdAt: row.created_at,
  });
}

function mapChunk(row: ChunkRow): RetrievedChunk {
  return {
    chunkId: row.chunk_id,
    content: row.content,
    source: {
      documentId: row.document_id,
      sourcePageId: row.source_page_id,
      title: row.title,
      breadcrumb: JSON.parse(row.breadcrumb_json) as string[],
      sourceUrl: row.source_url,
      lastEditedAt: row.last_edited_at,
    },
  };
}
