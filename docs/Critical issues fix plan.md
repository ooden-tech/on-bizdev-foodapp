# Critical Issues Fix Plan

## 1. Persistence Failure ("Amnesia" Bug)
**Severity:** Critical (Safety)
**Root Cause:** The `ReasoningAgent` receives `healthConstraints` in its `context` object, but it **never injects them** into the prompt context sent to the LLM. The `SYSTEM_PROMPT` is static. Thus, the LLM has no knowledge of the user's allergies unless it explicitly calls `get_health_constraints` (which it minimizes for efficiency) or `ask_nutrition_agent` (which only returns flags, not the list).
**Solution:**
Inject `healthConstraints` directly into the `contextPrefix` string constructed in `ReasoningAgent.execute()`.
```javascript
// reasoning-agent.ts logic update
if (context.healthConstraints && context.healthConstraints.length > 0) {
  contextPrefix += ` [Health: ${context.healthConstraints.map(c => c.category + '(' + c.severity + ')').join(', ')}]`;
}
```

## 2. Invisible Modal (UX Failure)
**Severity:** Critical (Blocker)
**Root Cause:** The `ReasoningAgent` likely hallucinates a "Ready to log" response without actually executing the `propose_food_log` tool, OR the `ToolExecutor` fails silently/returns a format the Orchestrator doesn't map to `activeProposal`.
**Solution:**
1.  **Prompt HArdware:** Strengthen `SYSTEM_PROMPT` in `ReasoningAgent` to explicitly demand the tool call for *any* logging intent.
2.  **Orchestrator Safeguard:** Add a check in `OrchestratorV3`: If `ReasoningAgent` output implies "logging" (regex check for "ready to log", "prepared", "confirm") but `activeProposal` is null, force a "fallback" or error state, or re-prompt the agent.
3.  **Frontend Alignment:** Ensure `Batch` ID handling (if any) is robust. (Frontend code looks fine, it checks `message_type`).

## 3. Nutrition Context (Eggs/Whey)
**Severity:** Medium
**Root Cause:** Over-aggressive normalization in `NutritionAgent` (collapsing quantities).
**Solution:**
Refine `NutritionAgent.analyzeNutrition` prompt to explicitly instruct: "Preserve the user's specific quantity/portion in the `serving_size` field if it differs from the standard database serving."

## Execution Order
1.  **Fix Persistence**: Modify `ReasoningAgent.ts`. verify with a test case.
2.  **Fix Modal**: Add logging to `Orchestrator` and strengthen `ReasoningAgent` prompt.
3.  **Run Manual Verification**: Re-run the specific failed test cases (4, 6, 12).
