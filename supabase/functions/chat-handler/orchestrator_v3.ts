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
import { createAdminClient } from '../_shared/supabase-client.ts';
import { DbService } from './services/db-service.ts';
import { PersistenceService } from './services/persistence-service.ts';
import { SessionService } from './services/session-service.ts';
import { ToolExecutor } from './services/tool-executor.ts';
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
  const userGoals = await db.getUserGoals(userId);
  const trackedNutrients = userGoals?.map((g: any) => g.nutrient) || [];

  const context = {
    userId,
    sessionId,
    supabase,
    timezone,
    session,
    healthConstraints,
    memories,
    dayClassification, // { day_type: 'travel' | 'sick' | ..., notes: ... }
    trackedNutrients
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
    // STEP 1: Recipe Heuristic (Speed for long texts)
    // =========================================================
    const seemsLikeRecipe = message.length > 200 || message.includes('\n') && message.split('\n').length > 3 || message.toLowerCase().includes('recipe') && message.length > 50;
    if (seemsLikeRecipe) {
      const consumptionKeywords = [
        'ate',
        'had',
        'log',
        'consumption',
        'portion',
        'serving',
        'having'
      ];
      const hasConsumption = consumptionKeywords.some((k) => lowerMessage.includes(k));
      if (!hasConsumption) {
        console.log('[OrchestratorV3] Recipe heuristic triggered (Direct Route)');
        reportStep('Analyzing recipe...');
        const toolExecutor = new ToolExecutor({
          userId,
          supabase,
          timezone,
          sessionId,
          healthConstraints: context.healthConstraints
        });
        const parseResult = await toolExecutor.execute('parse_recipe_text', {
          recipe_text: message
        });
        if (parseResult.proposal_type === 'recipe_save' && parseResult.flowState) {
          await sessionService.savePendingAction(userId, {
            type: parseResult.proposal_type,
            data: parseResult
          });
          response.response_type = 'confirmation_recipe_save';
          const fs = parseResult.flowState;
          response.data = {
            isMatch: parseResult.response_type === 'pending_duplicate_confirm',
            existingRecipeName: fs.existingRecipeName,
            parsed: {
              recipe_name: fs.parsed.recipe_name,
              servings: fs.parsed.servings,
              nutrition_data: fs.batchNutrition,
              ingredients: fs.ingredientsWithNutrition?.map((ing: any) => ({
                name: ing.name,
                amount: ing.amount || ing.quantity || '',
                unit: ing.unit || '',
                calories: ing.nutrition?.calories || 0
              })) || []
            },
            preview: message.substring(0, 100) + '...'
          };
          const chatAgent = new ChatAgent();
          response.message = await chatAgent.execute({
            userMessage: message,
            intent: 'save_recipe',
            data: {
              proposal: parseResult,
              toolsUsed: [
                'parse_recipe_text'
              ]
            },
            history: chatHistory
          }, context);
          response.steps = thoughts.getSteps();
          return response;
        }
      }
    }
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
        // Clear any stale pending actions from previous turns (Zombie Chicken Fix)
        // BUT preserve context if we are just querying details (e.g. "What ingredients?")
        if (intent === 'log_food') {
          await sessionService.clearPendingAction(userId);
        }

        // Simple logging or query can often bypass reasoning if entities are clear
        // But for now, we'll let reasoning handle it to maintain the tool orchestration
        // UNLESS it's a very simple one-item log.
        if (intentResult.food_items?.length === 1 && !message.includes(' recipes') && !message.includes(' yesterday')) {
          const food = intentResult.food_items[0];
          const portion = intentResult.portions?.[0] || '1 serving';
          // PRIORITIZE SAVED RECIPES (Fulfills request to clarify logging source)
          console.log(`[OrchestratorV3] Checking for saved recipes matching "${food}"...`);
          const recipeAgentForLog = new RecipeAgent();
          const findResultForLog = await recipeAgentForLog.execute({
            type: 'find',
            name: food
          }, context);
          if (findResultForLog.type === 'multiple_found') {
            // Multiple recipes match - ask user to select one
            console.log(`[OrchestratorV3] Found ${findResultForLog.recipes.length} recipes matching "${food}"`);
            await sessionService.savePendingAction(userId, {
              type: 'recipe_selection',
              data: {
                recipes: findResultForLog.recipes,
                query: food,
                original_portion: portion
              }
            });
            response.response_type = 'recipe_selection';
            response.data = {
              recipes: findResultForLog.recipes.map((r: any) => ({
                id: r.id,
                recipe_name: r.recipe_name,
                servings: r.servings,
                calories_per_serving: r.calories_per_serving,
                ingredients: r.ingredients // Explicitly passed
              })),
              query: food
            };
            const chatAgent = new ChatAgent();
            response.message = `I found ${findResultForLog.recipes.length} recipes matching "**${food}**". Which one would you like to log?\n\n${findResultForLog.recipes.map((r: any, i: number) => `${i + 1}. **${r.recipe_name}** (${r.servings} serving(s), ~${r.calories_per_serving} kcal each)`).join('\n')}`;
            return {
              ...response,
              steps: thoughts.getSteps()
            };
          } else if (findResultForLog.type === 'found') {
            console.log(`[OrchestratorV3] Found saved recipe match for "${food}" during log_food intent`);
            const recipe = findResultForLog.recipe;
            // Calculate per-serving nutrition
            const perServingNutrition = scaleNutrition(recipe.nutrition_data || {}, 1 / (recipe.servings || 1));
            const fs = {
              step: 'pending_duplicate_confirm',
              parsed: {
                recipe_name: recipe.recipe_name,
                servings: recipe.servings,
                ingredients: recipe.recipe_ingredients?.map((ing: any) => ({
                  name: ing.ingredient_name,
                  quantity: ing.quantity,
                  unit: ing.unit
                })) || []
              },
              batchNutrition: recipe.nutrition_data,
              perServingNutrition,
              existingRecipeId: recipe.id,
              existingRecipeName: recipe.recipe_name
            };
            await sessionService.savePendingAction(userId, {
              type: 'recipe_save',
              data: {
                flowState: fs,
                response_type: 'pending_duplicate_confirm',
                pending: true,
                portion
              }
            });
            response.response_type = 'confirmation_recipe_save';
            response.data = {
              isMatch: true,
              existingRecipeName: recipe.recipe_name,
              parsed: {
                ...fs.parsed,
                nutrition_data: fs.batchNutrition,
                per_serving_nutrition: perServingNutrition,
                ingredients: recipe.recipe_ingredients?.map((ing: any) => ({
                  name: ing.ingredient_name,
                  amount: ing.quantity,
                  unit: ing.unit,
                  calories: ing.nutrition_data?.calories || 0,
                  nutrition_data: ing.nutrition_data
                })) || []
              }
            };
            const chatAgentLogMatch = new ChatAgent();
            response.message = `I found your saved recipe for "**${recipe.recipe_name}**"! Would you like to use it for this log?`;
            return {
              ...response,
              steps: thoughts.getSteps()
            };
          }
          console.log('[OrchestratorV3] Branch: simple_log_food');
          reportStep('Looking up nutrition...');
          const nutritionData = await toolExecutor.execute('lookup_nutrition', {
            food,
            portion,
            calories: intentResult.calories, // Use intentResult.calories for consistency
            protein_g: intentResult.macros?.protein_g,
            carbs_g: intentResult.macros?.carbs_g,
            fat_total_g: intentResult.macros?.fat_total_g,
            healthConstraints: context.healthConstraints, // Assuming healthConstraints is in context
            memories: context.memories, // Assuming memories is in context
            trackedNutrients: context.trackedNutrients, // Assuming trackedNutrients is in context
            originalDescription: message // Pass original message for context (e.g. "with water")
          });

          // SAFETY CHECK: Block logging if food conflicts with health constraints
          // FIX: Cross-reference LLM-generated health flags (e.g. "Contains peanuts")
          // against the user's actual health constraints by category + severity.
          // Previously checked for "CRITICAL" substring which never matched the LLM output format.
          const criticalFlags = (nutritionData.health_flags || []).filter((flag: string) => {
            const lowerFlag = flag.toLowerCase();
            return (context.healthConstraints || []).some((c: any) =>
              c.severity === 'critical' && lowerFlag.includes(c.category.toLowerCase())
            );
          });

          if (criticalFlags.length > 0) {
            console.warn(`[OrchestratorV3] Health Warning for "${food}": ${criticalFlags.join(', ')}`);
            // FIX: Don't block — user wants WARNING not BLOCK.
            // Add warning to nutritionData so it shows in the proposal, but continue with normal flow.
            nutritionData.health_warning = `⚠️ Heads up: this contains ${criticalFlags.map((f: string) => f.replace(/contains /i, '').replace(/may contain /i, '')).join(', ')}. Please confirm you're okay with this.`;
          }

          const proposal = await toolExecutor.execute('propose_food_log', {
            ...nutritionData
          });
          await sessionService.savePendingAction(userId, {
            type: 'food_log',
            data: proposal.data
          });
          const chatAgentLog = new ChatAgent();
          response.message = await chatAgentLog.execute({
            userMessage: message,
            intent: 'log_food',
            data: {
              proposal,
              toolsUsed: [
                'lookup_nutrition'
              ]
            },
            history: chatHistory
          }, context);
          response.response_type = 'confirmation_food_log';
          response.data = {
            nutrition: [
              proposal.data
            ],
            proposal
          };
          return {
            ...response,
            steps: thoughts.getSteps()
          };
        }
        // FIX: Multi-item food logs (e.g. "log chicken and rice") skip the single-item
        // if-block above. Without this break, they fall through into log_recipe handling.
        // Instead, let them reach the ReasoningAgent fallback at STEP 4.
        break;
      case 'log_recipe':
        // Clear any stale pending actions from previous turns
        await sessionService.clearPendingAction(userId);

        // Shortcut: If intent is log_recipe and message is large or context exists
        if (message.length > 500 || intentResult.recipe_text) {
          console.log('[OrchestratorV3] Branch: log_recipe_shortcut (parse)');
          reportStep('Parsing recipe...');
          const recipeText = intentResult.recipe_text || message;
          const parseResult = await toolExecutor.execute('parse_recipe_text', {
            recipe_text: recipeText
          });
          if (parseResult.proposal_type === 'recipe_save' && parseResult.flowState) {
            await sessionService.savePendingAction(userId, {
              type: 'recipe_save',
              data: parseResult
            });
            const isMatch = parseResult.response_type === 'pending_duplicate_confirm';
            response.response_type = 'confirmation_recipe_save';
            const fs = parseResult.flowState;
            response.data = {
              isMatch,
              existingRecipeName: fs.existingRecipeName,
              parsed: {
                recipe_name: fs.parsed.recipe_name,
                servings: fs.parsed.servings,
                nutrition_data: fs.batchNutrition,
                ingredients: fs.ingredientsWithNutrition?.map((ing: any) => ({
                  name: ing.name,
                  amount: ing.amount || ing.quantity || '',
                  unit: ing.unit || '',
                  calories: ing.nutrition?.calories || 0
                })) || []
              }
            };
            const chatAgentRecipe = new ChatAgent();
            response.message = await chatAgentRecipe.execute({
              userMessage: message,
              intent: 'log_recipe',
              data: {
                proposal: parseResult,
                toolsUsed: [
                  'parse_recipe_text'
                ]
              },
              history: chatHistory
            }, context);
            return {
              ...response,
              steps: thoughts.getSteps()
            };
          }
        } else {
          // Simple search by name
          const recipeName = intentResult.food_items?.[0] || message;
          console.log('[OrchestratorV3] Branch: log_recipe_shortcut (search)');

          // Clean the query to remove "log", "my", "track" prefix if falling back to message
          let query = recipeName;
          if (query === message) {
            query = query.replace(/^(log|track|have|had|ate|record)\s+(my\s+)?/i, '').trim();
          }

          reportStep(`Searching for "${query}" in your recipes...`);
          const recipeAgent = new RecipeAgent();
          const findResult = await recipeAgent.execute({
            type: 'find',
            name: query
          }, context);
          if (findResult.type === 'multiple_found') {
            // Multiple recipes match - ask user to select one
            console.log(`[OrchestratorV3] Found ${findResult.recipes.length} recipes matching "${query}"`);
            await sessionService.savePendingAction(userId, {
              type: 'recipe_selection',
              data: {
                recipes: findResult.recipes,
                query: query,
                original_intent: 'log_recipe'
              }
            });
            response.response_type = 'recipe_selection';
            response.data = {
              recipes: findResult.recipes.map((r: any) => ({
                id: r.id,
                recipe_name: r.recipe_name,
                servings: r.servings,
                calories_per_serving: r.calories_per_serving,
                ingredients: r.ingredients // Explicitly passed
              })),
              query: query
            };
            response.message = `I found ${findResult.recipes.length} recipes matching "**${query}**". Which one would you like to work with?\n\n${findResult.recipes.map((r: any, i: number) => `${i + 1}. **${r.recipe_name}** (${r.servings} serving(s), ~${r.calories_per_serving} kcal each)`).join('\n')}`;
            return {
              ...response,
              steps: thoughts.getSteps()
            };
          } else if (findResult.type === 'found') {
            // We found it! Trigger the same "Duplicate Found" modal so user can choose log/update/new
            // This fulfills: "If we have the recipe saved we need to ask user what he wants, showing the modal to log, update, or do the edited log"
            // Convert saved recipe back to a pseudo-parsed format for the flowState
            const recipe = findResult.recipe;
            // Calculate per-serving nutrition
            const perServingNutrition = scaleNutrition(recipe.nutrition_data || {}, 1 / (recipe.servings || 1));
            const fs = {
              step: 'pending_duplicate_confirm',
              parsed: {
                recipe_name: recipe.recipe_name,
                servings: recipe.servings,
                ingredients: recipe.recipe_ingredients?.map((ing: any) => ({
                  name: ing.ingredient_name,
                  quantity: ing.quantity,
                  unit: ing.unit
                })) || []
              },
              batchNutrition: recipe.nutrition_data,
              perServingNutrition,
              existingRecipeId: recipe.id,
              existingRecipeName: recipe.recipe_name
            };
            await sessionService.savePendingAction(userId, {
              type: 'recipe_save',
              data: {
                flowState: fs,
                response_type: 'pending_duplicate_confirm',
                pending: true
              }
            });
            response.response_type = 'confirmation_recipe_save';
            response.data = {
              isMatch: true,
              existingRecipeName: recipe.recipe_name,
              parsed: {
                ...fs.parsed,
                nutrition_data: fs.batchNutrition,
                per_serving_nutrition: perServingNutrition,
                ingredients: recipe.recipe_ingredients?.map((ing: any) => ({
                  name: ing.ingredient_name,
                  amount: ing.quantity,
                  unit: ing.unit,
                  calories: ing.nutrition_data?.calories || 0,
                  nutrition_data: ing.nutrition_data
                })) || []
              }
            };
            const chatAgentFound = new ChatAgent();
            response.message = `I found your recipe for "**${recipe.recipe_name}**"! What would you like to do?`;
            // Ensure we tell the UI what recipe this is
            return {
              ...response,
              steps: thoughts.getSteps()
            };
          } else {
            // Not found? fallback to reasoning for nutrition estimate or new parse
            console.log('[OrchestratorV3] Recipe not found by name, falling back to Reasoning');
          }
        }
        break;
      case 'save_recipe':
        console.log('[OrchestratorV3] Branch: save_recipe');
        // Clear any stale pending actions from previous turns
        await sessionService.clearPendingAction(userId);

        reportStep('Parsing recipe...');
        const saveRecipeText = intentResult.recipe_text || message;
        const saveParseResult = await toolExecutor.execute('parse_recipe_text', {
          recipe_text: saveRecipeText
        });
        if (saveParseResult.proposal_type === 'recipe_save' && saveParseResult.flowState) {
          await sessionService.savePendingAction(userId, {
            type: 'recipe_save',
            data: saveParseResult
          });
          const isMatch = saveParseResult.response_type === 'pending_duplicate_confirm';
          response.response_type = 'confirmation_recipe_save';
          const fs = saveParseResult.flowState;
          response.data = {
            isMatch,
            existingRecipeName: fs.existingRecipeName,
            parsed: {
              recipe_name: fs.parsed.recipe_name,
              servings: fs.parsed.servings,
              nutrition_data: fs.batchNutrition,
              ingredients: fs.ingredientsWithNutrition?.map((ing: any) => ({
                name: ing.name,
                amount: ing.amount || ing.quantity || '',
                unit: ing.unit || '',
                calories: ing.nutrition?.calories || 0
              })) || []
            }
          };
          const chatAgentSaveRecipe = new ChatAgent();
          response.message = await chatAgentSaveRecipe.execute({
            userMessage: message,
            intent: 'save_recipe',
            data: {
              proposal: saveParseResult,
              toolsUsed: [
                'parse_recipe_text'
              ]
            },
            history: chatHistory
          }, context);
          return {
            ...response,
            steps: thoughts.getSteps()
          };
        }
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
        entities: intentResult.entities
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
        response.data.nutrition = [
          p.data
        ];
        response.response_type = 'confirmation_food_log';
      } else if (p.type === 'recipe_log') {
        response.data.nutrition = [
          {
            food_name: p.data.recipe_name,
            calories: p.data.calories,
            protein_g: p.data.protein_g,
            carbs_g: p.data.carbs_g,
            fat_total_g: p.data.fat_total_g,
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
  const schemaColumns = [
    'protein_g', 'carbs_g', 'fat_total_g', 'hydration_ml', 'fat_saturated_g',
    'fat_poly_g', 'fat_mono_g', 'fat_trans_g', 'omega_3_g', 'omega_6_g',
    'omega_ratio', 'fiber_g', 'fiber_soluble_g', 'sugar_g', 'sugar_added_g',
    'cholesterol_mg', 'sodium_mg', 'potassium_mg', 'calcium_mg', 'iron_mg',
    'magnesium_mg', 'phosphorus_mg', 'zinc_mg', 'copper_mg', 'manganese_mg',
    'selenium_mcg', 'vitamin_a_mcg', 'vitamin_c_mg', 'vitamin_d_mcg',
    'vitamin_e_mg', 'vitamin_k_mcg', 'thiamin_mg', 'riboflavin_mg',
    'niacin_mg', 'pantothenic_acid_mg', 'vitamin_b6_mg', 'biotin_mcg',
    'folate_mcg', 'vitamin_b12_mcg'
  ];

  trackedKeys.forEach((key: string) => {
    if (nutritionData[key] !== undefined && key !== 'calories') {
      const val = typeof nutritionData[key] === 'number' ? Math.round(nutritionData[key] * 10) / 10 : nutritionData[key];
      if (schemaColumns.includes(key)) {
        item[key] = val;
      } else {
        extras[key] = val;
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
        await logFilteredFood(userId, db, data);
        await sessionService.clearPendingAction(userId);
        return {
          status: 'success',
          message: `✅ Logged ${data.food_name} (${data.calories} cal)! Great choice! 🎉`,
          response_type: 'food_logged',
          data: {
            food_logged: data
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
        await db.updateUserGoal(userId, data.nutrient, data.target_value, data.unit, {
          yellow_min: data.yellow_min,
          green_min: data.green_min,
          red_min: data.red_min
        });
        await sessionService.clearPendingAction(userId);
        return {
          status: 'success',
          message: `✅ Updated your ${data.nutrient} goal to ${data.target_value}${data.unit}! 🎯`,
          response_type: 'goal_updated',
          data: {
            goal_updated: data
          }
        };

      case 'bulk_goal_update':
        await db.updateUserGoals(userId, data.goals);
        await sessionService.clearPendingAction(userId);
        return {
          status: 'success',
          message: `✅ Updated ${data.goals.length} nutrition goals! 🎯`,
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
