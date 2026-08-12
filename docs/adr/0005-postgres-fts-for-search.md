# ADR-0005 · PostgreSQL full-text search rather than a search engine

**Status:** Accepted · 2026-08-12

## Context

The catalogue needs relevance-ranked search, typo tolerance, autocomplete and faceted filtering.
Meilisearch, Typesense and OpenSearch all do this well. Each also adds a service to run, an index to
keep in sync with the database, and a new class of bug where search results and the catalogue
disagree.

## Decision

Use PostgreSQL: `tsvector` with `GIN` indexing for full-text ranking, and `pg_trgm` for typo
tolerance and autocomplete prefix matching. No separate search service.

Facet counts are aggregate queries against the same tables, so they are always consistent with the
filter set by construction.

## Consequences

**Good**

- One datastore. No sync pipeline, no eventual-consistency window between a product edit and search
  results.
- Facets cannot disagree with the catalogue, because they are computed from it.
- Search participates in the same transactions as writes.

**Bad**

- Relevance tuning is cruder than a purpose-built engine's. No learning-to-rank, no built-in
  synonyms.
- Search competes with transactional traffic for the same database resources.
- Performance depends on index discipline; a missing `GIN` index degrades quietly rather than
  loudly.

**Boundary**

F20/AC4 sets the limit: search over the seeded catalogue must stay under 200 ms warm. If a future
catalogue size makes that unachievable with sensible indexing, that is the signal to revisit — and
because search sits behind a module boundary (ADR-0001), swapping the implementation is contained.
