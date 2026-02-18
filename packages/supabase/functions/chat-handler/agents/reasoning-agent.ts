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
 */ import { createOpenAIClient } from '../../_shared/openai-client.ts';
import { toolDefinitions } from '../services/tools.ts';
import { ToolExecutor } from '../services/tool-executor.ts';
const SYSTEM_PROMPT = `You are NutriPal's ReasoningAgent, the brain of an intelligent nutrition assistant.

**MISSION: Be the ultimate proactive nutrition coach.**
1. **Context First:** ALWAYS call 'get_user_goals' and 'get_today_progress' at the START of any query about "what should I eat", "can I have X", or "how am I doing". You cannot give good advice without knowing the user's current status and targets.
2. **Action Oriented (PCC Pattern):**
   - For single items: Call 'propose_food_log'.
   - For recipes: Call 'parse_recipe_text'.
   - For saved recipes: Call 'propose_recipe_log'.
   - NEVER just tell the user nutritional info without offering to log it via a tool.
3. **Smart Comparisons:** If asked "should I have A or B", call 'compare_foods' or 'lookup_nutrition' for both, then use goals/progress to recommend the better fit.
4. **Goal Management & Thresholds:**
   - If user wants to change goal status colors (e.g., "Make fiber green at 90%"), use 'update_user_goal' with 'green_min=0.9'.
   - Default thresholds: yellow (0.5), green (0.75) for goals; green (0.75), yellow (0.9), red (1.0) for limits.
   - If user wants to stop tracking a nutrient, call 'delete_user_goal'.
5. **Workout Adjustments:**
   - If user reports a workout (e.g., "I did 30 mins cardio"), call 'apply_daily_workout_offset' with a recommended calorie/macro bonus.
6. **Error Handling:** If a user is off-topic, be polite but redirect to nutrition and health.

**TOOLS OVERVIEW:**
- Context: profile, goals, today_progress, weekly_summary, history
- Nutrition: lookup, estimate, validate, compare
- Recipes: search_saved, details, parse_recipe_text, calculate_recipe_serving
- Logging: propose_food_log, propose_recipe_log, apply_daily_workout_offset
- Goals: update_user_goal, calculate_recommended_goals
- Insights: get_food_recommendations, analyze_eating_patterns, get_progress_report`;
export class ReasoningAgent {
  name = 'reasoning';
  openai = createOpenAIClient();
  async execute(input, context) {
    const { message, intent, chatHistory = [] } = input;
    const { userId, supabase, timezone, sessionId } = context;
    console.log('[ReasoningAgent] Starting with message:', message);
    console.log('[ReasoningAgent] Intent:', intent);
    // Initialize tool executor
    const toolExecutor = new ToolExecutor({
      userId,
      supabase,
      timezone,
      sessionId
    });
    // Build messages array
    const messages = [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      }
    ];
    // Add recent chat history for context (last 6 messages)
    const recentHistory = chatHistory.slice(-6);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }
    // Add intent context if available
    let userMessage = message;
    const pendingAction = context.session?.pending_action;
    let contextPrefix = '';
    if (intent) {
      contextPrefix += `[Intent: ${intent.type}${intent.entities?.length ? ` | Entities: ${intent.entities.join(', ')}` : ''}]`;
    }
    if (pendingAction) {
      contextPrefix += ` [Pending Action: ${pendingAction.type} | Data: ${JSON.stringify(pendingAction.data)}]`;
    }
    if (contextPrefix) {
      userMessage = `${contextPrefix}\n\nUser: ${message}`;
    }
    messages.push({
      role: 'user',
      content: userMessage
    });
    // Track tools used and data gathered
    const toolsUsed = [];
    const gatheredData = {};
    // Call OpenAI with tools - UPGRADED TO GPT-4o
    let response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools: toolDefinitions,
      tool_choice: 'auto',
      max_tokens: 1000
    });
    let assistantMessage = response.choices[0].message;
    // Process tool calls iteratively
    let iterations = 0;
    const maxIterations = 5 // Safety limit
      ;
    while (assistantMessage.tool_calls && iterations < maxIterations) {
      iterations++;
      console.log(`[ReasoningAgent] Processing ${assistantMessage.tool_calls.length} tool calls (iteration ${iterations})`);
      // Add assistant message with tool calls
      messages.push(assistantMessage);
      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        console.log(`[ReasoningAgent] Calling tool: ${toolName}`, args);
        toolsUsed.push(toolName);
        try {
          const result = await toolExecutor.execute(toolName, args);
          gatheredData[toolName] = result;
          console.log(`[ReasoningAgent] Tool ${toolName} result:`, JSON.stringify(result).slice(0, 200));
          // Add tool result
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        } catch (error) {
          console.error(`[ReasoningAgent] Tool ${toolName} error:`, error);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: true,
              message: error.message
            })
          });
        }
      }
      // Get next response
      response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        tools: toolDefinitions,
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
    for (const [_toolName, result] of Object.entries(gatheredData)) {
      if (result?.proposal_type && result?.pending) {
        // Preserve flowState if present at root or in data
        const proposalData = result.data || {};
        if (result.flowState && !proposalData.flowState) {
          proposalData.flowState = result.flowState;
        }
        proposal = {
          type: result.proposal_type,
          id: result.proposal_id || result.id || `prop_${Date.now()}`,
          data: proposalData
        };
        break;
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
