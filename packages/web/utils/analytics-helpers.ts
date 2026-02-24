export interface UserGoal {
    nutrient: string;
    target_value: number;
    unit: string;
    goal_type?: string;
    yellow_min?: number;
    green_min?: number;
    red_min?: number;
}

export interface FoodLogEntry {
    log_time: string;
    [key: string]: unknown;
}

export interface DailyNutrientTotal {
    day: string;
    total: number;
}

export interface NutrientAnalyticsData {
    nutrient: string;
    goal: UserGoal;
    dailyTotals: DailyNutrientTotal[];
    today: { value: number; percent: number };
    weeklyAvg: { value: number; percent: number; total: number };
    monthlyAvg: { value: number; percent: number; total: number };
    streak: number;
}

export interface FocusItem {
    nutrient: string;
    message: string;
    severity: 'high' | 'medium' | 'low';
}

const formatDate = (date: Date): string => {
    return date.toISOString().split('T')[0];
};

const getPastDate = (daysAgo: number): Date => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return date;
};

/**
 * Validates whether a daily total meets the definition of "success" for the streak.
 */
function isTargetMet(value: number, goal: UserGoal): boolean {
    const { target_value, goal_type, green_min, red_min } = goal;
    const isLimit = goal_type === 'limit';

    if (isLimit) {
        // Limit: Success if <= target, or strictly speaking, below the red zone.
        // Dashboard uses redMin for limits. Let's use target as the strict cut-off for a "streak".
        return value <= target_value;
    } else {
        // Goal: Success if >= target, or optionally green_min * target.
        // Dashboard uses greenMin = 0.75 for visual, but for a streak, usually it's hitting the goal.
        return value >= target_value;
    }
}

/**
 * Process raw food logs into daily totals for ALL tracked nutrients over 30 days.
 */
export function processAllNutrientsData(
    rawLogs: FoodLogEntry[],
    trackedNutrients: UserGoal[]
): Record<string, NutrientAnalyticsData> {
    const todayStr = formatDate(new Date());
    const sevenDaysAgoStr = formatDate(getPastDate(6));

    // Initialize day map for the last 30 days (0 to 29) to guarantee consecutive dates
    const thirtyDays: string[] = [];
    for (let i = 29; i >= 0; i--) {
        thirtyDays.push(formatDate(getPastDate(i)));
    }

    const results: Record<string, NutrientAnalyticsData> = {};

    trackedNutrients.forEach(goal => {
        const dailyTotalsMap = new Map<string, number>();
        thirtyDays.forEach(day => dailyTotalsMap.set(day, 0)); // seed 0s

        // Aggregate day totals
        rawLogs.forEach(log => {
            if (log && typeof log.log_time === 'string' && typeof log[goal.nutrient] === 'number') {
                const day = log.log_time.split('T')[0];
                const value = log[goal.nutrient] as number;
                if (dailyTotalsMap.has(day)) {
                    dailyTotalsMap.set(day, dailyTotalsMap.get(day)! + value);
                }
            }
        });

        const dailyTotals: DailyNutrientTotal[] = Array.from(dailyTotalsMap, ([day, total]) => ({ day, total }))
            .sort((a, b) => a.day.localeCompare(b.day));

        // Today
        const todayData = dailyTotals.find(d => d.day === todayStr);
        const todayValue = todayData?.total || 0;
        const todayPercent = goal.target_value > 0 ? (todayValue / goal.target_value) * 100 : 0;

        // Weekly
        const weeklyData = dailyTotals.filter(d => d.day >= sevenDaysAgoStr);
        const weeklyTotal = weeklyData.reduce((sum, d) => sum + d.total, 0);
        const weeklyAvgValue = weeklyData.length > 0 ? weeklyTotal / weeklyData.length : 0;
        const weeklyAvgPercent = goal.target_value > 0 ? (weeklyAvgValue / goal.target_value) * 100 : 0;

        // Monthly
        const monthlyTotal = dailyTotals.reduce((sum, d) => sum + d.total, 0);
        const monthlyAvgValue = dailyTotals.length > 0 ? monthlyTotal / dailyTotals.length : 0;
        const monthlyAvgPercent = goal.target_value > 0 ? (monthlyAvgValue / goal.target_value) * 100 : 0;

        // Calculate Streak (working backwards from today, allowing today to be missing/incomplete)
        let streak = 0;
        let foundMiss = false;

        // iterate backwards from today
        for (let i = dailyTotals.length - 1; i >= 0; i--) {
            const dayData = dailyTotals[i];
            const met = isTargetMet(dayData.total, goal);

            if (dayData.day === todayStr) {
                // If today is met, great. If not, don't break the streak yet, 
                // because the day might not be over.
                if (met) {
                    streak++;
                }
            } else {
                if (met) {
                    streak++;
                } else {
                    break; // Streak broken
                }
            }
        }

        results[goal.nutrient] = {
            nutrient: goal.nutrient,
            goal,
            dailyTotals,
            today: { value: todayValue, percent: todayPercent },
            weeklyAvg: { value: weeklyAvgValue, percent: weeklyAvgPercent, total: weeklyTotal },
            monthlyAvg: { value: monthlyAvgValue, percent: monthlyAvgPercent, total: monthlyTotal },
            streak
        };
    });

    return results;
}

/**
 * Deterministically find the nutrient furthest from its goal over the last 7 days.
 */
export function calculateFocusItem(analyticsData: Record<string, NutrientAnalyticsData>): FocusItem | null {
    let worstNutrient: NutrientAnalyticsData | null = null;
    let worstDeviation = -Infinity; // highest positive deviation is worst
    let isLimitViolation = false;

    // We only care about looking at nutrients that have data.
    for (const data of Object.values(analyticsData)) {
        const { goal, weeklyAvg } = data;
        if (goal.target_value <= 0) continue;

        const isLimit = goal.goal_type === 'limit';

        let deviation = 0;
        if (isLimit) {
            // How much OVER the limit are we? (Percentage)
            // Example: limit 2000, avg 2600. Deviation = (2600 - 2000) / 2000 = +30%
            deviation = ((weeklyAvg.value - goal.target_value) / goal.target_value) * 100;
        } else {
            // How much UNDER the goal are we?
            // Example: goal 100, avg 60. Deviation = (100 - 60) / 100 = +40%
            deviation = ((goal.target_value - weeklyAvg.value) / goal.target_value) * 100;
        }

        if (deviation > worstDeviation) {
            worstDeviation = deviation;
            worstNutrient = data;
            isLimitViolation = isLimit;
        }
    }

    // If perfectly hitting everything (all deviations <= 0), no huge focus needed,
    // or maybe we return the one with the *least negative* if we want to always show something.
    // Let's only alert if deviation is > 5% off target.
    if (!worstNutrient || worstDeviation <= 5) {
        return null;
    }

    const displayName = worstNutrient.nutrient.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase());
    const pct = worstDeviation.toFixed(0);

    if (isLimitViolation) {
        return {
            nutrient: worstNutrient.nutrient,
            severity: worstDeviation > 25 ? 'high' : 'medium',
            message: `Focus Area: Try to reduce your average ${displayName} intake, which is currently running ${pct}% over your limit this week.`
        };
    } else {
        return {
            nutrient: worstNutrient.nutrient,
            severity: worstDeviation > 25 ? 'high' : 'medium',
            message: `Focus Area: Pay attention to ${displayName}, you are consistently ${pct}% short of your target this week.`
        };
    }
}
