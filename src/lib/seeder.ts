import { Connection } from '@salesforce/core';
import {
  SeedConfig,
  SeedResults,
  ObjectSeedResult,
  FileSeedResult,
  SeedError,
  IdMap,
  IdMapCollection,
  SeederLogger,
  FieldInfo,
  BATCH_SIZE,
  SYSTEM_READONLY_FIELDS,
  ACTIVITY_SYSTEM_FIELDS,
  SYSTEM_LOOKUP_OBJECTS,
} from './types.js';
import {
  queryAll,
  queryAllChunked,
  buildSelectFields,
  buildSeedQuery,
  inClause,
  formatBytes,
} from './query.js';
import {
  getObjectFields,
  getInsertableFieldNames,
  findLookupFieldsToRemap,
} from './schema.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SaveError {
  statusCode: string;
  message: string;
  fields: string[];
}

interface InsertResult {
  id?: string;
  success: boolean;
  errors?: SaveError[];
}

function formatErrors(errors?: SaveError[]): string {
  if (!errors || errors.length === 0) return 'Unknown error';
  return errors.map((e) => `${e.statusCode}: ${e.message}${e.fields?.length ? ` [${e.fields.join(', ')}]` : ''}`).join('; ');
}

// ---------------------------------------------------------------------------
// ID map helpers
// ---------------------------------------------------------------------------

function findInAnyIdMap(
  idMaps: IdMapCollection,
  sourceId: string
): string | undefined {
  for (const objectName of Object.keys(idMaps)) {
    const mapped = idMaps[objectName].get(sourceId);
    if (mapped) return mapped;
  }
  return undefined;
}

function getAllSourceIds(idMaps: IdMapCollection): string[] {
  const all: string[] = [];
  for (const objectName of Object.keys(idMaps)) {
    for (const sourceId of idMaps[objectName].keys()) {
      all.push(sourceId);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Record preparation — remap lookups, strip non-insertable fields
// ---------------------------------------------------------------------------

function prepareRecord(
  record: Record<string, unknown>,
  insertableFields: string[],
  lookupFields: FieldInfo[],
  allReferenceFields: FieldInfo[],
  idMaps: IdMapCollection,
  errors: SeedError[],
  objectApiName: string
): Record<string, unknown> | null {
  const prepared: Record<string, unknown> = {};
  const insertableSet = new Set(insertableFields);
  const allRefFieldNames = new Set(allReferenceFields.map((f) => f.name));
  const inScopeFieldNames = new Set(lookupFields.map((f) => f.name));

  for (const fieldName of insertableSet) {
    const value = record[fieldName];
    if (value === undefined) continue;

    // Check if this is an in-scope lookup field that needs remapping
    const lookupField = lookupFields.find((f) => f.name === fieldName);

    if (lookupField && value !== null) {
      const sourceId = value as string;
      const targetId = findInAnyIdMap(idMaps, sourceId);

      if (targetId) {
        prepared[fieldName] = targetId;
      } else if (lookupField.nillable) {
        // Optional lookup — set to null if we can't remap
        prepared[fieldName] = null;
      } else {
        // Required lookup with no mapping — skip this record
        errors.push({
          object: objectApiName,
          sourceId: record['Id'] as string,
          stage: 'remap',
          error: `Required lookup ${fieldName} references ${sourceId} which has no target mapping`,
        });
        return null;
      }
    } else if (allRefFieldNames.has(fieldName) && !inScopeFieldNames.has(fieldName) && value !== null) {
      // Out-of-scope reference field — source ID won't exist in target, strip it
      continue;
    } else {
      prepared[fieldName] = value;
    }
  }

  return prepared;
}

// ---------------------------------------------------------------------------
// Batch insert with result tracking
// ---------------------------------------------------------------------------

async function batchInsert(
  conn: Connection,
  objectApiName: string,
  records: Array<Record<string, unknown>>,
  sourceIds: string[],
  idMap: IdMap,
  errors: SeedError[],
  logger: SeederLogger,
  dryRun: boolean
): Promise<{ inserted: number; failed: number }> {
  let inserted = 0;
  let failed = 0;

  if (dryRun) {
    logger.log(`  [DRY RUN] Would insert ${records.length} ${objectApiName} records`);
    return { inserted: records.length, failed: 0 };
  }

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchSourceIds = sourceIds.slice(i, i + BATCH_SIZE);

    logger.updateSpinner(
      `Inserting ${objectApiName} batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(records.length / BATCH_SIZE)} (${batch.length} records)`
    );

    const results = await conn.sobject(objectApiName).create(batch);
    const resultArray: InsertResult[] = Array.isArray(results)
      ? (results as InsertResult[])
      : [results as InsertResult];

    for (let j = 0; j < resultArray.length; j++) {
      const r = resultArray[j];
      if (r.success && r.id) {
        idMap.set(batchSourceIds[j], r.id);
        inserted++;
      } else {
        failed++;
        errors.push({
          object: objectApiName,
          sourceId: batchSourceIds[j],
          stage: 'insert',
          error: formatErrors(r.errors),
        });
      }
    }
  }

  return { inserted, failed };
}

// ---------------------------------------------------------------------------
// Batch upsert with result tracking
// ---------------------------------------------------------------------------

async function batchUpsert(
  conn: Connection,
  objectApiName: string,
  records: Array<Record<string, unknown>>,
  sourceIds: string[],
  externalIdField: string,
  idMap: IdMap,
  errors: SeedError[],
  logger: SeederLogger,
  dryRun: boolean
): Promise<{ inserted: number; updated: number; failed: number }> {
  let inserted = 0;
  let updated = 0;
  let failed = 0;

  if (dryRun) {
    logger.log(`  [DRY RUN] Would upsert ${records.length} ${objectApiName} records via ${externalIdField}`);
    return { inserted: records.length, updated: 0, failed: 0 };
  }

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchSourceIds = sourceIds.slice(i, i + BATCH_SIZE);

    logger.updateSpinner(
      `Upserting ${objectApiName} batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(records.length / BATCH_SIZE)}`
    );

    const results = await conn.sobject(objectApiName).upsert(batch, externalIdField);
    const resultArray = Array.isArray(results) ? results : [results];

    for (let j = 0; j < resultArray.length; j++) {
      const r = resultArray[j] as InsertResult & { created?: boolean };
      if (r.success) {
        if (r.id) {
          idMap.set(batchSourceIds[j], r.id);
        }
        if (r.created === false) {
          updated++;
        } else {
          inserted++;
        }
      } else {
        failed++;
        errors.push({
          object: objectApiName,
          sourceId: batchSourceIds[j],
          stage: 'upsert',
          error: formatErrors(r.errors),
        });
      }
    }

    // For upsert, query back target IDs for records that were updated (no ID returned)
    if (!dryRun) {
      const missingMappings = batchSourceIds.filter((sid) => !idMap.has(sid));
      if (missingMappings.length > 0) {
        // Query by external ID to get the target IDs
        const extIdValues = missingMappings
          .map((sid) => {
            const rec = records.find((_, idx) => sourceIds[idx] === sid);
            return rec ? rec[externalIdField] : null;
          })
          .filter((v): v is string => v !== null && v !== undefined);

        if (extIdValues.length > 0) {
          const targetRecords = await queryAllChunked(
            conn,
            extIdValues.map(String),
            (chunk) =>
              `SELECT Id, ${externalIdField} FROM ${objectApiName} WHERE ${externalIdField} IN (${inClause(chunk)})`
          );

          // Build a reverse map: extIdValue -> sourceId
          const extToSource = new Map<string, string>();
          for (const sid of missingMappings) {
            const idx = sourceIds.indexOf(sid);
            if (idx !== -1) {
              const extVal = String(records[idx][externalIdField] ?? '');
              if (extVal) extToSource.set(extVal, sid);
            }
          }

          for (const tr of targetRecords) {
            const extVal = String(tr[externalIdField] ?? '');
            const sid = extToSource.get(extVal);
            if (sid && tr['Id']) {
              idMap.set(sid, tr['Id'] as string);
            }
          }
        }
      }
    }
  }

  return { inserted, updated, failed };
}

// ---------------------------------------------------------------------------
// Reference field categorization for core object
// ---------------------------------------------------------------------------

interface RefFieldCategories {
  systemFields: Set<string>;
  selfRefFields: Set<string>;
  dependencyFields: Map<string, string>;  // fieldName -> target object API name
}

function categorizeReferenceFields(
  fields: FieldInfo[],
  coreObjectApiName: string
): RefFieldCategories {
  const systemFields = new Set<string>();
  const selfRefFields = new Set<string>();
  const dependencyFields = new Map<string, string>();

  for (const f of fields) {
    if (!f.createable || f.referenceTo.length === 0 || f.type !== 'reference') continue;

    const refs = f.referenceTo;

    // Self-reference (e.g., Account.ParentId → Account)
    if (refs.length === 1 && refs[0] === coreObjectApiName) {
      selfRefFields.add(f.name);
      continue;
    }

    // All targets are system objects → strip
    const nonSystemTargets = refs.filter((r) => !SYSTEM_LOOKUP_OBJECTS.has(r));
    if (nonSystemTargets.length === 0) {
      systemFields.add(f.name);
      continue;
    }

    // Polymorphic with mixed system + non-system: if it includes self, treat as self-ref
    if (refs.includes(coreObjectApiName)) {
      selfRefFields.add(f.name);
      continue;
    }

    // Single non-system target → data dependency (pull in those records)
    if (nonSystemTargets.length === 1) {
      dependencyFields.set(f.name, nonSystemTargets[0]);
      continue;
    }

    // Polymorphic with multiple non-system targets — too complex, strip to be safe
    systemFields.add(f.name);
  }

  return { systemFields, selfRefFields, dependencyFields };
}

// ---------------------------------------------------------------------------
// Seed dependency objects — pull in records referenced by core object lookups
// ---------------------------------------------------------------------------

async function seedDependencyObjects(
  config: SeedConfig,
  sourceRecords: Array<Record<string, unknown>>,
  dependencyFields: Map<string, string>,
  idMaps: IdMapCollection,
  errors: SeedError[]
): Promise<void> {
  const { sourceConn, targetConn, logger, dryRun } = config;

  // Collect unique referenced IDs per target object
  const idsByObject = new Map<string, Set<string>>();
  const fieldToObject = new Map<string, string>();

  for (const [fieldName, targetObject] of dependencyFields) {
    fieldToObject.set(fieldName, targetObject);
    if (!idsByObject.has(targetObject)) {
      idsByObject.set(targetObject, new Set());
    }
    for (const rec of sourceRecords) {
      const val = rec[fieldName] as string | null;
      if (val) {
        idsByObject.get(targetObject)!.add(val);
      }
    }
  }

  for (const [depObjectName, sourceIds] of idsByObject) {
    if (sourceIds.size === 0) continue;
    if (idMaps[depObjectName]) continue; // Already seeded

    logger.startSpinner(`Pulling in ${sourceIds.size} referenced ${depObjectName} record(s)...`);

    try {
      // Check if the object is createable in the target
      const depTargetFields = await getObjectFields(targetConn, depObjectName);
      const depTargetCreateable = depTargetFields.some((f) => f.createable);
      if (!depTargetCreateable) {
        logger.stopSpinner(`${depObjectName}: not createable in target — stripping lookups`);
        // Move these fields to "system" category by removing from dependencyFields
        for (const [fieldName, obj] of dependencyFields) {
          if (obj === depObjectName) dependencyFields.delete(fieldName);
        }
        continue;
      }

      // Get insertable fields (intersected with target)
      const depSourceFields = await getObjectFields(sourceConn, depObjectName);
      const depSourceInsertable = getInsertableFieldNames(depSourceFields);
      const depTargetCreateableNames = new Set(depTargetFields.filter((f) => f.createable).map((f) => f.name));
      const depInsertableFields = depSourceInsertable.filter((f) => depTargetCreateableNames.has(f));

      if (depInsertableFields.length === 0) {
        logger.stopSpinner(`${depObjectName}: no insertable fields — skipping`);
        for (const [fieldName, obj] of dependencyFields) {
          if (obj === depObjectName) dependencyFields.delete(fieldName);
        }
        continue;
      }

      const depSelectFields = buildSelectFields(depInsertableFields);
      const idsArray = [...sourceIds];

      // Query the specific referenced records by ID
      const depRecords = await queryAllChunked(
        sourceConn,
        idsArray,
        (chunk) => `SELECT ${depSelectFields} FROM ${depObjectName} WHERE Id IN (${inClause(chunk)})`
      );

      if (depRecords.length === 0) {
        logger.stopSpinner(`${depObjectName}: no records found`);
        continue;
      }

      // Strip all reference fields on dependency records (no cascading)
      const depRefFieldNames = new Set(
        depSourceFields
          .filter((f) => f.createable && f.referenceTo.length > 0 && f.type === 'reference')
          .map((f) => f.name)
      );

      const depIdMap: IdMap = new Map();
      idMaps[depObjectName] = depIdMap;

      const depPrepared: Array<Record<string, unknown>> = [];
      const depPreparedSourceIds: string[] = [];

      for (const rec of depRecords) {
        const p: Record<string, unknown> = {};
        for (const fname of depInsertableFields) {
          if (rec[fname] === undefined) continue;
          // Strip all lookup fields on dependency objects (one level only, no cascade)
          if (depRefFieldNames.has(fname) && rec[fname] !== null) continue;
          p[fname] = rec[fname];
        }
        depPrepared.push(p);
        depPreparedSourceIds.push(rec['Id'] as string);
      }

      const result = await batchInsert(
        targetConn, depObjectName, depPrepared, depPreparedSourceIds,
        depIdMap, errors, logger, dryRun
      );

      logger.stopSpinner(`${depObjectName}: ${result.inserted} pulled in, ${result.failed} failed`);
    } catch (err) {
      logger.stopSpinnerFail(`${depObjectName}: failed to pull in — ${err instanceof Error ? err.message : String(err)}`);
      // Remove from dependency fields so the core object strips these lookups
      for (const [fieldName, obj] of dependencyFields) {
        if (obj === depObjectName) dependencyFields.delete(fieldName);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1: Seed core object
// ---------------------------------------------------------------------------

async function seedCoreObject(
  config: SeedConfig,
  idMaps: IdMapCollection,
  errors: SeedError[]
): Promise<ObjectSeedResult> {
  const { sourceConn, targetConn, coreObject, logger, dryRun } = config;
  const objectApiName = coreObject.objectApiName;

  logger.startSpinner(`Querying ${objectApiName} from source...`);

  const sourceFields = await getObjectFields(sourceConn, objectApiName);
  const sourceInsertable = getInsertableFieldNames(sourceFields);

  // Intersect with target's createable fields to avoid schema mismatches
  const targetFields = await getObjectFields(targetConn, objectApiName);
  const targetCreateable = new Set(targetFields.filter((f) => f.createable).map((f) => f.name));
  const insertableFields = sourceInsertable.filter((f) => targetCreateable.has(f));

  const selectFields = buildSelectFields(insertableFields);
  const soql = buildSeedQuery(selectFields, objectApiName, config.whereClause, config.recordCount);

  const sourceRecords = await queryAll(sourceConn, soql);
  logger.updateSpinner(`Found ${sourceRecords.length} ${objectApiName} records`);

  if (sourceRecords.length === 0) {
    logger.stopSpinner('No records found');
    return { objectApiName, queried: 0, inserted: 0, updated: 0, failed: 0, skipped: 0 };
  }

  // Categorize reference fields: system (strip), self-ref (defer), data dependency (pull in)
  const { systemFields, selfRefFields, dependencyFields } = categorizeReferenceFields(
    sourceFields.filter((f) => insertableFields.includes(f.name) || selfRefFieldCheck(f, objectApiName)),
    objectApiName
  );

  // Pull in dependency records (e.g., custom lookup targets)
  if (dependencyFields.size > 0) {
    logger.stopSpinner(`Found ${dependencyFields.size} data dependency lookup(s) to resolve`);
    await seedDependencyObjects(config, sourceRecords, dependencyFields, idMaps, errors);
  }

  // Also pull in self-referenced records not in the current batch
  const selfRefSourceIds = new Set(sourceRecords.map((r) => r['Id'] as string));
  const extraParentIds = new Set<string>();

  for (const fieldName of selfRefFields) {
    for (const rec of sourceRecords) {
      const val = rec[fieldName] as string | null;
      if (val && !selfRefSourceIds.has(val)) {
        extraParentIds.add(val);
      }
    }
  }

  // Query and prepend extra parent records so they're inserted first
  let allRecordsToInsert = [...sourceRecords];
  if (extraParentIds.size > 0) {
    logger.startSpinner(`Pulling in ${extraParentIds.size} parent ${objectApiName} record(s)...`);
    const extraParents = await queryAllChunked(
      sourceConn,
      [...extraParentIds],
      (chunk) => `SELECT ${selectFields} FROM ${objectApiName} WHERE Id IN (${inClause(chunk)})`
    );
    logger.stopSpinner(`Pulled in ${extraParents.length} parent record(s)`);
    // Parents go first so they're in the IdMap when we update self-refs
    allRecordsToInsert = [...extraParents, ...sourceRecords];
  }

  const coreIdMap: IdMap = new Map();
  idMaps[objectApiName] = coreIdMap;

  // Build set of dependency object names that were successfully seeded
  const resolvedDependencyFields = new Set(dependencyFields.keys());

  // Prepare core records — remap dependency lookups, strip system, defer self-refs
  logger.startSpinner(`Inserting ${allRecordsToInsert.length} ${objectApiName} records into target...`);

  const prepared: Array<Record<string, unknown>> = [];
  const preparedSourceIds: string[] = [];

  for (const rec of allRecordsToInsert) {
    const p: Record<string, unknown> = {};
    for (const fname of insertableFields) {
      if (rec[fname] === undefined) continue;

      if (systemFields.has(fname) && rec[fname] !== null) {
        // System lookup — strip
        continue;
      }

      if (selfRefFields.has(fname)) {
        // Self-reference — defer to post-insert update
        continue;
      }

      if (resolvedDependencyFields.has(fname) && rec[fname] !== null) {
        // Data dependency — remap using IdMap
        const sourceId = rec[fname] as string;
        const targetId = findInAnyIdMap(idMaps, sourceId);
        if (targetId) {
          p[fname] = targetId;
        } else {
          // Dependency record wasn't seeded (maybe it failed) — null out if possible
          const fieldInfo = sourceFields.find((f) => f.name === fname);
          if (fieldInfo?.nillable) {
            p[fname] = null;
          }
          // If not nillable, just omit it and let SF use the default
        }
        continue;
      }

      p[fname] = rec[fname];
    }
    prepared.push(p);
    preparedSourceIds.push(rec['Id'] as string);
  }

  let inserted = 0;
  let updated = 0;
  let failed = 0;

  if (coreObject.externalIdField) {
    const result = await batchUpsert(
      targetConn, objectApiName, prepared, preparedSourceIds,
      coreObject.externalIdField, coreIdMap, errors, logger, dryRun
    );
    inserted = result.inserted;
    updated = result.updated;
    failed = result.failed;
  } else {
    const result = await batchInsert(
      targetConn, objectApiName, prepared, preparedSourceIds,
      coreIdMap, errors, logger, dryRun
    );
    inserted = result.inserted;
    failed = result.failed;
  }

  logger.stopSpinner(`${objectApiName}: ${inserted} inserted, ${updated} updated, ${failed} failed`);

  // Post-insert: update self-reference fields using the IdMap
  if (selfRefFields.size > 0 && coreIdMap.size > 0 && !dryRun) {
    const updates: Array<Record<string, unknown>> = [];

    for (const rec of allRecordsToInsert) {
      const sourceId = rec['Id'] as string;
      const targetId = coreIdMap.get(sourceId);
      if (!targetId) continue;

      const updateRec: Record<string, unknown> = { Id: targetId };
      let hasUpdate = false;

      for (const fieldName of selfRefFields) {
        const refSourceId = rec[fieldName] as string | null;
        if (refSourceId) {
          const refTargetId = coreIdMap.get(refSourceId);
          if (refTargetId) {
            updateRec[fieldName] = refTargetId;
            hasUpdate = true;
          }
        }
      }

      if (hasUpdate) {
        updates.push(updateRec);
      }
    }

    if (updates.length > 0) {
      logger.startSpinner(`Updating ${updates.length} ${objectApiName} self-reference(s)...`);

      for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = updates.slice(i, i + BATCH_SIZE);
        const updateResults = await targetConn.sobject(objectApiName).update(batch as Array<Record<string, unknown> & { Id: string }>);
        const resultArray = Array.isArray(updateResults) ? updateResults : [updateResults];

        for (const r of resultArray as InsertResult[]) {
          if (!r.success) {
            errors.push({
              object: objectApiName,
              stage: 'self-ref update',
              error: formatErrors(r.errors),
            });
          }
        }
      }

      logger.stopSpinner(`Updated ${updates.length} self-reference(s)`);
    }
  } else if (selfRefFields.size > 0 && dryRun) {
    const selfRefCount = allRecordsToInsert.filter((rec) =>
      [...selfRefFields].some((f) => rec[f] !== null && rec[f] !== undefined)
    ).length;
    if (selfRefCount > 0) {
      logger.log(`  [DRY RUN] Would update ${selfRefCount} self-reference(s) after insert`);
    }
  }

  return {
    objectApiName,
    queried: sourceRecords.length,
    inserted,
    updated,
    failed,
    skipped: 0,
  };
}

// Helper for categorizeReferenceFields — check if a field is a self-ref candidate
function selfRefFieldCheck(f: FieldInfo, objectApiName: string): boolean {
  return f.createable && f.type === 'reference' && f.referenceTo.includes(objectApiName);
}

// ---------------------------------------------------------------------------
// Step 2 & 3: Seed child / grandchild objects
// ---------------------------------------------------------------------------

async function seedRelatedObject(
  config: SeedConfig,
  objectApiName: string,
  lookupField: string,
  parentSourceIds: string[],
  idMaps: IdMapCollection,
  errors: SeedError[],
  externalIdField?: string
): Promise<ObjectSeedResult> {
  const { sourceConn, targetConn, logger, dryRun } = config;

  logger.startSpinner(`Querying ${objectApiName} from source...`);

  const sourceFields = await getObjectFields(sourceConn, objectApiName);
  const sourceInsertable = getInsertableFieldNames(sourceFields);

  // Intersect with target's createable fields to avoid schema mismatches
  const targetFields = await getObjectFields(targetConn, objectApiName);
  const targetCreateable = new Set(targetFields.filter((f) => f.createable).map((f) => f.name));
  const insertableFields = sourceInsertable.filter((f) => targetCreateable.has(f));

  const selectFields = buildSelectFields(insertableFields);

  // Build set of all objects in scope for lookup remapping
  const objectsInScope = new Set(Object.keys(idMaps));
  const lookupFields = findLookupFieldsToRemap(sourceFields, objectsInScope);

  // All reference fields (for stripping out-of-scope lookups)
  const allReferenceFields = sourceFields.filter(
    (f) => f.createable && f.referenceTo.length > 0 && f.type === 'reference'
  );

  // Query children WHERE lookup IN (parent source IDs)
  const sourceRecords = await queryAllChunked(
    sourceConn,
    parentSourceIds,
    (chunk) =>
      `${buildSeedQuery(selectFields, objectApiName)} WHERE ${lookupField} IN (${inClause(chunk)})`
  );

  logger.updateSpinner(`Found ${sourceRecords.length} ${objectApiName} records`);

  if (sourceRecords.length === 0) {
    logger.stopSpinner(`${objectApiName}: no records found`);
    return { objectApiName, queried: 0, inserted: 0, updated: 0, failed: 0, skipped: 0 };
  }

  const objIdMap: IdMap = new Map();
  if (!idMaps[objectApiName]) {
    idMaps[objectApiName] = objIdMap;
  } else {
    // Merge into existing if multiple parents contribute to same child
    // (e.g., grandchild might already have some entries)
  }
  const targetIdMap = idMaps[objectApiName];

  const prepared: Array<Record<string, unknown>> = [];
  const preparedSourceIds: string[] = [];
  let skipped = 0;

  for (const rec of sourceRecords) {
    const p = prepareRecord(rec, insertableFields, lookupFields, allReferenceFields, idMaps, errors, objectApiName);
    if (p) {
      prepared.push(p);
      preparedSourceIds.push(rec['Id'] as string);
    } else {
      skipped++;
    }
  }

  if (prepared.length === 0) {
    logger.stopSpinner(`${objectApiName}: all ${sourceRecords.length} records skipped (lookup remap failures)`);
    return { objectApiName, queried: sourceRecords.length, inserted: 0, updated: 0, failed: 0, skipped };
  }

  logger.updateSpinner(`Inserting ${prepared.length} ${objectApiName} records into target...`);

  let inserted = 0;
  let updated = 0;
  let failed = 0;

  if (externalIdField) {
    const result = await batchUpsert(
      targetConn, objectApiName, prepared, preparedSourceIds,
      externalIdField, targetIdMap, errors, logger, dryRun
    );
    inserted = result.inserted;
    updated = result.updated;
    failed = result.failed;
  } else {
    const result = await batchInsert(
      targetConn, objectApiName, prepared, preparedSourceIds,
      targetIdMap, errors, logger, dryRun
    );
    inserted = result.inserted;
    failed = result.failed;
  }

  logger.stopSpinner(`${objectApiName}: ${inserted} inserted, ${updated} updated, ${failed} failed, ${skipped} skipped`);

  return {
    objectApiName,
    queried: sourceRecords.length,
    inserted,
    updated,
    failed,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Step 4 & 5: Seed Activities (Tasks / Events)
// ---------------------------------------------------------------------------

async function seedActivities(
  config: SeedConfig,
  activityType: 'Task' | 'Event',
  idMaps: IdMapCollection,
  errors: SeedError[]
): Promise<ObjectSeedResult> {
  const { sourceConn, targetConn, logger, dryRun } = config;

  logger.startSpinner(`Querying ${activityType}s from source...`);

  const sourceFields = await getObjectFields(sourceConn, activityType);
  const sourceInsertable = sourceFields
    .filter((f) => {
      if (!f.createable) return false;
      if (ACTIVITY_SYSTEM_FIELDS.has(f.name)) return false;
      if (f.type === 'address' || f.type === 'location') return false;
      return true;
    })
    .map((f) => f.name);

  // Intersect with target's createable fields to avoid schema mismatches
  const targetFields = await getObjectFields(targetConn, activityType);
  const targetCreateable = new Set(targetFields.filter((f) => f.createable).map((f) => f.name));
  const insertableFields = sourceInsertable.filter((f) => targetCreateable.has(f));

  const selectFields = buildSelectFields(insertableFields, ['WhatId', 'WhoId']);
  const allSourceIds = getAllSourceIds(idMaps);

  if (allSourceIds.length === 0) {
    logger.stopSpinner(`No source IDs to query ${activityType}s for`);
    return { objectApiName: activityType, queried: 0, inserted: 0, updated: 0, failed: 0, skipped: 0 };
  }

  // Query activities WHERE WhatId IN (...) OR WhoId IN (...)
  // We query both separately and deduplicate
  const whatRecords = await queryAllChunked(
    sourceConn,
    allSourceIds,
    (chunk) =>
      `SELECT ${selectFields} FROM ${activityType} WHERE WhatId IN (${inClause(chunk)})`
  );

  const whoRecords = await queryAllChunked(
    sourceConn,
    allSourceIds,
    (chunk) =>
      `SELECT ${selectFields} FROM ${activityType} WHERE WhoId IN (${inClause(chunk)})`
  );

  // Deduplicate
  const seenIds = new Set<string>();
  const sourceRecords: Array<Record<string, unknown>> = [];

  for (const rec of [...whatRecords, ...whoRecords]) {
    const id = rec['Id'] as string;
    if (!seenIds.has(id)) {
      seenIds.add(id);
      sourceRecords.push(rec);
    }
  }

  logger.updateSpinner(`Found ${sourceRecords.length} ${activityType}s`);

  if (sourceRecords.length === 0) {
    logger.stopSpinner(`${activityType}: no records found`);
    return { objectApiName: activityType, queried: 0, inserted: 0, updated: 0, failed: 0, skipped: 0 };
  }

  const activityIdMap: IdMap = new Map();
  idMaps[activityType] = activityIdMap;

  const insertableSet = new Set(insertableFields);
  const prepared: Array<Record<string, unknown>> = [];
  const preparedSourceIds: string[] = [];
  let skipped = 0;

  for (const rec of sourceRecords) {
    const p: Record<string, unknown> = {};
    let skipRecord = false;

    for (const fieldName of insertableSet) {
      const value = rec[fieldName];
      if (value === undefined) continue;
      p[fieldName] = value;
    }

    // Remap WhatId (polymorphic)
    const whatId = rec['WhatId'] as string | null;
    if (whatId) {
      const targetWhatId = findInAnyIdMap(idMaps, whatId);
      if (targetWhatId) {
        p['WhatId'] = targetWhatId;
      } else {
        p['WhatId'] = null;
      }
    }

    // Remap WhoId (polymorphic)
    const whoId = rec['WhoId'] as string | null;
    if (whoId) {
      const targetWhoId = findInAnyIdMap(idMaps, whoId);
      if (targetWhoId) {
        p['WhoId'] = targetWhoId;
      } else {
        p['WhoId'] = null;
      }
    }

    if (!skipRecord) {
      prepared.push(p);
      preparedSourceIds.push(rec['Id'] as string);
    } else {
      skipped++;
    }
  }

  logger.updateSpinner(`Inserting ${prepared.length} ${activityType}s into target...`);

  const result = await batchInsert(
    targetConn, activityType, prepared, preparedSourceIds,
    activityIdMap, errors, logger, dryRun
  );

  logger.stopSpinner(`${activityType}: ${result.inserted} inserted, ${result.failed} failed, ${skipped} skipped`);

  return {
    objectApiName: activityType,
    queried: sourceRecords.length,
    inserted: result.inserted,
    updated: 0,
    failed: result.failed,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Step 6: Seed Files (ContentDocumentLink + ContentVersion)
// ---------------------------------------------------------------------------

async function seedFiles(
  config: SeedConfig,
  idMaps: IdMapCollection,
  errors: SeedError[]
): Promise<FileSeedResult> {
  const { sourceConn, targetConn, logger, dryRun } = config;

  logger.startSpinner('Querying ContentDocumentLinks from source...');

  const allSourceIds = getAllSourceIds(idMaps);

  if (allSourceIds.length === 0) {
    logger.stopSpinner('No source IDs to query files for');
    return { filesFound: 0, filesUploaded: 0, filesFailed: 0, linksCreated: 0 };
  }

  // Step 6a: Query ContentDocumentLinks
  const links = await queryAllChunked(
    sourceConn,
    allSourceIds,
    (chunk) =>
      `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId IN (${inClause(chunk)})`
  );

  if (links.length === 0) {
    logger.stopSpinner('No files found');
    return { filesFound: 0, filesUploaded: 0, filesFailed: 0, linksCreated: 0 };
  }

  // Get unique ContentDocumentIds
  const contentDocIds = [...new Set(links.map((l) => l['ContentDocumentId'] as string))];
  logger.updateSpinner(`Found ${contentDocIds.length} unique files across ${links.length} links`);

  // Step 6b: Query ContentVersions (latest version of each document)
  const versions = await queryAllChunked(
    sourceConn,
    contentDocIds,
    (chunk) =>
      `SELECT Id, ContentDocumentId, Title, PathOnClient, FileExtension, ContentSize, Description
       FROM ContentVersion
       WHERE ContentDocumentId IN (${inClause(chunk)}) AND IsLatestVersion = true`
  );

  logger.updateSpinner(`Found ${versions.length} ContentVersions to transfer`);

  if (dryRun) {
    const totalSize = versions.reduce((sum, v) => sum + ((v['ContentSize'] as number) || 0), 0);
    logger.stopSpinner(
      `[DRY RUN] Would upload ${versions.length} files (${formatBytes(totalSize)}) and create ${links.length} links`
    );
    return {
      filesFound: versions.length,
      filesUploaded: versions.length,
      filesFailed: 0,
      linksCreated: links.length,
    };
  }

  // Step 6c: Download and upload files
  let filesUploaded = 0;
  let filesFailed = 0;
  const sourceDocIdToTargetDocId = new Map<string, string>();

  for (let i = 0; i < versions.length; i++) {
    const cv = versions[i];
    const cvId = cv['Id'] as string;
    const title = cv['Title'] as string;
    const contentDocId = cv['ContentDocumentId'] as string;

    logger.updateSpinner(`Uploading file ${i + 1}/${versions.length}: ${title}`);

    try {
      // Download binary content
      const apiVersion = sourceConn.getApiVersion();
      const downloadUrl = `${sourceConn.instanceUrl}/services/data/v${apiVersion}/sobjects/ContentVersion/${cvId}/VersionData`;
      const response = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${sourceConn.accessToken!}` },
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64Body = buffer.toString('base64');

      // Upload to target
      const insertResult = await targetConn.sobject('ContentVersion').create({
        Title: title,
        PathOnClient: cv['PathOnClient'] as string,
        VersionData: base64Body,
        Description: (cv['Description'] as string) || '',
      });

      const result = insertResult as unknown as InsertResult;
      if (result.success && result.id) {
        filesUploaded++;

        // Query back the ContentDocumentId for the newly created version
        const newCv = await targetConn.query(
          `SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${result.id}'`
        );
        const newRecords = (newCv as unknown as { records: Array<Record<string, unknown>> }).records;
        if (newRecords.length > 0) {
          sourceDocIdToTargetDocId.set(contentDocId, newRecords[0]['ContentDocumentId'] as string);
        }
      } else {
        filesFailed++;
        errors.push({
          object: 'ContentVersion',
          sourceId: cvId,
          stage: 'upload',
          error: formatErrors(result.errors),
        });
      }
    } catch (err) {
      filesFailed++;
      errors.push({
        object: 'ContentVersion',
        sourceId: cvId,
        stage: 'upload',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 6d: Create ContentDocumentLinks in target
  logger.updateSpinner('Creating ContentDocumentLinks in target...');

  let linksCreated = 0;
  const newLinks: Array<Record<string, unknown>> = [];

  for (const link of links) {
    const sourceDocId = link['ContentDocumentId'] as string;
    const sourceEntityId = link['LinkedEntityId'] as string;

    const targetDocId = sourceDocIdToTargetDocId.get(sourceDocId);
    const targetEntityId = findInAnyIdMap(idMaps, sourceEntityId);

    if (targetDocId && targetEntityId) {
      newLinks.push({
        ContentDocumentId: targetDocId,
        LinkedEntityId: targetEntityId,
        ShareType: 'V',
        Visibility: 'AllUsers',
      });
    }
  }

  for (let i = 0; i < newLinks.length; i += BATCH_SIZE) {
    const batch = newLinks.slice(i, i + BATCH_SIZE);
    const insertResults = await targetConn.sobject('ContentDocumentLink').create(batch);
    const resultArray = Array.isArray(insertResults) ? insertResults : [insertResults];

    for (const r of resultArray as InsertResult[]) {
      if (r.success) {
        linksCreated++;
      } else {
        errors.push({
          object: 'ContentDocumentLink',
          stage: 'link',
          error: formatErrors(r.errors),
        });
      }
    }
  }

  logger.stopSpinner(
    `Files: ${filesUploaded} uploaded, ${filesFailed} failed, ${linksCreated} links created`
  );

  return {
    filesFound: versions.length,
    filesUploaded,
    filesFailed,
    linksCreated,
  };
}

// ---------------------------------------------------------------------------
// Main entry point: runSeeder
// ---------------------------------------------------------------------------

export async function runSeeder(config: SeedConfig): Promise<SeedResults> {
  const { logger, shouldAbort } = config;
  const idMaps: IdMapCollection = {};
  const errors: SeedError[] = [];

  const results: SeedResults = {
    coreObject: { objectApiName: '', queried: 0, inserted: 0, updated: 0, failed: 0, skipped: 0 },
    children: [],
    grandchildren: [],
    tasks: null,
    events: null,
    files: null,
    errors,
    dryRun: config.dryRun,
  };

  // Step 1: Core object
  logger.log(`\nStep 1/6: Seeding core object — ${config.coreObject.objectApiName}`);
  results.coreObject = await seedCoreObject(config, idMaps, errors);

  if (shouldAbort?.()) {
    logger.warn('Aborted after core object');
    return results;
  }

  if (results.coreObject.inserted === 0 && results.coreObject.updated === 0 && !config.dryRun) {
    logger.warn('No core records were created. Skipping children/activities/files.');
    return results;
  }

  // Collect core source IDs
  const coreSourceIds = [...(idMaps[config.coreObject.objectApiName]?.keys() ?? [])];

  // Step 2: Child objects (sequential)
  if (config.children.length > 0) {
    logger.log(`\nStep 2/6: Seeding ${config.children.length} child object(s)`);

    for (const child of config.children) {
      if (shouldAbort?.()) {
        logger.warn('Aborted during child seeding');
        return results;
      }

      const childResult = await seedRelatedObject(
        config,
        child.objectApiName,
        child.lookupField,
        coreSourceIds,
        idMaps,
        errors,
        child.externalIdField
      );
      results.children.push(childResult);
    }
  } else {
    logger.log('\nStep 2/6: No child objects selected — skipping');
  }

  // Step 3: Grandchild objects (after all children)
  const grandchildren = config.children.flatMap((c) => c.grandchildren);
  if (grandchildren.length > 0) {
    logger.log(`\nStep 3/6: Seeding ${grandchildren.length} grandchild object(s)`);

    for (const gc of grandchildren) {
      if (shouldAbort?.()) {
        logger.warn('Aborted during grandchild seeding');
        return results;
      }

      const parentChildIdMap = idMaps[gc.parentChildObject];
      if (!parentChildIdMap || parentChildIdMap.size === 0) {
        logger.log(`  Skipping ${gc.objectApiName} — no ${gc.parentChildObject} records were seeded`);
        continue;
      }

      const parentSourceIds = [...parentChildIdMap.keys()];
      const gcResult = await seedRelatedObject(
        config,
        gc.objectApiName,
        gc.lookupField,
        parentSourceIds,
        idMaps,
        errors,
        gc.externalIdField
      );
      results.grandchildren.push(gcResult);
    }
  } else {
    logger.log('\nStep 3/6: No grandchild objects selected — skipping');
  }

  // Step 4: Tasks
  if (config.includeTasks) {
    logger.log('\nStep 4/6: Seeding Tasks');
    if (shouldAbort?.()) {
      logger.warn('Aborted before Tasks');
      return results;
    }
    results.tasks = await seedActivities(config, 'Task', idMaps, errors);
  } else {
    logger.log('\nStep 4/6: Tasks not selected — skipping');
  }

  // Step 5: Events
  if (config.includeEvents) {
    logger.log('\nStep 5/6: Seeding Events');
    if (shouldAbort?.()) {
      logger.warn('Aborted before Events');
      return results;
    }
    results.events = await seedActivities(config, 'Event', idMaps, errors);
  } else {
    logger.log('\nStep 5/6: Events not selected — skipping');
  }

  // Step 6: Files
  if (config.includeFiles) {
    logger.log('\nStep 6/6: Seeding Files');
    if (shouldAbort?.()) {
      logger.warn('Aborted before Files');
      return results;
    }
    results.files = await seedFiles(config, idMaps, errors);
  } else {
    logger.log('\nStep 6/6: Files not selected — skipping');
  }

  return results;
}
