# Codebase Audit & Debugging Report

> **Date:** 2026-02-23  
> **Scope:** Root-cause analysis for 7 categories of bugs observed during testing  
> **Status:** Investigation only — no fixes implemented  
> **Evidence Basis:** Code inspection + live DB queries on project `xujphusgufnlatokdsqy`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Issue 1: Saved Recipes Not Found](#2-issue-1-saved-recipes-not-found)
3. [Issue 2: Remembered Preferences Not Persisting](#3-issue-2-remembered-preferences-not-persisting)
4. [Issue 3: Logging Modal Missing Nutrition Fields](#4-issue-3-logging-modal-missing-nutrition-fields)
5. [Issue 4: Water/Hydration Always Zero](#5-issue-4-waterhydration-always-zero)
6. [Issue 5: Timezone Not Known](#6-issue-5-timezone-not-known)
7. [Issue 6: Health Constraint — Warn vs Refuse](#7-issue-6-health-constraint-warn-vs-refuse)
8. [Issue 7A: Backend Response Missing Confirmation Payload](#8-issue-7a-backend-response-missing-confirmation-payload)
9. [Issue 7B: "I Don't See Anything" Handled as Generic Turn](#9-issue-7b-i-dont-see-anything-handled-as-generic-turn)
10. [Cross-Cutting: Agent Timeouts & Fallback](#10-cross-cutting-agent-timeouts--fallback)
11. [High-Level Fix Plan](#11-high-level-fix-plan)
12. [Regression Prevention](#12-regression-prevention)

---

## 1. Architecture Overview

```
User Message
  │
  ▼
index.ts  ─── extracts { message, session_id, timezone } from body
  │
  ▼
orchestrateV3()  (orchestrator_v3.ts)
  │
  ├─ Step 0: Load session, health constraints, memories, day classification, goals
  ├─ Step 0: Check pending clarification → merge context
  ├─ Step 0: Static fast-paths (thanks, confirm/cancel buttons)
  │
  ├─ Step 2: IntentAgent (gpt-4o-mini, fast classification)
  │     └─ On timeout → fallback: { type: "complex_request", confidence: "low" }
  │
  ├─ Step 2.5: Ambiguity check → clarification flow
  │
  ├─ Step 3: Intent Switchboard
  │     ├─ greet → ChatAgent
  │     ├─ store_memory → ToolExecutor.storeMemory()
  │     ├─ confirm/decline → handlePendingConfirmation()
  │     ├─ audit/patterns/reflect/classify_day/summary → InsightAgent
  │     ├─ log_food/query_nutrition → falls through to Step 4
  │     └─ log_recipe/save_recipe → falls through to Step 4
  │
  ├─ Step 4: ReasoningAgent (gpt-4o, tool-calling loop, max 5 iterations)
  │     └─ ToolExecutor dispatches to: NutritionAgent, RecipeAgent, DbService, etc.
  │
  └─ Step 5: ChatAgent (gpt-4o-mini, personality formatting)
        └─ Response with { message, response_type, data }
```

### Layer Responsibility Map

| Layer | Responsibility | Key Files |
|---|---|---|
| **Frontend** | Session/timezone passing, modal rendering, dashboard | `page.tsx`, `ChatMessageList.tsx`, `FoodLogConfirmation.tsx` |
| **Chat Handler** | Auth, history fetch, SSE streaming, message persistence | `index.ts` |
| **Orchestrator** | Flow routing, context merging, proposal persistence, response shaping | `orchestrator_v3.ts` |
| **IntentAgent** | Fast intent classification (gpt-4o-mini) | `intent-agent.ts` |
| **ReasoningAgent** | Tool-calling orchestration (gpt-4o) | `reasoning-agent.ts` |
| **ToolExecutor** | Tool dispatch, nutrient filtering, proposal building | `tool-executor.ts` |
| **NutritionAgent** | API lookup + LLM estimation, scaling, allergen flagging | `nutrition-agent.ts` |
| **SessionService** | Session CRUD, pending actions, clarification context | `session-service.ts` |
| **DbService** | Database queries: food logs, goals, memories, health constraints | `db-service.ts` |
| **Memory Store** | `user_learned_context` table (category, fact, active, user_id) | `db-service.ts` |

---

## 2. Issue 1: Saved Recipes Not Found

### Symptom
User asks "what recipes do I have saved?" → Assistant replies "you don't have any specific recipes saved yet."

### DB Evidence ✅

```sql
SELECT user_id, COUNT(*) as recipe_count, array_agg(recipe_name) as recipe_names
FROM user_recipes GROUP BY user_id;
```

| user_id | recipe_count | recipe_names |
|---|---|---|
| aa9fdbea-... | **3** | Mega Omelet (new), Chicken and Pearl Couscous Soup (new), Chicken Pesto pasta (new) |

**Verdict: Recipes DO exist.** The data is present. The problem is the code path, not the data.

### Root Cause (Confirmed — code-backed gap)

**The ReasoningAgent has no "list all recipes" tool.** The only recipe tools available are:

- `search_saved_recipes(query)` — requires a search term. Has a guard rejecting queries < 2 chars:
  ```typescript
  if (!query || query.trim().length < 2) {
    return { message: "Please provide a more specific search term.", recipes: [] };
  }
  ```
- `get_recipe_details(recipe_id)` — requires a known recipe ID
- `ask_recipe_agent({ action: 'find', query })` — also requires a query

When the user asks "what recipes do I have saved?", the ReasoningAgent has no tool to list all recipes without a search term.

### Concrete Suspects
| File | Line(s) | Issue |
|---|---|---|
| [tool-executor.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/services/tool-executor.ts#L677-L701) | 677-701 | `searchSavedRecipes` requires query, rejects short queries |
| [tools.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/services/tools.ts) | — | No `list_saved_recipes` tool defined |
| [reasoning-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/reasoning-agent.ts#L80-L83) | 80-83 | Prompt says use `ask_recipe_agent` with `find`, which also needs a query |

---

## 3. Issue 2: Remembered Preferences Not Persisting

### Symptom
User says "I usually eat chobani zero sugar yogurt" → System confirms remembering → New chat: "log my usual yogurt" → asks for yogurt type again.

### DB Evidence ✅

```sql
SELECT id, category, fact, active, source_message, created_at
FROM user_learned_context ORDER BY created_at DESC LIMIT 5;
```

| category | fact | active | created_at |
|---|---|---|---|
| **preferences** | **Usually eat Chobani zero sugar yogurt, 200 ml pack.** | **true** | 2026-02-20 17:26:03 |
| food | User's favorite yogurt is Chobani zero sugar Greek yogurt. | true | 2026-02-12 17:10:52 |
| habits | I usually drink my coffee with two tsp of sugar. | true | 2026-02-12 12:12:42 |
| habits | User usually drinks 200 ml of coffee with 2 spoons of sugar. | true | 2026-02-11 17:36:08 |

**Verdict: Memory IS stored correctly and IS active.** The yogurt preference exists twice in DB. The problem is recall, not storage.

### Root Cause (Confirmed — code-backed gap)

**Memories are loaded at startup but never injected into the ReasoningAgent's prompt context.** The chain:

1. **Storage:** `store_memory` → `DbService.saveMemory()` → `user_learned_context` table  ✅
2. **Loading:** `orchestrateV3()` line 73 fetches all memories at startup ✅:
   ```typescript
   const memories = await db.getMemories(userId, ['food', 'preferences', 'habits', 'health']);
   ```
3. **Injection: ❌ MISSING.** The ReasoningAgent context prefix at [reasoning-agent.ts:183-213](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/reasoning-agent.ts#L183-L213) injects:
   - Intent metadata ✅
   - Pending action ✅
   - Day classification ✅
   - Health constraints ✅
   - **Memories: NOT INJECTED** ❌

The memories are in `context.memories` but the ReasoningAgent never reads them. The only way to recall is if the LLM independently calls the `search_memory` tool, but the prompt doesn't instruct it to do so for "usual" or "my regular" requests.

### Concrete Suspects
| File | Line(s) | Issue |
|---|---|---|
| [reasoning-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/reasoning-agent.ts#L196-L213) | 196-213 | Context prefix does NOT inject loaded memories |
| [reasoning-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/reasoning-agent.ts#L114-L115) | 114-115 | Prompt mentions `search_memory` tool but no directive on when to use it proactively |

---

## 4. Issue 3: Logging Modal Missing Nutrition Fields

### Symptom
Recipe log confirmation modal shows calories/protein/carbs/fat/fiber but sugars, sat fat, sodium, water, mono/poly/omegas all show "-".

### Root Cause (Confirmed — code-backed, two layers)

**Layer 1: `proposeRecipeLog` only uses tracked goal keys**, unlike `proposeFoodLog` which merges standard + tracked.

```typescript
// proposeFoodLog (line 791-800) — CORRECT: merges 14 standard nutrients + tracked
const standardNutrients = [
  'calories', 'protein_g', 'carbs_g', 'fat_total_g', 'hydration_ml',
  'fiber_g', 'sugar_g', 'sodium_mg', 'cholesterol_mg', 'potassium_mg',
  'fat_saturated_g', 'fat_trans_g', 'fat_mono_g', 'fat_poly_g'
];
const allKeys = Array.from(new Set([...trackedKeys, ...standardNutrients]));

// proposeRecipeLog (line 862-870) — BROKEN: only trackedKeys
trackedKeys.forEach(key => {
  const value = this.getNutrientValue(data, key);
  ...
});
```

**Layer 2: Orchestrator hardcodes 5 fields for `recipe_log` response:**
```typescript
// orchestrator_v3.ts lines 496-506
response.data.nutrition = [{
  food_name: p.data.recipe_name,
  calories: p.data.calories,
  protein_g: p.data.protein_g,
  carbs_g: p.data.carbs_g,
  fat_total_g: p.data.fat_total_g,
  serving_size: `${p.data.servings} serving(s)`
}];
```
This strips ALL other nutrients even if they were in the proposal.

### Concrete Suspects
| File | Line(s) | Issue |
|---|---|---|
| [tool-executor.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/services/tool-executor.ts#L844-L882) | 844-882 | `proposeRecipeLog` missing standard nutrients merge |
| [orchestrator_v3.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/orchestrator_v3.ts#L496-L506) | 496-506 | Hardcoded 5-field mapping strips all other nutrients |

---

## 5. Issue 4: Water/Hydration Always Zero

### Symptom
Logged soup shows `hydration_ml: 0`. Concern: "issues with water in the food we log."

### DB Evidence ✅

```sql
SELECT food_name, calories, hydration_ml FROM food_log ORDER BY log_time DESC LIMIT 10;
```

| food_name | calories | hydration_ml |
|---|---|---|
| **Chicken and Pearl Couscous Soup** | 480 | **0** |
| White Rice | 205 | 0 |
| Grilled Chicken Breast | 165 | 0 |
| Coffee | 2 | **240** ✅ |
| Dry Plain Pasta | 200 | 0 |
| Chicken Pesto pasta | 583 | 0 |
| boiled eggs | 62 | 0 |
| apple | 95 | **86** ✅ |

**Verdict:** Soup has 0 hydration, which is wrong. Coffee and apple DO have nonzero hydration, proving the column works when data is provided. The issue is upstream data generation.

### Root Cause Analysis (Mixed — confirmed + hypotheses)

**Confirmed:** The NutritionAgent LLM estimation returned `hydration_ml: 0` for the spaghetti carbonara (visible in the chat_messages metadata). The prompt at [nutrition-agent.ts:519](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/nutrition-agent.ts#L519) says:
> "CRITICAL HYDRATION RULE: If a food is a liquid... you MUST populate hydration_ml"

But the LLM ignores this for semi-liquid foods like soup.

**⚠️ HYPOTHESIS (needs verification):** The Nutritionix API path may not return a `hydration_ml` field. We could not confirm this without inspecting the external API response shape. Coffee and apple having hydration suggests the LLM path CAN produce values — but the API hit path may strip them.

**⚠️ HYPOTHESIS (needs verification):** A previous conversation about [Refining Nutrition Scaling](conversation cbfcc852) may have deliberately restricted hydration to explicit liquids only. The actual implementation decision would need to be confirmed by reviewing that conversation's changes.

### DB Verification Query
```sql
-- Run to check if any food from API path has hydration:
SELECT food_name, hydration_ml, confidence FROM food_log 
WHERE hydration_ml > 0 ORDER BY log_time DESC LIMIT 10;
```

### Concrete Suspects
| File | Line(s) | Issue |
|---|---|---|
| [nutrition-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/nutrition-agent.ts#L519) | 519 | Hydration prompt rule not strong enough for soup/stew |
| [nutrition-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/nutrition-agent.ts#L471-L483) | 471-483 | API cache hit path — unclear if hydration_ml is populated |

---

## 6. Issue 5: Timezone Not Known

### Symptom
User asks "what timezone am I in?" → Assistant says it can't access timezone/current time.

### Root Cause (Confirmed — code-backed)

**Timezone IS sent from the frontend and IS available in the pipeline — but NOT injected into the ReasoningAgent's context prefix.**

1. **Frontend sends it** at [page.tsx:290](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/packages/web/app/chat/page.tsx#L290): `timezone: Intl.DateTimeFormat().resolvedOptions().timeZone`
2. **index.ts extracts it** at [index.ts:33](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/index.ts#L33)
3. **Orchestrator stores it** in `context.timezone` at [orchestrator_v3.ts:94](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/orchestrator_v3.ts#L94)
4. **ToolExecutor uses it internally** for `getTodayProgress()` at [tool-executor.ts:321](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/services/tool-executor.ts#L321)
5. **ReasoningAgent context prefix: ❌ Missing.** At [reasoning-agent.ts:183-213](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/reasoning-agent.ts#L183-L213), the prefix includes intent, pending action, day classification, and health constraints — but NOT timezone or current time.

So when the user asks "what timezone am I in?", the LLM genuinely doesn't know.

### Concrete Suspects
| File | Line(s) | Issue |
|---|---|---|
| [reasoning-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/reasoning-agent.ts#L183-L213) | 183-213 | Context prefix missing timezone and current time injection |

---

## 7. Issue 6: Health Constraint — Warn vs Refuse

### Symptom
User asks to log "two boiled eggs" → System refuses due to egg constraint. Expected: warning, not refusal.

### DB Evidence ✅

```sql
SELECT constraint_type, category, severity, notes FROM user_health_constraints
WHERE user_id = 'aa9fdbea-...' ORDER BY created_at DESC;
```

| constraint_type | category | severity | notes |
|---|---|---|---|
| intolerance | dairy | **warning** | no dairy |
| condition | high heart rate | **warning** | high heart rate |
| condition | colitis | **warning** | medical condition |
| condition | sodium | **warning** | watch sodium due to high heart rate |
| preference | soy | **warning** | avoid soy |
| preference | fiber | **warning** | limit fiber |
| preference | pepper | **warning** | avoid pepper |
| allergy | peanuts | **critical** | peanut allergy |

**Key findings:**
- **There is NO "eggs" constraint in the DB.** The user removed it (confirmed in chat messages: "remove the health constraint about eggs" → "Removed: eggs").
- The **colitis** constraint is stored with severity `warning`, NOT `critical`.
- All constraints except peanuts have `warning` severity.

### Chat Message Evidence ✅

From the `chat_messages` table, the "log two boiled eggs" response metadata shows:
```json
{
  "ask_nutrition_agent": {
    "food_name": "Large Egg",
    "health_flags": ["colitis"],
    ...
  }
}
```

The NutritionAgent returned `health_flags: ["colitis"]` — not because there's an egg constraint, but because **the NutritionAgent matched the user's `colitis` condition against eggs** (likely because eggs can irritate colitis). The `message_type` for that response was `"unknown"` (not `confirmation_food_log`), meaning:

**The ReasoningAgent saw the health flag and decided NOT to call `propose_food_log`.** Instead, it just replied conversationally: "I found a match for two boiled eggs. Does this look right?"

### Root Cause (Confirmed — two interacting issues)

**Issue A: ReasoningAgent prompt has a hard block rule** at [reasoning-agent.ts:128](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/reasoning-agent.ts#L128):
```
If 'ask_nutrition_agent' returns 'health_flags' containing 'CRITICAL', 
you **MUST NOT** call 'propose_food_log' for that item.
```

The flag returned was `["colitis"]`, not literally the word `"CRITICAL"`. But the LLM interpreted it as a critical-level flag and blocked logging. **The prompt conflates the `health_flags` array content with severity.** The `health_flags` array contains condition *names* (like "colitis", "dairy", "sodium"), not severity levels — but the prompt says "containing 'CRITICAL'".

**Issue B: The desired behavior should NEVER be to block logging.** Health constraints should always warn, never block. The user should always be able to log what they ate — the system is a tracker, not a gatekeeper.

**⚠️ HYPOTHESIS:** The NutritionAgent's health flag generation in [nutrition-agent.ts:426-434](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/nutrition-agent.ts#L426-L434) may be generating "colitis" flags from the ALLERGEN_KEYWORDS heuristic even though colitis isn't in that map. This may be happening in the LLM prompt instead (the LLM was given `healthConstraints: ["colitis"]` and autonomously flagged eggs as a colitis concern). This needs verification of the exact NutritionAgent LLM call.

### Fix Direction
**Health constraints should NEVER block logging. The prompt must be changed to: always warn, always allow logging.**

### Concrete Suspects
| File | Line(s) | Issue |
|---|---|---|
| [reasoning-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/reasoning-agent.ts#L128) | 128 | Prompt says "MUST NOT call propose_food_log" for health flags — should warn instead |
| [nutrition-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/nutrition-agent.ts#L508) | 508 | LLM prompt passes health constraints to NutritionAgent which autonomously generates flags |

---

## 8. Issue 7A: Backend Response Missing Confirmation Payload

### Symptom
User says "log one bigmac and one small fries" → Chat asks for confirmation → But UI modal does not appear.

### DB Evidence ✅ (CRITICAL FINDING)

From `chat_messages`, the exact backend response for "log one bigmac and one small fries" (repeated twice in the session):

**First attempt (11:13:48):**
```json
{
  "content": "Just a heads up, the Big Mac and small fries have high sodium levels...",
  "metadata": {
    "get_user_goals": {...},
    "get_today_progress": {...},
    "ask_nutrition_agent": [{ "food_name": "Big Mac", ... }, { "food_name": "Small Fries", ... }]
  },
  "message_type": "unknown"   ← ❌ NOT "confirmation_food_log"
}
```

**Second attempt (11:15:45):**
```json
{
  "content": "I found the nutritional details for your meal, but I need your confirmation...",
  "metadata": {
    "get_user_goals": {...},
    "get_today_progress": {...},
    "ask_nutrition_agent": [{ "food_name": "Big Mac", ... }, { "food_name": "Small Fries", ... }]
  },
  "message_type": "unknown"   ← ❌ NOT "confirmation_food_log"
}
```

**Why the modal doesn't render:**

The frontend checks ([ChatMessageList.tsx:141](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/packages/web/components/ChatMessageList.tsx#L141)):
```tsx
msg.message_type === 'confirmation_food_log' && msg.metadata.nutrition
```

Both conditions fail:
1. `message_type` is `"unknown"` — should be `"confirmation_food_log"`
2. `metadata` has raw tool outputs (`ask_nutrition_agent`, `get_user_goals`) — no `nutrition` key

### Root Cause (Confirmed)

**The ReasoningAgent did NOT call `propose_food_log`.** Both times, the IntentAgent timed out (seen in logs), causing a fallback to `complex_request` intent. The ReasoningAgent then:
1. Called `get_user_goals`, `get_today_progress`, `ask_nutrition_agent` ✅
2. Generated a conversational response about the nutrition ❌
3. **Did NOT call `propose_food_log`** — so no proposal was created

Without a proposal, the orchestrator:
- Never sets `response_type` to `'confirmation_food_log'`
- Never maps `data.nutrition`
- Stores `response_type: 'unknown'` as `message_type` in the DB

### Why the ReasoningAgent skipped `propose_food_log`

The fallback intent is `{ type: "complex_request", confidence: "low", ambiguity_reasons: ["fallback_from_timeout"] }`. The ReasoningAgent's prompt has strict rules about health flags blocking logging (Issue 6 above). The nutrition data contained `health_flags: ["dairy", "sodium", "soy"]` which likely triggered the LLM to warn instead of propose.

### Concrete Suspects
| File | Line(s) | Issue |
|---|---|---|
| [orchestrator_v3.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/orchestrator_v3.ts#L456-L464) | 456-464 | `response_type` only set to confirmation if `activeProposal` exists |
| [orchestrator_v3.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/orchestrator_v3.ts#L484-L487) | 484-487 | `data.nutrition` only populated when proposal exists |
| [reasoning-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/reasoning-agent.ts#L128) | 128 | Health flags block `propose_food_log` call |
| [intent-agent.ts](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/intent-agent.ts#L118) | 118 | Timeout fallback produces `complex_request` instead of food intent |

---

## 9. Issue 7B: "I Don't See Anything" Handled as Generic Turn

### Symptom
User said "i dont see anything" after the system allegedly asked for confirmation. No modal appeared.

### DB Evidence ✅

The message preceding "i dont see anything" was from the Big Mac attempt at 11:15:45:
```json
{
  "content": "I found the nutritional details for your meal, but I need your confirmation...",
  "message_type": "unknown"    ← no modal rendered
}
```

The user correctly reported they don't see anything — **because the backend response had `message_type: "unknown"`, the frontend never rendered a modal.**

Then when the user said "i dont see anything":
1. IntentAgent timed out again → fallback `complex_request`
2. ReasoningAgent treated it as a new query (not a follow-up about the missing modal)
3. ReasoningAgent called `get_user_goals`, `get_today_progress`, and `ask_nutrition_agent` for analysis
4. No useful action taken

### Root Cause (Confirmed)

This is a downstream consequence of Issue 7A. The user's "i dont see anything" is a complaint about the missing modal, but the system has no mechanism to:
1. Detect that the previous turn should have shown a modal but didn't
2. Retry the proposal flow
3. Re-display or re-send the confirmation payload

The IntentAgent classifies "i dont see anything" as a generic `complex_request` (or times out), not as feedback about a UI failure.

### Retrieval Instruction

To retrieve the exact backend response payload for the turn where the modal should have appeared, run:
```sql
SELECT role, content, metadata, message_type, created_at
FROM chat_messages
WHERE user_id = 'aa9fdbea-c0d9-4bb5-b2a8-5ea49386aac9'
  AND created_at BETWEEN '2026-02-23 11:15:00' AND '2026-02-23 11:16:00'
ORDER BY created_at;
```

---

## 10. Cross-Cutting: Agent Timeouts & Fallback

### Evidence from Logs

The logs show **repeated** IntentAgent timeouts:
```
[IntentAgent] Execution Error (Returning Fallback): Error: Request timed out.
    at OpenAI.makeRequest ...
```

This happens at [intent-agent.ts:118](file:///c:/Users/ianku/Desktop/cursor%20projects/Joshs%20Food%20App/supabase/functions/chat-handler/agents/intent-agent.ts#L118) and causes a cascade:

1. IntentAgent returns fallback: `{ intent: "complex_request", confidence: "low", ambiguity_reasons: ["fallback_from_timeout"] }`
2. Orchestrator: "Fallback to ReasoningAgent"
3. ReasoningAgent starts without proper intent classification → skips food-specific logic

### Impact (Confirmed by chat_messages DB evidence)
- **Intent misrouting**: `log_food` becomes `complex_request` → skips the `log_food` switch case
- **No proposal generated**: ReasoningAgent responds conversationally → no `propose_food_log` call
- **`message_type` stored as `"unknown"`**: Frontend can't render modal
- **Stale pending actions**: The `log_food` case clears old pending actions; the fallback path doesn't

---

## 11. High-Level Fix Plan

### Priority 1: Critical (Blocking core functionality)

#### Fix 7A+7B: IntentAgent timeout resilience + proposal robustness
- **Where:** `intent-agent.ts`, `orchestrator_v3.ts`
- **What:**
  1. Add retry logic (1 retry with shorter timeout) before falling back
  2. In fallback, if message contains food keywords ("log", "eat", "had"), set intent to `log_food` instead of `complex_request`
  3. In orchestrator, if `ambiguity_reasons` includes `"fallback_from_timeout"` AND message matches food intent, route to `log_food` path

#### Fix 6: Health constraints should WARN, never block
- **Where:** `reasoning-agent.ts` line 128
- **What:** Change the prompt rule from:
  > "MUST NOT call propose_food_log"
  
  To:
  > "ALWAYS call propose_food_log. Include health warnings in the response text. NEVER refuse to log food."
  
  Health flags should be informational only. The user decides whether to eat something.

### Priority 2: Important (Data accuracy)

#### Fix 1: List saved recipes tool
- **Where:** `tool-executor.ts`, `tools.ts`, `reasoning-agent.ts`
- **What:** Add `list_saved_recipes` tool — queries all recipes for user (no query required)

#### Fix 2: Memory auto-recall
- **Where:** `reasoning-agent.ts` lines 196-213
- **What:**
  1. Inject loaded memories into context prefix: `[Known Preferences: yogurt=chobani zero sugar 200ml, ...]`
  2. Add prompt directive: "When user says 'usual', 'my regular', etc., ALWAYS check injected preferences first"

#### Fix 3: Recipe log nutrient parity
- **Where:** `tool-executor.ts` lines 844-882, `orchestrator_v3.ts` lines 496-506
- **What:**
  1. Copy `standardNutrients` merge pattern from `proposeFoodLog` into `proposeRecipeLog`
  2. In orchestrator, spread all `p.data` fields into `response.data.nutrition` instead of hardcoding 5 fields

#### Fix 5: Timezone context injection
- **Where:** `reasoning-agent.ts` lines 196-213
- **What:** Add timezone + current local time to context prefix:
  ```typescript
  contextPrefix += ` [Timezone: ${context.timezone} | Local Time: ${new Date().toLocaleString('en-US', { timeZone: context.timezone })}]`;
  ```

### Priority 3: Enhancement (Data quality)

#### Fix 4: Hydration enforcement
- **Where:** `nutrition-agent.ts`
- **What:**
  1. Add post-processing: if food name matches liquid keywords (soup, stew, broth, juice) and `hydration_ml === 0`, apply deterministic estimate
  2. Strengthen LLM prompt emphasis for hydration on semi-liquid foods

---

## 12. Regression Prevention

### Data Contract Enforcement
1. **Add `validateProposal()` function** — after every `proposeFoodLog`/`proposeRecipeLog`, assert all standard nutrients present
2. **Add response_type assertion** — if proposal exists, `response_type` MUST be a confirmation type, not `"unknown"`

### Testing
1. **IntentAgent timeout test:** Mock OpenAI timeout → verify fallback still routes food logging correctly
2. **Memory round-trip test:** Store memory → new session → verify memory is in agent context
3. **Nutrient completeness test:** For recipe log proposals, assert 14+ standard nutrients present
4. **Health constraint test:** Set any constraint → log flagged food → verify warning shown AND `propose_food_log` called (never blocked)

### Monitoring
1. Log whenever IntentAgent falls back to timeout → alert if rate exceeds threshold
2. Track `message_type='unknown'` rate in `chat_messages` → should be near zero for food logging turns
3. Track `hydration_ml` fill rate across food logs containing liquid keywords
