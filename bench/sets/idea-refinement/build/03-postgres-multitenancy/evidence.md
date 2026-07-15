# Authored internal evidence — PostgreSQL tenancy decision

As of 2026-06-30, the case owner supplied these planning inputs:

- 180 production tenant databases; 94% store less than 1 GB.
- $14,400 monthly managed-database infrastructure cost.
- 22 engineering hours per month spent coordinating schema and patch work.
- Two restore incidents in the previous twelve months.
- Six customer contracts contain stronger isolation language and have not yet been reviewed for shared tenancy.
- Engineering estimate: two engineers for ten weeks; no pilot or rollback drill performed.

These are authored benchmark facts, not independently audited measurements. The 60% saving is a forecast.
