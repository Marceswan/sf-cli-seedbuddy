# summary

Seed records (with children, grandchildren, activities, and files) from a source Salesforce org to a target org.

# description

Seeds records from a source org to a target org, including hierarchical child/grandchild objects, Tasks, Events, and ContentDocument files. Automatically discovers relationships via schema metadata, remaps all lookup IDs across tiers, and handles polymorphic activity fields (WhatId/WhoId).

Run without flags for an interactive guided experience, or provide all required flags for direct execution.

# examples

- Launch interactive mode:

  <%= config.bin %> <%= command.id %>

- Seed 10 Accounts with Contacts to a target org (dry run):

  <%= config.bin %> <%= command.id %> -s source-sandbox -t target-sandbox -o Account -c Contact -n 10 -d

- Seed all Accounts with Contacts and Opportunities plus Tasks:

  <%= config.bin %> <%= command.id %> -s source -t target -o Account -c Contact,Opportunity --include-tasks -n All

- Seed with upsert via External ID:

  <%= config.bin %> <%= command.id %> -s source -t target -o Account -c Contact -u External_Id__c -n 50

- Seed with a WHERE filter:

  <%= config.bin %> <%= command.id %> -s source -t target -o Account -n 20 -w "Industry = 'Technology'"

# flags.source-org.summary

Source org to seed FROM (username or alias).

# flags.target-org.summary

Target org to seed INTO (username or alias).

# flags.object.summary

Core SObject API name to seed (e.g., Account).

# flags.children.summary

Comma-separated child object API names (e.g., Contact,Opportunity).

# flags.grandchildren.summary

Comma-separated grandchild object API names (e.g., OpportunityContactRole).

# flags.include-tasks.summary

Include Task records (activities) linked to seeded records.

# flags.include-events.summary

Include Event records linked to seeded records.

# flags.include-files.summary

Include ContentDocument files linked to seeded records.

# flags.count.summary

Number of core records to seed, or "All" (default: 10).

# flags.where.summary

Optional SOQL WHERE clause to filter core records.

# flags.upsert-field.summary

External ID field for upsert instead of insert (applies to core object).

# flags.dry-run.summary

Preview what would be seeded without creating any records.
