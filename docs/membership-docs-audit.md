# 📋 Findings – Docs vs Implementation (Membership)

## 1. Scope & High‑level Observations
| Area | Docs (DesignBrief 🟦) | Codebase (core 🟥) | Gap / Conflict | Comment |
|------|----------------------|-------------------|---------------|---------|
| **Console vs API/SDK** | Mentions *Console* only in generic “merchant portal”. No explicit boundary description. | `OctaP_Core/docs/console-google-login.md` (Oct‑239) describes console login flow, but SDK docs (`implementation‑guide.md`) focus on REST + TypeScript SDK. No clear separation of responsibilities. | **Missing explicit contract** – docs should state which functions are only reachable via console UI vs programmatic API/SDK. | Add a **Console‑API Boundary** section (BM03). |
| **Node SDK vs Browser SDK** | No mention; DesignBrief assumes a single SDK. | `OctaP_Core/ts‑sdks` contains both `node` (server) and `browser` folders, each with its own `package.json`. README in `implementation‑guide.md` talks about “Node SDK” but not about a separate Browser bundle. | **Undocumented split** – developers may import server‑only modules in the browser. | Document the split and packaging strategy (e.g., `@octap/sdk-node` vs `@octap/sdk-browser`). |
| **Terminology (token/coin/ví)** | Uses the word *points* exclusively; explicitly bans “token”, “coin”, “ví”. | Code uses `points` everywhere (`credits.repository.ts`, `credits.service.ts`). No stray `token` references. | ✅ No conflict. |
| **P2P / Phone‑OTP** | Listed under *Out of Scope* (section 1.2). | No code for peer‑to‑peer transfer APIs; phone‑OTP login flow removed from `auth` module (only zkLogin remains). | ✅ Consistent. |
| **Tier feature (OCT‑263, grantPoints, reversal‑expiry, ledger‑report, set_paused)** | Not mentioned; DesignBrief currently has **No changes** in 1.1. | Issues `OCT‑263` and related tickets exist in Linear but **no source files** implementing tier contracts or ledger reports. Search for `grantPoints`/`reversalExpiry` returns nothing. | **Missing implementation** – docs should flag these as “planned, not yet delivered”. |
| **Design Brief change note** | Section 1.1 says *No changes* (registration unchanged). | Tech‑lead says any scope change (e.g., dropping P2P, dropping tier) must be recorded in **BM03**. | **Documentation mismatch** – current BM01 does not capture these scope changes. |
| **Diagrams** | No diagram files (png/svg) found under `docs`. | Architecture diagram exists in `architecture.md` (mermaid) but no exported images. | **Verify diagram consistency** – ensure the mermaid diagram matches the textual description of tier isolation and SDK boundaries. |

## 2. Detailed Findings
| # | Description | Location (Docs) | Location (Code) | Impact |
|---|-------------|-----------------|-----------------|--------|
| 1 | *Console vs API boundary* not defined. | DesignBrief 🟦 (none) | `OctaP_Core/docs/console-google-login.md` (API login) | Developers may misuse console‑only endpoints in SDK. |
| 2 | *Node vs Browser SDK split* missing. | DesignBrief 🟦 (none) | `OctaP_Core/ts‑sdks/node/`, `OctaP_Core/ts‑sdks/browser/` | Package size & security risk if server‑only code shipped to browser. |
| 3 | *Tier‑related tickets* present but no code. | DesignBrief 🟦 (no mention) | No files matching `tier`, `grantPoints`, `ledger-report`. | Future work must be tracked in BM03/ BM04. |
| 4 | *Out‑of‑scope* items correctly documented (P2P, phone‑OTP). | DesignBrief 🟦 (section 1.2) | No related code. | ✅ Consistent. |
| 5 | *Terminology* enforced. | DesignBrief 🟦 (section 1.2) | All source uses `points`. | ✅ Consistent. |
| 6 | *Design Brief “No changes”* conflict with tech‑lead requirement. | DesignBrief 🟦 (section 1.1) | No BM03 file yet. | Need to create **BM03 – Scope Change Log** and record dropped features. |
| 7 | *Missing diagrams* – only mermaid in Markdown. | DesignBrief 🟦 (none) | `architecture.md` (mermaid) | Export diagram as PNG/SVG for reviewers. |

## 3. Recommended Actions (for today)
1. **Create BM03 – Scope‑Change Register** and record:
   - Removal of P2P & phone‑OTP.
   - Deferral of tier‑related features (OCT‑263, grantPoints, reversal‑expiry, ledger‑report, set_paused).
2. **Add a “Console ↔ API/SDK Boundary” section** to `DesignBrief.md` (or a separate `boundary.md`). Summarize which endpoints are console‑only (e.g., admin UI actions) and which are publicly exposed via SDK.
3. **Document Node vs Browser SDK split**:
   - Add a table in `implementation‑guide.md`.
   - Mention bundling, tree‑shaking, and runtime environment constraints.
4. **Export the mermaid architecture diagram** to PNG/SVG and place it under `docs/diagrams/architecture.png`. Update the DesignBrief to reference the image.
5. **Add placeholder files for pending tier features** (e.g., `src/tiers/grantPoints.ts` with TODO comment) so the repo reflects the documented gap.
6. **Update the “Known Gaps” table** (section 5) to include the missing SDK boundary and tier implementation items.

## 4. Quick Reference Table (final output for you)
| Category | Finding | Docs OK? | Code OK? | Action |
|----------|---------|----------|----------|--------|
| Console vs API/SDK | No boundary defined | ❌ | ❌ | Add section (BM03) |
| Node vs Browser SDK | No split described | ❌ | ✅ (folders exist) | Document split |
| Terminology | Consistent “points” only | ✅ | ✅ | – |
| P2P / Phone‑OTP | Out‑of‑scope correctly listed | ✅ | ✅ (absent) | – |
| Tier & related tickets | Not mentioned, no code | ❌ | ❌ | Record in BM03, create stubs |
| Design Brief “No changes” | Conflicts with tech‑lead need to log scope changes | ❌ | – | Add BM03 entry |
| Diagrams | Missing exported images | ❌ | ✅ (mermaid) | Export PNG/SVG |

---
*Prepared for BM01 refinement; the above table can be copy‑pasted into the DesignBrief or a separate audit sheet.*
