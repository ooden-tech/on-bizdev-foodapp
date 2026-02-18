/**
 * Service to handle database operations, decoupling persistence from orchestrator
 */ import { SupabaseClient } from '@supabase/supabase-js';

export class DbService {
  private supabase: SupabaseClient;
  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }
  /**
   * Logs food items to the database
   */ async logFoodItems(userId: string, items: any[]) {
    const { error } = await this.supabase.from('food_log').insert(items.map((item) => ({
      ...item,
      user_id: userId
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
   * Fetches today's progress by combining user goals and food logs
   */ async getTodayProgress(userId: string, start: string, end: string) {
    const [{ data: goals, error: goalsError }, { data: logs, error: logsError }] = await Promise.all([
      this.supabase.from('user_goals').select('*').eq('user_id', userId),
      this.supabase.from('food_log').select('*').eq('user_id', userId).gte('log_time', start).lte('log_time', end)
    ]);

    if (goalsError) {
      console.error('[DbService] Error fetching user goals for progress:', goalsError);
      throw goalsError;
    }
    if (logsError) {
      console.error('[DbService] Error fetching food logs for progress:', logsError);
      throw logsError;
    }
    return { goals, logs };
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
   */
  async updateUserGoal(
    userId: string,
    nutrient: string,
    value: number,
    unit: string,
    goalType: 'goal' | 'limit' = 'goal',
    thresholds: { yellow_min?: number; green_min?: number; red_min?: number } = {}
  ) {
    // Only include defined thresholds to avoid overwriting existing ones with nulls if not meant to
    const cleanThresholds: any = {};
    if (thresholds.yellow_min !== undefined) cleanThresholds.yellow_min = thresholds.yellow_min;
    if (thresholds.green_min !== undefined) cleanThresholds.green_min = thresholds.green_min;
    if (thresholds.red_min !== undefined) cleanThresholds.red_min = thresholds.red_min;

    const { error } = await this.supabase.from('user_goals').upsert({
      user_id: userId,
      nutrient: nutrient,
      target_value: value,
      unit: unit,
      goal_type: goalType,
      ...cleanThresholds
    }, {
      onConflict: 'user_id, nutrient'
    });
    if (error) {
      console.error('[DbService] Error updating user goal:', error);
      throw error;
    }
  }

  /**
   * Deletes a user's nutritional goal
   */
  async deleteUserGoal(userId: string, nutrient: string) {
    const { error } = await this.supabase
      .from('user_goals')
      .delete()
      .eq('user_id', userId)
      .eq('nutrient', nutrient);

    if (error) {
      console.error('[DbService] Error deleting user goal:', error);
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
    const { error } = await this.supabase.from('user_goals').upsert(goals.map((g) => ({
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
   */ async applyDailyAdjustment(userId: string, adjustment: { nutrient: string; value: number; type?: string; notes?: string; date?: string }) {
    const { error } = await this.supabase.from('daily_adjustments').upsert({
      user_id: userId,
      nutrient: adjustment.nutrient,
      adjustment_value: adjustment.value,
      adjustment_type: adjustment.type || 'workout',
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
   * Fetches daily adjustments for a specific date
   */ async getDailyAdjustments(userId: string, date: string) {
    const { data, error } = await this.supabase.from('daily_adjustments').select('*').eq('user_id', userId).eq('adjustment_date', date);
    if (error) {
      console.error('[DbService] Error fetching daily adjustments:', error);
      return [];
    }
    return data;
  }
}
