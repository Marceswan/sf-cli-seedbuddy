import { Connection } from '@salesforce/core';

// ---------------------------------------------------------------------------
// Logger — decouples from oclif
// ---------------------------------------------------------------------------

export interface SeederLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  startSpinner: (msg: string) => void;
  updateSpinner: (msg: string) => void;
  stopSpinner: (msg: string) => void;
  stopSpinnerFail: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Schema discovery types
// ---------------------------------------------------------------------------

export interface ObjectInfo {
  name: string;
  label: string;
  custom: boolean;
  keyPrefix: string | null;
}

export interface FieldInfo {
  name: string;
  label: string;
  type: string;
  createable: boolean;
  nillable: boolean;
  externalId: boolean;
  unique: boolean;
  referenceTo: string[];
  relationshipName: string | null;
}

export interface ChildRelationship {
  childSObject: string;
  field: string;
  relationshipName: string | null;
  cascadeDelete: boolean;
}

// ---------------------------------------------------------------------------
// User configuration types
// ---------------------------------------------------------------------------

export interface GrandchildObjectConfig {
  objectApiName: string;
  lookupField: string;
  parentChildObject: string;
  externalIdField?: string;
}

export interface ChildObjectConfig {
  objectApiName: string;
  lookupField: string;
  externalIdField?: string;
  grandchildren: GrandchildObjectConfig[];
}

export interface ObjectSeedConfig {
  objectApiName: string;
  externalIdField?: string;
}

export interface SeedConfig {
  sourceConn: Connection;
  targetConn: Connection;
  coreObject: ObjectSeedConfig;
  children: ChildObjectConfig[];
  includeTasks: boolean;
  includeEvents: boolean;
  includeFiles: boolean;
  recordCount: number | 'All';
  whereClause?: string;
  dryRun: boolean;
  logger: SeederLogger;
  shouldAbort?: (() => boolean) | null;
}

// ---------------------------------------------------------------------------
// Results types
// ---------------------------------------------------------------------------

export interface SeedError {
  object: string;
  sourceId?: string;
  stage: string;
  error: string;
}

export interface ObjectSeedResult {
  objectApiName: string;
  queried: number;
  inserted: number;
  updated: number;
  failed: number;
  skipped: number;
}

export interface FileSeedResult {
  filesFound: number;
  filesUploaded: number;
  filesFailed: number;
  linksCreated: number;
}

export interface SeedResults {
  coreObject: ObjectSeedResult;
  children: ObjectSeedResult[];
  grandchildren: ObjectSeedResult[];
  tasks: ObjectSeedResult | null;
  events: ObjectSeedResult | null;
  files: FileSeedResult | null;
  errors: SeedError[];
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// ID mapping — the heart of relationship remapping
// ---------------------------------------------------------------------------

export type IdMap = Map<string, string>;

export interface IdMapCollection {
  [objectApiName: string]: IdMap;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BATCH_SIZE = 200;
export const QUERY_CHUNK_SIZE = 200;

export const SYSTEM_READONLY_FIELDS = new Set([
  'Id',
  'IsDeleted',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
  'SystemModstamp',
  'LastActivityDate',
  'LastViewedDate',
  'LastReferencedDate',
]);

export const ACTIVITY_SYSTEM_FIELDS = new Set([
  ...SYSTEM_READONLY_FIELDS,
  'IsClosed',
  'IsArchived',
  'IsRecurrence',
  'IsHighPriority',
  'TaskSubtype',
  'EventSubtype',
  'IsGroupEvent',
  'GroupEventType',
  'IsChild',
  'IsAllDayEvent',
  'IsReminderSet',
  'RecurrenceActivityId',
]);

// Objects whose lookups should be stripped — platform/config records, not user data.
// IDs for these objects are org-specific and won't match across orgs.
export const SYSTEM_LOOKUP_OBJECTS = new Set([
  // Platform / Identity
  'User',
  'Group',
  'Organization',
  'Profile',
  'UserRole',
  'PermissionSet',
  'PermissionSetGroup',
  'ConnectedApplication',
  // Metadata / Config
  'RecordType',
  'BusinessProcess',
  'ApexClass',
  'ApexTrigger',
  'CustomPermission',
  'EmailTemplate',
  'Folder',
  'ListView',
  'Layout',
  // Service / Entitlements
  'BusinessHours',
  'Entitlement',
  'EntitlementTemplate',
  'Milestone',
  'MilestoneType',
  'SlaProcess',
  // Territory
  'Territory2',
  'Territory2Model',
  'Territory2Type',
  // Multi-currency
  'CurrencyType',
  'DatedConversionRate',
  // Other platform objects
  'Division',
  'QueueSobject',
  'Calendar',
  'CollaborationGroup',
  'Network',
  'Site',
  'Community',
  'BrandTemplate',
  'DandBCompany',
  'PartnerRole',
  'DuplicateRecordSet',
  'DuplicateRecordItem',
  'DuplicateRule',
  'MatchingRule',
  'Period',
  'FiscalYearSettings',
]);

export const EXCLUDED_CHILD_OBJECTS = new Set([
  'Task',
  'Event',
  'ContentDocumentLink',
  'FeedItem',
  'FeedComment',
  'TopicAssignment',
  'EntitySubscription',
  'NetworkUserHistoryRecent',
]);

export const EXCLUDED_CHILD_SUFFIXES = [
  '__Feed',
  '__History',
  '__Share',
  '__ChangeEvent',
  'History',
  'Feed',
  'Share',
  'ChangeEvent',
];
