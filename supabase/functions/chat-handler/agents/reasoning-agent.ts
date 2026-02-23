/**
 * ReasoningAgent
 * 
 * The intelligent orchestrator that uses OpenAI function calling to:
 * 1. Understand the user's intent (with help from IntentAgent classification)
 * 2. Call tools to gather data from specialized agents
 * 3. Reason across all gathered information
 * 4. Pass results to ChatAgent for final formatting
 * 
 * Flow: IntentAgent -> ReasoningAgent -> [Tools] -> ChatAgent
 */
import { createOpenAIClient } from '../../_shared/openai-client.ts';
import { toolDefinitions } from '../services/tools.ts';
import { ToolExecutor } from '../services/tool-executor.ts';
import { PipelineContext } from '../types.ts';
// Import Master Map for context injection
// Since we can't easily import from shared in Deno without configuring imports, 
// we'll define a compact version of the map keys here for the prompt.
// Ideally this comes from refined shared imports in production.
const MASTER_NUTRIENT_KEYS = [
  "Calories (kcal)", "Protein (g)", "Carbs (g)", "Total Fat (g)", "Water (ml)",
  "Saturated Fat (g)", "Sugar (g)", "Fiber (g)", "Sodium (mg)", "Cholesterol (mg)",
  "Potassium (mg)", "Vitamin A (mcg)", "Vitamin C (mg)", "Calcium (mg)", "Iron (mg)"
].join(", ");

const SYSTEM_PROMPT = `You are NutriPal's ReasoningAgent, the brain of an intelligent nutrition assistant.

**MISSION: Be the ultimate proactive nutrition coach.**
1. **Context First:** ALWAYS call 'get_user_goals' and 'get_today_progress' at the START of any query about "what should I eat", "can I have X", "how am I doing", or "what are my goals".
   - **Goal Recall:** If the user asks "What are my goals?", you MUST list ALL active goals returned by the tool, including **micronutrients (vitamins, minerals)** and **water intake**. Do not summarize or omit them unless the user specifically asks for "macros only".
   - **Day Context Awareness:** You have access to 'dayClassification' (e.g., travel, sick, social). Use this to adjust your reasoning (e.g., be less strict on sodium during travel), but **DO NOT offer unsolicited advice** based on it unless the user asks.
   - **Account/Context Questions:** If the user asks about their timezone, current time, or account info, and this data is available in the context prefix (e.g., [Timezone: ...]), answer the question directly. Do NOT deflect with "I'm a nutrition assistant". You are allowed to answer contextual queries.

   **GOAL MANAGEMENT & UPDATES (CRITICAL):**
   - **Context Injection:** The valid nutrients you can track are: \${MASTER_NUTRIENT_KEYS}.
   - **Smart Mapping:** You MUST map user terms to these technical keys. "Water" -> 'hydration_ml'. "Sugar" -> 'sugar_g'.
   - **Unit Conversion:** ALWAYS convert user units to the standard units shown above (e.g., '2 Liters' -> 2000 ml). Do NOT pass 'oz' or 'L' to tools.
   - **Reset Logic:** If the user implies a full reset (e.g., "Set my goals to X and Y"), you MUST:
     1. Call 'get_user_goals' to see what is currently set.
     2. Explicitly generate \`action: 'remove'\` for ANY existing goal that is NOT in the user's new list.
     3. Pay special attention to removing "phantom" or legacy keys (e.g. 'hydration', 'omega_3') if you see them.
   - **Clarification:** If the user asks for a nutrient NOT in the list above (e.g. "Selenium") and you cannot confidently map it, **DO NOT call the tool**. Ask for clarification first.

2. **Action Oriented (PCC Pattern):**
   - **EFFICIENCY**: Call multiple tools in PARALLEL whenever possible.
     - Example: Call 'get_user_goals', 'get_today_progress', and 'ask_nutrition_agent' in the SAME turn.
     - DO NOT wait for 'get_user_goals' before calling 'ask_nutrition_agent'.
     - DO NOT act like a chat bot that asks one question at a time. Be proactive.

   - If intent is LOGGING (log_food/log_recipe): Call 'propose_food_log' or 'propose_recipe_log'.
   - For recipes text: Call 'parse_recipe_text'.
   - **Crucial**: If the user is just ASKING (intent='query_nutrition' or 'compare'), provide the answer/comparison. Do NOT call 'propose_food_log' unless they specifically ask to log it.
   
   **SINGLE FOOD ITEM LOGGING WORKFLOW (MANDATORY):**
   When the user wants to log a food item, follow this EXACT sequence:
   1. Call 'get_user_goals', 'get_today_progress', AND 'ask_nutrition_agent' (lookup) ALL TOGETHER in the first turn.
   2. Review the nutrition data returned:
      - If 'is_missing_item' is TRUE:
        - STOP! Do NOT call propose_food_log.
        - Ask the user a clarification question (e.g., "Did you mix that with water, milk, or have it dry?").
        - Wait for their response.
      - If health_flags contain 'CRITICAL', WARN the user but don't block
      - If confidence is 'low', mention the uncertainty in your response
   3. Call 'propose_food_log' with the nutrition data
   4. NEVER skip steps. NEVER estimate nutrition yourself — always use ask_nutrition_agent.
   
   **CRITICAL: PROPOSING IS MANDATORY — NO EXCEPTIONS**\r
   When intent is log_food and is_missing_item is FALSE, you **MUST** call 'propose_food_log' for EVERY food item.\r
   - This applies even for low-calorie items (coffee, tea, water, gum, etc.)\r
   - This applies even when calories are close to 0\r
   - NEVER describe nutrition in text without also calling propose_food_log\r
   - If ask_nutrition_agent returned data, your NEXT tool call MUST be propose_food_log\r
   - Failing to call propose_food_log when data is available is a SYSTEM ERROR\r
   State: "I've prepared the log for [Food]. Please confirm."\r

   **HYPOTHETICAL / WHAT-IF QUERIES (CRITICAL):**
   If the user says "If I eat...", "What would happen if...", or the intent from the system is \`plan_scenario\`, you MUST NOT call \`propose_food_log\`.
   Instead:
   1. Call 'ask_nutrition_agent' to get the hypothetical data.
   2. REASON about the impact verbally in your response.
   3. NEVER propose logging a hypothetical scenario.

   **RECIPE WORKFLOWS:**
   - If user asks to see/list all their saved recipes, call 'list_saved_recipes' (no query needed)
   - If user asks to log a saved recipe by name, call 'ask_recipe_agent' with action 'find'
   - If user pastes recipe text, call 'parse_recipe_text' with the text
   - If multiple recipes found, list them and ask which one
   - If user asks to save a recipe, call 'parse_recipe_text' then propose saving
   - ALWAYS use the recipe name extracted from the text, never generate a type name

   **AMBIGUITY HANDLING:**
   If the intent metadata includes ambiguity_level 'high':
   - **Partial Logging:** If the user requested multiple items and some are CLEAR while others are AMBIGUOUS, you SHOULD call 'propose_food_log' for the clear items immediately.
   - **Clarification:** For the ambiguous items, ask 1-2 specific clarifying questions (size? type? preparation?) instead of trying to guess.
   - Example: "Log 2 eggs and 200ml water" -> Log the water immediately, but ask about egg size.
   
   3. **Smart Comparisons:** If asked "should I have A or B" or "why is X different from Y", use 'ask_nutrition_agent' (or your own knowledge) to explain. Do NOT auto-log the items being compared.
4. **Goal Management & Thresholds:**
   - If user wants to change nutrition goals, use 'bulk_update_user_goals' if setting multiple at once, or 'update_user_goal' for a single one.
   - You can specify thresholds: 'yellow_min' (e.g., 0.5), 'green_min' (e.g., 0.75), 'red_min' (e.g., 0.90).
   - For GOALS (like protein): Green is "completing the goal" (default >= 75%).
   - For LIMITS (like saturated fat, sodium, sugar): Green is "staying under the limit" (default < 60% or 75%), Red is "exceeding" (default > 90%).
5. **Profile & Health:**
   - If user mentions specific health conditions, allergies, or intolerances (e.g., "I have colitis", "no dairy"), use 'manage_health_constraints'.
   - Use 'update_user_profile' only for general dietary preferences (e.g. "vegetarian") or goals.
6. **Workout Adjustments:**
   - If user reports a workout (e.g., "I did 30 mins cardio"), call 'apply_daily_workout_offset' with a recommended calorie/macro bonus.
7. **Proactive Day Detection:**
   - If the user's behavior seems unusual (e.g., logging fast food at odd times, mentioning "airport", "sick", "party"), and there is NO existing 'dayClassification', you should suspect a special day.
   - **Workflow:** 
     1. Call 'ask_insight_agent' with action='classify_day' (or 'patterns') to see if it fits a known pattern.
     2. If suspicious, instruct the ChatAgent to ask the user: "You're eating differently today—is this a [travel/sick/social] day?"
   - **DO NOT** automatically set the day classification without user confirmation.
8. **Error Handling:** If a user is off-topic, be polite but redirect to nutrition and health.

**DELEGATION TOOLS (USE THESE FOR SPECIALIST TASKS):**
- **ask_nutrition_agent**: For nutrition lookups, estimates, and comparisons. Pass query_type and items array.
- **ask_recipe_agent**: For searching saved recipes, getting recipe details. Pass action and query/recipe_id.
- **ask_insight_agent**: For pattern analysis, audits, reflection, and classification. Pass action (audit/patterns/reflect/classify_day/summary).
- **store_memory**: To save a user preference, habit, or health constraint. Pass category (food/health/habit/preferences) and fact.
- **search_memory**: To retrieve stored memories. Pass query (keywords).


**TOOLS OVERVIEW:**
- Context: profile, goals, today_progress, weekly_summary, history, update_user_profile, manage_health_constraints
- Nutrition: **ask_nutrition_agent** (lookup, estimate, compare), validate, compare_foods
- Recipes: **ask_recipe_agent** (find, details), parse_recipe_text, calculate_recipe_serving
- Logging: propose_food_log, propose_recipe_log, apply_daily_workout_offset
- Goals: update_user_goal, bulk_update_user_goals, calculate_recommended_goals
- Insights: **ask_insight_agent** (audit, patterns, reflect, classify_day, summary), get_food_recommendations. Use 'audit' if user complains about data integrity, 'reflect' to find the 'one big lever' for tomorrow. Always 'classify_day' if user mentions travel, illness, or social events.
- Memory: **store_memory** (save preferences/habits), **search_memory** (recall info).

**CRITICAL RULES:**
1. **Health Safety (WARN, NEVER BLOCK)**: If 'ask_nutrition_agent' returns 'health_flags', you MUST still call 'propose_food_log' (or 'propose_recipe_log' for recipes). Include a clear warning in your response text (e.g., "⚠️ Note: This contains [Allergen], which may conflict with your [constraint]. Logging it anyway for accurate tracking."). The user is the final decision maker — NEVER refuse to log food. Always propose, always warn.
2. **Composite Item Logging**:
   - If a food is described with a mixer (e.g. "in water", "with milk"), do NOT create separate log entries. The NutritionAgent will capture hydration data in the single entry.
   - **Ingredient-list composites**: When the user describes a food by listing its ingredients after clarification (e.g., "bread + cheese + ham" = sandwich), create ONE log entry named after the composite item (e.g., "Ham & Cheese Sandwich"). Call 'ask_nutrition_agent' with all ingredients, then sum the nutrition and call 'propose_food_log' ONCE with a single composite food_name. NEVER split ingredient-described composites into separate log entries.
   - Only create separate entries for genuinely separate foods (e.g. "a coffee AND a glass of water") or if the user explicitly asks to split them.
3. **Recipe Logging (CRITICAL)**: When the intent is to LOG a saved recipe (not save a new one), you MUST use 'propose_recipe_log' (NOT 'propose_food_log'). Call 'ask_recipe_agent' with action 'find' to get the recipe, then call 'propose_recipe_log' with the recipe data. Health warnings go in your response text, but the proposal MUST still be generated.
4. **Ambiguity**: If the user provides a vague portion like "bowl" or "restaurant portion", trust the NutritionAgent's normalization, but if the calories look suspiciously low (e.g. <300kcal for a meal), verify before proposing.
5. **Strict Progress Readouts**: When a user asks about their progress, totals, or daily summary, you MUST output the EXACT numbers from 'get_today_progress'. DO NOT provide just generic coaching or fluffy summaries without the hard data.
6. **Anti-Hallucination (Medical)**: NEVER mention specific diseases or medical conditions (e.g. colitis, diabetes, heart disease) UNLESS they are explicitly listed in the user's health constraints profile. Use neutral biological terms (e.g., 'your fiber is low', 'your sodium is high') instead.
`;

export class ReasoningAgent {
  name = 'reasoning';
  openai = createOpenAIClient();

  async execute(input: any, context: PipelineContext) {
    const { message, intent, chatHistory = [] } = input;
    const { userId, supabase, timezone, sessionId } = context;

    console.log('[ReasoningAgent] Starting with message:', message);
    console.log('[ReasoningAgent] Intent:', intent);

    // Initialize tool executor
    const toolExecutor = new ToolExecutor({
      userId,
      supabase,
      timezone,
      sessionId,
      healthConstraints: context.healthConstraints,
      userGoals: context.userGoals, // Feature 4: Pass goals
      userProfile: context.userProfile, // Feature 4: Pass profile
      dayClassification: context.dayClassification, // Feature 9: Pass day context
      trackedNutrients: context.trackedNutrients // Feature 10: Pass tracked nutrients
    });

    // Build messages array
    const messages: any[] = [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      }
    ];

    // Add recent chat history for context (last 6 messages)
    const recentHistory = chatHistory.slice(-6);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content
      });
    }

    // Add intent context if available
    let userMessage = message;
    const pendingAction = context.session?.pending_action;
    let contextPrefix = '';

    if (intent) {
      contextPrefix += `[Intent: ${intent.type}${intent.entities?.length ? ` | Entities: ${intent.entities.join(', ')}` : ''}]`;
      if (intent.food_items?.length) {
        contextPrefix += ` [EXTRACTED ENTITIES: ${intent.food_items.join(', ')}]`;
        if (intent.portions?.length) {
          contextPrefix += ` [PORTIONS: ${intent.portions.join(', ')}]`;
        }
      }
      if (intent.ambiguity_level === 'high' || intent.ambiguity_level === 'medium') {
        contextPrefix += ` [AMBIGUITY: ${intent.ambiguity_level} — ${intent.ambiguity_reasons?.join('; ')}]`;
      }
    }

    if (pendingAction) {
      contextPrefix += ` [Pending Action: ${pendingAction.type} | Data: ${JSON.stringify(pendingAction.data)}]`;
    }

    // Feature 9: Day Classification Context
    if (context.dayClassification) {
      contextPrefix += ` [Day Type: ${context.dayClassification.day_type} | Notes: ${context.dayClassification.notes || 'None'}]`;
    }

    // CRITICAL FIX: Inject Health Constraints directly into context so LLM is aware
    if (context.healthConstraints && context.healthConstraints.length > 0) {
      const constraintsText = context.healthConstraints.map((c: any) => `${c.category} (${c.severity})`).join(', ');
      contextPrefix += ` [Active Health Constraints: ${constraintsText}]`;
    }

    // Fix 2: Inject loaded memories so the LLM can recall preferences without calling search_memory
    if (context.memories && context.memories.length > 0) {
      const memoryText = context.memories
        .slice(0, 10)
        .map((m: any) => `${m.category}: ${m.fact}`)
        .join('; ');
      contextPrefix += ` [Known Preferences: ${memoryText}]`;
    }

    // Fix 5: Inject timezone and current local time
    if (context.timezone) {
      try {
        const localTime = new Date().toLocaleString('en-US', { timeZone: context.timezone });
        contextPrefix += ` [Timezone: ${context.timezone} | Local Time: ${localTime}]`;
      } catch {
        contextPrefix += ` [Timezone: ${context.timezone}]`;
      }
    }

    if (contextPrefix) {
      userMessage = `${contextPrefix}\n\nUser: ${message}`;
    }

    messages.push({
      role: 'user',
      content: userMessage
    });

    // Track tools used and data gathered
    const toolsUsed: string[] = [];
    const gatheredData: Record<string, any> = {};

    // Call OpenAI with tools - UPGRADED TO GPT-4o
    let response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages as any,
      tools: toolDefinitions as any,
      tool_choice: 'auto',
      max_tokens: 1000
    });

    let assistantMessage = response.choices[0].message;

    // Process tool calls iteratively
    let iterations = 0;
    const maxIterations = 5; // Safety limit

    while (assistantMessage.tool_calls && iterations < maxIterations) {
      iterations++;
      console.log(`[ReasoningAgent] Processing ${assistantMessage.tool_calls.length} tool calls (iteration ${iterations})`);

      // Add assistant message with tool calls
      messages.push(assistantMessage as any);

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');

        console.log(`[ReasoningAgent] Calling tool: ${toolName}`, args);
        toolsUsed.push(toolName);

        try {
          const result = await toolExecutor.execute(toolName, args);

          // FIX: Don't overwrite if tool called multiple times (e.g. multiple food logs)
          if (gatheredData[toolName]) {
            if (Array.isArray(gatheredData[toolName])) {
              gatheredData[toolName].push(result);
            } else {
              gatheredData[toolName] = [gatheredData[toolName], result];
            }
          } else {
            gatheredData[toolName] = result;
          }

          console.log(`[ReasoningAgent] Tool ${toolName} result:`, JSON.stringify(result).slice(0, 200));

          // Add tool result
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          } as any);
        } catch (error) {
          console.error(`[ReasoningAgent] Tool ${toolName} error:`, error);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: true,
              message: (error as Error).message
            })
          } as any);
        }
      }

      // Get next response
      response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: messages as any,
        tools: toolDefinitions as any,
        tool_choice: 'auto',
        max_tokens: 1000
      });

      assistantMessage = response.choices[0].message;
    }

    // Extract final response
    const finalResponse = assistantMessage.content || '';
    console.log('[ReasoningAgent] Final response:', finalResponse.slice(0, 200));

    // Check for any proposals in gathered data
    let proposal = undefined;

    // Flatten results to handle arrays from multiple calls
    const allResults = Object.values(gatheredData).flat();

    // Collect specific proposals
    const foodLogProposals: any[] = [];

    for (const result of allResults) {
      if (result?.proposal_type && result?.pending) {
        if (result.proposal_type === 'food_log') {
          foodLogProposals.push(result);
        } else {
          // For other types, just take the first one found (usually only one goal update/recipe log at a time)
          const proposalData = result.data || {};
          if (result.flowState && !proposalData.flowState) {
            proposalData.flowState = result.flowState;
          }
          proposal = {
            type: result.proposal_type,
            id: result.proposal_id || result.id || `prop_${Date.now()}`,
            data: proposalData
          };
          // If we found a non-food proposal, we favor that (rare to mix types)
          // But strict logic: prioritize food logs if present?
        }
      }
    }

    // Handle Food Log Batching
    if (foodLogProposals.length > 0) {
      if (foodLogProposals.length === 1) {
        // Single item - standard behavior
        proposal = {
          type: 'food_log',
          id: foodLogProposals[0].proposal_id,
          data: foodLogProposals[0].data
        };
      } else {
        // Multiple items - bundle them!
        // Orchestrator needs to handle this by accepting an array in data.
        proposal = {
          type: 'food_log',
          id: `batch_${Date.now()}`,
          data: foodLogProposals.map(p => p.data) // Array of food data objects
        };
      }
    }

    return {
      reasoning: finalResponse,
      toolsUsed,
      data: gatheredData,
      response: finalResponse,
      proposal
    };
  }
}
