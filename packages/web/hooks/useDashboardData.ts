'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStartAndEndOfDay } from 'shared';

interface UserGoal {
  nutrient: string;
  target_value: number;
  unit: string;
  goal_type?: string;
  yellow_min?: number;
  green_min?: number;
  red_min?: number;
}

interface FoodLog {
  id: string;
  log_time: string;
  food_name?: string | null;
  calories?: number | null;
  [key: string]: unknown;
}

interface DailyTotals {
  [nutrientKey: string]: number | undefined;
}

interface DailyAdjustments {
  [nutrientKey: string]: number | undefined;
}

// Helper to normalize nutrient keys (e.g., "Protein (g)" -> "protein_g")
// Helper to normalize nutrient keys (e.g., "Protein (g)" -> "protein_g")
import { normalizeNutrientKey, MASTER_NUTRIENT_MAP } from 'shared';

export const useDashboardData = () => {
  const { user, supabase, loading: authLoading } = useAuth();
  const [userGoals, setUserGoals] = useState<UserGoal[]>([]);
  const [dailyTotals, setDailyTotals] = useState<DailyTotals>({});
  const [dailyAdjustments, setDailyAdjustments] = useState<DailyAdjustments>({});
  const [recentLogs, setRecentLogs] = useState<FoodLog[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch dashboard data function (migrated from page)
  const fetchDashboardData = useCallback(async (isRefreshing = false) => {
    if (!user || !supabase) {
      setLoadingData(false);
      setRefreshing(false);
      setUserGoals([]);
      setDailyTotals({});
      return;
    }

    if (!isRefreshing) setLoadingData(true);
    else setRefreshing(true);
    setError(null);

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { start: startOfDay, end: endOfDay } = getStartAndEndOfDay(new Date(), timezone);

    try {
      const [goalsResponse, logsResponse, adjsResponse] = await Promise.all([
        supabase.from('user_goals').select('*').eq('user_id', user.id),
        supabase.from('food_log')
          .select('*')
          .eq('user_id', user.id)
          .gte('log_time', startOfDay)
          .lte('log_time', endOfDay)
          .order('log_time', { ascending: false }),
        supabase.from('daily_adjustments')
          .select('*')
          .eq('user_id', user.id)
          .eq('adjustment_date', startOfDay.split('T')[0])
      ]);

      if (goalsResponse.error) throw goalsResponse.error;
      if (logsResponse.error) throw logsResponse.error;
      // adjustments might fail if table just created or user has none - be graceful
      const fetchedAdjs = adjsResponse?.data || [];

      const fetchedGoals = goalsResponse.data || [];
      const fetchedLogs = logsResponse.data || [];

      // Deduplicate goals by normalized key
      // STRICT FILTERING: Only allow keys present in MASTER_NUTRIENT_MAP
      const uniqueGoalsMap = new Map<string, UserGoal>();

      fetchedGoals.forEach(g => {
        const normalized = normalizeNutrientKey(g.nutrient);

        // Strict Check: Is this a valid technical key?
        if (!MASTER_NUTRIENT_MAP[normalized]) {
          console.warn(`[useDashboardData] Ignoring invalid/legacy nutrient goal: ${g.nutrient} -> ${normalized}`);
          return;
        }

        const existing = uniqueGoalsMap.get(normalized);

        // Priority Logic:
        // 1. If we have a goal that EXACTLY matches the normalized key (technical key), prefer it.
        // 2. Otherwise, valid alias is okay.
        // 3. If duplicate technical keys (unlikely in DB constraint but possible), take latest or max. 
        //    Here we assume if existing is NOT exact technical match, but new IS, take new.

        const isNewExact = g.nutrient === normalized;
        const isExistingExact = existing ? existing.nutrient === normalized : false;

        if (!existing) {
          uniqueGoalsMap.set(normalized, { ...g, nutrient: normalized });
        } else if (isNewExact && !isExistingExact) {
          // New one is the "Real" key, replace the "alias" entry
          uniqueGoalsMap.set(normalized, { ...g, nutrient: normalized });
        } else if (isNewExact && isExistingExact) {
          // Both are "Real" keys? Take max target.
          if (g.target_value > existing.target_value) {
            uniqueGoalsMap.set(normalized, { ...g, nutrient: normalized });
          }
        } else if (!isNewExact && !isExistingExact) {
          // Both are aliases? Take max.
          if (g.target_value > existing.target_value) {
            uniqueGoalsMap.set(normalized, { ...g, nutrient: normalized });
          }
        }
        // implicit else: New is alias, Existing is Real -> Keep Existing.
      });

      const finalGoals = Array.from(uniqueGoalsMap.values());

      const totals: DailyTotals = {};
      fetchedLogs.forEach(log => {
        Object.keys(log).forEach(key => {
          if (typeof log[key] === 'number') {
            const normalizedKey = normalizeNutrientKey(key);
            // Only sum up if valid nutrient
            if (MASTER_NUTRIENT_MAP[normalizedKey] || normalizedKey === 'calories') {
              totals[normalizedKey] = (totals[normalizedKey] || 0) + (log[key] as number);
            }
          }
        });
      });

      setUserGoals(finalGoals);
      setRecentLogs(fetchedLogs);
      setDailyTotals(totals);

      const adjs: DailyAdjustments = {};
      fetchedAdjs.forEach(adj => {
        const normalized = normalizeNutrientKey(adj.nutrient);
        if (MASTER_NUTRIENT_MAP[normalized] || normalized === 'calories') {
          adjs[normalized] = (adjs[normalized] || 0) + (adj.adjustment_value as number);
        }
      });
      setDailyAdjustments(adjs);

    } catch (err: unknown) {
      console.error("[useDashboardData] Error fetching data:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to load dashboard data: ${errorMessage}`);
      setUserGoals([]);
      setDailyTotals({});
    } finally {
      setLoadingData(false);
      setRefreshing(false);
    }
  }, [user, supabase]);

  useEffect(() => {
    if (user && !authLoading) {
      fetchDashboardData();
    }
  }, [user, authLoading, fetchDashboardData]);

  return {
    userGoals,
    dailyTotals,
    dailyAdjustments,
    recentLogs,
    loadingData,
    error,
    refreshing,
    refreshDashboardData: fetchDashboardData
  };
};