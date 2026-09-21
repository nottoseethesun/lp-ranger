# Remove Orphaned HTML Element IDs

> **Status:** Nice-to-have / hygiene &mdash; not a bug. The orphans are
> inert markup that nothing reads. Funds are never at risk.

## Plain language

A one-off audit found roughly 47 element IDs in the dashboard's HTML that
no JavaScript or CSS refers to any more &mdash; leftovers from features
whose code was removed while the markup stayed behind. One cluster has
since been deleted; about 42 remain.

## Detail

They group into: the inline-edit dialog Save/Cancel/Reset controls
(~25 IDs), the wallet-import validation shell (10 IDs), and seven
individual finds scattered near different dashboard modules. A spot check
confirms they are still unreferenced.

An automated lint for orphan DOM IDs was considered and rejected:
dynamically built IDs and template slots produce too many false
positives. A one-shot audit plus opportunistic cleanup is the safer
shape.

## Fix when prioritized

Clean up locally rather than in a sweep: when a task already lands in one
of those areas, re-check that the neighbouring ID is still unreferenced
and delete it, along with any CSS that existed only for it, in the same
commit. One cluster per pull request at most &mdash; the point is a small
blast radius, since the only way to verify dashboard markup is by hand.
