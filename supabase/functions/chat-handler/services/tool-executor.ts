/**
 * Tool Executor for ReasoningAgent
 * 
 * Executes tools by delegating to existing agents and services.
 * This bridges the ReasoningAgent's tool calls to our existing functionality.
 */
import { DbService } from './db-service.ts';
import { NutritionAgent } from '../agents/nutrition-agent.ts';
import { RecipeAgent } from '../agents/recipe-agent.ts';
import { InsightAgent } from '../agents/insight-agent.ts';
import { ValidatorAgent } from '../agents/validator-agent.ts';
import { createOpenAIClient } from '../../_shared/openai-client.ts';
import { getStartAndEndOfDay, getDateRange } from '../../_shared/utils.ts';
import { parseHealthInput } from '../utils/health-parser.ts';
import { validateNutrientHierarchy, sanitizeNutrients } from '../../_shared/nutrient-validation.ts';

export class ToolExecutor {
  context: any;
  db: DbService;
  nutritionAgent: NutritionAgent;
  recipeAgent: RecipeAgent;
  insightAgent: InsightAgent;
  validatorAgent: ValidatorAgent;
  agentContext: any;

  constructor(context: any) {
    this.context = context;
    this.db = new DbService(context.supabase);
    this.nutritionAgent = new NutritionAgent();
    this.recipeAgent = new RecipeAgent();
    this.insightAgent = new InsightAgent();
    this.validatorAgent = new ValidatorAgent();
    this.agentContext = {
      userId: context.userId,
      supabase: context.supabase,
      timezone: context.timezone || 'UTC',
      sessionId: context.sessionId,
      healthConstraints: context.healthConstraints,
      memories: context.memories
    };
  }

  /**
   * Execute a tool by name with given arguments
   */
  async execute(toolName: string, args: any = {}) {
    console.log(`[ToolExecutor] Executing tool: ${toolName}`, args);
    try {
      switch (toolName) {
        // User Context Tools
        case 'get_user_profile':
          return this.getUserProfile();
        case 'get_user_goals':
          return this.getUserGoals();
        case 'get_today_progress':
          return this.getTodayProgress();
        case 'get_weekly_summary':
          return this.getWeeklySummary();
        case 'get_food_history':
          return this.getFoodHistory(args.days || 7);
        // Delegation Tools (NEW)
        case 'ask_nutrition_agent':
          return this.askNutritionAgent(args);
        case 'ask_recipe_agent':
          return this.askRecipeAgent(args);
        case 'ask_insight_agent':
          return this.askInsightAgent(args);
        // Nutrition Support Tools
        case 'validate_nutrition':
          return this.validateNutrition(args);
        case 'compare_foods':
          return this.compareFoods(args.foods);
        // Legacy tool handlers - kept for backward compatibility with orchestrator direct calls
        case 'lookup_nutrition':
          return this.lookupNutrition(args.food, args.portion, args.calories, args.macros, args.originalDescription);
        case 'estimate_nutrition':
          return this.estimateNutrition(args.description, args.portion, args.calories_hint, args.tracked_nutrients);
        case 'search_saved_recipes':
          return this.searchSavedRecipes(args.query);
        case 'get_recipe_details':
          return this.getRecipeDetails(args.recipe_id);
        // Recipe Support Tools
        case 'parse_recipe_text':
          return this.parseRecipeText(args.recipe_text, args.recipe_name);
        case 'calculate_recipe_serving':
          return this.calculateRecipeServing(args.recipe_id, args.servings);
        // Logging Tools
        case 'propose_food_log':
          return this.proposeFoodLog(args);
        case 'propose_recipe_log':
          return this.proposeRecipeLog(args);
        case 'confirm_pending_log':
          return this.confirmPendingLog(args.proposal_id);
        case 'update_user_profile':
          return this.updateUserProfile(args);
        case 'manage_health_constraints':
          return this.manageHealthConstraints(args.instruction);
        // Goal Tools
        case 'update_user_goal':
          return this.updateUserGoal(args.nutrient, args.target_value, args.unit, {
            yellow_min: args.yellow_min,
            green_min: args.green_min,
            red_min: args.red_min
          });
        case 'bulk_update_user_goals':
          return this.bulkUpdateUserGoals(args.goals);
        case 'apply_daily_workout_offset':
          return this.applyDailyWorkoutOffset(args.adjustment_value, args.nutrient, args.notes);
        case 'calculate_recommended_goals':
          return this.calculateRecommendedGoals();
        // Insight Support Tools
        case 'get_food_recommendations':
          return this.getFoodRecommendations(args.focus, args.preferences);
        // Memory Tools
        case 'store_memory':
          return this.storeMemory(args);
        case 'search_memory':
          return this.searchMemory(args);
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error: any) {
      console.error(`[ToolExecutor] Error executing ${toolName}:`, error);
      return {
        error: true,
        message: `Failed to execute ${toolName}: ${error.message}`
      };
    }
  }

  // =============================================================
  // DELEGATION TOOLS (NEW)
  // =============================================================

  /**
   * Delegate nutrition tasks to NutritionAgent
   */
  async askNutritionAgent(args: { query_type: string, items: string[], portions?: string[] }) {
    console.log('[ToolExecutor] Delegating to NutritionAgent:', args);
    const { query_type, items, portions = [] } = args;

    switch (query_type) {
      case 'lookup':
      case 'estimate':
        // For single item lookups/estimates, use the existing method
        if (items.length === 1) {
          return this.lookupNutrition(items[0], portions[0] || '1 serving');
        }
        // For multiple items, call NutritionAgent directly
        return this.nutritionAgent.execute({
          items,
          portions,
          trackedNutrients: this.context.trackedNutrients || [],
          originalDescription: args.items.join(', ')
        }, this.agentContext);
      case 'compare':
        return this.compareFoods(items);
      default:
        return this.nutritionAgent.execute({
          items,
          portions,
          trackedNutrients: this.context.trackedNutrients || [],
          originalDescription: args.items.join(', ')
        }, this.agentContext);
    }
  }

  /**
   * Delegate recipe tasks to RecipeAgent
   */
  async askRecipeAgent(args: { action: string, query?: string, recipe_id?: string, servings?: number }) {
    console.log('[ToolExecutor] Delegating to RecipeAgent:', args);
    const { action, query, recipe_id, servings } = args;

    switch (action) {
      case 'find':
        return this.searchSavedRecipes(query || '');
      case 'details':
        if (!recipe_id) return { error: true, message: 'recipe_id required for details action' };
        return this.getRecipeDetails(recipe_id);
      case 'calculate_serving':
        if (!recipe_id || !servings) return { error: true, message: 'recipe_id and servings required' };
        return this.calculateRecipeServing(recipe_id, servings);
      default:
        return { error: true, message: `Unknown recipe action: ${action}` };
    }
  }

  /**
   * Delegate insight/analysis tasks to InsightAgent
   */
  async askInsightAgent(args: {
    action: 'audit' | 'patterns' | 'reflect' | 'classify_day' | 'summary',
    query?: string,
    filters?: any,
    day_type?: string,
    notes?: string
  }) {
    console.log('[ToolExecutor] Delegating to InsightAgent:', args);
    // Inject DB into context if not present (safeguard)
    const context = { ...this.agentContext, db: this.db };
    return this.insightAgent.execute(args, context);
  }

  // =============================================================
  // USER CONTEXT TOOLS
  // =============================================================

  async getUserProfile() {
    const { data } = await this.db.getUserProfile(this.context.userId);
    if (!data) {
      return {
        message: "No profile found. User hasn't set up their profile yet."
      };
    }
    return {
      height_cm: data.height_cm || data.height,
      weight_kg: data.weight_kg || data.weight,
      age: data.age,
      gender: data.gender,
      activity_level: data.activity_level,
      goal: data.health_goal || data.goal,
      dietary_preferences: data.dietary_preferences,
      allergies: data.allergies
    };
  }

  async updateUserProfile(data: any) {
    const { dietary_preferences, health_goal, allergies, notes } = data;
    const updateData: any = {};
    if (dietary_preferences) updateData.dietary_preferences = dietary_preferences;
    if (health_goal) updateData.health_goal = health_goal;
    // allergies handled via health constraints table
    if (notes) updateData.notes = notes;

    if (Object.keys(updateData).length > 0) {
      await this.db.updateUserProfile(this.context.userId, updateData);
    }

    if (allergies && Array.isArray(allergies)) {
      // Use addHealthConstraint to safely handle multiple allergies without unique constraint violations
      for (const allergy of allergies) {
        await this.db.addHealthConstraint(this.context.userId, {
          category: allergy,
          type: 'allergy',
          severity: 'critical', // Treat explicit allergies as critical/high
          notes: 'From profile update'
        });
      }
    }

    return {
      status: 'success',
      message: '✅ Profile updated with your health considerations! 🩺',
      data: { ...updateData, allergies }
    };
  }

  async manageHealthConstraints(instruction: string) {
    const updates = await parseHealthInput(instruction);
    if (!updates || updates.length === 0) {
      return {
        message: "I couldn't identify any specific health constraints to update. Please be more specific (e.g., 'I am allergic to peanuts')."
      };
    }

    const applied: string[] = [];
    for (const update of updates) {
      if (update.action === 'add') {
        await this.db.addHealthConstraint(this.context.userId, {
          category: update.category,
          type: update.type,
          severity: update.severity,
          notes: update.notes || ''
        });
        applied.push(`Added ${update.severity} ${update.type}: ${update.category}`);
      } else if (update.action === 'remove') {
        await this.db.removeHealthConstraint(this.context.userId, update.category);
        applied.push(`Removed: ${update.category}`);
      }
    }

    return {
      success: true,
      message: `Health profile updated:\n- ${applied.join('\n- ')}`,
      data: updates
    };
  }

  async getUserGoals() {
    const goals = await this.db.getUserGoals(this.context.userId);
    if (!goals || goals.length === 0) {
      return {
        message: "No goals set yet. User should set their nutrition targets."
      };
    }
    // Convert array to object for easier reading
    const goalsMap: Record<string, any> = {};
    for (const goal of goals) {
      goalsMap[goal.nutrient] = {
        target: goal.target_value,
        unit: goal.unit || (goal.nutrient === 'calories' ? 'kcal' : 'g'),
        yellow_min: goal.yellow_min,
        green_min: goal.green_min,
        red_min: goal.red_min
      };
    }
    return goalsMap;
  }

  async getTodayProgress() {
    const timezone = this.context.timezone || 'UTC';
    const { start, end } = getStartAndEndOfDay(new Date(), timezone);
    const [logs, adjustments] = await Promise.all([
      this.db.getFoodLogs(this.context.userId, start, end),
      this.db.getDailyAdjustments(this.context.userId, start.split('T')[0], end.split('T')[0])
    ]);

    // Dynamically accumulate any nutrient found in NUTRIENT_MAP
    const map = this.getMasterNutrientMap();
    const totals: Record<string, number> = {
      calories: 0,
      items_logged: 0
    };
    const adjustmentMap: Record<string, number> = {};

    // Initialize all possible keys
    Object.keys(map).forEach(key => {
      totals[key] = 0;
      adjustmentMap[key] = 0;
    });

    if (logs) {
      for (const log of logs) {
        totals.calories += log.calories || 0;
        totals.items_logged++;
        // Accumulate all other keys
        Object.keys(map).forEach(key => {
          if (key === 'fat_total_g') {
            totals[key] += log.fat_total_g || log.fat_g || 0;
          } else {
            totals[key] += (log as any)[key] || 0;
          }
        });
      }
    }

    if (adjustments) {
      for (const adj of adjustments) {
        const key = adj.nutrient;
        if (adjustmentMap[key] !== undefined) {
          adjustmentMap[key] += adj.adjustment_value;
        } else if (key === 'calories') {
          totals.calories += adj.adjustment_value; // Fallback if calories not in map
        }
      }
    }

    // Round values
    Object.keys(totals).forEach((key) => {
      totals[key] = Math.round(totals[key] * 10) / 10;
    });
    totals.calories = Math.round(totals.calories);

    return {
      consumed: totals,
      adjustments: adjustmentMap
    };
  }

  async getWeeklySummary() {
    const context = { ...this.agentContext, db: this.db };
    const result: any = await this.insightAgent.execute({ action: 'summary' }, context);
    const todayProgress = await this.getTodayProgress();
    return {
      daily_averages: result.patterns ? this.parseWeeklyAverages(result.patterns) : {},
      today_totals: todayProgress,
      goal_progress: result.goal_progress,
      suggestions: result.suggestions,
      compliance_summary: this.calculateCompliance(result.goal_progress)
    };
  }

  private parseWeeklyAverages(patterns: string[]) {
    const averages: Record<string, number> = {};
    for (const pattern of patterns) {
      const match = pattern.match(/Weekly avg (\w+): (\d+)/);
      if (match) {
        averages[match[1]] = parseInt(match[2]);
      }
    }
    return averages;
  }

  private calculateCompliance(progress: Record<string, number>) {
    const values = Object.values(progress);
    if (values.length === 0) return 'No goals to track';
    const avgProgress = values.reduce((a, b) => a + b, 0) / values.length;
    if (avgProgress >= 90 && avgProgress <= 110) return 'On track! 🎯';
    if (avgProgress < 90) return 'Under targets';
    return 'Above targets';
  }

  async getFoodHistory(days: number) {
    const timezone = this.context.timezone || 'UTC';
    const { start, end } = getDateRange(new Date(), Math.min(days, 30), timezone);
    const logs = await this.db.getFoodLogs(this.context.userId, start, end);

    const byDate: Record<string, any[]> = {};
    for (const log of logs || []) {
      const date = new Date(log.log_time).toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push({
        food_name: log.food_name,
        calories: log.calories,
        protein_g: log.protein_g,
        portion: log.portion
      });
    }
    return {
      days_requested: days,
      history: byDate,
      total_items: logs?.length || 0
    };
  }

  // =============================================================
  // NUTRITION TOOLS
  // =============================================================

  async lookupNutrition(food: string, portion: string, calories?: number, macros?: { protein?: number | null, carbs?: number | null, fat?: number | null }, originalDescription?: string) {
    console.log(`[ToolExecutor] lookupNutrition for: ${food}${calories ? ` (${calories} kcal)` : ''}`);

    // Only trust provided values if they are explicitly non-null and calories > 0
    // (Exception: user might explicitly want to log 0, but usually 0 calories for an "apple" is an error)
    const hasValidMacros = macros && (
      (macros.protein !== undefined && macros.protein !== null) ||
      (macros.carbs !== undefined && macros.carbs !== null) ||
      (macros.fat !== undefined && macros.fat !== null)
    );

    if (calories !== undefined && calories !== null && calories > 0 && hasValidMacros) {
      return {
        food_name: food,
        portion: portion || 'standard serving',
        calories,
        protein_g: macros?.protein || 0,
        carbs_g: macros?.carbs || 0,
        fat_total_g: macros?.fat || 0,
        source: 'user_provided',
        confidence: 'high',
        ...macros
      };
    }

    const goals = await this.getUserGoals();
    let trackedNutrients: string[] = [];

    if (typeof goals === 'object' && !(goals as any).message) {
      // Get technical names for all user goals
      trackedNutrients = Object.keys(goals).map(key => this.normalizeNutrientName(key));
    }

    // FIX: Only use estimateNutrition when user explicitly provided a positive calorie count.
    // Previously, null from IntentAgent passed this check (null !== undefined === true)
    // which bypassed NutritionAgent entirely and overwrote LLM estimates with null → 0.
    if (calories != null && calories > 0) {
      return this.estimateNutrition(food, portion, calories, trackedNutrients);
    }

    // Feature 2: Delegate to NutritionAgent FIRST (Cache -> API -> LLM fallback internal to agent)
    // This ensures we use the specialized agent logic instead of a generic LLM estimate here.
    const items = [food];
    const portions = [portion || '1 serving'];
    // FIX: Pass trackedNutrients so NutritionAgent can estimate all user-tracked nutrients
    const results: any[] = await this.nutritionAgent.execute({ items, portions, trackedNutrients, originalDescription }, this.agentContext);

    // Define base keys for filtering
    const baseKeys = ['calories', 'protein_g', 'carbs_g', 'fat_total_g'];

    if (results && results.length > 0) {
      const result = results[0];

      // FIX: Only accept results with positive calories for real food.
      // Previously, result.calories === 0 was accepted, letting 0-calorie results through.
      if (result && result.calories > 0) {
        const filteredResult: any = {
          food_name: result.food_name || food,
          portion: portion || result.serving_size || 'standard serving',
          calories: Math.round(result.calories || 0),
          source: result.source || 'agent',
          confidence: result.confidence || 'medium',
          confidence_details: result.confidence_details || {},
          error_sources: result.error_sources || [],
          health_flags: result.health_flags || [],
          applied_memory: result.applied_memory || null
        };

        // Map nutrient names correctly from agent result to our schema
        trackedNutrients.forEach(key => {
          // Check if key exists in result (directly or as macro alias)
          let val = result[key];

          // Fallback mapping for common aliases in agent output
          if (val === undefined) {
            if (key === 'fat_total_g') val = result.fat_g || result.fat;
            if (key === 'protein_g') val = result.protein;
            if (key === 'carbs_g') val = result.carbs;
          }

          if (val !== undefined && key !== 'calories') {
            filteredResult[key] = typeof val === 'number' ? Math.round(val * 10) / 10 : val;
          } else if (baseKeys.includes(key) && key !== 'calories') {
            // FIX: Was overwriting filteredResult.calories (already set correctly at line 395) to 0.
            // The 'key !== calories' guard in the if-branch meant calories always fell to this else-if,
            // which unconditionally set it to 0. Now we also exclude calories from this fallback.
            filteredResult[key] = 0;
          }
        });

        // Ensure base keys exist
        baseKeys.forEach(k => {
          if (filteredResult[k] === undefined) filteredResult[k] = 0;
        });

        return filteredResult;
      }
    }

    console.warn(`[ToolExecutor] NutritionAgent returned no valid data for "${food}", falling back to generic estimate`);
    return this.estimateNutrition(food, portion, undefined, trackedNutrients);
  }

  private getMasterNutrientMap(): Record<string, { name: string, unit: string }> {
    return {
      calories: { name: "Calories", unit: "kcal" },
      protein_g: { name: "Protein", unit: "g" },
      fat_total_g: { name: "Total Fat", unit: "g" },
      carbs_g: { name: "Carbohydrates", unit: "g" },
      hydration_ml: { name: "Water", unit: "ml" },
      fat_saturated_g: { name: "Saturated Fat", unit: "g" },
      fat_poly_g: { name: "Polyunsaturated Fat", unit: "g" },
      fat_mono_g: { name: "Monounsaturated Fat", unit: "g" },
      fat_trans_g: { name: "Trans Fat", unit: "g" },
      omega_3_g: { name: "Omega-3 Fatty Acids", unit: "g" },
      omega_6_g: { name: "Omega-6 Fatty Acids", unit: "g" },
      omega_ratio: { name: "Omega 6:3 Ratio", unit: "" },
      fiber_g: { name: "Dietary Fiber", unit: "g" },
      fiber_soluble_g: { name: "Soluble Fiber", unit: "g" },
      sugar_g: { name: "Total Sugars", unit: "g" },
      sugar_added_g: { name: "Added Sugars", unit: "g" },
      cholesterol_mg: { name: "Cholesterol", unit: "mg" },
      sodium_mg: { name: "Sodium", unit: "mg" },
      potassium_mg: { name: "Potassium", unit: "mg" },
      calcium_mg: { name: "Calcium", unit: "mg" },
      iron_mg: { name: "Iron", unit: "mg" },
      magnesium_mg: { name: "Magnesium", unit: "mg" },
      phosphorus_mg: { name: "Phosphorus", unit: "mg" },
      zinc_mg: { name: "Zinc", unit: "mg" },
      copper_mg: { name: "Copper", unit: "mg" },
      manganese_mg: { name: "Manganese", unit: "mg" },
      selenium_mcg: { name: "Selenium", unit: "mcg" },
      vitamin_a_mcg: { name: "Vitamin A", unit: "mcg" },
      vitamin_c_mg: { name: "Vitamin C", unit: "mg" },
      vitamin_d_mcg: { name: "Vitamin D", unit: "mcg" },
      vitamin_e_mg: { name: "Vitamin E", unit: "mg" },
      vitamin_k_mcg: { name: "Vitamin K", unit: "mcg" },
      thiamin_mg: { name: "Thiamin (B1)", unit: "mg" },
      riboflavin_mg: { name: "Riboflavin (B2)", unit: "mg" },
      niacin_mg: { name: "Niacin (B3)", unit: "mg" },
      pantothenic_acid_mg: { name: "Pantothenic Acid (B5)", unit: "mg" },
      vitamin_b6_mg: { name: "Vitamin B6", unit: "mg" },
      biotin_mcg: { name: "Biotin (B7)", unit: "mcg" },
      folate_mcg: { name: "Folate (B9)", unit: "mcg" },
      vitamin_b12_mcg: { name: "Vitamin B12", unit: "mcg" },
    };
  }

  async estimateNutrition(description: string, portion?: string, calories_hint?: number, trackedNutrients: string[] = []) {
    const openai = createOpenAIClient();
    const map = this.getMasterNutrientMap();

    const hintPrompt = calories_hint ? `\nIMPORTANT: The user has specified that this food has EXACTLY ${calories_hint} kcal. Your goal is to estimate the macros (protein, carbs, fat) that would logically make up these ${calories_hint} calories for this type of food (using 4 kcal/g for protein/carbs and 9 kcal/g for fat). DO NOT deviate from ${calories_hint} kcal unless absolutely necessary for mathematical consistency.` : 'Always provide realistic estimates - never return 0 calories for foods that have calories.';

    const baseKeys = ['calories', 'protein_g', 'carbs_g', 'fat_total_g'];
    const allToEstimate = Array.from(new Set([...baseKeys, ...trackedNutrients]));

    const nutrientListPrompt = allToEstimate.map(key => {
      const info = map[key];
      return `- ${key}: number (${info ? `${info.name} in ${info.unit}` : key})`;
    }).join('\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a nutrition estimation expert. Estimate the nutrition for the given food.
Return a JSON object with these fields:
- food_name: string (clean name of the food)
- portion: string (the portion size)
${nutrientListPrompt}
 
Be reasonable and accurate. Use your knowledge of typical nutrition values. Even if a nutrient value is 0 (e.g. fat in an apple), you MUST include it in the response as 0. ${hintPrompt}`
        },
        {
          role: 'user',
          content: `Estimate nutrition for: ${portion ? portion + ' of ' : ''}${description}`
        }
      ],
      response_format: {
        type: 'json_object'
      },
      max_tokens: 300
    });
    try {
      const estimate = JSON.parse(response.choices[0].message.content || '{}');
      // FIX: Only override LLM calories when hint is a valid positive number.
      // Previously, null from IntentAgent passed (null !== undefined === true)
      // and overwrote valid LLM estimates with null → 0.
      if (calories_hint != null && calories_hint > 0) estimate.calories = calories_hint;

      const filtered: any = {
        food_name: estimate.food_name || description,
        portion: estimate.portion || portion || 'serving',
        source: 'estimate',
        estimated: true
      };

      allToEstimate.forEach(key => {
        const value = this.getNutrientValue(estimate, key);
        if (value !== undefined) {
          const numValue = typeof value === 'number' ? value : parseFloat(value);
          filtered[key] = !isNaN(numValue) ? Math.round(numValue * 10) / 10 : 0;
        } else if (trackedNutrients.includes(key) || baseKeys.includes(key)) {
          // Default to 0 for any tracked nutrient or macro if missing
          filtered[key] = 0;
        }
      });

      // FIX: If calories is missing or 0, calculate from macros before defaulting.
      // Previously, this just set calories = 0, allowing malformed LLM responses
      // to produce 0-calorie food logs.
      if (!filtered.calories || filtered.calories <= 0) {
        const calcCals = ((filtered.protein_g || 0) * 4) + ((filtered.carbs_g || 0) * 4) + ((filtered.fat_total_g || 0) * 9);
        if (calcCals > 0) {
          console.log(`[ToolExecutor] estimateNutrition: 0 calories from LLM for "${description}", calculated ${Math.round(calcCals)} from macros`);
          filtered.calories = Math.round(calcCals);
        } else {
          // Last resort: LLM returned nothing useful. Log a warning.
          console.warn(`[ToolExecutor] estimateNutrition: No calories or macros from LLM for "${description}"`);
          filtered.calories = 0;
        }
      }

      return filtered;
    } catch (e) {
      return {
        error: true,
        message: `Could not estimate nutrition for "${description}"`
      };
    }
  }

  async validateNutrition(data: any) {
    const item = {
      food_name: data.food_name,
      calories: data.calories,
      protein_g: data.protein_g || 0,
      carbs_g: data.carbs_g || 0,
      fat_total_g: data.fat_total_g || data.fat_g || 0,
      serving_size: '1 serving'
    };
    const result: any = await this.validatorAgent.execute([item], this.agentContext);
    return {
      valid: result.passed,
      issues: [...result.errors, ...result.warnings],
      suggestion: result.passed ? null : 'Consider using estimate_nutrition for a better estimate or checking the values.'
    };
  }

  async compareFoods(foods: string[]) {
    const comparisons: any[] = await Promise.all(foods.slice(0, 5).map((food) => this.lookupNutrition(food, '1 serving')));
    return {
      foods: comparisons,
      best_protein: this.findBest(comparisons, 'protein_g'),
      lowest_calories: this.findLowest(comparisons, 'calories'),
      comparison_note: this.generateComparisonNote(comparisons)
    };
  }

  private findBest(items: any[], field: string) {
    const best = items.reduce((a, b) => (a[field] || 0) > (b[field] || 0) ? a : b);
    return best.food_name;
  }

  private findLowest(items: any[], field: string) {
    const lowest = items.reduce((a, b) => (a[field] || 9999) < (b[field] || 9999) ? a : b);
    return lowest.food_name;
  }

  private generateComparisonNote(items: any[]) {
    const names = items.map((i) => i.food_name).join(', ');
    return `Compared ${items.length} foods: ${names}`;
  }

  // =============================================================
  // RECIPE TOOLS
  // =============================================================

  async searchSavedRecipes(query: string) {
    if (!query || query.trim().length < 2) {
      return {
        message: "Please provide a more specific search term.",
        recipes: []
      };
    }
    const words = query.trim().split(/\s+/).filter((w) => w.length > 1);
    const searchPattern = words.length > 0 ? `%${words.join('%')}%` : `%${query.trim()}%`;
    const { data, error } = await this.context.supabase.from('user_recipes').select('id, recipe_name, nutrition_data, servings').eq('user_id', this.context.userId).ilike('recipe_name', searchPattern).limit(5);
    if (error) throw error;
    if (!data || data.length === 0) {
      return {
        message: `No recipes found matching "${query}"`
      };
    }
    return {
      recipes: data.map((r: any) => ({
        id: r.id,
        name: r.recipe_name,
        servings: r.servings || 1,
        calories_per_serving: r.nutrition_data?.calories ? Math.round(r.nutrition_data.calories / (r.servings || 1)) : 0
      }))
    };
  }

  async getRecipeDetails(recipeId: string) {
    const [{ data: recipe }, ingredients] = await Promise.all([
      this.context.supabase.from('user_recipes').select('id, recipe_name, servings, nutrition_data').eq('id', recipeId).single(),
      this.db.getRecipeIngredients(recipeId)
    ]);
    if (!recipe) {
      return {
        error: true,
        message: 'Recipe not found'
      };
    }
    const nutrition = recipe.nutrition_data || {};
    return {
      id: recipe.id,
      name: recipe.recipe_name,
      servings: recipe.servings || 1,
      nutrition_per_serving: {
        calories: Math.round((nutrition.calories || 0) / (recipe.servings || 1)),
        protein_g: Math.round((nutrition.protein_g || 0) / (recipe.servings || 1) * 10) / 10,
        carbs_g: Math.round((nutrition.carbs_g || 0) / (recipe.servings || 1) * 10) / 10,
        fat_total_g: Math.round((nutrition.fat_total_g || 0) / (recipe.servings || 1) * 10) / 10
      },
      total_batch: {
        calories: nutrition.calories || 0,
        protein_g: nutrition.protein_g || 0,
        carbs_g: nutrition.carbs_g || 0,
        fat_total_g: nutrition.fat_total_g || 0
      },
      ingredients: ingredients
    };
  }

  async parseRecipeText(recipeText: string, recipeName?: string) {
    // FIX: specific bug where recipeName becomes "String" string literal or object
    let cleanName = recipeName;
    if (typeof recipeName === 'string' && (recipeName === 'String' || recipeName === 'string' || recipeName === 'undefined')) {
      cleanName = undefined;
    }

    const result = await this.recipeAgent.execute({
      type: 'parse',
      text: recipeText,
      recipeName: cleanName
    }, this.agentContext);
    return result;
  }

  async calculateRecipeServing(recipeId: string, servings: number) {
    const details: any = await this.getRecipeDetails(recipeId);
    if (details.error) return details;
    const scale = servings / (details.servings || 1);
    return {
      recipe_name: details.name,
      servings_calculated: servings,
      nutrition: {
        calories: Math.round((details.nutrition_per_serving?.calories || 0) * scale),
        protein_g: Math.round((details.nutrition_per_serving?.protein_g || 0) * scale * 10) / 10,
        carbs_g: Math.round((details.nutrition_per_serving?.carbs_g || 0) * scale * 10) / 10,
        fat_total_g: Math.round((details.nutrition_per_serving?.fat_total_g || 0) * scale * 10) / 10
      }
    };
  }

  // =============================================================
  // LOGGING TOOLS
  // =============================================================

  async proposeFoodLog(data: any) {
    console.log('[ToolExecutor] proposeFoodLog input:', JSON.stringify(data));
    const goals = await this.getUserGoals();
    let trackedKeys: string[] = ['calories', 'protein_g', 'carbs_g', 'fat_total_g'];

    if (typeof goals === 'object' && !(goals as any).message) {
      trackedKeys = Object.keys(goals).map(key => this.normalizeNutrientName(key));
      // Ensure calories is always included if not in goals
      if (!trackedKeys.includes('calories')) trackedKeys.push('calories');
    }

    const proposalId = `food_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const filteredData: any = {
      food_name: data.food_name,
      portion: data.portion || 'serving',
      confidence: data.confidence,
      confidence_details: data.confidence_details,
      error_sources: data.error_sources
    };

    // FIX: Always include standard nutrients even if not explicitly verified as a goal
    const standardNutrients = [
      'calories', 'protein_g', 'carbs_g', 'fat_total_g', 'hydration_ml',
      'fiber_g', 'sugar_g', 'sodium_mg', 'cholesterol_mg', 'potassium_mg',
      'fat_saturated_g', 'fat_trans_g', 'fat_mono_g', 'fat_poly_g'
    ];

    // Merge tracked keys with standard ones to ensure nothing is missed
    const allKeys = Array.from(new Set([...trackedKeys, ...standardNutrients]));

    allKeys.forEach(key => {
      const value = this.getNutrientValue(data, key);

      if (value !== undefined) {
        const numValue = typeof value === 'number' ? value : parseFloat(value);
        filteredData[key] = !isNaN(numValue) ? Math.round(numValue * 10) / 10 : 0;
      } else if (trackedKeys.includes(key)) {
        // Only default to 0 for explicitly tracked goals
        filteredData[key] = 0;
      }
    });

    // Ensure calories is explicitly set for the proposal message
    if (filteredData.calories === undefined) filteredData.calories = 0;

    // Feature 10: Validate Nutrient Hierarchy (AI Feedback Loop)
    // If the AI proposes invalid data (e.g. Sugar > Carbs), reject it immediately
    // and ask the AI to correct it. Do NOT show this to the user.
    const validation = validateNutrientHierarchy(filteredData);
    if (!validation.valid) {
      console.warn(`[ToolExecutor] Rejecting invalid food log proposal: ${validation.violations.join(', ')}`);
      return {
        error: true,
        message: `Scientific impossibility detected: ${validation.violations.join(', ')}. Please recalculate and try again with corrected values.`
      };
    }

    // Attach metadata for the UI (Feature 3)
    filteredData.confidence = data.confidence || 'medium';
    filteredData.confidence_details = data.confidence_details || {};
    filteredData.error_sources = data.error_sources || [];
    filteredData.health_flags = data.health_flags || [];
    filteredData.applied_memory = data.applied_memory || null;

    return {
      proposal_type: 'food_log',
      proposal_id: proposalId,
      pending: true,
      data: filteredData,
      message: `Ready to log ${data.food_name} (${Math.round(filteredData.calories)} cal). Please confirm.`
    };
  }

  async proposeRecipeLog(data: any) {
    const goals = await this.getUserGoals();
    let trackedKeys: string[] = ['calories', 'protein_g', 'carbs_g', 'fat_total_g'];

    if (typeof goals === 'object' && !(goals as any).message) {
      trackedKeys = Object.keys(goals).map(key => this.normalizeNutrientName(key));
      // Ensure calories is always included if not in goals
      if (!trackedKeys.includes('calories')) trackedKeys.push('calories');
    }

    const proposalId = `recipe_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const filteredData: any = {
      recipe_id: data.recipe_id,
      recipe_name: data.recipe_name,
      servings: data.servings
    };

    trackedKeys.forEach(key => {
      const value = this.getNutrientValue(data, key);

      if (value !== undefined) {
        const numValue = typeof value === 'number' ? value : parseFloat(value);
        filteredData[key] = !isNaN(numValue) ? Math.round(numValue * 10) / 10 : 0;
      } else {
        filteredData[key] = 0;
      }
    });

    if (filteredData.calories === undefined) filteredData.calories = 0;

    return {
      proposal_type: 'recipe_log',
      proposal_id: proposalId,
      pending: true,
      data: filteredData,
      message: `Ready to log ${data.servings} serving(s) of ${data.recipe_name} (${Math.round(filteredData.calories)} cal). Please confirm.`
    };
  }

  async confirmPendingLog(proposalId: string) {
    return {
      status: 'pending_frontend_confirmation',
      proposal_id: proposalId,
      message: 'Awaiting user confirmation via UI'
    };
  }

  // =============================================================
  // MEMORY TOOLS (NEW)
  // =============================================================

  async storeMemory(args: any) {
    const { category, fact } = args;
    if (!category || !fact) {
      return { error: true, message: 'Category and fact are required' };
    }
    await this.db.saveMemory(this.context.userId, category, fact, 'Chat Interaction');
    return {
      status: 'success',
      message: 'Memory stored successfully.',
      data: { category, fact }
    };
  }

  async searchMemory(args: any) {
    const { query } = args;
    const categories = ['food', 'health', 'habits', 'preferences'];
    const memories = await this.db.getMemories(this.context.userId, categories);

    if (!memories || memories.length === 0) {
      return { matches: [] };
    }

    const lowerQuery = query.toLowerCase();
    const matches = memories.filter((m: any) =>
      m.fact.toLowerCase().includes(lowerQuery) ||
      m.category.toLowerCase().includes(lowerQuery)
    );

    return {
      query,
      matches: matches.slice(0, 5)
    };
  }

  // =============================================================
  // GOAL TOOLS
  // =============================================================

  /**
   * Helper to normalize nutrient names to technical column names
   */
  private normalizeNutrientName(name: string): string {
    const lower = name.toLowerCase();
    const map = this.getMasterNutrientMap();

    // Direct match with column names
    if (map[lower]) return lower;

    // Reverse lookup by human name
    for (const [key, info] of Object.entries(map)) {
      if (info.name.toLowerCase() === lower) return key;
    }

    // Common aliases
    const aliases: Record<string, string> = {
      'water': 'hydration_ml',
      'hydration': 'hydration_ml',
      'liquid': 'hydration_ml',
      'fluids': 'hydration_ml',
      'protein': 'protein_g',
      'carbs': 'carbs_g',
      'carbohydrates': 'carbs_g',
      'fat': 'fat_total_g',
      'total fat': 'fat_total_g',
      'fiber': 'fiber_g',
      'sugar': 'sugar_g',
      'sugars': 'sugar_g',
      'sodium': 'sodium_mg',
      'calories': 'calories'
    };

    return aliases[lower] || lower;
  }

  async updateUserGoal(nutrient: string, targetValue: number, unit?: string, thresholds: any = {}) {
    const proposalId = `goal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const normalizedNutrient = this.normalizeNutrientName(nutrient);
    const defaultUnit = normalizedNutrient === 'calories' ? 'kcal' : normalizedNutrient === 'sodium_mg' ? 'mg' : 'g';

    // Clean up thresholds (remove undefined)
    const cleanedThresholds: any = {};
    if (thresholds.yellow_min !== undefined) cleanedThresholds.yellow_min = thresholds.yellow_min;
    if (thresholds.green_min !== undefined) cleanedThresholds.green_min = thresholds.green_min;
    if (thresholds.red_min !== undefined) cleanedThresholds.red_min = thresholds.red_min;

    return {
      proposal_type: 'goal_update',
      proposal_id: proposalId,
      pending: true,
      data: {
        nutrient: normalizedNutrient,
        target_value: targetValue,
        unit: unit || defaultUnit,
        ...cleanedThresholds
      },
      message: `Ready to update ${normalizedNutrient} goal to ${targetValue}${unit || defaultUnit}${Object.keys(cleanedThresholds).length ? ' with custom thresholds' : ''}. Please confirm.`
    };
  }

  async bulkUpdateUserGoals(goals: any[]) {
    const proposalId = `bulk_goal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const processedGoals = goals.map(g => {
      const normalizedNutrient = this.normalizeNutrientName(g.nutrient);
      const defaultUnit = normalizedNutrient === 'calories' ? 'kcal' : normalizedNutrient === 'sodium_mg' ? 'mg' : 'g';

      const thresholds: any = {};
      if (g.yellow_min !== undefined) thresholds.yellow_min = g.yellow_min;
      if (g.green_min !== undefined) thresholds.green_min = g.green_min;
      if (g.red_min !== undefined) thresholds.red_min = g.red_min;

      return {
        nutrient: normalizedNutrient,
        value: g.target_value,
        unit: g.unit || defaultUnit,
        ...thresholds
      };
    });

    return {
      proposal_type: 'bulk_goal_update',
      proposal_id: proposalId,
      pending: true,
      data: {
        goals: processedGoals
      },
      message: `Ready to update ${processedGoals.length} nutrition goals. Please confirm.`
    };
  }

  async applyDailyWorkoutOffset(value: number, nutrient: string = 'calories', notes?: string) {
    const proposalId = `workout_${Date.now()}`;
    const nutrientMap: Record<string, string> = {
      'protein': 'protein_g',
      'carbs': 'carbs_g',
      'fat': 'fat_total_g',
      'fiber': 'fiber_g'
    };
    const normalizedNutrient = nutrientMap[nutrient.toLowerCase()] || nutrient.toLowerCase();

    // Directly apply or propose? The requirement says "AI triggers a call". 
    // Usually PCC pattern is better for tracking.
    return {
      proposal_type: 'workout_adjustment',
      proposal_id: proposalId,
      pending: true,
      data: {
        nutrient: normalizedNutrient,
        adjustment_value: value,
        notes: notes || 'Daily workout'
      },
      message: `I'll add a ${value} ${normalizedNutrient === 'calories' ? 'kcal' : 'g'} bonus to your ${normalizedNutrient} target for today's workout. Sound good?`
    };
  }

  async calculateRecommendedGoals() {
    const profile: any = await this.getUserProfile();
    if (profile.message) {
      return {
        error: true,
        message: 'Need profile data to calculate recommended goals'
      };
    }
    let bmr;
    if (profile.gender === 'male') {
      bmr = 10 * profile.weight_kg + 6.25 * profile.height_cm - 5 * profile.age + 5;
    } else {
      bmr = 10 * profile.weight_kg + 6.25 * profile.height_cm - 5 * profile.age - 161;
    }
    const activityMultipliers: Record<string, number> = {
      sedentary: 1.2,
      light: 1.375,
      moderate: 1.55,
      active: 1.725,
      very_active: 1.9
    };
    const tdee = bmr * (activityMultipliers[profile.activity_level] || 1.55);
    let targetCalories = tdee;
    if (profile.goal === 'lose weight') targetCalories = tdee - 500;
    if (profile.goal === 'gain muscle') targetCalories = tdee + 300;
    const proteinPerKg = profile.goal === 'gain muscle' ? 2.0 : 1.6;
    const protein_g = Math.round(profile.weight_kg * proteinPerKg);
    const fat_g = Math.round(targetCalories * 0.25 / 9);
    const carbs_g = Math.round((targetCalories - protein_g * 4 - fat_g * 9) / 4);
    return {
      recommended: {
        calories: Math.round(targetCalories),
        protein_g,
        carbs_g,
        fat_g,
        fiber_g: profile.gender === 'male' ? 38 : 25,
        sugar_g: 50
      },
      calculation_basis: {
        bmr: Math.round(bmr),
        tdee: Math.round(tdee),
        goal: profile.goal,
        activity_level: profile.activity_level
      }
    };
  }

  // =============================================================
  // INSIGHT TOOLS
  // =============================================================

  async getFoodRecommendations(focus?: string, preferences?: string) {
    const progress: any = await this.getTodayProgress();
    const goals = await this.getUserGoals();
    const remaining: Record<string, number> = {};
    if (typeof goals !== 'object' || (goals as any).message) {
      return {
        message: 'Need goals set to provide recommendations'
      };
    }
    for (const [nutrient, goalData] of Object.entries(goals as Record<string, any>)) {
      const consumed = progress[nutrient] || 0;
      remaining[nutrient] = Math.max(0, goalData.target - consumed);
    }
    const openai = createOpenAIClient();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a nutrition advisor. Suggest 3 foods or meals based on remaining nutritional needs.
Consider the user's focus (${focus || 'balanced'}) and preferences (${preferences || 'none specified'}).
Return JSON with: { suggestions: [{ food: string, reason: string, approximate_nutrition: { calories, protein_g } }] }`
        },
        {
          role: 'user',
          content: `Remaining needs today: ${JSON.stringify(remaining)}`
        }
      ],
      response_format: {
        type: 'json_object'
      },
      max_tokens: 300
    });
    try {
      return JSON.parse(response.choices[0].message.content || '{}');
    } catch {
      return {
        message: 'Could not generate recommendations'
      };
    }
  }

  async analyzeEatingPatterns(days: number) {
    const history = await this.getFoodHistory(days);
    const openai = createOpenAIClient();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Analyze eating patterns from the food log. Look for:
- Consistent meal times
- Common foods
- Potential gaps (missing meals, low variety)
- Trends (increasing/decreasing calories)
Return JSON with: { patterns: string[], insights: string[], suggestions: string[] }`
        },
        {
          role: 'user',
          content: `Food history: ${JSON.stringify(history)}`
        }
      ],
      response_format: {
        type: 'json_object'
      },
      max_tokens: 400
    });
    try {
      return JSON.parse(response.choices[0].message.content || '{}');
    } catch {
      return {
        message: 'Could not analyze patterns'
      };
    }
  }

  async getProgressReport() {
    const [profile, goals, progress, weekly]: [any, any, any, any] = await Promise.all([
      this.getUserProfile(),
      this.getUserGoals(),
      this.getTodayProgress(),
      this.getWeeklySummary()
    ]);
    return {
      profile_summary: profile.message ? null : {
        goal: profile.goal,
        weight: profile.weight_kg
      },
      goals,
      today: progress,
      weekly_summary: weekly,
      overall_status: weekly.compliance_summary
    };
  }

  /**
   * Universal resolver: checks data (and common sub-objects) for a technical key, its human name, or common aliases.
   */
  private getNutrientValue(data: any, key: string): any {
    if (!data) return undefined;

    const map = this.getMasterNutrientMap();
    const info = map[key];
    const aliasesList = {
      'fat_total_g': ['fat', 'total_fat', 'fat_g'],
      'carbs_g': ['carbs', 'carbohydrates', 'total_carbohydrates', 'carb_g'],
      'protein_g': ['protein', 'protein_g'],
      'hydration_ml': ['water', 'hydration', 'liquid', 'fluids'],
      'fiber_g': ['fiber', 'dietary_fiber', 'fiber_g'],
      'sugar_g': ['sugar', 'sugars', 'total_sugar', 'total_sugars', 'sugar_g'],
      'sodium_mg': ['sodium', 'sodium_mg'],
      'calories': ['kcal', 'energy', 'calories']
    };

    // Helper to search within a specific object
    const findInObject = (obj: any): any => {
      if (obj[key] !== undefined) return obj[key];

      // Case-insensitive check of all keys
      const lowerKey = key.toLowerCase();
      for (const k of Object.keys(obj)) {
        if (k.toLowerCase() === lowerKey) return obj[k];
      }

      // Check human names from map
      if (info) {
        const humanName = info.name.toLowerCase();
        for (const k of Object.keys(obj)) {
          const lowerK = k.toLowerCase();
          if (lowerK === humanName || lowerK === humanName.replace(/\s/g, '_')) return obj[k];
        }
      }

      // Check common aliases
      const aliases = (aliasesList as any)[key] || [];
      for (const alias of aliases) {
        if (obj[alias] !== undefined) return obj[alias];
        // Case-insensitive alias check
        for (const k of Object.keys(obj)) {
          if (k.toLowerCase() === alias.toLowerCase()) return obj[k];
        }
      }

      // Check short name (e.g. "protein" for "protein_g")
      const short = key.split('_')[0];
      if (obj[short] !== undefined) return obj[short];

      return undefined;
    };

    // Try top-level first
    let result = findInObject(data);

    // If not found, look into common sub-objects the AI might use
    if (result === undefined) {
      const subObjects = ['nutrition', 'estimate', 'data', 'nutrients', 'values'];
      for (const subKey of subObjects) {
        if (data[subKey] && typeof data[subKey] === 'object') {
          result = findInObject(data[subKey]);
          if (result !== undefined) break;
        }
      }
    }

    return result;
  }
}
