import { createAdminClient } from '../../_shared/supabase-client.ts';
import { createOpenAIClient } from '../../_shared/openai-client.ts';
import { DbService } from '../services/db-service.ts';

/**
 * InsightAgent
 * Specialist for forensic analysis, audits, and pattern recognition.
 * Upgraded to "Forensic Health Analyst" persona (Feature 5).
 */
export class InsightAgent {
  name = 'insight';

  async execute(input: any, context: any) {
    const action = input?.action || 'summary';
    const query = input?.query || '';
    const filters = input?.filters || {};

    console.log(`[InsightAgent] Executing ${action} with query: "${query}"`, filters);

    switch (action) {
      case 'audit':
        return this.executeAudit(context, query, filters);
      case 'patterns':
        return this.executePatterns(context, query, filters);
      case 'reflect':
        return this.executeReflect(context, query, filters);
      case 'classify_day':
        return this.executeClassifyDay(context, input?.day_type, input?.notes);
      case 'summary':
      default:
        return this.executeSummary(context, filters);
    }
  }

  private async executeAudit(context: any, query: string, filters: any) {
    const userId = context.userId;
    const timezone = context.timezone || 'UTC';
    const { logs, classifications } = await context.db.getHistoricalData(userId, { days: 7 }, timezone);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
    const dayClass = await context.db.getDayClassification(userId, today);
    const goals = await context.db.getUserGoals(userId);

    const metadataFields = ['id', 'user_id', 'food_name', 'meal_type', 'log_time', 'created_at', 'updated_at', 'portion', 'recipe_id', 'extras', 'confidence', 'confidence_details', 'error_sources'];

    // Streamline logs for prompt to prevent timeouts, dynamically including all numeric metrics
    const streamlinedLogs = logs.map((l: any) => {
      const entry: any = {
        name: l.food_name,
        time: l.log_time
      };

      Object.keys(l).forEach(key => {
        if (!metadataFields.includes(key) && typeof l[key] === 'number' && l[key] !== 0) {
          entry[key] = l[key];
        }
      });

      return entry;
    });

    const auditPrompt = `
    You are a Forensic Nutrition Analyst. Audit the user's food log for today.
    
    Context:
    - User Goals: ${JSON.stringify(goals)}
    - Day Type: ${dayClass?.day_type || 'normal'}
    - User Inquiry: "${query}"

    Task:
    1. Identify Entropy: Find unlogged gaps (e.g., long periods without food).
    2. Statistical Outliers: Flag entries that look unusual for those items.
    3. Nutritional Discordance: Check if logged items match core goal profiles. Analyze EVERY tracked metric provided (e.g., Sodium, Sugar, Fiber, Water, etc.).
    
    Format: 3-5 punchy bullets. Focus on "Debugging the model, not correcting the user."
    If day type is 'travel' or 'social', acknowledge that baseline shifts (e.g., higher sodium/fat/calories) are contextual and expected.
    `;

    const openai = createOpenAIClient();
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: auditPrompt },
        { role: "user", content: `Recent Logs for Review: ${JSON.stringify(streamlinedLogs)}` }
      ],
    });

    return {
      action: 'audit',
      audit_report: response.choices[0].message.content,
      data_snapshot: { logs_count: logs.length, day_type: dayClass?.day_type }
    };
  }

  private async executePatterns(context: any, query: string, days: number = 7) {
    const userId = context.userId;
    const timezone = context.timezone || 'UTC';
    const analysisData = await context.db.getAnalyticalData(userId, days, timezone);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });

    // Use summarized data for patterns to keep prompt size small

    const patternPrompt = `
    You are a Data Analyst. Look for structural patterns and directional insights.
    
    Target: ${query || 'General patterns'}
    Today is: ${today}
    History: ${days} days
    Daily Totals (Summarized): ${JSON.stringify(analysisData.dailyTotals)}
    Special Context: ${JSON.stringify(analysisData.classifications)}

    Distinction:
    - Patterns: Recurring behaviors in macros, calories, or timing (3+ times). Suggest one "Structural Fix".
    - Insights: Directional trends or observations (e.g., "Protein is consistently 20% lower on weekends").
    
    Format: 3-5 bullets. Non-preachy, context-aware. Focus on the integration of macros, not just calories.
    `;

    const openai = createOpenAIClient();
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: patternPrompt }],
    });

    return {
      action: 'patterns',
      analysis: response.choices[0].message.content,
      history_range: days
    };
  }

  private async executeReflect(context: any, query: string, filters: any) {
    const userId = context.userId;
    const timezone = context.timezone || 'UTC';
    // CRITICAL: Use summarized data to prevent timeouts
    const analysisData = await context.db.getAnalyticalData(userId, 7, timezone);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
    console.log(`[InsightAgent] executeReflect: timezone=${timezone}, today=${today}, analysisDays=${Object.keys(analysisData.dailyTotals).length}`);

    const reflectPrompt = `
    Analyze how today (${today}) compares to the previous 7 days (the baseline).
    
    Today's Date: ${today}
    Summarized Data (Daily Totals): ${JSON.stringify(analysisData.dailyTotals)}
    User Focus: "${query}"

    Task:
    1. Contrast EVERY tracked metric (all numeric fields in the data) between today and the average/trend of the baseline.
    2. Identify the "One Big Lever" for tomorrow (the most impactful macro, micro-nutrient, or timing adjustment).
    
    Style: Non-preachy, context-aware. If today was a "social" or "travel" day, explain the variance as a context choice rather than a failure.
    `;

    const openai = createOpenAIClient();
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: reflectPrompt }],
    });

    return {
      action: 'reflect',
      reflection: response.choices[0].message.content
    };
  }

  private async executeClassifyDay(context: any, dayType: string, notes: string) {
    const today = new Date().toISOString().split('T')[0];
    await context.db.setDayClassification(context.userId, today, dayType, notes);

    return {
      action: 'classify_day',
      status: 'confirmed',
      day_type: dayType
    };
  }

  private async executeSummary(context: any, filters: any) {
    const userId = context.userId;
    const timezone = context.timezone || 'UTC';
    const days = filters.days || 7;

    // Use getAnalyticalData for structured daily totals (same approach as patterns/reflect)
    const analysisData = await context.db.getAnalyticalData(userId, days, timezone);
    const goals = await context.db.getUserGoals(userId);

    const daysWithData = Object.keys(analysisData.dailyTotals).length;
    console.log(`[InsightAgent] executeSummary: ${daysWithData} days with data out of ${days} requested`);

    // Trim daily totals to key nutrients only to reduce token count and avoid timeout
    const keyNutrients = ['calories', 'protein_g', 'carbs_g', 'fat_total_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'hydration_ml'];
    const trimmedTotals: Record<string, any> = {};
    for (const [date, data] of Object.entries(analysisData.dailyTotals) as [string, any][]) {
      trimmedTotals[date] = { items: data.items };
      for (const k of keyNutrients) {
        if (data[k] !== undefined) trimmedTotals[date][k] = Math.round(data[k] * 10) / 10;
      }
    }

    const summaryPrompt = `
    You are a Nutrition Summary Analyst. Provide a comprehensive yet concise progress summary.
    
    Period: Last ${days} days (${daysWithData} days have logged data)
    Daily Totals by Date: ${JSON.stringify(trimmedTotals)}
    User Goals: ${JSON.stringify(goals || 'No goals set')}
    Day Classifications: ${JSON.stringify(analysisData.classifications)}
    
    Task:
    1. Per-day highlights: For each day with data, mention key foods logged and total calories vs goal.
    2. Best & worst days: Identify the best and worst days based on goal adherence.
    3. Averages vs goals: Show average daily intake vs target for each tracked nutrient.
    4. Key patterns: Note any recurring themes (e.g., consistently low protein, high sugar on weekends).
    5. One actionable adjustment for the coming week.
    
    Hard Rules:
    - Be SPECIFIC with numbers (actual calories, grams, etc.). Reference actual foods the user logged.
    - If data is missing for some days, note that (e.g., "3 of 7 days had no logged meals").
    - No moral tone. Factual and constructive.
    - Use structured sections, not generic one-liners.
    `;

    const openai = createOpenAIClient();
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: summaryPrompt },
      ],
      max_tokens: 800
    }, {
      timeout: 25000
    });

    return {
      action: 'summary',
      summary: response.choices[0].message.content,
      data_snapshot: {
        days_requested: days,
        days_with_data: daysWithData,
        goals_count: goals?.length || 0
      }
    };
  }
}
