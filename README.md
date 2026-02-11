# SF-CLI-SEEDBUDDY

A Salesforce CLI plugin that seeds records from a source org to a target org — including hierarchical children, grandchildren, activities, and files — with automatic relationship discovery and ID remapping across all tiers.

## Features

- **Hierarchical seeding** — Core object + children + grandchildren, all with correct lookup ID remapping
- **Automatic relationship discovery** — Detects child/grandchild relationships via `describe()` metadata; no manual configuration needed
- **Polymorphic activity handling** — Tasks and Events with WhatId/WhoId remapped across all seeded objects
- **File transfer** — Downloads ContentVersions from source, uploads to target, creates ContentDocumentLinks
- **Upsert support** — Match by External ID fields instead of always inserting (per-object configuration)
- **Dual mode** — Interactive guided experience or direct flag-based execution
- **Dry run** — Preview what would be seeded without creating any records
- **Cooperative shutdown** — First Ctrl+C finishes the current batch; second force-quits

## Installation

```bash
# Clone the repository
git clone https://github.com/marcSFDC/sf-cli-seedbuddy.git
cd sf-cli-seedbuddy

# Install dependencies
npm install

# Build
npm run build

# Link to Salesforce CLI
sf plugins link .
```

## Quick Start

### Interactive Mode

```bash
sf seedbuddy seed
```

Launches a guided menu where you can:
1. Connect source and target orgs
2. Select a core object (searchable autocomplete)
3. Pick child objects from auto-detected relationships
4. Pick grandchild objects
5. Toggle Tasks, Events, and Files
6. Set record count and optional WHERE filter
7. Optionally configure upsert via External ID fields
8. Review and confirm before seeding

### Flag Mode

Provide `--source-org`, `--target-org`, and `--object` to skip the interactive menu:

```bash
# Seed 10 Accounts with Contacts (dry run)
sf seedbuddy seed -s source-sandbox -t target-sandbox -o Account -c Contact -n 10 -d

# Seed all Accounts with Contacts, Opportunities, Tasks, and Events
sf seedbuddy seed -s source -t target -o Account -c Contact,Opportunity --include-tasks --include-events -n All

# Seed with upsert via External ID
sf seedbuddy seed -s source -t target -o Account -c Contact -u External_Id__c -n 50

# Seed with a WHERE filter
sf seedbuddy seed -s source -t target -o Account -n 20 -w "Industry = 'Technology'"

# Include grandchildren
sf seedbuddy seed -s source -t target -o Account -c Opportunity -g OpportunityContactRole -n 10
```

## Flags

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--source-org` | `-s` | Source org to seed FROM (username or alias) | — |
| `--target-org` | `-t` | Target org to seed INTO (username or alias) | — |
| `--object` | `-o` | Core SObject API name (e.g., `Account`) | — |
| `--children` | `-c` | Comma-separated child object API names | — |
| `--grandchildren` | `-g` | Comma-separated grandchild object API names | — |
| `--include-tasks` | | Include Task records linked to seeded records | `false` |
| `--include-events` | | Include Event records linked to seeded records | `false` |
| `--include-files` | | Include ContentDocument files | `false` |
| `--count` | `-n` | Number of core records to seed, or `"All"` | `10` |
| `--where` | `-w` | SOQL WHERE clause to filter core records | — |
| `--upsert-field` | `-u` | External ID field for upsert (core object) | — |
| `--dry-run` | `-d` | Preview without creating records | `false` |

## How It Works

### 6-Step Pipeline

```
Step 1: Seed core object
  → Query source → Insert/Upsert into target → Build ID map (sourceId → targetId)

Step 2: Seed child objects (sequential)
  → Query WHERE lookupField IN (core source IDs)
  → Remap ALL lookup fields pointing to in-scope objects
  → Insert → Build child ID maps

Step 3: Seed grandchild objects (after all children)
  → Same pattern as Step 2, using child ID maps as parents

Step 4: Seed Tasks (if enabled)
  → Query WHERE WhatId/WhoId IN (all source IDs)
  → Remap polymorphic WhatId/WhoId across ALL ID maps
  → Insert

Step 5: Seed Events (if enabled)
  → Same as Step 4

Step 6: Seed Files (if enabled)
  → Query ContentDocumentLinks → Download ContentVersions
  → Upload to target → Create ContentDocumentLinks
```

### ID Remapping

The core concept is an `IdMapCollection` — a dictionary of `Map<sourceId, targetId>` per object. When seeding child records, every reference/lookup field is checked against the collection:

- **Mapped** — the source ID is replaced with the corresponding target ID
- **Unmapped + nillable** — set to null (optional lookups)
- **Unmapped + required** — record is skipped with an error

For polymorphic fields (WhatId/WhoId on Tasks/Events), the source ID is searched across ALL ID maps. This works because Salesforce IDs contain a unique 3-character key prefix per object type.

### Schema Discovery

Child and grandchild relationships are automatically detected via `conn.describe()`:

- System objects are excluded: Task, Event, ContentDocumentLink, FeedItem, FeedComment, plus objects ending in `__Feed`, `__History`, `__Share`, `__ChangeEvent`
- Only queryable + createable objects are shown
- Circular references are prevented in grandchild detection

### Field Handling

**Whitelist approach** — only `createable` fields are included. The following system fields are always stripped:

`Id`, `IsDeleted`, `CreatedDate`, `CreatedById`, `LastModifiedDate`, `LastModifiedById`, `SystemModstamp`, `LastActivityDate`, `LastViewedDate`, `LastReferencedDate`

Activities have additional exclusions: `IsClosed`, `IsArchived`, `IsRecurrence`, `IsHighPriority`, `TaskSubtype`, `EventSubtype`, `IsGroupEvent`, `GroupEventType`, `IsChild`, `IsAllDayEvent`, `IsReminderSet`, `RecurrenceActivityId`

Compound fields (`address`, `location` types) are also excluded as they cannot be directly inserted.

## Prerequisites

- **Salesforce CLI** (`sf`) installed
- **Authenticated orgs** — at least one source and one target: `sf org login web`
- **Node.js** 18+ (for native `fetch()` support used in file downloads)

## Development

```bash
# Build
npm run build

# Clean compiled output
npm run clean

# Link for local development
sf plugins link .

# Verify
sf seedbuddy seed --help
```

### Project Structure

```
src/
├── index.ts                    # Plugin export barrel
├── commands/seedbuddy/
│   └── seed.ts                 # SfCommand class, flags, dual-mode routing
├── lib/
│   ├── types.ts                # All interfaces + constants
│   ├── query.ts                # SOQL helpers (queryAll, queryAllChunked)
│   ├── schema.ts               # Schema discovery (describe-based)
│   ├── seeder.ts               # Core 6-step pipeline
│   └── interactive.ts          # Inquirer-based interactive menu
└── types/
    └── inquirer-autocomplete-prompt.d.ts
```

## License

ISC
