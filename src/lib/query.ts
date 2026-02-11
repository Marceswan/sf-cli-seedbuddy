import { Connection } from '@salesforce/core';
import { QUERY_CHUNK_SIZE } from './types.js';

// ---------------------------------------------------------------------------
// Internal query result type (jsforce returns this shape)
// ---------------------------------------------------------------------------

interface QueryResult {
  done: boolean;
  nextRecordsUrl?: string;
  records: Array<Record<string, unknown>>;
  totalSize: number;
}

// ---------------------------------------------------------------------------
// queryAll — paginate via queryMore
// ---------------------------------------------------------------------------

export async function queryAll(
  conn: Connection,
  soql: string
): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  let result = (await conn.query(soql)) as unknown as QueryResult;
  records.push(...result.records);

  while (!result.done) {
    result = (await conn.queryMore(result.nextRecordsUrl!)) as unknown as QueryResult;
    records.push(...result.records);
  }

  return records;
}

// ---------------------------------------------------------------------------
// queryAllChunked — batch IN clauses to stay under SOQL limits
// ---------------------------------------------------------------------------

export async function queryAllChunked(
  conn: Connection,
  values: string[],
  soqlBuilder: (chunk: string[]) => string,
  chunkSize = QUERY_CHUNK_SIZE
): Promise<Array<Record<string, unknown>>> {
  const allRecords: Array<Record<string, unknown>> = [];

  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    const records = await queryAll(conn, soqlBuilder(chunk));
    allRecords.push(...records);
  }

  return allRecords;
}

// ---------------------------------------------------------------------------
// SOQL helpers
// ---------------------------------------------------------------------------

export function escSoql(val: string): string {
  return val.replace(/'/g, "\\'");
}

export function buildSelectFields(
  fields: string[],
  additionalFields?: string[]
): string {
  const allFields = new Set(fields);
  if (additionalFields) {
    for (const f of additionalFields) {
      allFields.add(f);
    }
  }
  // Always include Id
  allFields.add('Id');
  return [...allFields].join(', ');
}

export function buildSeedQuery(
  selectFields: string,
  objectApiName: string,
  whereClause?: string,
  limit?: number | 'All'
): string {
  let soql = `SELECT ${selectFields} FROM ${objectApiName}`;
  if (whereClause) {
    soql += ` WHERE ${whereClause}`;
  }
  if (limit && limit !== 'All') {
    soql += ` LIMIT ${limit}`;
  }
  return soql;
}

// ---------------------------------------------------------------------------
// Display utilities
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function inClause(ids: string[]): string {
  return ids.map((id) => `'${escSoql(id)}'`).join(',');
}
