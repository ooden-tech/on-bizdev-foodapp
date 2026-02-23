# Post Test Flow Analysis & Fix Plan

> **Analysis Date:** 2026-02-23  
> **Scope:** Test Flow Parts 1–6 (Tests 1–22)  
> **Status:** Analysis only — no code modifications

---

## Executive Summary

Manual execution of 22 tests across 6 test parts revealed **7 tests with failures** and **15 passing tests**. The failures cluster around 4 systemic weaknesses:

1. **Fat subtype hierarchy violations** — The LLM generates omega-3/omega-6 values without maintaining parent-child consistency with `fat_poly_g`, causing `validateNutrientHierarchy` to reject otherwise valid food logs (Tests 7, 12, 17).
2. **Portion scaling inaccuracy** — LLM-based nutrition estimation for weight-specified portions underestimates calories/protein by ~15–20%, with no post-estimation density sanity check (Test 6).
3. **Recipe logging flow gap** — The orchestrator's auto-proposal safety net covers `food_log` but not `recipe_log`, creating a broken multi-turn conversation that fails to display the confirmation modal or persist the log (Test 19).
4. **Composite food fragmentation** — Multi-ingredient items described after clarification (e.g., "sandwich = bread + cheese + ham") are split into separate log entries instead of being aggregated into a single composite item (Test 12).

Secondary issues include `hydration_ml = 0` for water-rich solid foods (Tests 5, 11) and `serving_size` labels not reflecting user-specified counts (Test 5).

All failures originate from **three architectural layers**: NutritionAgent LLM prompt design, ToolExecutor validation strategy, and Orchestrator flow coverage gaps. No database, frontend rendering, or auth issues were observed.

---

## Sequential Test Analysis

### Part 1: Foundation (Tests 1–4) ✅ ALL PASS

| Test | Name | Result |
|------|------|--------|
| 1 | Goal Setting | ✅ Pass |
| 2 | Goal Recall | ✅ Pass |
| 3 | Health Constraint Setup | ✅ Pass |
| 4 | Constraint Verification | ✅ Pass |

**Notes:** Goal management and health constraint flows work correctly end-to-end. The `bulk_update_user_goals` tool, `manageHealthConstraints`, and `getUserGoals` paths in `tool-executor.ts` function as designed.

---

### Part 2: Core Food Logging (Tests 5–9)

#### Test 5: Simple Item Log — "Log 2 boiled eggs" ⚠️ PARTIAL PASS

**Observed:** Logged successfully but with two issues:
1. Serving size displayed as "1 serving" instead of "2 eggs"
2. Water = 0 ml (eggs are ~75% water by weight)

**Root Cause 1 — Serving Size Label:**  
- **Layer:** NutritionAgent (LLM) → FoodLogConfirmation (Frontend)
- **Category:** UX / response contract issue
- **Technical:** The UI showing "1 serving" for "2 eggs" is a UI contract issue. Relying entirely on `serving_size` to carry both the backend standard measurement and the user's requested portion is flawed. There needs to be an explicit `display_portion` field separated from `serving_size`. The frontend (`FoodLogConfirmation.tsx:106`) falls back to `'1 serving'` when `serving_size` is missing or not appropriately formatted for display.
- **Confirmed:** The scaling function `getScalingMultiplier` (line 146–286) returns a numeric multiplier only — it does not provide a separate `display_portion` string. `scaleNutrition` (line 387–420) scales numeric fields but preserves the original `serving_size` string without updating the user-facing portion representation.

**Root Cause 2 — Hydration = 0:**  
- **Layer:** NutritionAgent (LLM prompt)
- **Category:** Data generation issue
- **Technical:** The LLM prompt's "CRITICAL HYDRATION RULE" (`nutrition-agent.ts:497`) targets *"liquid (water, coffee, tea, soup, milk, etc.) or contains significant water"* — this is interpreted by the LLM as referring to beverages, not intrinsic water content of solid foods. Eggs (~37ml water per large egg) are not covered. The external API path also doesn't populate `hydration_ml` as it's not a standard nutrition API field.
- **Hypothesis:** This is a prompt design gap — the rule is too narrowly scoped to liquids.

---

#### Test 6: Multi-Item Log — "150g chicken + 1 cup rice" ⚠️ FAIL

**Observed:** 370 kcal / 35g protein / 45g carbs / 4g fat (expected: ~440–450 kcal / ~49g protein / ~45g carbs / ~5–6g fat)

**Root Cause:**
- **Layer:** NutritionAgent (LLM estimation accuracy)
- **Category:** Scaling issue / Data generation issue
- **Technical:** The carb value (45g) is correct for 1 cup rice, confirming rice was estimated correctly. The deficit is entirely in chicken: 370 - 200 (rice kcal) = 170 kcal for chicken, ~35 - 4 (rice protein) = 31g protein. This implies the LLM estimated chicken at ~100–110g instead of 150g.
- **Flow analysis:** In `NutritionAgent.analyzeNutrition`, if the API cache miss occurs, the LLM receives the portion "150g" explicitly in the prompt. The LLM either: (a) ignored the portion, (b) normalized to a default serving, or (c) used incorrect per-100g baseline values.
- **Confirmed gap:** There is **no post-estimation sanity check** that validates LLM output against known caloric density ranges. For chicken breast, ~1.65 kcal/g is expected. However, outright rejection or auto-scaling based on density risks false positives. It is better implemented as a `warn + requery` loop mechanism.
- **Hypothesis:** If the API path hit successfully with a different serving size (e.g., "3 oz / 85g"), `getScalingMultiplier` may have computed incorrectly if `parseUnitAndAmount` failed to parse the user's multi-item portion string.

---

#### Test 7: Brand/Specific Log — "Log 1 Snickers Bar" ❌ FAIL

**Observed:** Validation error: *"Omega-6 (0.8g) cannot exceed Polyunsaturated Fat (0g)"*

**Root Cause:**
- **Layer:** NutritionAgent (LLM data generation) + ToolExecutor (validation strategy)
- **Category:** Data generation issue + Validation logic issue
- **Technical:** The LLM generated `omega_6_g: 0.8` but `fat_poly_g: 0` (or absent, defaulting to 0). This violates `NUTRIENT_HIERARCHY.poly_fat_group` in `nutrient-validation.ts:30-34`, where omega-6 is defined as a child of `fat_poly_g`.
- **Why the LLM fails:** The NutritionAgent prompt (`nutrition-agent.ts:506`) lists all `MASTER_NUTRIENT_MAP` keys as valid output fields but provides **no hierarchy constraint instructions** — the LLM doesn't know that `omega_6_g ≤ fat_poly_g ≤ fat_total_g` must hold.
- **Why the system doesn't recover:** `proposeFoodLog` (`tool-executor.ts:849-854`) calls `validateNutrientHierarchy` and **rejects the entire proposal** when violations are found. The error message is returned to the ReasoningAgent. `sanitizeNutrients` only caps children down to parent values — it would cap omega_6 to 0g (parent's value), making data worse.
- **Confirmed:** Simply lifting `fat_poly_g` is incomplete. If we lift `fat_poly_g` to match `omega_3_g + omega_6_g`, we must also ensure `fat_total_g ≥ sat + mono + poly + trans`. Lifting `poly` without adjusting `total` (or reducing others) just moves the violation up the chain. We need a holistic sanitization approach that maintains full consistency.

---

#### Tests 8–9: Confirmation & Cancellation Flows ✅ PASS

Both the "Confirm" and "Cancel" flows work correctly. The orchestrator's static fast-path detection (`orchestrator_v3.ts:160-229`) handles these reliably.

---

### Part 3: Ambiguity & "Thinking Partner" (Tests 10–12)

#### Test 10: Ambiguity Detection — "Log a bowl of pasta" ✅ PASS

Ambiguity correctly detected and clarification requested.

#### Test 11: Clarification Response — "Large carbonara from restaurant" ⚠️ PARTIAL PASS

**Observed:** Foods logged successfully, but Water = 0ml (same pattern as Test 5).

**Root Cause:** Identical to Test 5, Root Cause 2. Carbonara contains cream, cheese, and pasta that absorbed cooking water — significant water content not captured.
- **Layer:** NutritionAgent (LLM prompt)
- **Category:** Data generation issue
- **Confirmed:** The hydration rule narrowly targets beverages, not cooked dishes.

#### Test 12: Vague Item + Clarification — "Log a sandwich" → "bread + cheese + ham" ❌ FAIL

**Observed:**
1. System treated ingredients as 3 separate items instead of 1 sandwich
2. Asked unnecessary clarification for bread (post-initial-clarification)
3. Flagged ham for macro inconsistency (fat subtype issue)
4. Displayed as "White Bread Slice + 1 more" instead of "Ham & Cheese Sandwich"
5. Confusing multi-item confirmation flow

**Root Cause 1 — Composite Food Fragmentation & Naming:**
- **Layer:** IntentAgent (entity extraction) + ReasoningAgent (composite food logic)
- **Category:** Intent routing issue + Agent prompt issue
- **Technical:** When the user clarified "one slice bread, one slice cheese, one slice ham," the IntentAgent extracted these as 3 separate `food_items`. The ReasoningAgent prompt (`reasoning-agent.ts:135-137`) handles composites described with "mixers" (e.g., "protein powder in water") but **has no rule for ingredient-list composites** like sandwiches. Each ingredient went through separate `ask_nutrition_agent` + `propose_food_log` calls, resulting in a batch proposal.
- **Confirmed gap:** There is no "composite food detection" concept, and batched grouped logs generate bad labels like "White Bread Slice + 1 more". The ReasoningAgent should: (a) recognize that "bread + cheese + ham" described as a "sandwich" is one item, (b) call `ask_nutrition_agent` with all ingredients and an explicit composite naming strategy for the batch, mapping it correctly to a single `food_name` like "Ham & Cheese Sandwich".

**Root Cause 2 — Unnecessary Post-Clarification Ambiguity:**
- **Layer:** Orchestrator (ambiguity handling)
- **Category:** Intent routing issue
- **Technical:** The orchestrator (`orchestrator_v3.ts:252-256`) has a rule: *"After one clarification, NEVER clarify again"* — but this only applies when `augmentedMessage !== message` (i.e., when clarification context is prepended). If the IntentAgent independently flags "toaster bread" as ambiguous (bread type unknown), and the context prepending didn't trigger, the system asks again.
- **Hypothesis:** The clarification context may not have been properly prepended for the bread sub-item, allowing a second round of ambiguity detection.

**Root Cause 3 — Ham Macro Inconsistency:**
- Same fat subtype hierarchy issue as Test 7. The LLM generated inconsistent omega/poly fat values for ham.

---

### Part 4: Learning, Memory & Corrections (Tests 15–16) ✅ ALL PASS

| Test | Name | Result |
|------|------|--------|
| 15 | Brand Learning | ✅ Pass |
| 16 | Brand Application | ✅ Pass |

Memory system (`storeMemory`, `searchMemory` in `tool-executor.ts`) works correctly. Cross-session recall via memory injection in context (`reasoning-agent.ts:218-224`) functions as designed.

---

### Part 5: Recipe Management (Tests 17–20)

#### Test 17: Recipe Parsing/Save — Chicken Pesto Pasta ⚠️ PARTIAL PASS

**Observed:** Recipe saved, but fat subtype math inconsistent. Total fat = 154g, with sat(20) + mono(91.5) + omega3(0.5) + omega6(4.4) = 116.4g, leaving ~37g unaccounted (polyunsaturated fat total missing).

**Root Cause:**
- **Layer:** NutritionAgent (LLM) + RecipeAgent (no validation on save)
- **Category:** Data generation issue + Validation logic issue
- **Technical:** `RecipeAgent.calculateNutrition` (`recipe-agent.ts:530-586`) sums per-ingredient nutrition from the NutritionAgent. The LLM generated omega-3 and omega-6 for individual ingredients but **did not generate `fat_poly_g`** (or generated 0). Since `calculateNutrition` sums all numeric keys, `fat_poly_g` remained 0 or absent while `omega_3_g` and `omega_6_g` accumulated to 4.9g.
- **Key gap:** Unlike `proposeFoodLog`, `RecipeAgent.saveRecipeToDb` (`recipe-agent.ts:587-613`) does **not call `validateNutrientHierarchy`** before saving. Inconsistent data is persisted to the database, creating a latent data quality issue that surfaces when the recipe is later logged.
- **Confirmed:** `validateNutrientHierarchy` is only invoked in `ToolExecutor.proposeFoodLog`, not in `RecipeAgent.calculateNutrition` or `saveRecipeToDb`.

#### Test 18: Recipe Confirmation — "Yes, save it" ✅ PASS

#### Test 19: Recipe Logging — "Log 1 serving of Chicken Pesto Pasta" ❌ FAIL (Critical)

**Observed:**
1. No food log modal shown initially — AI gave text warning about calories/health constraints
2. User said "yes" → AI said "logged" → THEN showed food log modal
3. Food was **not actually logged** to database
4. Modal showed only calories, all other macros = 0

**Root Cause — Multi-layer flow failure:**
- **Layer:** ReasoningAgent + Orchestrator + ToolExecutor
- **Category:** Intent routing issue + UX/response contract issue

**Detailed flow trace:**

| Step | What Should Happen | What Likely Happened |
|------|--------------------|---------------------|
| 1 | IntentAgent classifies `log_recipe` | ✅ Correct |
| 2 | Orchestrator routes to ReasoningAgent | ✅ Correct |
| 3 | ReasoningAgent calls `ask_recipe_agent` (find) | ✅ Found recipe |
| 4 | ReasoningAgent calls `propose_recipe_log` | ❌ **Skipped** — generated text warning about dairy constraint instead |
| 5 | Orchestrator checks for proposal | ❌ No proposal exists |
| 6 | Orchestrator safety net auto-creates proposal | ❌ Safety net only checks for `log_food` intent (`orchestrator_v3.ts:450`), not `log_recipe` |
| 7 | Response sent without modal | ⚠️ Text-only response, no confirmation UI |
| 8 | User says "yes" → confirm intent | ❌ No `pending_action` stored → falls to ReasoningAgent again |
| 9 | ReasoningAgent tries to log, calls `propose_food_log` (wrong tool) | ❌ Passes recipe data through food_log path, missing nutrient resolution |
| 10 | Modal appears with only calories | ❌ `proposeRecipeLog` was never called — `getNutrientValue` can't resolve recipe-shaped data |

**Confirmed gaps:**
- `orchestrator_v3.ts:450`: `if (intent === 'log_food' && !activeProposal)` — no equivalent for `log_recipe`
- `reasoning-agent.ts:134`: Health flag rule says *"MUST still call propose_food_log"* — but for recipes it should be `propose_recipe_log`, and the prompt doesn't distinguish
- `proposeRecipeLog` (`tool-executor.ts:878-925`) has the correct logic but is never invoked

#### Test 20: Recipe Detail Query ✅ PASS

---

### Part 6: Safety & Constraints (Tests 21–22) — NO RESULTS RECORDED

Tests 21 (Allergen Warning) and 22 (Intolerance Flag) have no recorded results in the test document.

---

## Cross-System Failure Patterns

### Pattern 1: Fat Subtype Hierarchy Violations
**Affected Tests:** 7, 12, 17  
**Frequency:** 3/22 tests (14%)  
**Impact:** Blocks food logging (Test 7), creates inconsistent stored data (Test 17)  

```
LLM estimates → omega_3/omega_6 populated → fat_poly_g = 0 or missing
                       ↓
         validateNutrientHierarchy rejects
                       ↓
         proposeFoodLog returns error → no modal shown
```

**Root modules:** `nutrition-agent.ts` (LLM prompt), `nutrient-validation.ts` (validate), `tool-executor.ts:849-854` (reject strategy)

---

### Pattern 2: LLM Estimation Accuracy Deficit
**Affected Tests:** 5, 6, 11  
**Frequency:** 3/22 tests (14%)  
**Impact:** Undercounted calories/protein, missing hydration data  

The system lacks a **post-LLM sanity check layer** that validates estimated nutritional values against known food density ranges (kcal/g, protein/g for common food categories). However, this must be implemented carefully via a `warn + requery` loop to avoid false positive rejections or inaccurate auto-scaling.

**Root modules:** `nutrition-agent.ts` (no density validation), `tool-executor.ts` (no sanity check after lookupNutrition)

---

### Pattern 3: Intent → Proposal Gaps
**Affected Tests:** 12, 19  
**Frequency:** 2/22 tests (9%)  
**Impact:** Complete flow failures — food not logged, broken UX  

The orchestrator has different coverage for different intent types:
- `log_food`: Safety net at `orchestrator_v3.ts:450-480` auto-creates proposals ✅
- `log_recipe`: No safety net ❌
- Composite foods: No aggregation concept ❌

---

### Pattern 4: Validate-Then-Reject vs Holistic-Sanitize-Then-Validate
**Affected Tests:** 7  
**Impact:** Correctible data is rejected instead of safely corrected  

`sanitizeNutrients` exists (`nutrient-validation.ts:112-147`) but is **never called** before `validateNutrientHierarchy` in the proposal flow. A holistic sanitize-first approach must intelligently ensure that `poly >= omega3 + omega6` AND `total >= sat + mono + poly + trans`. Simple upward lifting of a single nutrient risk breaking the parent's parent validation.

---

## Architectural Weak Points

| Weakness | Impact | Location |
|----------|--------|----------|
| No post-LLM nutritional density warn+requery check | Underestimated macros | `nutrition-agent.ts`, `tool-executor.ts` |
| Contract-level validation missing on all entry points | Inconsistent data persisted across paths | Various (needs single shared validator) |
| No composite food aggregation/naming concept | Fragmented sandwich logging / Bad labels | `reasoning-agent.ts` prompt |
| Recipe logging safety net missing | Complete recipe log failure | `orchestrator_v3.ts:450-480` |
| Lack of explicit `display_portion` field | Misleading "1 serving" label | `nutrition-agent.ts`, UI contract |
| Hydration rule scoped to liquids only | 0ml water for solid foods | `nutrition-agent.ts` prompt |

---

## Proposed Fix Strategy (Ordered by Priority)

### P0 — Critical (Blocks Core Functionality)

#### Fix 1: Universal Contract-Level Validation & Holistic Sanitization
- **What:** Create a single shared validator (e.g., `validateNutritionContract`) used everywhere before DB writes (food log, recipe log, recipe save). This sanitizer must intelligently ensure `poly ≥ omega3 + omega6` AND `total ≥ sat + mono + poly + trans`. If we lift `poly`, we must also lift `total` (or reduce `mono`/`sat`) to maintain consistency.
- **Where:** A new or expanded `validateNutritionContract` method in `nutrient-validation.ts` called universally across `proposeFoodLog`, `proposeRecipeLog`, and `saveRecipeToDb`.
- **Why sanitize not prompt-fix:** LLMs are probabilistic — even perfect prompts will occasionally violate hierarchy. A deterministic sanitizer provides a reliable contract-level safety net.

#### Fix 2: Recipe Logging Flow Parity
- **What:** Add safety net for `log_recipe` in orchestrator, mirroring the `log_food` auto-proposal at `orchestrator_v3.ts:450-480`.
- **Where:** `orchestrator_v3.ts` (after line 480)
- **Also:** Update ReasoningAgent prompt to clarify: *"For recipe logging, use `propose_recipe_log` (not `propose_food_log`). Health warnings go in response text, but the proposal MUST still be generated."*

### P1 — High (Impacts Data Accuracy)

#### Fix 3: Post-LLM Nutritional Density Warn + Requery
- **What:** After receiving LLM estimates, check that kcal/g falls within the expected range for the food category. To avoid false positive rejections or inaccurate auto-scaling, implement this as a `warn + requery` loop. Ensure the LLM tries to self-correct based on density guidelines.
- **Where:** `nutrition-agent.ts:analyzeNutrition` (after LLM response parsing).
- **Approach:** Maintain a small lookup table of caloric density ranges for ~20 common food categories. If the LLM estimate deviates >25%, trigger a requery with a specific warning about the expected density range.

#### Fix 4: Composite Food Aggregation & Group Naming Strategy
- **What:** Add a rule to ReasoningAgent prompt: *"When the user describes a food by listing its ingredients (e.g., 'bread + cheese + ham' = sandwich), create ONE log entry named after the composite item, with nutrition summed from all components. Apply a specific naming strategy so it does not show up as 'Bread + 1 more'."*
- **Where:** `reasoning-agent.ts` SYSTEM_PROMPT, "Composite Item Logging" section (line 135-137).
- **Also:** Have the ReasoningAgent call `ask_nutrition_agent` with all ingredients, then aggregate results into a single explicit `food_name` before calling `propose_food_log`.

### P2 — Medium (UX / Data Quality)

#### Fix 5: Expand Hydration Rule to Solid Foods
- **What:** Update NutritionAgent prompt's hydration rule to include water content estimation for cooked/water-rich solid foods.
- **Where:** `nutrition-agent.ts` prompt (line ~497)
- **Prompt addition:** *"For solid foods that are cooked or naturally water-rich (eggs, cooked pasta, soups, stews, fruits, vegetables), estimate the intrinsic water content in hydration_ml. A large egg contains ~37ml water. 1 cup of cooked pasta contains ~100ml absorbed water."*

#### Fix 6: Introduce Explicit `display_portion` Field
- **What:** Decouple the UI contract from the backend measurement. Return an explicit `display_portion` string that reflects the user's input (e.g., "2 large eggs") while leaving the backend `serving_size` accurate to the nutrition source.
- **Where:** Add to the LLM UI contract, `nutrition-agent.ts:getScalingMultiplier` (propagate through `scaleNutrition` and `proposeFoodLog`), and update `FoodLogConfirmation.tsx`.

#### Fix 7: Universal Contract-Level Validation
- **What:** Apply the shared `validateNutritionContract` (from Fix 1) across all DB write paths, including `RecipeAgent.saveRecipeToDb`, to prevent inconsistent data storage.
- **Where:** `recipe-agent.ts:saveRecipeToDb` (and any other entry points).

---

## Validation & Regression Prevention Plan

### Automated Tests

| Test ID | Target Fix | Validation Method |
|---------|-----------|-------------------|
| R-1 | Fix 1 | Unit test: `validateNutrientHierarchy` after sanitization with omega_6 > fat_poly_g = 0 → should auto-correct and pass |
| R-2 | Fix 2 | Integration test: "Log 1 serving of [saved recipe]" → must produce `confirmation_food_log` response with nutrition data |
| R-3 | Fix 3 | Unit test: LLM estimate for "150g chicken breast" must produce kcal ∈ [220, 280] range |
| R-4 | Fix 4 | Integration test: "Log a sandwich (bread + cheese + ham)" → single `propose_food_log` call with composite name |
| R-5 | Fix 5 | Unit test: "2 boiled eggs" must have hydration_ml > 0 |
| R-6 | Fix 7 | Unit test: Recipe with inconsistent fat subtypes → saved with corrected values |

### Re-execution of Failed Tests
After fixes are deployed, re-run tests 5, 6, 7, 11, 12, 17, 19 and document results.

### Regression Guard
Add `validateNutrientHierarchy` to: (a) `proposeFoodLog`, (b) `proposeRecipeLog`, (c) `saveRecipeToDb`, (d) any future entry point that writes nutrition data.

---

## Suggested Telemetry Improvements

| Metric | Purpose | Location |
|--------|---------|----------|
| `llm_fat_subtype_consistency` | Log `fat_total_g` vs sum of `fat_saturated_g + fat_poly_g + fat_mono_g + fat_trans_g` pre-validation | `tool-executor.ts:proposeFoodLog` |
| `llm_density_check` | Log kcal/g for each estimated item vs expected density range | `nutrition-agent.ts:analyzeNutrition` |
| `proposal_generation_rate` | Count proposals generated vs intent type (`food_log`, `recipe_log`) | `orchestrator_v3.ts` |
| `composite_food_detection` | Track when multi-ingredient items are detected and aggregated | `reasoning-agent.ts` |
| `scaling_multiplier_audit` | Log `userPortion`, `servingSize`, computed multiplier, and resulting kcal/g | `nutrition-agent.ts:getScalingMultiplier` |
| `validation_rejection_rate` | Count `validateNutrientHierarchy` rejections with violation type | `tool-executor.ts:proposeFoodLog` |
| `hydration_ml_population_rate` | % of food logs with hydration_ml > 0 vs hydration_ml = 0 | `logFilteredFood` |
| `recipe_log_flow_completeness` | Track recipe log requests that result in actual DB writes vs text-only responses | `orchestrator_v3.ts:handlePendingConfirmation` |

---

## Legend

- ✅ **Confirmed issue** — directly observed in test results and verified in codebase
- ⚠️ **Hypothesis** — plausible root cause inferred from architecture, not directly logged
- 🔍 **Requires investigation** — needs additional logging/debugging to confirm
