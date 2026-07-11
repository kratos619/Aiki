Decide whether a 14-person B2B SaaS company should migrate its 180 customers from one managed PostgreSQL
database per tenant to a shared-schema database using `tenant_id` and row-level security.

The company has $2.4M ARR. Its June operations baseline reports $14,400 per month in database infrastructure,
22 engineering hours per month on schema and patch coordination, and two restore incidents in the last year.
Ninety-four percent of tenants store less than 1 GB, while six large customers have contract language requiring
strong data isolation. A two-engineer estimate proposes a ten-week, no-downtime migration and forecasts a 60%
infrastructure-cost reduction. No representative migration pilot, rollback drill, row-level-security penetration
test, or review of the six isolation contracts has been completed.

Choose among a full migration next quarter, a limited pilot or hybrid architecture, and keeping the current design.
State what must be validated before committing.
