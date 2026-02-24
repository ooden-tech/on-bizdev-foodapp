# NutriPal — Client Requirements Gap Analysis

> **Date**: 2026-02-24  
> **Scope**: Comparison of the two client spec documents ("Features and behavior.md" + "client Request .md") against the live codebase.  
> **Verdict**: Read-only audit — no code changes.

---

## Scoring Legend

| Rating | Meaning |
|--------|---------|
| ✅ **Shipped** | Feature is implemented and working |
| 🟡 **Partial** | Core mechanics exist but the spec's full intent is not met |
| ❌ **Missing** | No implementation found in codebase |

---

## 1. Totals + Transparency (Auditability)

| Sub-requirement | Status | Evidence |
|---|---|---|
| Per-item nutrition breakdown shown to user | ✅ | PCC pattern in orchestrator shows `nutrition` array in `confirmation_food_log` responses; UI renders confirmation cards |
| Running totals visible | ✅ | `get_today_progress` tool aggregates daily totals; dashboard page displays them |
| Delta to targets | ✅ | `DashboardSummaryTable.tsx` computes goal progress percentages with color-coded thresholds |
| Internal sanity checks | ✅ | `ValidatorAgent` checks calorie-macro consistency, outlier detection, zero-calorie guards |
| Surface raw math even when disagreeing | 🟡 | Validator warnings are logged but **not always surfaced to the user** in the chat response — the ChatAgent may summarize without showing the numbers |

**Gap**: The spec says "never output a conclusion without the numbers behind it." The current `ChatAgent` prompt says "Never use bullet points for nutrition data. The UI handles that." — this can result in chat responses that give advice without showing math when no confirmation card is present (e.g., advisory queries).

---

## 2. Ambiguity Detection + Clarification

| Sub-requirement | Status | Evidence |
|---|---|---|
| Detect unclear portions, homemade vs restaurant, cooking methods | 🟡 | No dedicated ambiguity-detection pass. The system relies on the `ReasoningAgent` (GPT-4o) to decide whether to ask. There is no **structured** ambiguity triage |
| Ask 1–2 clarifying questions max | 🟡 | No hard limit enforced in prompts. GPT-4o can ask as many or as few questions as it decides |
| Label assumptions explicitly if proceeding | 🟡 | Nutrition estimates include a `confidence` field internally, but it is **not consistently surfaced** to the user as "I'm assuming X because Y" |
| No silent defaults | 🟡 | The `IntentAgent` extracts portions with a default of `"1 serving"` (line 290 orchestrator) — a silent default |

**Gap**: Ambiguity awareness exists but is **ad-hoc** (depends on LLM initiative) rather than **systematic** (a dedicated detection pass before estimation). The spec demands "Ambiguity beats speed" — the current design prioritizes speed (fast-paths bypass reasoning for single items).

---

## 3. Error Awareness & Uncertainty as First-Class Output

| Sub-requirement | Status | Evidence |
|---|---|---|
| Confidence level on every estimate | 🟡 | `batch-calculator.ts`, `serving-detector.ts`, and `nutrition-agent.ts` compute `confidence: 'low' | 'medium' | 'high'`. But this is **internal only** — the confidence is not rendered to the user in the chat message or the confirmation card UI |
| Top 1–2 likely error sources surfaced | ❌ | No implementation. Error sources are not listed |
| False precision avoided | 🟡 | Values are rounded, but estimates are presented as exact numbers rather than ranges |

**Gap**: The internal machinery computes confidence, but **none of it reaches the user**. This is the single largest gap against the spec, which calls uncertainty a "first-class output." Error sources (restaurant oils, portion ambiguity, label vs. prepared) are never surfaced.

---

## 4. Corrections Persist as Memory (Learning System)

| Sub-requirement | Status | Evidence |
|---|---|---|
| User corrections override defaults | 🟡 | `SessionService.addUserCorrection()` stores corrections in the session buffer (last 10) |
| Corrections cached and reused automatically | ❌ | Corrections are stored but **never read back**. No code queries the `userCorrections` buffer to influence future estimates |
| System confirms "I'll treat this as source of truth" | ❌ | No such confirmation text in any agent prompt |

**Gap**: The persistence layer exists but the **retrieval and re-application loop is missing**. User corrections vanish after the session buffer scrolls past them.

---

## 5. Planning Is First-Class (What-If Engine)

| Sub-requirement | Status | Evidence |
|---|---|---|
| "If I eat this, where does that put me?" | 🟡 | `ReasoningAgent` can call `get_today_progress` + `lookup_nutrition` to answer this, but it is **not a structured mode** — it relies on the LLM stitching the answer together |
| Branching scenarios | ❌ | No scenario storage, no branching logic, no planned-vs-actual comparison |
| Planning mode vs. logging mode | ❌ | There is only one mode (logging). No explicit planning mode exists |
| Counterfactuals ("if I hadn't eaten that snack…") | ❌ | No implementation |

**Gap**: The spec calls this a "what-if engine, not a diary." The current system is fundamentally a **diary** with advisory capabilities. There is no scenario branching, no planned intake, and no counterfactual reasoning.

---

## 6. Time + Timezone Awareness

| Sub-requirement | Status | Evidence |
|---|---|---|
| Timestamp on every entry | ✅ | `log_time` is set on every food log entry |
| Timezone awareness | ✅ | `timezone` is threaded through the entire orchestrator → agents → tools chain |
| Reasoning about "earlier today," "late-night," etc. | 🟡 | Time data is available to the `ReasoningAgent`, but there is **no prompt guidance** instructing it to reason temporally. No "late-night eating" detection |
| Daily boundary logic | ✅ | `getStartAndEndOfDay()` utility handles timezone-aware day boundaries |

**Gap**: Infrastructure is solid. The missing piece is **temporal reasoning prompts and pattern detection** tied to time-of-day.

---

## 7. Triage Logic (What Matters Now)

| Sub-requirement | Status | Evidence |
|---|---|---|
| Rank today's priorities when goals conflict | ❌ | No triage logic. The system presents all goals with equal weight |
| Say what can be ignored | ❌ | Not implemented |
| Identify one lever worth pulling | ❌ | Not implemented |
| Special handling for late nights, travel, depleted states | ❌ | No day-state awareness (see §11) |

**Gap**: Entirely missing. The system treats every goal as equally important regardless of context.

---

## 8. Tradeoff Reasoning (Multi-Objective Arbitration)

| Sub-requirement | Status | Evidence |
|---|---|---|
| Reason across protein vs sodium, calories vs hunger, etc. | ❌ | No tradeoff reasoning in any agent prompt |
| Make a recommendation tied to today | ❌ | Recommendations exist (`get_food_recommendations`) but are generic, not conflict-aware |
| Include confidence and uncertainty | ❌ | See §3 |

**Gap**: Entirely missing. The spec says "No 'just facts' cop-outs." Current behavior is purely fact-driven.

---

## 9. Cognitive Load Reduction (Summary Format)

| Sub-requirement | Status | Evidence |
|---|---|---|
| Bullets only, 3–5 max | 🟡 | `InsightAgent` prompt says "Keep it under 40 words total" but does **not enforce** bullet format |
| Summary answers: what mattered, what didn't, takeaway, adjustment | 🟡 | `InsightAgent` asks for "2 very short suggestions" — not aligned with the spec's 4-part structure |
| No moral tone, no essays | 🟡 | Not enforced in prompts. `ChatAgent` says "encouraging" which can drift toward moral tone |
| Weekly summary | ✅ | `get_weekly_summary` tool exists and is called by `ReasoningAgent` |

**Gap**: Summaries exist but don't follow the spec's hard format rules. The current prompt produces free-form suggestions, not the structured "what mattered / what didn't / takeaway / adjustment" format.

---

## 10. Negotiation Stance (Not Authority)

| Sub-requirement | Status | Evidence |
|---|---|---|
| Pragmatic, constraint-aware tone | 🟡 | `ChatAgent` prompt says "friendly and professional" and "encouraging." This is closer to **coach** than **negotiation partner** |
| No "you should have," "ideally," "best practice" | ❌ | Not enforced. No negative-pattern instructions in prompts |
| Comfortable with "good enough" | ❌ | Not addressed in any prompt |

**Gap**: The tone is "friendly nutrition coach" — the spec explicitly says it should **not** be a coach. It should be a "pragmatic decision partner." The prompt language needs a rewrite.

---

## 11. Exception Handling & Day Classification

| Sub-requirement | Status | Evidence |
|---|---|---|
| Detect travel / sick / workout / social / depleted days | ❌ | No day classification system. No DB table for day types |
| Adjust expectations for exceptional days | ❌ | No implementation. `apply_daily_workout_offset` handles workouts only as calorie bonuses, not as day reclassification |
| Avoid silent penalties | ❌ | Goal thresholds are static; a travel day is penalized the same as a normal day |

**Gap**: Entirely missing. The spec treats this as critical: "Exceptions are categories, not failures."

---

## 12. Audit Mode (Model Debugging)

| Sub-requirement | Status | Evidence |
|---|---|---|
| When user says "this seems off," surface undercount sources | ❌ | No audit-mode intent or handler. "This seems off" would route to `ReasoningAgent` with no specific prompt guidance |
| Discuss uncertainty explicitly | ❌ | See §3 |
| Ask minimal clarifying questions | ❌ | No audit-specific logic |

**Gap**: Entirely missing. The spec says treat this as "debugging the model, not correcting the user." No code supports this.

---

## 13. Reflection Loops (Post-Hoc Insight)

| Sub-requirement | Status | Evidence |
|---|---|---|
| Top contributors today | 🟡 | `InsightAgent` computes daily totals and can surface top items, but doesn't explicitly list "top contributors" |
| What changed vs yesterday | ❌ | No day-over-day comparison tool |
| Single biggest improvement lever | ❌ | Not implemented |
| Pattern vs noise judgment | ❌ | Not implemented |

**Gap**: `InsightAgent` provides basic suggestions but **not** the structured retrospective the spec requires.

---

## 14. Longitudinal Pattern Interpretation

| Sub-requirement | Status | Evidence |
|---|---|---|
| "This keeps happening" | ❌ | No recurring-pattern detection. `analyze_eating_patterns` exists as a tool definition but the implementation (in `ToolExecutor`) just returns raw data; no interpretation layer |
| "This is new" | ❌ | No novelty detection |
| "This only happens under condition X" | ❌ | No conditional pattern analysis (would require day classification from §11) |
| Proactive pattern recognition (unprompted) | ❌ | Nothing triggers pattern analysis automatically |

**Gap**: The tool infrastructure (`analyze_eating_patterns`, `get_progress_report`) exists, but it returns raw aggregates without the **interpretive layer** the spec demands.

---

## Anti-Patterns Check

| Anti-pattern | Status |
|---|---|
| No silent guessing | 🟡 — Default "1 serving" is a silent assumption |
| No red-badge / guilt framing without context | 🟡 — Dashboard uses red/yellow/green but context is limited to threshold math |
| No treatises in summaries | 🟡 — `InsightAgent` prompt is short, but `ChatAgent` responses can be lengthy |
| No one-size-fits-all recommendations | ❌ — No personalization beyond goals |
| No "remaining macros" as primary response when user is stressed | ❌ — No stress/context detection |

---

## Acceptance Test Readiness

| Test | Pass? |
|---|---|
| "A bowl of pasta" → asks 1–2 clarifiers or proceeds with explicit assumptions + low confidence | ❌ — Currently looks up nutrition silently with default portion |
| "Was today fine?" → 3–5 bullets, no essay | 🟡 — Could produce bullets via reasoning, but no format enforcement |
| "Worth it?" tradeoff → decision + rationale + uncertainty | ❌ — No tradeoff engine |
| "Travel day, no control" → reclassifies day and changes expectations | ❌ — No day classification |
| "This seems wrong" → lists top error sources and asks minimal clarifiers | ❌ — No audit mode |

---

## Summary Scorecard

| Requirement Area | Score |
|---|---|
| 1. Totals + Transparency | **85%** ✅ |
| 2. Ambiguity Detection | **30%** 🟡 |
| 3. Uncertainty as Output | **15%** 🟡 |
| 4. Corrections Persist | **20%** 🟡 |
| 5. What-If / Planning | **10%** ❌ |
| 6. Time Awareness | **70%** ✅ |
| 7. Triage Logic | **0%** ❌ |
| 8. Tradeoff Reasoning | **0%** ❌ |
| 9. Summary Format | **40%** 🟡 |
| 10. Negotiation Tone | **20%** 🟡 |
| 11. Day Classification | **0%** ❌ |
| 12. Audit Mode | **0%** ❌ |
| 13. Reflection Loops | **15%** 🟡 |
| 14. Longitudinal Patterns | **5%** ❌ |

### Overall Alignment: **~22%**

> The app has a strong **logging and recipe management** foundation (PCC pattern, validation, recipes, goals, dashboard) but the **reasoning, uncertainty, planning, and contextual intelligence** layers that define the client's vision are largely absent. The system currently behaves as a **nutrition diary with an AI lookup**, not the **"auditable, stateful, scenario-aware thinking partner"** the client specified.

---

## Highest-Impact Gaps (Recommended Priority Order)

1. **Uncertainty & Confidence surfaced to user** (§3) — data exists internally, just needs to flow to UI
2. **Ambiguity detection pass** (§2) — a pre-estimation check before silent defaults
3. **Day classification system** (§11) — enables §7, §8, §14
4. **Prompt tone overhaul** (§10) — negotiation partner, not coach
5. **Summary format enforcement** (§9) — structured bullets, not free-form
6. **Audit mode** (§12) — "this seems off" handler
7. **Tradeoff reasoning** (§8) — multi-objective arbitration
8. **What-if engine** (§5) — branching scenarios and planning mode
9. **Corrections reuse loop** (§4) — read back stored corrections
10. **Longitudinal pattern interpretation** (§14) — interpretive layer on top of raw data
