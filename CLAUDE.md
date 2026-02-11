# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SF-CLI-SEEDBUDDY is a Salesforce CLI plugin that seeds records from a source org to a target org, including hierarchical child/grandchild objects, Tasks, Events, and ContentDocument files. It automatically discovers relationships via `conn.describe()`, remaps all lookup IDs across object tiers, and handles polymorphic activity fields (WhatId/WhoId). The plugin supports both an interactive guided experience (Inquirer-based) and direct flag-based execution.

**Command:** `sf seedbuddy seed`

## Build and Development Commands

```bash
# Build TypeScript to lib/
npm run build

# Clean compiled output
npm run clean

# Install dependencies
npm install

# Link plugin to Salesforce CLI (for local development)
sf plugins link .

# Verify plugin is registered
sf seedbuddy seed --help
```

## Architecture

### Plugin Framework

This is an **oclif plugin** for the Salesforce CLI (`sf`). Key framework details:
- **ESM module** (`"type": "module"` in package.json) — all imports use `.js` extensions even for `.ts` source files
- **TypeScript** compiled to `lib/` via `tsc -b` — ES2022 target, Node16 module resolution, strict mode
- **oclif config** in package.json: `bin: "sf"`, `commands: "./lib/commands"`, `topicSeparator: " "`
- **Messages** loaded from `messages/seedbuddy.seed.md` via `Messages.importMessagesDirectoryFromMetaUrl(import.meta.url)` — each `# heading` becomes a message key

### Command Class

**`src/commands/seedbuddy/seed.ts`** — Extends `SfCommand<SeedResults | void>`

**Dual-mode routing:**
- If `source-org` + `target-org` + `object` are all provided → **flag mode** (direct execution via `runFlagMode()`)
- Otherwise → **interactive mode** (launches Inquirer menu via `runInteractive()`, prefilling any provided flags)

**Flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `source-org` | `-s` | `Flags.requiredOrg` (required: false) | — | Source org alias/username |
| `target-org` | `-t` | `Flags.requiredOrg` (required: false) | — | Target org alias/username |
| `object` | `-o` | string | — | Core SObject API name |
| `children` | `-c` | string | — | Comma-separated child object API names |
| `grandchildren` | `-g` | string | — | Comma-separated grandchild object API names |
| `include-tasks` | — | boolean | false | Include Task records |
| `include-events` | — | boolean | false | Include Event records |
| `include-files` | — | boolean | false | Include ContentDocument files |
| `count` | `-n` | string | `"10"` | Number of core records, or `"All"` |
| `where` | `-w` | string | — | SOQL WHERE clause |
| `upsert-field` | `-u` | string | — | External ID field for upsert |
| `dry-run` | `-d` | boolean | false | Preview without creating records |

**SeederLogger** adapter wraps oclif's `action` spinner: `{ log, warn, startSpinner, updateSpinner, stopSpinner, stopSpinnerFail }`

### Library Modules

**`src/lib/types.ts`** — All TypeScript interfaces and constants
- `SeederLogger` — decouples pipeline from oclif UX methods
- `ObjectInfo`, `FieldInfo`, `ChildRelationship` — schema discovery types
- `SeedConfig`, `ObjectSeedConfig`, `ChildObjectConfig`, `GrandchildObjectConfig` — user configuration
- `SeedResults`, `ObjectSeedResult`, `FileSeedResult`, `SeedError` — results
- `IdMap` (`Map<sourceId, targetId>`), `IdMapCollection` — relationship remapping
- Constants: `BATCH_SIZE = 200`, `QUERY_CHUNK_SIZE = 200`, `SYSTEM_READONLY_FIELDS`, `ACTIVITY_SYSTEM_FIELDS`, `EXCLUDED_CHILD_OBJECTS`, `EXCLUDED_CHILD_SUFFIXES`

**`src/lib/query.ts`** — SOQL helpers
- `queryAll(conn, soql)` — paginate via `conn.query()` + `conn.queryMore()` loop
- `queryAllChunked(conn, values, soqlBuilder, chunkSize)` — batch IN clauses in chunks of 200 to stay under SOQL limits
- `escSoql(val)` — escape single quotes
- `buildSelectFields(fields, additionalFields)` — build SELECT list, always includes `Id`
- `buildSeedQuery(selectFields, objectApiName, whereClause, limit)` — full SOQL builder
- `inClause(ids)` — format IDs for SOQL IN clause
- `formatBytes(bytes)` — display utility

**`src/lib/schema.ts`** — Schema discovery via `conn.describe()` / `conn.describeGlobal()`
- `getAllObjects(conn)` — returns queryable + createable objects sorted by label
- `getObjectFields(conn, objectApiName)` — full `FieldInfo[]` with `referenceTo`, `createable`, `nillable`, `externalId`
- `getChildRelationships(conn, objectApiName)` — reads `describe().childRelationships`, filters out system objects (Task, Event, ContentDocumentLink, FeedItem, *Feed, *History, *Share, *ChangeEvent), only returns createable + queryable children
- `getGrandchildRelationships(conn, childObjectNames, coreObjectApiName)` — calls `getChildRelationships()` for each child, avoids circular references by skipping objects already in scope
- `findLookupFieldsToRemap(fields, objectsInScope)` — finds reference fields pointing to in-scope objects
- `getInsertableFieldNames(fields, userExcluded)` — whitelist: createable minus SYSTEM_READONLY_FIELDS, excludes compound fields (address/location)
- `getExternalIdFields(fields)` — fields marked as externalId

**`src/lib/seeder.ts`** — Core 6-step seeding pipeline (`runSeeder(config)`)

| Step | Function | Description |
|------|----------|-------------|
| 1 | `seedCoreObject()` | Query core object from source, insert/upsert into target, build root `IdMap` |
| 2 | `seedRelatedObject()` | For each child: query WHERE lookupField IN (source parent IDs), remap ALL lookup fields pointing to in-scope objects via IdMaps, insert/upsert, build child IdMap |
| 3 | `seedRelatedObject()` | Same as step 2 but for grandchildren, using child IdMaps as parents |
| 4 | `seedActivities('Task')` | Query WHERE WhatId/WhoId IN (all source IDs across all IdMaps), remap polymorphic WhatId/WhoId via `findInAnyIdMap()`, insert |
| 5 | `seedActivities('Event')` | Same as step 4 for Events |
| 6 | `seedFiles()` | Query ContentDocumentLinks, download ContentVersion binaries via REST API (Bearer token + fetch), upload as base64, create ContentDocumentLinks with remapped entity IDs |

**Key algorithms:**
- **Lookup remapping** (`prepareRecord()`): Iterates all reference-type fields. Looks up source value in the appropriate IdMap. Required fields with no mapping cause the record to be skipped. Nillable fields set to null.
- **Polymorphic activity handling**: WhatId/WhoId searched across ALL IdMaps via `findInAnyIdMap()` — safe because SF IDs have unique 3-char key prefixes per object.
- **Batch insert** (`batchInsert()`): Processes records in batches of 200 via `conn.sobject().create()`, tracks success/failure per record, builds IdMap from results.
- **Batch upsert** (`batchUpsert()`): Uses `conn.sobject().upsert(records, extIdField)`. For updated records (no ID returned), queries back target IDs by external ID value.
- **Field stripping**: Whitelist approach via `getInsertableFieldNames()` — only copies createable fields minus SYSTEM_READONLY_FIELDS. Activities use a separate `ACTIVITY_SYSTEM_FIELDS` set with additional read-only fields.
- **File transfer**: Downloads via native `fetch()` with `Authorization: Bearer` header, converts to base64 for upload. ContentDocumentLinks created with `ShareType: 'V'`, `Visibility: 'AllUsers'`.
- **Cooperative SIGINT**: First Ctrl+C sets `aborted` flag (checked between pipeline steps), second Ctrl+C force-quits. Original SIGINT listeners restored in finally block.

**`src/lib/interactive.ts`** — Inquirer-based interactive flow
- Module-scoped state: `sourceConn`, `targetConn`, `sourceLabel`, `targetLabel`
- `showBanner()` — ASCII art box with chalk
- `connectOrg('source'|'target')` — lists authenticated orgs via `AuthInfo.listAllAuthorizations()`, connects via `Org.create()`, verifies with `conn.identity()`
- `startSeeding(logger)` — 10-step guided flow:
  1. Select core object (autocomplete from `getAllObjects()`)
  2. Select children (checkbox multi-select from `getChildRelationships()`)
  3. Select grandchildren (checkbox from `getGrandchildRelationships()`)
  4. Toggle Tasks (confirm)
  5. Toggle Events (confirm)
  6. Toggle Files (confirm)
  7. Record count (input: number or "All")
  8. WHERE clause (input, optional)
  9. Upsert config (optional: per-object External ID field selection)
  10. Review config summary + confirm → call `runSeeder()`
- `displayResults(results)` — colored summary table with error listing (max 20 shown)
- `mainMenu(logger)` — recursive loop: Connect Source, Connect Target, Start Seeding, Disconnect, Exit
- `runInteractive(prefilledFlags, logger)` — entry point, applies prefilled flags from partial flag mode

### Entry Point

**`src/index.ts`** — Plugin export barrel: `export { default as Seed } from './commands/seedbuddy/seed.js'`

### Type Declarations

**`src/types/inquirer-autocomplete-prompt.d.ts`** — Ambient type declaration for `inquirer-autocomplete-prompt` which has no bundled types.

## Data Flow

```
sf seedbuddy seed
    │
    ├─ Flag mode (all required flags present)
    │   └─ seed.ts:runFlagMode() → auto-detects child lookup fields → builds SeedConfig → runSeeder()
    │
    └─ Interactive mode (missing flags)
        └─ interactive.ts:runInteractive() → mainMenu() → startSeeding() → runSeeder()

runSeeder(config) pipeline:
    1. seedCoreObject()     → queryAll() from source → batchInsert/batchUpsert() to target → IdMap
    2. seedRelatedObject()  → queryAllChunked() children → prepareRecord() remap lookups → insert → IdMap
    3. seedRelatedObject()  → queryAllChunked() grandchildren → prepareRecord() remap → insert → IdMap
    4. seedActivities(Task) → queryAllChunked() WhatId/WhoId → findInAnyIdMap() remap → insert
    5. seedActivities(Event) → same as step 4
    6. seedFiles()          → query ContentDocumentLinks → download ContentVersions → upload → create links
```

## Constants Reference

**SYSTEM_READONLY_FIELDS** (stripped from all inserts):
`Id`, `IsDeleted`, `CreatedDate`, `CreatedById`, `LastModifiedDate`, `LastModifiedById`, `SystemModstamp`, `LastActivityDate`, `LastViewedDate`, `LastReferencedDate`

**ACTIVITY_SYSTEM_FIELDS** (additional fields stripped from Task/Event inserts):
All of the above plus: `IsClosed`, `IsArchived`, `IsRecurrence`, `IsHighPriority`, `TaskSubtype`, `EventSubtype`, `IsGroupEvent`, `GroupEventType`, `IsChild`, `IsAllDayEvent`, `IsReminderSet`, `RecurrenceActivityId`

**EXCLUDED_CHILD_OBJECTS** (filtered from child relationship discovery):
`Task`, `Event`, `ContentDocumentLink`, `FeedItem`, `FeedComment`, `TopicAssignment`, `EntitySubscription`, `NetworkUserHistoryRecent`

**EXCLUDED_CHILD_SUFFIXES**: `__Feed`, `__History`, `__Share`, `__ChangeEvent`, `History`, `Feed`, `Share`, `ChangeEvent`

## File Structure

```
sf-cli-seedbuddy/
├── package.json                              # oclif plugin config, ESM, dependencies
├── tsconfig.json                             # ES2022, Node16, strict
├── .gitignore                                # node_modules, lib, tsbuildinfo
├── messages/
│   └── seedbuddy.seed.md                     # Help text (oclif markdown messages)
├── src/
│   ├── index.ts                              # Plugin export barrel
│   ├── commands/seedbuddy/
│   │   └── seed.ts                           # SfCommand class, flags, dual-mode routing
│   ├── lib/
│   │   ├── types.ts                          # All TypeScript interfaces + constants
│   │   ├── query.ts                          # SOQL helpers (queryAll, queryAllChunked, escSoql)
│   │   ├── schema.ts                         # Schema discovery (child/grandchild detection)
│   │   ├── seeder.ts                         # Core 6-step seeding pipeline
│   │   └── interactive.ts                    # Inquirer-based interactive flow
│   └── types/
│       └── inquirer-autocomplete-prompt.d.ts # Ambient type declaration
└── lib/                                      # Compiled output (git-ignored)
```

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@oclif/core` | ^4 | CLI framework |
| `@salesforce/core` | ^8 | Org connections, AuthInfo, Connection |
| `@salesforce/sf-plugins-core` | ^12 | SfCommand, Flags |
| `chalk` | ^5.3.0 | Terminal colors |
| `inquirer` | ^9.2.12 | Interactive prompts |
| `inquirer-autocomplete-prompt` | ^3.0.1 | Autocomplete prompt for object selection |
| `typescript` | ^5 | Build-time compiler |

## Development Notes

- All imports use `.js` extensions (ESM requirement with Node16 module resolution)
- The plugin follows the same architecture as `sf-cli-migrator` — see that project for additional patterns (state management, temp file handling)
- `Flags.requiredOrg({ required: false })` allows oclif to auto-resolve org aliases to `Org` objects when provided, but returns `undefined` when omitted (enabling interactive fallback)
- Batch operations use `conn.sobject('ObjectName').create(recordArray)` which returns `InsertResult[]` — always handle both single-result and array-result shapes
- File downloads use native `fetch()` with Bearer token auth against the REST API `/services/data/vXX.0/sobjects/ContentVersion/{id}/VersionData`
- The cooperative SIGINT handler checks `shouldAbort()` between each pipeline step — it does NOT interrupt mid-batch
