import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';
import chalk from 'chalk';
import { AuthInfo, Connection, Org, OrgAuthorization } from '@salesforce/core';
import {
  SeederLogger,
  SeedConfig,
  SeedResults,
  ObjectSeedResult,
  ChildObjectConfig,
  GrandchildObjectConfig,
} from './types.js';
import {
  getAllObjects,
  getObjectFields,
  getChildRelationships,
  getGrandchildRelationships,
  getExternalIdFields,
} from './schema.js';
import { runSeeder } from './seeder.js';

inquirer.registerPrompt('autocomplete', autocompletePrompt);

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let sourceConn: Connection | null = null;
let targetConn: Connection | null = null;
let sourceLabel: string | null = null;
let targetLabel: string | null = null;

// ---------------------------------------------------------------------------
// Prefilled flags interface (for partial flag mode)
// ---------------------------------------------------------------------------

export interface InteractivePrefilledFlags {
  sourceConn?: Connection;
  sourceLabel?: string;
  targetConn?: Connection;
  targetLabel?: string;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function showBanner(): void {
  const lines = [
    '',
    chalk.cyan('  ┌─────────────────────────────────────────┐'),
    chalk.cyan('  │') + chalk.bold.white('        SF-CLI-SEEDBUDDY v1.0.0          ') + chalk.cyan('│'),
    chalk.cyan('  │') + chalk.gray('    Seed records between SF orgs          ') + chalk.cyan('│'),
    chalk.cyan('  │') + chalk.gray('    with children, activities & files     ') + chalk.cyan('│'),
    chalk.cyan('  └─────────────────────────────────────────┘'),
    '',
  ];
  for (const line of lines) {
    console.log(line);
  }
}

function connectionStatus(): void {
  const srcStatus = sourceLabel
    ? chalk.green(`Connected: ${sourceLabel}`)
    : chalk.yellow('Not connected');
  const tgtStatus = targetLabel
    ? chalk.green(`Connected: ${targetLabel}`)
    : chalk.yellow('Not connected');

  console.log(`\n  ${chalk.bold('Source:')} ${srcStatus}`);
  console.log(`  ${chalk.bold('Target:')} ${tgtStatus}\n`);
}

function displayResults(results: SeedResults, logger: SeederLogger): void {
  logger.log('\n' + chalk.bold.cyan('═══ SEED RESULTS ═══'));

  if (results.dryRun) {
    logger.log(chalk.yellow.bold('  [DRY RUN — no records were actually created]\n'));
  }

  // Core object
  const core = results.coreObject;
  logger.log(chalk.bold(`  ${core.objectApiName}:`));
  logger.log(`    Queried: ${core.queried} | Inserted: ${core.inserted} | Updated: ${core.updated} | Failed: ${core.failed} | Skipped: ${core.skipped}`);

  // Children
  for (const child of results.children) {
    logger.log(chalk.bold(`  ${child.objectApiName}:`));
    logger.log(`    Queried: ${child.queried} | Inserted: ${child.inserted} | Updated: ${child.updated} | Failed: ${child.failed} | Skipped: ${child.skipped}`);
  }

  // Grandchildren
  for (const gc of results.grandchildren) {
    logger.log(chalk.bold(`  ${gc.objectApiName}:`));
    logger.log(`    Queried: ${gc.queried} | Inserted: ${gc.inserted} | Updated: ${gc.updated} | Failed: ${gc.failed} | Skipped: ${gc.skipped}`);
  }

  // Tasks
  if (results.tasks) {
    logger.log(chalk.bold('  Task:'));
    logger.log(`    Queried: ${results.tasks.queried} | Inserted: ${results.tasks.inserted} | Failed: ${results.tasks.failed}`);
  }

  // Events
  if (results.events) {
    logger.log(chalk.bold('  Event:'));
    logger.log(`    Queried: ${results.events.queried} | Inserted: ${results.events.inserted} | Failed: ${results.events.failed}`);
  }

  // Files
  if (results.files) {
    logger.log(chalk.bold('  Files:'));
    logger.log(`    Found: ${results.files.filesFound} | Uploaded: ${results.files.filesUploaded} | Failed: ${results.files.filesFailed} | Links: ${results.files.linksCreated}`);
  }

  // Errors
  if (results.errors.length > 0) {
    logger.log(chalk.red.bold(`\n  Errors (${results.errors.length}):`));
    const maxDisplay = 20;
    const displayErrors = results.errors.slice(0, maxDisplay);
    for (const err of displayErrors) {
      logger.log(chalk.red(`    [${err.object}] ${err.stage}: ${err.error}${err.sourceId ? ` (source: ${err.sourceId})` : ''}`));
    }
    if (results.errors.length > maxDisplay) {
      logger.log(chalk.red(`    ... and ${results.errors.length - maxDisplay} more errors`));
    }
  }

  logger.log('');
}

// ---------------------------------------------------------------------------
// Org connection
// ---------------------------------------------------------------------------

async function listAvailableOrgs(): Promise<OrgAuthorization[]> {
  const auths = await AuthInfo.listAllAuthorizations();
  return auths.filter((a) => !a.error);
}

async function connectOrg(role: 'source' | 'target'): Promise<void> {
  const label = role === 'source' ? 'Source' : 'Target';
  const orgs = await listAvailableOrgs();

  if (orgs.length === 0) {
    console.log(chalk.red('  No authenticated orgs found. Run: sf org login web'));
    return;
  }

  const choices = orgs.map((a) => ({
    name: `${a.aliases?.join(', ') || a.username} — ${a.username}`,
    value: a.username,
  }));

  const { selection } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selection',
      message: `${label} — Select an org:`,
      choices,
      pageSize: 15,
    },
  ]);

  try {
    const org = await Org.create({ aliasOrUsername: selection });
    const conn = org.getConnection();
    const identity = await conn.identity();

    if (role === 'source') {
      sourceConn = conn;
      sourceLabel = `${identity.username} (${conn.instanceUrl})`;
    } else {
      targetConn = conn;
      targetLabel = `${identity.username} (${conn.instanceUrl})`;
    }

    console.log(chalk.green(`  ${label} connected: ${identity.username}`));
  } catch (err) {
    console.log(chalk.red(`  Failed to connect: ${err instanceof Error ? err.message : String(err)}`));
  }
}

function disconnectOrg(role: 'source' | 'target'): void {
  if (role === 'source') {
    sourceConn = null;
    sourceLabel = null;
    console.log(chalk.yellow('  Source disconnected'));
  } else {
    targetConn = null;
    targetLabel = null;
    console.log(chalk.yellow('  Target disconnected'));
  }
}

// ---------------------------------------------------------------------------
// Interactive seeding flow (10 steps)
// ---------------------------------------------------------------------------

async function startSeeding(logger: SeederLogger): Promise<void> {
  if (!sourceConn || !targetConn) {
    console.log(chalk.red('  Please connect both source and target orgs first.'));
    return;
  }

  // Step 1: Select core object
  logger.startSpinner('Loading objects from source...');
  const objects = await getAllObjects(sourceConn);
  logger.stopSpinner(`Loaded ${objects.length} objects`);

  const objectChoices = objects.map((o) => ({
    name: `${o.label} (${o.name})`,
    value: o.name,
  }));

  const { objectApiName } = await inquirer.prompt([
    {
      type: 'autocomplete',
      name: 'objectApiName',
      message: 'Core object to seed (start typing to filter):',
      source: (_answers: unknown, input: string) => {
        const term = (input || '').toLowerCase();
        return objectChoices.filter(
          (c) => c.value.toLowerCase().includes(term) || c.name.toLowerCase().includes(term)
        );
      },
      pageSize: 12,
    },
  ]);

  // Step 2: Select child objects
  logger.startSpinner(`Discovering child relationships for ${objectApiName}...`);
  const childRels = await getChildRelationships(sourceConn, objectApiName);
  logger.stopSpinner(`Found ${childRels.length} child relationship(s)`);

  let selectedChildren: ChildObjectConfig[] = [];

  if (childRels.length > 0) {
    const childChoices = childRels.map((r) => ({
      name: `${r.childSObject} (via ${r.field})`,
      value: r,
      checked: false,
    }));

    const { children } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'children',
        message: 'Select child objects to include:',
        choices: childChoices,
        pageSize: 15,
      },
    ]);

    selectedChildren = (children as typeof childRels).map((r) => ({
      objectApiName: r.childSObject,
      lookupField: r.field,
      grandchildren: [],
    }));
  }

  // Step 3: Select grandchild objects
  if (selectedChildren.length > 0) {
    const childNames = selectedChildren.map((c) => c.objectApiName);
    logger.startSpinner('Discovering grandchild relationships...');
    const grandchildRels = await getGrandchildRelationships(sourceConn, childNames, objectApiName);
    logger.stopSpinner(`Found ${grandchildRels.length} grandchild relationship(s)`);

    if (grandchildRels.length > 0) {
      const gcChoices = grandchildRels.map((r) => ({
        name: `${r.childSObject} (child of ${r.parentChildObject} via ${r.field})`,
        value: r,
        checked: false,
      }));

      const { grandchildren } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'grandchildren',
          message: 'Select grandchild objects to include:',
          choices: gcChoices,
          pageSize: 15,
        },
      ]);

      for (const gc of grandchildren as Array<typeof grandchildRels[number]>) {
        const parentChild = selectedChildren.find((c) => c.objectApiName === gc.parentChildObject);
        if (parentChild) {
          parentChild.grandchildren.push({
            objectApiName: gc.childSObject,
            lookupField: gc.field,
            parentChildObject: gc.parentChildObject,
          });
        }
      }
    }
  }

  // Step 4: Toggle Tasks
  const { includeTasks } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'includeTasks',
      message: 'Include Tasks (activities)?',
      default: false,
    },
  ]);

  // Step 5: Toggle Events
  const { includeEvents } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'includeEvents',
      message: 'Include Events?',
      default: false,
    },
  ]);

  // Step 6: Toggle Files
  const { includeFiles } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'includeFiles',
      message: 'Include Files (ContentDocuments)?',
      default: false,
    },
  ]);

  // Step 7: Record count
  const { recordCountInput } = await inquirer.prompt([
    {
      type: 'input',
      name: 'recordCountInput',
      message: 'Number of core records to seed (number or "All"):',
      default: '10',
      validate: (val: string) => {
        if (val.toLowerCase() === 'all') return true;
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1) return 'Enter a positive number or "All"';
        return true;
      },
    },
  ]);
  const recordCount: number | 'All' =
    recordCountInput.toLowerCase() === 'all' ? 'All' : parseInt(recordCountInput, 10);

  // Step 8: WHERE clause
  const { whereClause } = await inquirer.prompt([
    {
      type: 'input',
      name: 'whereClause',
      message: 'Optional WHERE clause (leave empty for none):',
      default: '',
    },
  ]);

  // Step 9: Upsert config (optional external ID fields)
  let coreExternalIdField: string | undefined;
  const childExternalIds: Map<string, string> = new Map();

  const { useUpsert } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useUpsert',
      message: 'Use upsert (match by External ID instead of always inserting)?',
      default: false,
    },
  ]);

  if (useUpsert) {
    // Core object external IDs
    const coreFields = await getObjectFields(sourceConn, objectApiName);
    const coreExtIds = getExternalIdFields(coreFields);

    if (coreExtIds.length > 0) {
      const { coreExtId } = await inquirer.prompt([
        {
          type: 'list',
          name: 'coreExtId',
          message: `External ID field for ${objectApiName}:`,
          choices: [
            { name: '(none — always insert)', value: '' },
            ...coreExtIds.map((f) => ({ name: `${f.label} (${f.name})`, value: f.name })),
          ],
        },
      ]);
      if (coreExtId) coreExternalIdField = coreExtId;
    }

    // Child object external IDs
    for (const child of selectedChildren) {
      const childFields = await getObjectFields(sourceConn, child.objectApiName);
      const childExtIds = getExternalIdFields(childFields);

      if (childExtIds.length > 0) {
        const { childExtId } = await inquirer.prompt([
          {
            type: 'list',
            name: 'childExtId',
            message: `External ID field for ${child.objectApiName}:`,
            choices: [
              { name: '(none — always insert)', value: '' },
              ...childExtIds.map((f) => ({ name: `${f.label} (${f.name})`, value: f.name })),
            ],
          },
        ]);
        if (childExtId) childExternalIds.set(child.objectApiName, childExtId);
      }
    }
  }

  // Step 10: Review & confirm
  console.log('\n' + chalk.bold.cyan('═══ SEED CONFIGURATION ═══'));
  console.log(`  ${chalk.bold('Source:')} ${sourceLabel}`);
  console.log(`  ${chalk.bold('Target:')} ${targetLabel}`);
  console.log(`  ${chalk.bold('Core Object:')} ${objectApiName}${coreExternalIdField ? ` (upsert: ${coreExternalIdField})` : ''}`);
  console.log(`  ${chalk.bold('Record Count:')} ${recordCount}`);
  if (whereClause) console.log(`  ${chalk.bold('WHERE:')} ${whereClause}`);

  if (selectedChildren.length > 0) {
    console.log(`  ${chalk.bold('Children:')}`);
    for (const child of selectedChildren) {
      const extId = childExternalIds.get(child.objectApiName);
      console.log(`    - ${child.objectApiName} (via ${child.lookupField})${extId ? ` [upsert: ${extId}]` : ''}`);
      for (const gc of child.grandchildren) {
        console.log(`      - ${gc.objectApiName} (via ${gc.lookupField})`);
      }
    }
  }

  console.log(`  ${chalk.bold('Tasks:')} ${includeTasks ? 'Yes' : 'No'}`);
  console.log(`  ${chalk.bold('Events:')} ${includeEvents ? 'Yes' : 'No'}`);
  console.log(`  ${chalk.bold('Files:')} ${includeFiles ? 'Yes' : 'No'}`);
  console.log('');

  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Proceed with seeding?',
      default: true,
    },
  ]);

  if (!confirmed) {
    console.log(chalk.yellow('  Cancelled.'));
    return;
  }

  // Apply external ID fields
  if (coreExternalIdField) {
    // Already set above
  }
  for (const child of selectedChildren) {
    const extId = childExternalIds.get(child.objectApiName);
    if (extId) child.externalIdField = extId;
  }

  // Build config & run
  let aborted = false;
  const existingSigintListeners = process.listeners('SIGINT');
  process.removeAllListeners('SIGINT');
  const sigintHandler = (): void => {
    if (aborted) {
      console.log(chalk.red('\n  Force quit.'));
      process.exit(1);
    }
    aborted = true;
    console.log(chalk.yellow('\n  Graceful shutdown requested. Press Ctrl+C again to force quit.'));
  };
  process.on('SIGINT', sigintHandler);

  const startTime = Date.now();

  try {
    const seedConfig: SeedConfig = {
      sourceConn,
      targetConn,
      coreObject: {
        objectApiName,
        externalIdField: coreExternalIdField,
      },
      children: selectedChildren,
      includeTasks,
      includeEvents,
      includeFiles,
      recordCount,
      whereClause: whereClause || undefined,
      dryRun: false,
      logger,
      shouldAbort: () => aborted,
    };

    const results = await runSeeder(seedConfig);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.log(chalk.gray(`\n  Completed in ${elapsed}s`));
    displayResults(results, logger);
  } catch (err) {
    logger.stopSpinnerFail('Seeding failed');
    logger.log(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    for (const listener of existingSigintListeners) {
      process.on('SIGINT', listener as NodeJS.SignalsListener);
    }
  }
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

async function mainMenu(logger: SeederLogger): Promise<void> {
  connectionStatus();

  const choices = [
    new inquirer.Separator(chalk.gray('── Connections ──')),
    {
      name: sourceLabel ? `Change source (${sourceLabel})` : 'Connect source org',
      value: 'connect_source',
    },
    {
      name: targetLabel ? `Change target (${targetLabel})` : 'Connect target org',
      value: 'connect_target',
    },
  ];

  if (sourceConn || targetConn) {
    choices.push({
      name: 'Disconnect orgs',
      value: 'disconnect',
    });
  }

  choices.push(new inquirer.Separator(chalk.gray('── Actions ──')) as never);

  if (sourceConn && targetConn) {
    choices.push({
      name: chalk.green.bold('Start seeding'),
      value: 'seed',
    });
  }

  choices.push(
    new inquirer.Separator(chalk.gray('────────────────')) as never,
    { name: 'Exit', value: 'exit' }
  );

  const { action: menuAction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices,
      pageSize: 12,
    },
  ]);

  switch (menuAction) {
    case 'connect_source':
      await connectOrg('source');
      break;
    case 'connect_target':
      await connectOrg('target');
      break;
    case 'disconnect': {
      const { which } = await inquirer.prompt([
        {
          type: 'list',
          name: 'which',
          message: 'Disconnect which org?',
          choices: [
            ...(sourceConn ? [{ name: `Source: ${sourceLabel}`, value: 'source' }] : []),
            ...(targetConn ? [{ name: `Target: ${targetLabel}`, value: 'target' }] : []),
            { name: 'Both', value: 'both' },
          ],
        },
      ]);
      if (which === 'source' || which === 'both') disconnectOrg('source');
      if (which === 'target' || which === 'both') disconnectOrg('target');
      break;
    }
    case 'seed':
      await startSeeding(logger);
      break;
    case 'exit':
      console.log(chalk.gray('  Goodbye!'));
      return;
  }

  await mainMenu(logger);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runInteractive(
  prefilledFlags: InteractivePrefilledFlags,
  logger: SeederLogger
): Promise<void> {
  showBanner();

  // Apply prefilled flags
  if (prefilledFlags.sourceConn) {
    sourceConn = prefilledFlags.sourceConn;
    sourceLabel = prefilledFlags.sourceLabel ?? sourceConn.instanceUrl;
  }
  if (prefilledFlags.targetConn) {
    targetConn = prefilledFlags.targetConn;
    targetLabel = prefilledFlags.targetLabel ?? targetConn.instanceUrl;
  }

  await mainMenu(logger);

  // Reset module state on exit
  sourceConn = null;
  targetConn = null;
  sourceLabel = null;
  targetLabel = null;
}
