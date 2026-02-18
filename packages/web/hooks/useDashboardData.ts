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

      // STRICT FILTERING: Only allow goals present in MASTER_NUTRIENT_MAP
      // Since the DB is purified, these should mostly be 1:1 matches.
      const finalGoals: UserGoal[] = fetchedGoals
        .filter(g => MASTER_NUTRIENT_MAP[g.nutrient.toLowerCase()] || g.nutrient === 'calories')
        .map(g => ({
          ...g,
          nutrient: g.nutrient.toLowerCase() // Ensure consistent case
        }));

      const totals: DailyTotals = {};
      fetchedLogs.forEach(log => {
        Object.keys(log).forEach(key => {
          if (typeof log[key] === 'number') {
            const normalizedKey = normalizeNutrientKey(key);
            // STRICT FILTERING: Only sum up if valid nutrient in MASTER_NUTRIENT_MAP
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
        // STRICT FILTERING: Only sum up if valid nutrient in MASTER_NUTRIENT_MAP
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