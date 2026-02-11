import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { action } from '@oclif/core/ux';
import chalk from 'chalk';
import { SeederLogger, SeedConfig, SeedResults, ChildObjectConfig } from '../../lib/types.js';
import { getObjectFields, getChildRelationships } from '../../lib/schema.js';
import { runSeeder } from '../../lib/seeder.js';
import { runInteractive, InteractivePrefilledFlags } from '../../lib/interactive.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-cli-seedbuddy', 'seedbuddy.seed');

export default class Seed extends SfCommand<SeedResults | void> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'source-org': Flags.requiredOrg({
      char: 's',
      summary: messages.getMessage('flags.source-org.summary'),
      required: false,
    }),
    'target-org': Flags.requiredOrg({
      char: 't',
      summary: messages.getMessage('flags.target-org.summary'),
      required: false,
    }),
    object: Flags.string({
      char: 'o',
      summary: messages.getMessage('flags.object.summary'),
    }),
    children: Flags.string({
      char: 'c',
      summary: messages.getMessage('flags.children.summary'),
    }),
    grandchildren: Flags.string({
      char: 'g',
      summary: messages.getMessage('flags.grandchildren.summary'),
    }),
    'include-tasks': Flags.boolean({
      summary: messages.getMessage('flags.include-tasks.summary'),
      default: false,
    }),
    'include-events': Flags.boolean({
      summary: messages.getMessage('flags.include-events.summary'),
      default: false,
    }),
    'include-files': Flags.boolean({
      summary: messages.getMessage('flags.include-files.summary'),
      default: false,
    }),
    count: Flags.string({
      char: 'n',
      summary: messages.getMessage('flags.count.summary'),
      default: '10',
    }),
    where: Flags.string({
      char: 'w',
      summary: messages.getMessage('flags.where.summary'),
    }),
    'upsert-field': Flags.string({
      char: 'u',
      summary: messages.getMessage('flags.upsert-field.summary'),
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      summary: messages.getMessage('flags.dry-run.summary'),
      default: false,
    }),
  };

  public async run(): Promise<SeedResults | void> {
    const { flags } = await this.parse(Seed);

    const logger: SeederLogger = {
      log: (msg) => this.log(msg),
      warn: (msg) => this.warn(msg),
      startSpinner: (msg) => action.start(msg),
      updateSpinner: (msg) => { action.status = msg; },
      stopSpinner: (msg) => action.stop(msg),
      stopSpinnerFail: (msg) => action.stop(msg),
    };

    const hasAllRequired = flags['source-org'] && flags['target-org'] && flags.object;

    if (hasAllRequired) {
      return this.runFlagMode(flags, logger);
    } else {
      const prefilled: InteractivePrefilledFlags = {};

      if (flags['source-org']) {
        prefilled.sourceConn = flags['source-org'].getConnection();
        prefilled.sourceLabel = `${flags['source-org'].getUsername() ?? ''} (${prefilled.sourceConn.instanceUrl})`;
      }
      if (flags['target-org']) {
        prefilled.targetConn = flags['target-org'].getConnection();
        prefilled.targetLabel = `${flags['target-org'].getUsername() ?? ''} (${prefilled.targetConn.instanceUrl})`;
      }

      await runInteractive(prefilled, logger);
    }
  }

  private async runFlagMode(
    flags: Record<string, unknown>,
    logger: SeederLogger
  ): Promise<SeedResults> {
    const sourceOrg = flags['source-org'] as { getConnection: () => import('@salesforce/core').Connection };
    const targetOrg = flags['target-org'] as { getConnection: () => import('@salesforce/core').Connection };
    const sourceConn = sourceOrg.getConnection();
    const targetConn = targetOrg.getConnection();
    const objectApiName = flags['object'] as string;
    const dryRun = flags['dry-run'] as boolean;
    const upsertField = flags['upsert-field'] as string | undefined;

    // Parse record count
    const countStr = flags['count'] as string;
    const recordCount: number | 'All' =
      countStr.toLowerCase() === 'all' ? 'All' : parseInt(countStr, 10);

    // Parse children flag
    const childrenStr = flags['children'] as string | undefined;
    const selectedChildren: ChildObjectConfig[] = [];

    if (childrenStr) {
      const childNames = childrenStr.split(',').map((s) => s.trim());

      for (const childName of childNames) {
        // Auto-detect the lookup field by describing the child object
        const childRels = await getChildRelationships(sourceConn, objectApiName);
        const rel = childRels.find((r) => r.childSObject === childName);

        if (rel) {
          selectedChildren.push({
            objectApiName: childName,
            lookupField: rel.field,
            grandchildren: [],
          });
        } else {
          // Try describing the child to find a lookup to the parent
          const childFields = await getObjectFields(sourceConn, childName);
          const lookupField = childFields.find(
            (f) => f.referenceTo.includes(objectApiName) && f.createable
          );
          if (lookupField) {
            selectedChildren.push({
              objectApiName: childName,
              lookupField: lookupField.name,
              grandchildren: [],
            });
          } else {
            logger.warn(`Could not find lookup from ${childName} to ${objectApiName} — skipping`);
          }
        }
      }
    }

    // Parse grandchildren flag
    const grandchildrenStr = flags['grandchildren'] as string | undefined;
    if (grandchildrenStr && selectedChildren.length > 0) {
      const gcNames = grandchildrenStr.split(',').map((s) => s.trim());

      for (const gcName of gcNames) {
        // Find which child object this grandchild belongs to
        for (const child of selectedChildren) {
          const childRels = await getChildRelationships(sourceConn, child.objectApiName);
          const rel = childRels.find((r) => r.childSObject === gcName);
          if (rel) {
            child.grandchildren.push({
              objectApiName: gcName,
              lookupField: rel.field,
              parentChildObject: child.objectApiName,
            });
            break;
          }
        }
      }
    }

    // SIGINT handler
    let aborted = false;
    const existingSigintListeners = process.listeners('SIGINT');
    process.removeAllListeners('SIGINT');
    const sigintHandler = (): void => {
      if (aborted) {
        process.exit(1);
      }
      aborted = true;
      logger.warn('Graceful shutdown requested. Press Ctrl+C again to force quit.');
    };
    process.on('SIGINT', sigintHandler);

    const startTime = Date.now();

    try {
      const seedConfig: SeedConfig = {
        sourceConn,
        targetConn,
        coreObject: {
          objectApiName,
          externalIdField: upsertField,
        },
        children: selectedChildren,
        includeTasks: flags['include-tasks'] as boolean,
        includeEvents: flags['include-events'] as boolean,
        includeFiles: flags['include-files'] as boolean,
        recordCount,
        whereClause: (flags['where'] as string) || undefined,
        dryRun,
        logger,
        shouldAbort: () => aborted,
      };

      const results = await runSeeder(seedConfig);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      this.displayResults(results, elapsed);
      return results;
    } finally {
      process.removeListener('SIGINT', sigintHandler);
      for (const listener of existingSigintListeners) {
        process.on('SIGINT', listener as NodeJS.SignalsListener);
      }
    }
  }

  private displayResults(results: SeedResults, elapsed: string): void {
    this.log('\n' + chalk.bold.cyan('═══ SEED RESULTS ═══'));

    if (results.dryRun) {
      this.log(chalk.yellow.bold('  [DRY RUN — no records were actually created]'));
    }

    this.log(chalk.gray(`  Completed in ${elapsed}s\n`));

    const printResult = (r: { objectApiName: string; queried: number; inserted: number; updated: number; failed: number; skipped: number }): void => {
      this.log(`  ${chalk.bold(r.objectApiName)}: queried=${r.queried} inserted=${r.inserted} updated=${r.updated} failed=${r.failed} skipped=${r.skipped}`);
    };

    printResult(results.coreObject);
    for (const child of results.children) printResult(child);
    for (const gc of results.grandchildren) printResult(gc);
    if (results.tasks) printResult(results.tasks);
    if (results.events) printResult(results.events);

    if (results.files) {
      const f = results.files;
      this.log(`  ${chalk.bold('Files')}: found=${f.filesFound} uploaded=${f.filesUploaded} failed=${f.filesFailed} links=${f.linksCreated}`);
    }

    if (results.errors.length > 0) {
      this.log(chalk.red(`\n  ${results.errors.length} error(s) occurred. First 5:`));
      for (const err of results.errors.slice(0, 5)) {
        this.log(chalk.red(`    [${err.object}] ${err.stage}: ${err.error}`));
      }
    }

    this.log('');
  }
}
