# Post Test Issue Fix Plan

## Issue 1: Persistence failure
**Statement of Issue:**
When the system tries to log execution in the database, it throws a Postgres type error: `invalid input syntax for type uuid: "Europe/Zagreb"`. This indicates that a timezone string is being inserted into a UUID column (likely `session_id` or `parent_id`).

**Root Cause:**
In `supabase/functions/chat-handler/index.ts`, the destructured body is: `const { message, session_id, timezone } = body;`. The orchestrator function signature is `orchestrateV3(userId, message, sessionId, chatHistory, timezone)`. In `orchestrator_v3.ts`, `persistence.logExecution(userId, sessionId, 'reasoning', agentsInvolved, startTime, response, message, undefined)` is called. If the frontend payload omits `session_id`, or if the variables get mismatched on the client, the error occurs.

**Fix Plan:**
1. Check the frontend API call to the `chat-handler` edge function to ensure it explicitly passes a valid UUID for `session_id` and correctly places `timezone`.
2. In `chat-handler/index.ts`, add fallback validation for `session_id` so that if it's missing or a timezone string, it generates a new UUID or explicitly sets it to null so it doesn't crash the database insert.

## Issue 2: Wrong intent classification
**Statement of Issue:**
Queries like "why is my calories so high today" are classified as `off_topic` by the `IntentAgent`, falling back to `complex_request` or generic reasoning.

**Root Cause:**
In `intent-agent.ts`, the `SYSTEM_PROMPT` defines `audit` ("check my numbers", "audit my day") and `reflect` ("compare today vs baseline", "big lever"). However, it lacks clear examples for "why" questions about specific metrics (e.g., "why is my X so high", "why is protein low"). Because it doesn't match standard patterns, the fast LLM (`gpt-4o-mini`) guesses `off_topic`.

**Fix Plan:**
1. Update `SYSTEM_PROMPT` in `intent-agent.ts`.
2. Add explicit examples to the `audit` or `reflect` intent descriptions: "why is my calories so high", "why did I go over my fat limit", "explain my numbers".

## Issue 3: Backend "today" numbers differ from UI screenshot (Double Counting)
**Statement of Issue:**
`get_today_progress` returned 2510 calories, but the UI showed 1255 calories (exactly half).

**Root Cause:**
In `tool-executor.ts`, inside `getTodayProgress`, there is a loop iterating over logs:
```typescript
totals.calories += log.calories || 0;
// ...
Object.keys(map).forEach(key => {
    // ...
    totals[key] += (log as any)[key] || 0;
});
```
Since `MASTER_NUTRIENT_MAP` now includes `calories: { name: "Calories", unit: "kcal" }`, the nested `forEach(key)` adds the local log's calories to `totals['calories']` AGAIN. The calories are literally double-counted in the backend's response to the agent.

**Fix Plan:**
1. In `tool-executor.ts` -> `getTodayProgress()`, remove the explicit `totals.calories += log.calories || 0;` line.
2. Rely strictly on the generic `Object.keys(map).forEach(key => ...)` loop, mapping `calories` just like any other nutrient.

## Issue 4: Goals mismatch vs what user set
**Statement of Issue:**
The AI assistant references a 1600 calorie goal and 132g protein, but the user explicitly set 2400 cal / 180g protein. The DB retrieval seems to get the wrong data.

**Root Cause:**
In `db-service.ts`, `updateUserGoal` inserts goals directly into the `user_goals` table without normalizing the nutrient key. `const { error } = await this.supabase.from('user_goals').upsert({ user_id: userId, nutrient: nutrient, ... })`. Conversely, `getUserGoals` normalizes the keys retrieved from the DB. This means if a user sets "Calories (kcal)", it saves as "Calories (kcal)". Later, default "calories" might still exist, causing retrieval mismatches.

**Fix Plan:**
1. In `db-service.ts` (`updateUserGoal` and `updateUserGoals` bulk update), apply `normalizeNutrientKey(nutrient)` BEFORE upserting to the database.
2. Ensure that any goal updates replace the standardized key (e.g., "calories", "protein_g") to maintain a single source of truth.

## Issue 5: What-if question routed into log-food flow
**Statement of Issue:**
Hypothetical questions ("if i eat bigmac, will i go over my fat limit") are triggering the `propose_food_log` tool instead of just estimating and chatting.

**Root Cause:**
The `ReasoningAgent` system prompt says: "If the user says 'If I eat...' or 'What would happen if...', do NOT call propose_food_log." However, it might still do so if the IntentAgent classifies it as `query_nutrition` and the ReasoningAgent's prompt isn't strong enough. Also, IntentAgent has a `plan_scenario` intent but might not be reliably triggering it.

**Fix Plan:**
1. In `intent-agent.ts`, strengthen `plan_scenario` instructions to strictly capture hypothetical questions ("if I eat X", "would I go over").
2. In `orchestrator_v3.ts`, ensure `plan_scenario` routes to the ReasoningAgent.
3. In `reasoning-agent.ts`, add a hard rule: if intent is `plan_scenario`, completely ABORT any call to `propose_food_log`.

## Issue 6: Confidence defaults to High when undefined
**Statement of Issue:**
`propose_food_log` acts with `confidence: undefined`, but the UI renders "High Confidence" by default.

**Root Cause:**
In `packages/web/components/chat/FoodLogConfirmation.tsx`, the logic is:
```typescript
{(!mainItem?.confidence || mainItem.confidence === 'high') && (
    <span className="... bg-emerald-100 ...">High Confidence</span>
)}
```
When `confidence` is stripped by the AI or undefined, it defaults to High, which implies unwarranted certainty.

**Fix Plan:**
1. In `FoodLogConfirmation.tsx`, default it to 'Medium Confidence - AI Estimate' or 'Estimated' if undefined, reserving High only for exact matches.
2. In `tool-executor.ts`, explicitly set `confidence = 'medium'` as the default in `proposeFoodLog` and `estimateNutrition` if not explicitly defined as 'high'.

## Issue 7: Hydration always 0
**Statement of Issue:**
Hydration always parses and saves as 0 ml.

**Root Cause:**
1. `hydration_ml` is not consistently added to `trackedNutrients` unless explicitly set as a goal.
2. In `estimateNutrition` inside `tool-executor.ts`, the `baseKeys` are hardcoded to `['calories', 'protein_g', 'carbs_g', 'fat_total_g']`. If `hydration_ml` isn't in `baseKeys` and isn't actively tracked, the explicit estimate is ignored or defaulted to 0.

**Fix Plan:**
1. In `tool-executor.ts`, add `hydration_ml` to the `baseKeys` array in both `lookupNutrition` and `estimateNutrition` so that water content is always requested from the LLM and retained.
2. Include instructions in the LLM prompt to actively estimate water content for beverages.

## Issue 8: Dashboard progress bar still empty after logging
**Statement of Issue:**
Backend `get_today_progress` successfully returns nonzero values, however, the UI dashboard progress bar renders 0% empty.

**Root Cause:**
`DashboardSummaryTable.tsx` has mangled Tailwind class names inside template literals (e.g., `h - full`, `transition - colors`, `w - full`) due to a bad string literal formatting. This breaks the CSS rendering of the progress bar width and colors, causing it to appear empty even when `barWidth` calculates correctly.

**Fix Plan:**
1. In `packages/web/components/DashboardSummaryTable.tsx`, remove all erroneous spaces from the Tailwind class strings (e.g., change `h - full` to `h-full`).

## Issue 9: Memory storing says "remembered" but search_memory returns nothing
**Statement of Issue:**
When explicitly asking to remember an item (like "Chobani zero sugar yogurt"), the system stores it. However, later queries like "log my usual yogurt" fail to recall it because `search_memory` returns no matches.

**Root Cause:**
`searchMemory` in `tool-executor.ts` currently uses strict `.includes()` matching on the complete query string against the memory fact. If the user searches "yogurt usual", it fails to match a fact saying "Chobani zero sugar yogurt".

**Fix Plan:**
1. Modify `searchMemory` in `tool-executor.ts` to tokenize the search query into separate words.
2. Implement a scoring system that checks if each word exists in the stored facts, allowing partial keyword matching across the memory index to ensure multi-query recall works effectively.

## Issue 10: The bot refuses timezone questions, gives fluffy progress, and hallucinates medical conditions
**Statement of Issue:**
The bot marks timezone questions as off-topic, responds with generic coaching instead of hard numbers for daily progress questions, and hallucinates medical conditions like "colitis" when generating warnings.

**Root Cause:**
1. `intent-agent.ts` lacks an intent category for generic metadata/account settings.
2. `reasoning-agent.ts` lacks a strict mandate to output numerical data when asked for progress.
3. Both `chat-agent.ts` and `reasoning-agent.ts` lack strict anti-hallucination guardrails preventing the LLM from inventing or assuming medical conditions.

**Fix Plan:**
1. In `intent-agent.ts`, add `account_settings` to the intent list and map metadata/timezone questions there.
2. In `reasoning-agent.ts`, add a hard rule requiring the output of EXACT numbers from `get_today_progress` when a user asks about their progress.
3. In both `reasoning-agent.ts` and `chat-agent.ts`, add critical rules explicitly forbidding the mention of specific diseases or medical conditions unless they are confirmed in the user's structured health constraints profile, enforcing neutral biological terminology instead.

## Issue 11: "log_food intent but NO active proposal generated"
**Statement of Issue:**
The orchestrator logs a warning when the intent is `log_food` but no active logging proposal is generated, causing the system to silently fail or proceed without notifying the user that the log failed.

**Root Cause:**
When ambiguity is high and the `ReasoningAgent` decides to ask a clarifying question rather than immediately logging, it doesn't prepare a proposal. However, the `ChatAgent` is not explicitly instructed on how to handle a `log_food` intent when the `proposal` object is missing, leading to silent or confusing responses.

**Fix Plan:**
1. In `chat-agent.ts`, add an explicit instruction directing the agent to acknowledge that it needs more information (clarification) and CANNOT log the item yet whenever `intent` is `log_food` but the `proposal` data is missing.
