# Beads

This repository uses Beads for repo-local issue/task memory.

Fresh clones should run:

```bash
bd bootstrap --yes
bd ready --json
```

Tracked portable files:

- `.beads/metadata.json`
- `.beads/config.yaml`

After the first Beads issue is created, Beads will export `.beads/issues.jsonl`;
commit it with the code change that creates or updates the issue state.

Local Dolt/runtime files are ignored and must not be committed.
