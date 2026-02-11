import { Connection } from '@salesforce/core';
import {
  ObjectInfo,
  FieldInfo,
  ChildRelationship,
  SYSTEM_READONLY_FIELDS,
  EXCLUDED_CHILD_OBJECTS,
  EXCLUDED_CHILD_SUFFIXES,
} from './types.js';

// ---------------------------------------------------------------------------
// getAllObjects — describeGlobal filtered to queryable + createable
// ---------------------------------------------------------------------------

export async function getAllObjects(conn: Connection): Promise<ObjectInfo[]> {
  const result = await conn.describeGlobal();
  return result.sobjects
    .filter((o) => o.queryable && o.createable)
    .map((o) => ({
      name: o.name,
      label: o.label,
      custom: o.custom,
      keyPrefix: o.keyPrefix ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// getObjectFields — full field metadata for an object
// ---------------------------------------------------------------------------

export async function getObjectFields(
  conn: Connection,
  objectApiName: string
): Promise<FieldInfo[]> {
  const describe = await conn.describe(objectApiName);
  return describe.fields.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    createable: f.createable,
    nillable: f.nillable,
    externalId: f.externalId ?? false,
    unique: f.unique ?? false,
    referenceTo: (f.referenceTo ?? []) as string[],
    relationshipName: (f.relationshipName as string) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// getChildRelationships — child objects from describe().childRelationships
// ---------------------------------------------------------------------------

export async function getChildRelationships(
  conn: Connection,
  objectApiName: string
): Promise<ChildRelationship[]> {
  const describe = await conn.describe(objectApiName);
  const globalResult = await conn.describeGlobal();
  const createableObjects = new Set(
    globalResult.sobjects.filter((o) => o.createable && o.queryable).map((o) => o.name)
  );

  const children: ChildRelationship[] = [];

  for (const rel of describe.childRelationships) {
    const childName = rel.childSObject;

    // Skip system objects handled separately
    if (EXCLUDED_CHILD_OBJECTS.has(childName)) continue;

    // Skip suffix-based system objects
    if (EXCLUDED_CHILD_SUFFIXES.some((suffix) => childName.endsWith(suffix))) continue;

    // Only include createable + queryable objects
    if (!createableObjects.has(childName)) continue;

    // Must have a field reference
    if (!rel.field) continue;

    children.push({
      childSObject: childName,
      field: rel.field,
      relationshipName: (rel.relationshipName as string) ?? null,
      cascadeDelete: rel.cascadeDelete ?? false,
    });
  }

  return children.sort((a, b) => a.childSObject.localeCompare(b.childSObject));
}

// ---------------------------------------------------------------------------
// getGrandchildRelationships — children of children, avoiding circular refs
// ---------------------------------------------------------------------------

export async function getGrandchildRelationships(
  conn: Connection,
  childObjectNames: string[],
  coreObjectApiName: string
): Promise<Array<ChildRelationship & { parentChildObject: string }>> {
  const grandchildren: Array<ChildRelationship & { parentChildObject: string }> = [];
  const alreadyInScope = new Set([coreObjectApiName, ...childObjectNames]);

  for (const childName of childObjectNames) {
    const childRels = await getChildRelationships(conn, childName);
    for (const rel of childRels) {
      // Avoid circular references — skip if the grandchild is the core object or another child
      if (alreadyInScope.has(rel.childSObject)) continue;

      grandchildren.push({
        ...rel,
        parentChildObject: childName,
      });
    }
  }

  return grandchildren.sort((a, b) => a.childSObject.localeCompare(b.childSObject));
}

// ---------------------------------------------------------------------------
// findLookupFieldsToRemap — reference fields pointing to in-scope objects
// ---------------------------------------------------------------------------

export function findLookupFieldsToRemap(
  fields: FieldInfo[],
  objectsInScope: Set<string>
): FieldInfo[] {
  return fields.filter(
    (f) =>
      f.createable &&
      f.referenceTo.length > 0 &&
      f.referenceTo.some((ref) => objectsInScope.has(ref))
  );
}

// ---------------------------------------------------------------------------
// getInsertableFieldNames — whitelist: createable minus system fields
// ---------------------------------------------------------------------------

export function getInsertableFieldNames(
  fields: FieldInfo[],
  userExcluded?: Set<string>
): string[] {
  return fields
    .filter((f) => {
      if (!f.createable) return false;
      if (SYSTEM_READONLY_FIELDS.has(f.name)) return false;
      if (userExcluded?.has(f.name)) return false;
      // Skip compound fields (address/location)
      if (f.type === 'address' || f.type === 'location') return false;
      return true;
    })
    .map((f) => f.name);
}

// ---------------------------------------------------------------------------
// getExternalIdFields — fields marked as externalId on an object
// ---------------------------------------------------------------------------

export function getExternalIdFields(fields: FieldInfo[]): FieldInfo[] {
  return fields.filter((f) => f.externalId);
}
