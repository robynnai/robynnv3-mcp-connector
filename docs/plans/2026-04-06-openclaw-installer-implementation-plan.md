# OpenClaw Installer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `robynn install openclaw` to patch OpenClaw config with the local Robynn stdio MCP server entry and print manual instructions on failure.

**Architecture:** Keep the worker and CLI runtime unchanged except for a new CLI installer helper. The helper owns OpenClaw path detection, JSON patching, atomic writes, and fallback messaging while `robynn init` remains the single source of truth for stored auth.

**Tech Stack:** TypeScript, Commander, Node.js fs/path/os, Vitest

---

### Task 1: Add failing tests for installer behavior

**Files:**
- Create: `src/cli/install-openclaw.test.ts`
- Create: `src/cli/install-openclaw.ts`

- [ ] **Step 1: Write failing tests for path detection and config patching**
- [ ] **Step 2: Run `pnpm vitest src/cli/install-openclaw.test.ts` and verify failure**
- [ ] **Step 3: Implement minimal helper module to satisfy the tests**
- [ ] **Step 4: Re-run `pnpm vitest src/cli/install-openclaw.test.ts` and verify pass**

### Task 2: Wire installer into CLI

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Add failing tests or assertions for install command behavior where practical**
- [ ] **Step 2: Register `robynn install openclaw`**
- [ ] **Step 3: Ensure install works before auth and points users to `robynn init rbo_...`**
- [ ] **Step 4: Re-run targeted tests**

### Task 3: Fix package/build ergonomics and docs

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Fix the broken `build` script**
- [ ] **Step 2: Document the OpenClaw install flow**
- [ ] **Step 3: Re-run typecheck/tests for touched areas**

### Task 4: Final verification

**Files:**
- No new files

- [ ] **Step 1: Run `pnpm vitest src/cli/install-openclaw.test.ts`**
- [ ] **Step 2: Run `pnpm test` if the repo is stable enough**
- [ ] **Step 3: Run `pnpm typecheck`**
- [ ] **Step 4: Report exact verification results and any remaining gaps**
