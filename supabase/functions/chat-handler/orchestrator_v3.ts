/**
 * Orchestrator V3 - Hybrid Multi-Agent Architecture
 * 
 * Flow: User Message → IntentAgent → ReasoningAgent → ChatAgent → Response
 * 
 * Key differences from V2:
 * - IntentAgent still classifies intent (fast, cheap gpt-4o-mini)
 * - ReasoningAgent replaces PlannerAgent + IntentRouter
 * - ReasoningAgent uses tools that wrap specialized agents
 * - ChatAgent still handles final response formatting
 * - PCC pattern preserved via proposal tools
 */ import { IntentAgent } from './agents/intent-agent.ts';
import { ChatAgent } from './agents/chat-agent.ts';
import { ReasoningAgent } from './agents/reasoning-agent.ts';
import { RecipeAgent } from './agents/recipe-agent.ts';
import { InsightAgent } from './agents/insight-agent.ts';
import { scaleNutrition } from './agents/nutrition-agent.ts';
import { normalizeNutrientKey, MASTER_NUTRIENT_MAP } from '../_shared/nutrient-validation.ts';
import { createAdminClient } from '../_shared/supabase-client.ts';
import { DbService } from './services/db-service.ts';
import { PersistenceService } from './services/persistence-service.ts';
import { SessionService } from './services/session-service.ts';
import { ToolExecutor } from './services/tool-executor.ts';
import { PipelineContext } from './types.ts';
class ThoughtLogger {
  steps: string[] = [];
  log(step: string) {
    console.log(`[ThoughtLogger] ${step}`);
    this.steps.push(step);
  }
  getSteps() {
    return this.steps;
  }
}
/**
 * Helper to decorate user message with explicit context for the AI
 * This prevents the AI from "missing" details buried in JSON blobs
 */
function decorateWithContext(message: string, pendingAction: any): string {
  if (!pendingAction) return message;

  let decoration = '';
  if (pendingAction.type === 'recipe_selection' && pendingAction.data?.recipes) {
    decoration = `[CONTEXT: Choice pending for "${pendingAction.data.query}". Options:\n` +
      pendingAction.data.recipes.map((r: any, i: number) =>
        `${i + 1}. ${r.recipe_name}: ${r.ingredients || 'Details unknown'}`
      ).join('\n') + ']';
  } else if (pendingAction.type === 'recipe_save' && pendingAction.data?.flowState?.parsed) {
    const p = pendingAction.data.flowState.parsed;
    const ingredients = p.ingredients?.map((i: any) => `${i.quantity} ${i.unit} ${i.name}`).join(', ');
    decoration = `[CONTEXT: Preparing to save recipe "${p.recipe_name}". Ingredients: ${ingredients || 'Unknown'}]`;
  }

  return decoration ? `${decoration}\n\n${message}` : message;
}
/**
 * Main Orchestrator V3 for the Chat Handler.
 * Uses hybrid multi-agent architecture:
 * - IntentAgent: Fast classification (gpt-4o-mini)
 * - ReasoningAgent: Tool orchestration and reasoning (gpt-4o)
 * - ChatAgent: Response formatting with personality (gpt-4o-mini)
 */ export async function orchestrateV3(userId: string, message: string, sessionId: string, chatHistory: any[] = [], timezone: string = 'UTC', onStep?: (step: string) => void) {
  const supabase = createAdminClient();
  const db = new DbService(supabase);
  const persistence = new PersistenceService(supabase);
  const sessionService = new SessionService(supabase);
  // Load session state
  const session = await sessionService.getSession(userId, sessionId);

  // Feature 6: Fetch Learned Context & Health Constraints
  const healthConstraints = await db.getHealthConstraints(userId);
  // We fetch commonly used memory categories by default
  const memories = await db.getMemories(userId, ['food', 'preferences', 'habits', 'health']);

  // Feature 9: Day Classification
  // Get today's classification based on user's timezone
  const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const dayClassification = await db.getDayClassification(userId, todayDate);

  // Feature 10: Tracked Nutrients from Goals
  // Feature 10: Tracked Nutrients from Goals
  const userGoals = await db.getUserGoals(userId);
  const trackedNutrients = userGoals
    ?.map((g: any) => normalizeNutrientKey(g.nutrient))
    .filter((k: string) => MASTER_NUTRIENT_MAP[k]) || [];

  // Feature 4: Unified Pipeline Context
  const userProfile = (await db.getUserProfile(userId))?.data;

  const context: PipelineContext = {
    userId,
    sessionId,
    supabase,
    timezone,
    session,
    healthConstraints,
    memories,
    dayClassification, // { day_type: 'travel' | 'sick' | ..., notes: ... }
    trackedNutrients,
    userGoals,
    userProfile,
    db // Inject DB service for agents to use if needed
  };
  const startTime = Date.now();
  const thoughts = new ThoughtLogger();
  const reportStep = (step: string) => {
    thoughts.log(step);
    if (onStep) onStep(step);
  };
  const agentsInvolved = [];
  let response: any = {
    status: 'success',
    message: '',
    response_type: 'unknown',
    steps: [] as string[]
  };
  try {
    // =========================================================
    // STEP 0: Context Merging (Ambiguity Handling)
    // =========================================================
    // Check if we are returning from a clarification
    // FIX: Use the session already loaded at startup instead of a separate DB query.
    // getClarificationContext uses .maybeSingle() which silently fails when multiple
    // session rows exist for the same user, causing clarification context to be lost.
    const pendingClarification = session?.buffer?.pending_clarification || null;
    let augmentedMessage = message;

    if (pendingClarification) {
      console.log('[OrchestratorV3] Found pending clarification context. Merging...');
      // Prepend context to the current message
      augmentedMessage = `[Context: User said '${pendingClarification.original_message}'. System asked to clarify '${pendingClarification.ambiguity_reasons?.join(', ')}'] ${message}`;
      console.log('[OrchestratorV3] Augmented Message:', augmentedMessage);

      // Clear the context so we don't get stuck in a loop
      await sessionService.clearClarificationContext(userId);
    }

    // Deep Context Decoration (e.g. for Recipes)
    augmentedMessage = decorateWithContext(augmentedMessage, session.pending_action);

    const lowerMessage = message.trim().toLowerCase();
    // =========================================================
    // STEP 0: Static Fast-Paths (Synchronous)
    // =========================================================
    // 0.1 Quick Thanks/Closing
    const thanksKeywords = [
      'thanks',
      'thank you',
      'thx',
      'cheers',
      'awesome',
      'great'
    ];
    if (thanksKeywords.includes(lowerMessage) && lowerMessage.length < 15) {
      console.log('[OrchestratorV3] Static fast-path: thanks');
      return {
        status: 'success',
        message: "You're very welcome! Let me know if there's anything else I can help with. 😊",
        response_type: 'chat_response',
        steps: [
          'Closing recognized'
        ]
      };
    }
    // 0.2 Quick Confirmation Buttons (from UI)
    // If message starts with "Confirm " or is exactly "Log it", "Save it", etc.
    const looksLikeNewLog = lowerMessage.startsWith('log ') || lowerMessage.startsWith('track ') || lowerMessage.startsWith('save ') || lowerMessage.startsWith('add ');

    // STRICTER Fast-Path: Only accept exact short phrases or button payloads.
    // This prevents "Yes, but add sugar" from being caught as a simple "Yes" confirmation.
    const fastPathPhrases = new Set([
      'yes', 'yeah', 'yep', 'correct', 'confirm', 'log it', 'save it',
      'save', 'record it', 'track it', 'looks good', 'ok', 'okay', 'right', 'sure',
      'yes log', 'yes save', 'confirm save'
    ]);

    // Clean punctuation for matching "Yes." or "Yes!"
    const cleanMessage = lowerMessage.replace(/[.!]/g, '');
    const isExactMatch = fastPathPhrases.has(cleanMessage);

    // Check for button interactions (which often contain hidden payloads like "name:..." or "portion:...")
    const isButtonPayload = lowerMessage.includes('portion:') || lowerMessage.includes('name:');

    // Also allow "Confirm [action]" if it's very short (e.g. "Confirm that"), but reject long sentences.
    const isShortConfirm = lowerMessage.startsWith('confirm') && lowerMessage.length < 30;

    const isButtonConfirm = !looksLikeNewLog && (isExactMatch || isButtonPayload || isShortConfirm);

    if (isButtonConfirm && session.pending_action) {
      console.log(`[OrchestratorV3] Static fast-path: button confirm (Action: ${session.pending_action.type})`);
      reportStep('Processing your confirmation...');
      // Extract choice and portion if present (e.g. "Confirm log portion:1.5 servings")
      const portionMatch = message.match(/portion:([\w\s.]+)/i);
      const choiceMatch = message.match(/Confirm\s+(\w+)/i);
      const nameMatch = message.match(/name:([\w\s.!@#$%^&*()-]+)/i);
      if (choiceMatch) {
        session.pending_action.data.choice = choiceMatch[1].toLowerCase();
      }
      if (portionMatch) {
        session.pending_action.data.portion = portionMatch[1].trim();
      }
      if (nameMatch) {
        session.pending_action.data.customName = nameMatch[1].trim();
        console.log(`[OrchestratorV3] Extracted custom name: "${session.pending_action.data.customName}"`);
      }
      const confirmResult: any = await handlePendingConfirmation(session.pending_action, userId, sessionService, db, context, message);
      confirmResult.steps = thoughts.getSteps();
      return confirmResult;
    }
    const isButtonCancel = [
      'cancel',
      'stop',
      'no, cancel',
      'decline',
      'no',
      'forget it'
    ].includes(lowerMessage) || lowerMessage.startsWith('cancel');
    if (isButtonCancel && session.pending_action) {
      console.log('[OrchestratorV3] Static fast-path: button cancel');
      await sessionService.clearPendingAction(userId);
      return {
        status: 'success',
        message: 'Action cancelled. ❌',
        response_type: 'action_cancelled',
        steps: [
          'Cancellation recognized'
        ]
      };
    }
    // =========================================================
    // STEP 1: Recipe Heuristic (REMOVED - Handled by ReasoningAgent)
    // =========================================================
    // Fast path for recipes removed to use ReasoningAgent intelligence
    // =========================================================
    // STEP 2: IntentAgent - Classification (The Router)
    // =========================================================
    reportStep('Analyzing intent...');
    const intentAgent = new IntentAgent();
    const intentResult = await intentAgent.execute({
      message: augmentedMessage.length > 2000 ? augmentedMessage.substring(0, 2000) + "... [Truncated]" : augmentedMessage,
      history: chatHistory
    }, context);
    agentsInvolved.push('intent');
    console.log('[OrchestratorV3] Intent:', intentResult.intent, `(Confidence: ${intentResult.confidence || 'N/A'})`);

    // =========================================================
    // STEP 2.5: Ambiguity Check
    // =========================================================
    // After one clarification, NEVER clarify again. Proceed with low confidence instead.
    // This prevents interrogating the user. If they gave us more info and it's still ambiguous,
    // just do our best estimate and propose with low confidence.
    if (intentResult.ambiguity_level === 'high' && augmentedMessage !== message) {
      console.log('[OrchestratorV3] Post-clarification still HIGH ambiguity. Proceeding with low confidence instead of re-asking.');
      intentResult.ambiguity_level = 'medium';
      intentResult.confidence = 'low';
    }

    // Only trigger clarification ONCE (first time, no prior clarification context)
    if (intentResult.ambiguity_level === 'high' && augmentedMessage === message) {
      console.log('[OrchestratorV3] High ambiguity detected. Triggering clarification flow.');
      reportStep('Asking for clarification...');

      // Store context for next turn
      await sessionService.setClarificationContext(userId, {
        original_message: message, // Store original user message
        ambiguity_reasons: intentResult.ambiguity_reasons,
        partial_intent: intentResult
      });

      // Ask ChatAgent to generate a clarification question
      const chatAgent = new ChatAgent();
      const clarificationMessage = await chatAgent.execute({
        userMessage: message,
        intent: 'clarify_ambiguity',
        data: {
          ambiguity_reasons: intentResult.ambiguity_reasons,
          partial_data: intentResult
        },
        history: chatHistory
      }, context);

      return {
        status: 'success',
        message: clarificationMessage,
        response_type: 'clarification_request',
        steps: thoughts.getSteps()
      };
    }
    // =========================================================
    // STEP 3: Intent Switchboard (The Hub)
    // =========================================================
    const toolExecutor = new ToolExecutor({
      userId,
      supabase,
      timezone,
      sessionId,
      healthConstraints: context.healthConstraints
    });
    const intent = intentResult.intent;
    switch (intent) {
      case 'greet':
        console.log('[OrchestratorV3] Branch: greet');
        reportStep('Saying hello!');
        const chatAgentGreet = new ChatAgent();
        response.message = await chatAgentGreet.execute({
          userMessage: message,
          intent: 'greet',
          data: {
            reasoning: 'Greeting user'
          },
          history: chatHistory
        }, context);
        response.response_type = 'chat_response';
        return {
          ...response,
          steps: thoughts.getSteps()
        };
      case 'store_memory':
        console.log('[OrchestratorV3] Branch: store_memory');
        reportStep('Storing memory...');
        if (intentResult.memory_content) {
          const toolExecutor = new ToolExecutor({ userId, supabase, timezone, sessionId });
          await toolExecutor.storeMemory(intentResult.memory_content);
          return {
            status: 'success',
            message: "Got it! I've remembered that for you.",
            response_type: 'chat_response',
            steps: thoughts.getSteps()
          };
        }
        break; // Fallback to reasoning if no content extracted
      case 'confirm':
        if (session.pending_action) {
          // DEFENSIVE CHECK: If the explorer found food items, it might NOT be a confirmation of the PREVIOUS action
          if (intentResult.food_items && intentResult.food_items.length > 0) {
            console.log('[OrchestratorV3] Intent was confirm but food items found. Redirecting to log_food.');
            // We fall through to log_food logic or let it hit reasoning
          } else {
            console.log('[OrchestratorV3] Branch: confirm (Direct Route)');
            reportStep('Confirmed! Processing...');
            const confirmResult: any = await handlePendingConfirmation(session.pending_action, userId, sessionService, db, context, message);
            confirmResult.steps = thoughts.getSteps();
            return confirmResult;
          }
        }
        break; // Fallback to reasoning if no pending action or if it looked like a new log
      case 'decline':
      case 'cancel':
        console.log('[OrchestratorV3] Branch: cancel');
        reportStep('Cancelling...');
        await sessionService.clearPendingAction(userId);
        return {
          status: 'success',
          message: 'No problem! I\'ve cancelled that. What else can I help with?',
          response_type: 'action_cancelled',
          steps: thoughts.getSteps()
        };
      case 'audit':
      case 'patterns':
      case 'reflect':
      case 'classify_day':
      case 'summary':
        console.log(`[OrchestratorV3] Branch: ${intent} (Direct Route to InsightAgent)`);
        reportStep('Analyzing your data...');
        const insightAgent = new InsightAgent();
        const insightResult = await insightAgent.execute({
          action: intent,
          query: intentResult.query_focus || message,
          filters: intentResult.flexible_range || {},
          day_type: intentResult.day_type,
          notes: intentResult.notes
        }, { ...context, db });

        agentsInvolved.push('insight');
        // Format with ChatAgent
        const chatAgentInsight = new ChatAgent();
        response.message = await chatAgentInsight.execute({
          userMessage: message,
          intent: intent,
          data: {
            reasoning: `InsightAgent ${intent} analysis`,
            insight: insightResult
          },
          history: chatHistory
        }, context);
        response.response_type = 'chat_response';
        response.data = insightResult;
        return {
          ...response,
          steps: thoughts.getSteps()
        };
      case 'log_food':
      case 'query_nutrition':
        // Clear stale pending actions for new logs
        if (intent === 'log_food') {
          await sessionService.clearPendingAction(userId);
        }
        // All food logging and nutrition queries are handled by the ReasoningAgent
        // which has access to ask_nutrition_agent (with safety, memory, verification)
        console.log('[OrchestratorV3] Routing log_food/query_nutrition to ReasoningAgent');
        break;
      case 'log_recipe':
      case 'save_recipe':
        // Route to ReasoningAgent for recipe handling
        await sessionService.clearPendingAction(userId);
        console.log(`[OrchestratorV3] Routing ${intent} to ReasoningAgent`);
        break;
    }
    // =========================================================
    // STEP 4: ReasoningAgent - Fallback (Complex cases)
    // =========================================================
    console.log('[OrchestratorV3] Fallback to ReasoningAgent');
    reportStep('Thinking about how to help...');
    const reasoningAgent = new ReasoningAgent();
    const reasoningResult = await reasoningAgent.execute({
      message: augmentedMessage.length > 2000 ? augmentedMessage.substring(0, 2000) + "... [Truncated]" : augmentedMessage,
      intent: {
        type: intentResult.intent,
        confidence: intentResult.confidence,
        entities: intentResult.entities,
        food_items: intentResult.food_items,
        portions: intentResult.portions,
        ambiguity_level: intentResult.ambiguity_level,
        ambiguity_reasons: intentResult.ambiguity_reasons
      },
      chatHistory
    }, context);
    agentsInvolved.push('reasoning');
    agentsInvolved.push(...reasoningResult.toolsUsed);
    // Log specific tool actions as thoughts
    if (reasoningResult.toolsUsed.includes('lookup_nutrition')) reportStep('Looking up nutrition info...');
    if (reasoningResult.toolsUsed.includes('estimate_nutrition')) reportStep('Estimating nutritional values...');
    if (reasoningResult.toolsUsed.includes('parse_recipe_text')) reportStep('Parsing recipe details...');
    if (reasoningResult.toolsUsed.includes('get_user_goals')) reportStep('Checking your nutrition goals...');
    if (reasoningResult.toolsUsed.includes('propose_food_log')) reportStep('Preparing a log entry for you...');
    // Handle proposals (PCC pattern)
    let activeProposal = reasoningResult.proposal;

    // Persist pending modal: If ReasoningAgent didn't make a new proposal, but we have one in session,
    // re-attach it so the modal persists during follow-up questions.
    if (!activeProposal && session.pending_action) {
      console.log('[OrchestratorV3] Re-attaching pending action from session for persistence');
      activeProposal = {
        type: session.pending_action.type,
        id: session.pending_action.data.proposal_id || session.pending_action.data.id || `prop_persist_${Date.now()}`,
        data: session.pending_action.data
      };
    }

    if (intent === 'log_food' && !activeProposal) {
      console.warn('[OrchestratorV3] WARNING: Intent is log_food but NO active proposal generated!');
      // AUTO-PROPOSAL SAFETY NET: If ReasoningAgent gathered nutrition data but forgot to call propose_food_log,
      // create the proposal automatically from the gathered ask_nutrition_agent results.
      const nutritionData = reasoningResult.data?.ask_nutrition_agent;
      if (nutritionData) {
        const items = Array.isArray(nutritionData) ? nutritionData : [nutritionData];
        const validItems = items.filter((item: any) => item && (item.calories !== undefined || item.food_name));
        if (validItems.length > 0) {
          console.log(`[OrchestratorV3] Auto-creating proposal from ${validItems.length} gathered nutrition item(s)`);
          const proposalData = validItems.map((item: any) => ({
            food_name: item.food_name || 'Unknown Food',
            portion: item.portion || item.serving_size || '1 serving',
            calories: Math.round(item.calories || 0),
            protein_g: Math.round((item.protein_g || 0) * 10) / 10,
            carbs_g: Math.round((item.carbs_g || 0) * 10) / 10,
            fat_total_g: Math.round((item.fat_total_g || 0) * 10) / 10,
            ...item // spread remaining nutrient fields
          }));
          activeProposal = {
            type: 'food_log',
            id: `auto_${Date.now()}`,
            data: proposalData.length === 1 ? proposalData[0] : proposalData
          };
          // Save to session
          await sessionService.savePendingAction(userId, {
            type: 'food_log',
            data: activeProposal.data
          });
        }
      }
    }

    // AUTO-PROPOSAL SAFETY NET FOR RECIPE LOGGING
    if (intent === 'log_recipe' && !activeProposal) {
      console.warn('[OrchestratorV3] WARNING: Intent is log_recipe but NO active proposal generated!');
      const recipeData = reasoningResult.data?.ask_recipe_agent;
      if (recipeData) {
        const recipeResult = Array.isArray(recipeData) ? recipeData[0] : recipeData;
        const recipe = recipeResult?.recipe;
        if (recipe && recipe.nutrition_data) {
          console.log(`[OrchestratorV3] Auto-creating recipe log proposal from recipe: "${recipe.recipe_name}"`);
          const servings = 1;
          const scale = servings / (recipe.servings || 1);
          const scaled = scaleNutrition(recipe.nutrition_data || {}, scale);
          activeProposal = {
            type: 'recipe_log',
            id: `auto_recipe_${Date.now()}`,
            data: {
              recipe_id: recipe.id,
              recipe_name: recipe.recipe_name,
              servings,
              ...scaled
            }
          };
          await sessionService.savePendingAction(userId, {
            type: 'recipe_log',
            data: activeProposal.data
          });
        }
      }
    }

    if (activeProposal) {
      console.log(`[OrchestratorV3] Active Proposal Generated: ${activeProposal.type} (ID: ${activeProposal.id})`);
    }

    if (activeProposal) {
      if (reasoningResult.proposal) {
        // Only save to DB if it's a NEW proposal from this turn
        await sessionService.savePendingAction(userId, {
          type: activeProposal.type,
          data: activeProposal.data
        });
      }
      response.response_type = `confirmation_${activeProposal.type}`;
    }
    // =========================================================
    // STEP 5: ChatAgent - Final Formatting
    // =========================================================
    reportStep('Formatting response...');
    const chatAgent = new ChatAgent();
    response.message = await chatAgent.execute({
      userMessage: message,
      intent: intentResult.intent,
      data: {
        reasoning: reasoningResult.reasoning,
        proposal: reasoningResult.proposal,
        toolsUsed: reasoningResult.toolsUsed,
        data: reasoningResult.data
      },
      history: chatHistory
    }, context);
    agentsInvolved.push('chat');
    // Finalize Response data
    response.data = {
      ...reasoningResult.data,
      proposal: activeProposal
    };

    // Map proposal data to specific keys for frontend
    if (activeProposal) {
      const p = activeProposal;
      if (p.type === 'food_log') {
        // Handle batch proposals (array of items) or single item
        response.data.nutrition = Array.isArray(p.data) ? p.data : [p.data];
        response.response_type = 'confirmation_food_log';
      } else if (p.type === 'recipe_log') {
        // Fix 3B: Spread all proposal data to preserve nutrients (was hardcoding only 5 fields)
        response.data.nutrition = [
          {
            ...p.data,
            food_name: p.data.recipe_name,
            serving_size: `${p.data.servings} serving(s)`
          }
        ];
        response.response_type = 'confirmation_food_log';
      } else if (p.type === 'recipe_save' && p.data?.flowState) {
        const fs = p.data.flowState;
        response.data.parsed = {
          recipe_name: fs.parsed.recipe_name,
          servings: fs.parsed.servings,
          nutrition_data: fs.batchNutrition,
          ingredients: fs.ingredientsWithNutrition?.map((ing: any) => ({
            name: ing.name || ing.ingredient_name,
            amount: ing.amount || ing.quantity || '',
            unit: ing.unit || '',
            calories: ing.nutrition?.calories || ing.nutrition_data?.calories || 0
          })) || fs.parsed.ingredients?.map((ing: any) => ({
            name: ing.name,
            amount: ing.quantity || '',
            unit: ing.unit || '',
            calories: 0 // Placeholder if nutrition calculation failed but ingredients are there
          })) || []
        };
        response.response_type = 'confirmation_recipe_save';
      } else if (p.type === 'goal_update') {
        response.response_type = 'confirmation_goal_update';
      }
    }
    // Update session context
    await sessionService.updateContext(userId, {
      intent: intentResult.intent,
      agent: 'reasoning',
      responseType: response.response_type
    });
    // Extraction for Context Preservation (Phase 2.2)
    const foodEntities = extractFoodEntities(intentResult, reasoningResult.data);
    const topic = classifyTopic(intentResult.intent);
    if (foodEntities.length > 0 || topic) {
      await sessionService.updateBuffer(userId, {
        recentFoods: foodEntities,
        lastTopic: topic
      });
    }
    response.steps = thoughts.getSteps();
    persistence.logExecution(userId, sessionId, 'reasoning', agentsInvolved, startTime, response, message, undefined);
    return response;
  } catch (error) {
    console.error('[OrchestratorV3] Fatal Error:', error);
    return {
      status: 'error',
      message: `I encountered an unexpected error. Please try again. (${(error as Error).message})`,
      response_type: 'fatal_error'
    };
  }
}
/**
 * Helper to log food items with strict nutrient filtering
 */
async function logFilteredFood(userId: string, db: DbService, nutritionData: any) {
  const goals = await db.getUserGoals(userId);
  const trackedKeys = goals && goals.length > 0 ? goals.map((g: any) => g.nutrient) : ['calories', 'protein_g', 'carbs_g', 'fat_total_g'];

  // Base fields
  const item: any = {
    food_name: nutritionData.food_name || nutritionData.recipe_name,
    portion: nutritionData.portion,
    calories: Math.round(nutritionData.calories || 0),
    log_time: new Date().toISOString()
  };

  // Add optional metadata
  if (nutritionData.recipe_id) item.recipe_id = nutritionData.recipe_id;

  // Tracked fields only
  const extras: Record<string, any> = {};

  // We need to know which keys are EXPLICIT database columns vs. extras
  // For now, we'll assume anything not in the standard FoodLogEntry interface is an extra
  // But wait, I added 40+ columns. I should check against a known list.
  // FIX: Use MASTER_NUTRIENT_MAP for schema columns to ensure single source of truth
  const schemaColumns = Object.keys(MASTER_NUTRIENT_MAP);

  // FIX: Iterate over keys present in nutritionData, not just tracked keys
  // This ensures we capture everything the AI gave us that fits in the DB.
  Object.keys(nutritionData).forEach((key: string) => {
    if (key !== 'calories' && key !== 'food_name' && key !== 'portion' && key !== 'recipe_id' && key !== 'recipe_name') {
      const val = typeof nutritionData[key] === 'number' ? Math.round(nutritionData[key] * 10) / 10 : nutritionData[key];

      if (schemaColumns.includes(key)) {
        item[key] = val;
      } else {
        // Only add significant extras (ignore internal flags)
        if (key !== 'confidence' && key !== 'confidence_details' && key !== 'error_sources' && key !== 'health_flags' && key !== 'applied_memory') {
          extras[key] = val;
        }
      }
    }
  });

  if (Object.keys(extras).length > 0) {
    item.extras = extras;
  }

  await db.logFoodItems(userId, [item]);
  return item;
}

/**
 * Handle confirmation of pending actions (food log, recipe log, goal update)
 */ async function handlePendingConfirmation(pendingAction: any, userId: string, sessionService: any, db: DbService, context: any, message: string) {
  const { type, data } = pendingAction;
  const lowerMessage = message.trim().toLowerCase();
  try {
    switch (type) {
      case 'food_log':
        // Handle batch processing (array of items)
        const itemsToLog = Array.isArray(data) ? data : [data];
        let totalCalories = 0;

        for (const item of itemsToLog) {
          await logFilteredFood(userId, db, item);
          totalCalories += (item.calories || 0);
        }

        await sessionService.clearPendingAction(userId);

        const confirmationMsg = itemsToLog.length === 1
          ? `✅ Logged ${itemsToLog[0].food_name} (${itemsToLog[0].calories} cal)! Great choice! 🎉`
          : `✅ Logged ${itemsToLog.length} items (${Math.round(totalCalories)} cal total)! Great choices! 🎉`;

        return {
          status: 'success',
          message: confirmationMsg,
          response_type: 'food_logged',
          data: {
            food_logged: itemsToLog
          }
        };
      case 'recipe_log':
        await logFilteredFood(userId, db, {
          ...data,
          portion: `${data.servings} serving(s)`
        });
        await sessionService.clearPendingAction(userId);
        return {
          status: 'success',
          message: `✅ Logged ${data.servings} serving(s) of ${data.recipe_name}! 🍽️`,
          response_type: 'recipe_logged',
          data: {
            recipe_logged: data
          }
        };
      case 'goal_update':
        if (data.action === 'remove') {
          await db.removeUserGoal(userId, data.nutrient);
          await sessionService.clearPendingAction(userId);
          return {
            status: 'success',
            message: `✅ Removed your ${data.nutrient} goal! 🗑️`,
            response_type: 'goal_updated',
            data: {
              goal_updated: { ...data, removed: true }
            }
          };
        } else {
          await db.updateUserGoal(userId, data.nutrient, data.target_value, data.unit, data.goal_type, {
            yellow_min: data.yellow_min,
            green_min: data.green_min,
            red_min: data.red_min
          });
          await sessionService.clearPendingAction(userId);
          return {
            status: 'success',
            message: `✅ Updated your ${data.nutrient} goal to ${data.target_value}${data.unit}${data.goal_type === 'limit' ? ' (Limit)' : ''}! 🎯`,
            response_type: 'goal_updated',
            data: {
              goal_updated: data
            }
          };
        }

      case 'bulk_goal_update':
        await db.updateUserGoals(userId, data.goals);
        await sessionService.clearPendingAction(userId);

        // Count adds/removes for message
        const removedCount = data.goals.filter((g: any) => g.action === 'remove').length;
        const updatedCount = data.goals.length - removedCount;
        let msg = `✅ Processed ${data.goals.length} goal updates!`;
        if (removedCount > 0 && updatedCount > 0) msg = `✅ Updated ${updatedCount} goals and removed ${removedCount}! 🎯`;
        else if (removedCount > 0) msg = `✅ Removed ${removedCount} goals! 🗑️`;
        else msg = `✅ Updated ${updatedCount} nutrition goals! 🎯`;

        return {
          status: 'success',
          message: msg,
          response_type: 'goal_updated',
          data: {
            goals_updated: data.goals
          }
        };
      case 'recipe_selection':
        // User has selected one recipe from multiple matches
        // Extract recipe ID from user's choice (could be number or recipe name)
        const selectionChoice = message.trim();
        console.log(`[OrchestratorV3] Recipe selection choice: "${selectionChoice}"`);

        let selectedRecipe = null;

        // Try to match by number (e.g., "1", "2")
        const choiceNum = parseInt(selectionChoice);
        if (!isNaN(choiceNum) && choiceNum > 0 && choiceNum <= data.recipes.length) {
          selectedRecipe = data.recipes[choiceNum - 1];
        } else {
          // Try to match by name
          selectedRecipe = data.recipes.find((r: any) =>
            r.recipe_name.toLowerCase().includes(selectionChoice.toLowerCase())
          );
        }

        if (!selectedRecipe) {
          return {
            status: 'error',
            message: `I couldn't find that recipe in the list. Please enter the number (1-${data.recipes.length}) or the recipe name.`,
            response_type: 'error'
          };
        }

        console.log(`[OrchestratorV3] Selected recipe: ${selectedRecipe.recipe_name} (${selectedRecipe.id})`);

        // Fetch the full recipe data (selectedRecipe might only have summary data)
        const selectedRecipeData = selectedRecipe.full_recipe || selectedRecipe;

        // Calculate per-serving nutrition
        const perServingNutritionSelection = scaleNutrition(selectedRecipeData.nutrition_data || {}, 1 / (selectedRecipeData.servings || 1));

        // Build flowState for duplicate confirmation
        const recipeFs = {
          step: 'pending_duplicate_confirm',
          parsed: {
            recipe_name: selectedRecipeData.recipe_name,
            servings: selectedRecipeData.servings,
            ingredients: selectedRecipeData.recipe_ingredients?.map((ing: any) => ({
              name: ing.ingredient_name,
              quantity: ing.quantity,
              unit: ing.unit
            })) || []
          },
          batchNutrition: selectedRecipeData.nutrition_data,
          perServingNutrition: perServingNutritionSelection,
          existingRecipeId: selectedRecipeData.id,
          existingRecipeName: selectedRecipeData.recipe_name
        };

        // Save new pending action for duplicate confirmation
        await sessionService.savePendingAction(userId, {
          type: 'recipe_save',
          data: {
            flowState: recipeFs,
            response_type: 'pending_duplicate_confirm',
            pending: true,
            portion: data.original_portion
          }
        });

        return {
          status: 'success',
          message: `Great! I'll use \"**${selectedRecipeData.recipe_name}**\". What would you like to do?`,
          response_type: 'confirmation_recipe_save',
          data: {
            isMatch: true,
            existingRecipeName: selectedRecipeData.recipe_name,
            parsed: {
              ...recipeFs.parsed,
              nutrition_data: recipeFs.batchNutrition,
              per_serving_nutrition: perServingNutritionSelection,
              ingredients: selectedRecipeData.recipe_ingredients?.map((ing: any) => ({
                name: ing.ingredient_name,
                amount: ing.quantity,
                unit: ing.unit,
                calories: ing.nutrition_data?.calories || 0,
                nutrition_data: ing.nutrition_data
              })) || []
            }
          }
        };
      case 'recipe_save':
        // Delegate to RecipeAgent for robust handling
        const recipeAgent = new RecipeAgent();
        const dataAny = data;
        const fs = dataAny.flowState;
        if (dataAny.customName) {
          if (fs?.parsed) fs.parsed.recipe_name = dataAny.customName;
          else if (dataAny.parsed) dataAny.parsed.recipe_name = dataAny.customName;
        }
        const choice = dataAny.choice || (lowerMessage.includes('log') ? 'log' : lowerMessage.includes('update') ? 'update' : lowerMessage.includes('new') ? 'new' : undefined);
        const optimizationData = fs ? {
          batchNutrition: fs.batchNutrition,
          ingredientsWithNutrition: fs.ingredientsWithNutrition
        } : {};
        const action = choice ? {
          type: 'handle_duplicate',
          flowState: fs,
          choice: choice,
          ...optimizationData
        } : {
          type: 'save',
          parsed: fs?.parsed || data.parsed,
          mode: 'commit',
          ...optimizationData
        };
        const saveResult = await recipeAgent.execute(action, context);
        await sessionService.clearPendingAction(userId);
        if (saveResult.type === 'error') {
          throw new Error(saveResult.error || 'Unknown error saving recipe');
        } else if (saveResult.type === 'updated') {
          const portion = data.portion;
          if (portion) {
            const recipe = saveResult.recipe;
            const servings = parseFloat(portion) || 1;
            const scale = servings / (recipe.servings || 1);
            const scaled = scaleNutrition(recipe.nutrition_data || {}, scale);
            await logFilteredFood(userId, db, {
              ...scaled,
              food_name: recipe.recipe_name,
              portion: portion,
              recipe_id: recipe.id
            });
            return {
              status: 'success',
              message: `✅ Updated and logged ${portion} of "${recipe.recipe_name}"! 🍽️`,
              response_type: 'recipe_logged',
              data: {
                recipe_logged: recipe
              }
            };
          }
          return {
            status: 'success',
            message: `✅ Updated recipe "${saveResult.recipe.recipe_name}"! 📖`,
            response_type: 'recipe_saved',
            data: {
              recipe: saveResult.recipe
            }
          };
        } else if (saveResult.type === 'found' && saveResult.skipSave) {
          // This is the "Log Existing" choice
          // We need to log it now
          const recipe = saveResult.recipe;
          const portion = data.portion || `1 serving`;
          // Simple scaling for logging
          const servings = parseFloat(portion) || 1;
          const scale = servings / (recipe.servings || 1);
          const scaled = scaleNutrition(recipe.nutrition_data || {}, scale);
          await logFilteredFood(userId, db, {
            ...scaled,
            food_name: recipe.recipe_name,
            portion: portion,
            recipe_id: recipe.id
          });
          return {
            status: 'success',
            message: `✅ Logged ${portion} of "${recipe.recipe_name}"! 🍽️`,
            response_type: 'recipe_logged',
            data: {
              recipe_logged: recipe
            }
          };
        }
        return {
          status: 'success',
          message: `✅ Saved recipe "${saveResult.recipe?.recipe_name || 'your recipe'}"! You can now log it any time. 📖`,
          response_type: 'recipe_saved',
          data: {
            recipe: saveResult.recipe
          }
        };
      default:
        await sessionService.clearPendingAction(userId);
        return {
          status: 'success',
          message: 'Done! ✅',
          response_type: 'action_confirmed'
        };
    }
  } catch (error) {
    console.error('[OrchestratorV3] Confirmation error:', error);
    return {
      status: 'error',
      message: `Failed to save: ${(error as Error).message}. Please try again.`,
      response_type: 'confirmation_failed'
    };
  }
}
/**
 * Extract food entity names from intent result and gathered data.
 * Phase 2.2: These are stored in the buffer for context preservation.
 */ function extractFoodEntities(intentResult: any, gatheredData: any) {
  const foods = [];
  // Extract from intent entities
  if (intentResult.food_items && Array.isArray(intentResult.food_items)) {
    foods.push(...intentResult.food_items);
  }
  if (intentResult.entities && Array.isArray(intentResult.entities)) {
    // Entities might contain food names
    foods.push(...intentResult.entities.filter((e: any) => ![
      'today',
      'yesterday',
      'tomorrow',
      'morning',
      'evening',
      'lunch',
      'dinner',
      'breakfast'
    ].includes(e.toLowerCase())));
  }
  // Extract from nutrition lookup results
  if (gatheredData?.lookup_nutrition?.food_name) {
    foods.push(gatheredData.lookup_nutrition.food_name);
  }
  if (gatheredData?.propose_food_log?.data?.food_name) {
    foods.push(gatheredData.propose_food_log.data.food_name);
  }
  // Deduplicate and clean
  return [
    ...new Set(foods.filter((f) => f && f.length > 0))
  ];
}
/**
 * Classify the topic of conversation based on intent.
 * Phase 2.2: Used to track conversation context.
 */ function classifyTopic(intent: string) {
  if ([
    'log_food',
    'query_nutrition',
    'dietary_advice'
  ].includes(intent)) {
    return 'food';
  }
  if ([
    'log_recipe',
    'save_recipe'
  ].includes(intent)) {
    return 'recipe';
  }
  if ([
    'query_goals',
    'update_goals',
    'suggest_goals'
  ].includes(intent)) {
    return 'goals';
  }
  if ([
    'off_topic',
    'clarify'
  ].includes(intent)) {
    return 'general';
  }
  return undefined;
}
// Export default for easy switching between versions
export { orchestrateV3 as orchestrate };
