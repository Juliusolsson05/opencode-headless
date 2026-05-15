# opencode-headless

> **Research-phase placeholder.** Nothing here is imported by the rest of the
> repo and nothing here ships. The real work is happening in `research/`,
> where parallel research agents are documenting how OpenCode is built so we
> can decide what `opencode-headless` should look like.

## Goal

Add a third headless wrapper sibling to `packages/claude-code-headless/` and
`packages/codex-headless/`, so Agent Code can drive OpenCode the same way it
drives Claude Code and Codex today. OpenCode is positioned as an **addon**
provider — Claude Code and Codex remain primary.

## Status

- Research phase. No `src/`, no exports, not on the dependency graph of
  `agent-code`.
- See `research/00-brief.md` for the brief the research agents are working
  against, and `research/01-*.md` … `research/10-*.md` for their outputs.

## Next step

Once the research files land, a follow-up session will use them to design
the actual `src/` layout. That session is where code gets written — not
this one.
