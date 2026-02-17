/**
 * Service to handle database operations, decoupling persistence from orchestrator
 */
import { getStartAndEndOfDay, getDateRange } from '../../_shared/utils.ts';
import { validateNutrientHierarchy } from '../../_shared/nutrient-validation.ts';

export class DbService {
  supabase: any;
  constructor(supabase: any) {
    this.supabase = supabase;
  }
  /**
   * Logs food items to the database
   */ async logFoodItems(userId: string, items: any[]) {
    // Validate each item for nutrient hierarchy (Feature 10)
    for (const item of items) {
      const validation = validateNutrientHierarchy(item);
      if (!validation.valid) {
        const errorMsg = `Nutrient Validation Failed for "${item.food_name}": ${validation.violations.join(', ')}`;
        console.error(`[DbService] ${errorMsg}`);
        throw new Error(errorMsg);
      }
    }

    const { error } = await this.supabase.from('food_log').insert(items.map((item: any) => ({
      ...item,
      user_id: userId,
      confidence: item.confidence,
      confidence_details: item.confidence_details,
      error_sources: item.error_sources
    })));
    if (error) {
      console.error('[DbService] Error logging food items:', error);
      throw error;
    }
  }
  /**
   * Fetches food logs for a user within a time range
   */ async getFoodLogs(userId: string, start: string, end: string) {
    const { data, error } = await this.supabase.from('food_log').select('*').eq('user_id', userId).gte('log_time', start).lte('log_time', end);
    if (error) {
      console.error('[DbService] Error fetching food logs:', error);
      throw error;
    }
    return data;
  }
  /**
   * Fetches user goals
   */ async getUserGoals(userId: string) {
    const { data, error } = await this.supabase.from('user_goals').select('nutrient, target_value, unit, goal_type, yellow_min, green_min, red_min').eq('user_id', userId);
    if (error) {
      console.error('[DbService] Error fetching user goals:', error);
      throw error;
    }
    return data;
  }
  /**
   * Updates a recipe's nutrition data
   */ async updateRecipeNutrition(recipeId: string, nutritionData: any) {
    const { error } = await this.supabase.from('user_recipes').update({
      nutrition_data: nutritionData
    }).eq('id', recipeId);
    if (error) {
      console.error('[DbService] Error updating recipe nutrition:', error);
      throw error;
    }
  }
  /**
   * Fetches ingredients for a recipe
   */ async getRecipeIngredients(recipeId: string) {
    const { data, error } = await this.supabase.from('recipe_ingredients').select('*').eq('recipe_id', recipeId);
    if (error) {
      console.error('[DbService] Error fetching recipe ingredients:', error);
      throw error;
    }
    return data;
  }
  /**
   * Updates a user's nutritional goal
   */ async updateUserGoal(userId: string, nutrient: string, value: number, unit: string, goalType: 'goal' | 'limit' = 'goal', thresholds: any = {}) {
    const { error } = await this.supabase.from('user_goals').upsert({
      user_id: userId,
      nutrient: nutrient,
      target_value: value,
      unit: unit,
      goal_type: goalType,
      ...thresholds
    }, {
      onConflict: 'user_id, nutrient'
    });
    if (error) {
      console.error('[DbService] Error updating user goal:', error);
      throw error;
    }
  }
  /**
   * Fetches recent messages for context
   */ async getRecentMessages(userId: string, sessionId: string, limit: number = 10) {
    const { data, error } = await this.supabase.from('chat_messages').select('*').eq('user_id', userId).eq('session_id', sessionId).order('created_at', {
      ascending: false
    }).limit(limit);
    if (error) {
      console.error('[DbService] Error fetching recent messages:', error);
      throw error;
    }
    return data;
  }
  /**
   * Updates multiple user nutritional goals in a single transaction-like call
   */ async updateUserGoals(userId: string, goals: any[]) {
    const { error } = await this.supabase.from('user_goals').upsert(goals.map((g: any) => ({
      user_id: userId,
      nutrient: g.nutrient,
      target_value: g.value,
      unit: g.unit,
      goal_type: g.goal_type || 'goal',
      yellow_min: g.yellow_min,
      green_min: g.green_min,
      red_min: g.red_min
    })), {
      onConflict: 'user_id, nutrient'
    });
    if (error) {
      console.error('[DbService] Error updating user goals:', error);
      throw error;
    }
  }
  /**
   * Updates a user's profile information
   */ async updateUserProfile(userId: string, data: any) {
    const { error } = await this.supabase.from('user_profiles').update(data).eq('id', userId);
    if (error) {
      console.error('[DbService] Error updating user profile:', error);
      throw error;
    }
  }
  /**
   * Fetches user profile with safe handling for missing rows
   */ async getUserProfile(userId: string) {
    const { data, error } = await this.supabase.from('user_profiles').select('*').eq('id', userId).maybeSingle();
    if (error) {
      console.error('[DbService] Error fetching user profile:', error);
      throw error;
    }
    return {
      data
    };
  }
  /**
   * Adds a daily adjustment (e.g., workout)
   */ async addDailyAdjustment(userId: string, adjustment: any) {
    const { error } = await this.supabase.from('daily_adjustments').upsert({
      user_id: userId,
      nutrient: adjustment.nutrient,
      adjustment_value: adjustment.adjustment_value,
      adjustment_type: adjustment.adjustment_type || 'workout',
      notes: adjustment.notes,
      adjustment_date: adjustment.date || new Date().toISOString().split('T')[0]
    }, {
      onConflict: 'user_id, adjustment_date, nutrient, adjustment_type'
    });
    if (error) {
      console.error('[DbService] Error adding daily adjustment:', error);
      throw error;
    }
  }
  /**
   * Fetches daily adjustments for a date range
   */ async getDailyAdjustments(userId: string, start: string, end: string) {
    const { data, error } = await this.supabase.from('daily_adjustments').select('*').eq('user_id', userId).gte('adjustment_date', start).lte('adjustment_date', end);
    if (error) {
      console.error('[DbService] Error fetching daily adjustments:', error);
      throw error;
    }
    return data;
  }
  /**
   * Fetches the day classification for a user on a specific date
   */ async getDayClassification(userId: string, date: string) {
    const { data, error } = await this.supabase.from('daily_classification').select('*').eq('user_id', userId).eq('date', date).maybeSingle();
    if (error) {
      console.error('[DbService] Error fetching day classification:', error);
      throw error;
    }
    return data;
  }
  /**
   * Sets or updates the day classification for a user
   */ async setDayClassification(userId: string, date: string, type: string, notes: string | null = null) {
    const { error } = await this.supabase.from('daily_classification').upsert({
      user_id: userId,
      date: date,
      day_type: type,
      notes: notes
    }, {
      onConflict: 'user_id, date'
    });
    if (error) {
      console.error('[DbService] Error setting day classification:', error);
      throw error;
    }
  }
  async getHistoricalData(userId: string, filters: { days?: number, range?: { start: string, end: string }, type?: string }, timezone: string = 'UTC') {
    let query = this.supabase.from('food_log').select('*').eq('user_id', userId);
    if (filters.days) {
      const { start } = getDateRange(new Date(), filters.days, timezone);
      query = query.gte('log_time', start);
    } else if (filters.range) {
      query = query.gte('log_time', filters.range.start).lte('log_time', filters.range.end);
    }
    const { data: logs, error: logsError } = await query.order('log_time', {
      ascending: true
    });
    if (logsError) throw logsError;

    // Fetch classifications
    let classQuery = this.supabase.from('daily_classification').select('*').eq('user_id', userId);
    if (filters.type) {
      classQuery = classQuery.eq('day_type', filters.type);
    }
    const { data: classifications, error: classError } = await classQuery;
    if (classError) throw classError;

    // If type filter is provided, filter logs to only include those from matching days
    let filteredLogs = logs;
    if (filters.type && classifications.length > 0) {
      const validDates = new Set(classifications.map((c: any) => c.date));
      filteredLogs = logs.filter((l: any) => validDates.has(new Date(l.log_time).toISOString().split('T')[0]));
    }

    return {
      logs: filteredLogs,
      classifications
    };
  }

  /**
   * Fetches summarized daily totals for analysis, grouping by the user's local date
   */
  async getAnalyticalData(userId: string, days: number = 7, timezone: string = 'UTC') {
    const { logs, classifications } = await this.getHistoricalData(userId, { days }, timezone);
    console.log(`[DbService] getAnalyticalData: Found ${logs.length} logs for range. Timezone: ${timezone}`);

    // Group logs by date and calculate totals
    const dailyTotals: Record<string, any> = {};
    const metadataFields = ['id', 'user_id', 'food_name', 'meal_type', 'log_time', 'created_at', 'updated_at', 'portion', 'recipe_id', 'extras', 'confidence', 'confidence_details', 'error_sources', 'hydration_ml'];

    logs.forEach((log: any) => {
      // Use the user's timezone to get the date string (YYYY-MM-DD)
      const date = new Date(log.log_time).toLocaleDateString('en-CA', { timeZone: timezone });
      console.log(`[DbService] Map log "${log.food_name}" (${log.log_time}) to local date: ${date}`);
      if (!dailyTotals[date]) {
        dailyTotals[date] = {
          items: []
        };
      }

      // Dynamically aggregate all numeric fields
      Object.keys(log).forEach(key => {
        if (!metadataFields.includes(key) && typeof log[key] === 'number') {
          dailyTotals[date][key] = (dailyTotals[date][key] || 0) + log[key];
        }
      });

      // Special handling for hydration (sometimes named differently in logs vs schema)
      const water = log.hydration_ml || log.water_ml || 0;
      if (water > 0) {
        dailyTotals[date].water_ml = (dailyTotals[date].water_ml || 0) + water;
      }

      dailyTotals[date].items.push(log.food_name);
    });

    console.log(`[DbService] Daily totals keys: ${Object.keys(dailyTotals).join(', ')}`);

    // Map classifications for easy access
    const classMap: Record<string, any> = {};
    classifications.forEach((c: any) => {
      classMap[c.date] = { type: c.day_type, notes: c.notes };
    });

    return {
      dailyTotals,
      classifications: classMap,
      daysAnalysed: days
    };
  }

  /**
   * Fetches active memories for a user by category
   */
  async getMemories(userId: string, categories: string[]) {
    const { data, error } = await this.supabase
      .from('user_learned_context')
      .select('*')
      .eq('user_id', userId)
      .eq('active', true)
      .in('category', categories);

    if (error) {
      console.error('[DbService] Error fetching memories:', error);
      throw error;
    }
    return data;
  }

  /**
   * Saves a new learned memory
   */
  async saveMemory(userId: string, category: string, fact: string, source: string) {
    const { error } = await this.supabase
      .from('user_learned_context')
      .insert({
        user_id: userId,
        category,
        fact,
        source_message: source,
        active: true
      });

    if (error) {
      console.error('[DbService] Error saving memory:', error);
      throw error;
    }
  }

  /**
   * Replaces all constraints of a specific category for a user
   */
  async replaceHealthConstraints(userId: string, category: string, constraints: { constraint: string, severity: string }[]) {
    // 1. Delete existing constraints for this category
    const { error: deleteError } = await this.supabase
      .from('user_health_constraints')
      .delete()
      .eq('user_id', userId)
      .eq('category', category);

    if (deleteError) {
      console.error('[DbService] Error deleting old health constraints:', deleteError);
      throw deleteError;
    }

    if (constraints.length === 0) return;

    // 2. Insert new constraints
    const { error: insertError } = await this.supabase
      .from('user_health_constraints')
      .insert(constraints.map(c => ({
        user_id: userId,
        category: category,
        constraint: c.constraint,
        severity: c.severity,
        active: true
      })));

    if (insertError) {
      console.error('[DbService] Error inserting new health constraints:', insertError);
      throw insertError;
    }
  }


  /**
   * Marks a memory as used (updates timestamp)
   */
  async markMemoryUsed(memoryId: string) {
    const { error } = await this.supabase
      .from('user_learned_context')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', memoryId);

    if (error) {
      console.error('[DbService] Error marking memory used:', error);
    }
  }

  /**
   * Fetches user health constraints
   */
  async getHealthConstraints(userId: string) {
    const { data, error } = await this.supabase
      .from('user_health_constraints')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      console.error('[DbService] Error fetching health constraints:', error);
      throw error;
    }
    return data;
  }

  /**
   * Saves or updates a health constraint
   */
  async saveHealthConstraint(userId: string, constraint: any) {
    const { error } = await this.supabase
      .from('user_health_constraints')
      .upsert({
        user_id: userId,
        ...constraint
      }, {
        onConflict: 'user_id, category'
      });

    if (error) {
      console.error('[DbService] Error saving health constraint:', error);
      throw error;
    }
  }

  /**
   * Adds a dictionary-based health constraint
   */
  async addHealthConstraint(userId: string, data: { category: string, type: string, severity: string, notes?: string }) {
    console.log(`[DbService] Adding constraint: ${data.category} (${data.type})`);
    const { error } = await this.supabase
      .from('user_health_constraints')
      .upsert({
        user_id: userId,
        category: data.category.toLowerCase().trim(),
        constraint_type: data.type,
        severity: data.severity,
        notes: data.notes
      }, {
        onConflict: 'user_id, category'
      });

    if (error) {
      console.error('[DbService] Error adding health constraint:', error);
      throw error;
    }
  }

  /**
   * Removes a health constraint by category
   */
  async removeHealthConstraint(userId: string, category: string) {
    console.log(`[DbService] Removing constraint: ${category}`);
    const { error } = await this.supabase
      .from('user_health_constraints')
      .delete()
      .eq('user_id', userId)
      .eq('category', category.toLowerCase().trim());

    if (error) {
      console.error('[DbService] Error removing health constraint:', error);
      throw error;
    }
  }
}
