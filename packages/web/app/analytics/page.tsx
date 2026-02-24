'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer
} from 'recharts';
import type { UserProfile } from 'shared';
import DashboardShell from '@/components/DashboardShell';

interface UserGoal {
    nutrient: string;
    target_value: number;
    unit: string;
    goal_type?: string;
}

interface DailyNutrientTotal {
    day: string;
    total: number;
}

interface AnalyticsSummary {
    today: { value: number; percent: number };
    weeklyAvg: { value: number; percent: number };
    monthlyAvg: { value: number; percent: number };
}

interface ChartPoint {
    label: string;
    Actual: number | null;
    Goal: number | null;
}

interface FoodLogEntry {
    log_time: string;
    [key: string]: unknown;
}

const formatDate = (date: Date): string => {
    return date.toISOString().split('T')[0];
};
const getPastDate = (daysAgo: number): Date => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return date;
};

const calculateYAxisDomain = (chartData: ChartPoint[], goalValue: number, nutrientType: string | null) => {
    if (!chartData || chartData.length === 0) return [0, 100];

    const maxDataValue = Math.max(
        ...chartData.map(point => (point.Actual !== null ? point.Actual : 0)),
        goalValue || 0
    );

    if (nutrientType === 'calories') {
        const ceiling = Math.max(1000, maxDataValue * 1.2);
        return [0, Math.ceil(ceiling / 500) * 500];
    }

    const padding = Math.max(maxDataValue * 0.2, 5);
    return [0, Math.ceil(maxDataValue + padding)];
};

export default function AnalyticsPage() {
    const { user, supabase, loading: authLoading } = useAuth();

    const [loadingGoals, setLoadingGoals] = useState(true);
    const [loadingData, setLoadingData] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedNutrient, setSelectedNutrient] = useState<string | null>(null);
    const [trackedNutrientsList, setTrackedNutrientsList] = useState<UserGoal[]>([]);
    const [analyticsSummary, setAnalyticsSummary] = useState<AnalyticsSummary | null>(null);
    const [weeklyChartData, setWeeklyChartData] = useState<ChartPoint[] | null>(null);
    const [monthlyChartData, setMonthlyChartData] = useState<ChartPoint[] | null>(null);
    const [currentGoal, setCurrentGoal] = useState<UserGoal | null>(null);

    const loadTrackedNutrients = useCallback(async () => {
        if (!user || !supabase) {
            setTrackedNutrientsList([]);
            setLoadingGoals(false);
            setError("Authentication context not available.")
            return;
        }
        setLoadingGoals(true);
        setError(null);
        try {
            const { data: goalsData, error: goalsError } = await supabase
                .from('user_goals')
                .select('nutrient, target_value, unit, goal_type')
                .eq('user_id', user.id);

            if (goalsError) throw goalsError;

            const nutrients = goalsData || [];
            setTrackedNutrientsList(nutrients);

            if (nutrients.length > 0) {
                if (!selectedNutrient || !nutrients.some(n => n.nutrient === selectedNutrient)) {
                    setSelectedNutrient(nutrients[0].nutrient);
                }
            } else {
                setSelectedNutrient(null);
                setError("No nutrients are currently being tracked. Please set goals in Settings.");
            }

        } catch (err: unknown) {
            console.error("Full error object loading tracked nutrients:", err);
            console.error("Error loading tracked nutrients:", err);
            const errorMessage = err instanceof Error ? err.message : String(err);
            setError(`Failed to load nutrient goals: ${errorMessage}`);
        } finally {
            setLoadingGoals(false);
        }
    }, [user, supabase]);

    const fetchAnalyticsData = useCallback(async () => {
        if (!user || !supabase || !selectedNutrient) {
            setError("Cannot fetch analytics data: missing user, service, or selected nutrient.");
            return;
        }
        setLoadingData(true);
        setError(null);

        const currentGoal = trackedNutrientsList.find(g => g.nutrient === selectedNutrient);
        setCurrentGoal(currentGoal || null);

        if (!currentGoal) {
            setError(`Goal not found for ${selectedNutrient}. Unable to calculate analytics.`);
            setLoadingData(false);
            setAnalyticsSummary(null);
            setWeeklyChartData(null);
            setMonthlyChartData(null);
            return;
        }

        const today = new Date();
        const thirtyDaysAgo = getPastDate(29);
        const startRange = thirtyDaysAgo.toISOString();
        const endRange = today.toISOString();

        try {
            console.log(`Fetching food_log for ${selectedNutrient} between ${startRange} and ${endRange}`);
            const { data, error: logError } = await supabase
                .from('food_log')
                .select('*')
                .eq('user_id', user.id)
                .gte('log_time', startRange)
                .lte('log_time', endRange)
                .order('log_time', { ascending: true });

            if (logError) throw logError;

            const rawLogs: FoodLogEntry[] | null = data as any;

            console.log("Fetched raw logs:", rawLogs);

            const dailyTotalsMap = new Map<string, number>();
            if (Array.isArray(rawLogs)) {
                rawLogs.forEach(log => {
                    if (log && typeof log.log_time === 'string' && typeof log[selectedNutrient] === 'number') {
                        const day = log.log_time.split('T')[0];
                        const value = log[selectedNutrient] as number;
                        const currentTotal = dailyTotalsMap.get(day) || 0;
                        dailyTotalsMap.set(day, currentTotal + value);
                    } else {
                        console.warn("Skipping invalid log entry or missing nutrient value:", log);
                    }
                });
            }
            for (let i = 29; i >= 0; i--) {
                const date = getPastDate(i);
                const dateStr = formatDate(date);
                if (!dailyTotalsMap.has(dateStr)) {
                    dailyTotalsMap.set(dateStr, 0);
                }
            }

            const dailyTotals: DailyNutrientTotal[] = Array.from(dailyTotalsMap, ([day, total]) => ({ day, total }))
                .sort((a, b) => a.day.localeCompare(b.day));

            console.log("Aggregated daily totals:", dailyTotals);

            if (dailyTotals.length === 0) {
                console.log("No aggregated totals found for the selected period and nutrient.");
                setAnalyticsSummary({
                    today: { value: 0, percent: 0 },
                    weeklyAvg: { value: 0, percent: 0 },
                    monthlyAvg: { value: 0, percent: 0 },
                });
                setWeeklyChartData([]);
                setMonthlyChartData([]);
                setError(null);
                setLoadingData(false);
                return;
            }

            const todayStr = formatDate(new Date());
            const sevenDaysAgoStr = formatDate(getPastDate(6));

            const todayData = dailyTotals.find(d => d.day === todayStr);
            const todayValue = todayData?.total || 0;
            const todayPercent = currentGoal.target_value > 0 ? (todayValue / currentGoal.target_value) * 100 : 0;

            const weeklyData = dailyTotals.filter(d => d.day >= sevenDaysAgoStr);
            const weeklyTotal = weeklyData.reduce((sum, d) => sum + d.total, 0);
            const weeklyAvgValue = weeklyData.length > 0 ? weeklyTotal / weeklyData.length : 0;
            const weeklyAvgPercent = currentGoal.target_value > 0 ? (weeklyAvgValue / currentGoal.target_value) * 100 : 0;

            const monthlyData = dailyTotals;
            const monthlyTotal = monthlyData.reduce((sum, d) => sum + d.total, 0);
            const monthlyAvgValue = monthlyData.length > 0 ? monthlyTotal / monthlyData.length : 0;
            const monthlyAvgPercent = currentGoal.target_value > 0 ? (monthlyAvgValue / currentGoal.target_value) * 100 : 0;

            setAnalyticsSummary({
                today: { value: todayValue, percent: todayPercent },
                weeklyAvg: { value: weeklyAvgValue, percent: weeklyAvgPercent },
                monthlyAvg: { value: monthlyAvgValue, percent: monthlyAvgPercent },
            });

            const goalValue = currentGoal.target_value;
            const weeklyChart: ChartPoint[] = [];
            for (let i = 6; i >= 0; i--) {
                const date = getPastDate(i);
                const dateStr = formatDate(date);
                const dayData = dailyTotalsMap.get(dateStr);
                weeklyChart.push({
                    label: date.toLocaleDateString('en-US', { weekday: 'short' }),
                    Actual: dayData !== undefined ? dayData : null,
                    Goal: goalValue
                });
            }
            setWeeklyChartData(weeklyChart);

            const monthlyChart: ChartPoint[] = dailyTotals.map(item => ({
                label: new Date(item.day + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                Actual: item.total,
                Goal: goalValue
            }));
            setMonthlyChartData(monthlyChart);

        } catch (err: unknown) {
            console.error("Full error object fetching/processing analytics data:", err);
            console.error(`Error fetching/processing analytics data for ${selectedNutrient}:`, err);
            const errorMessage = err instanceof Error ? err.message : String(err);
            setError(`Failed to load analytics: ${errorMessage}`);
            setAnalyticsSummary(null);
            setWeeklyChartData(null);
            setMonthlyChartData(null);
            setCurrentGoal(null);
        } finally {
            setLoadingData(false);
        }
    }, [user, supabase, selectedNutrient, trackedNutrientsList]);

    useEffect(() => {
        if (!authLoading && user) {
            loadTrackedNutrients();
        }
    }, [authLoading, user, loadTrackedNutrients]);

    useEffect(() => {
        if (selectedNutrient && !loadingGoals) {
            fetchAnalyticsData();
        }
    }, [selectedNutrient, loadingGoals, fetchAnalyticsData]);

    if (authLoading || loadingGoals) {
        return <div className="flex h-screen items-center justify-center"><p>Loading Analytics Setup...</p></div>;
    }
    if (!user) {
        return <div className="flex h-screen items-center justify-center"><p>Please log in to view analytics.</p></div>;
    }

    const getNutrientName = (key: string | null): string => {
        return trackedNutrientsList.find(n => n.nutrient === key)?.nutrient.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Nutrient';
    };
    const getNutrientUnit = (key: string | null): string => {
        return trackedNutrientsList.find(n => n.nutrient === key)?.unit || '';
    };

    return (
        <DashboardShell headerTitle="Nutrition Analytics">
            {/* Nutrient Selector */}
            <div className="mb-6 p-4 bg-white rounded-lg border border-gray-200 shadow-sm max-w-sm">
                <label htmlFor="nutrient-select" className="block text-base font-medium text-gray-800 mb-2">Select Nutrient</label>
                <select
                    id="nutrient-select"
                    value={selectedNutrient || ''}
                    onChange={(e) => setSelectedNutrient(e.target.value)}
                    disabled={loadingGoals || trackedNutrientsList.length === 0}
                    className="mt-1 block w-full pl-4 pr-10 py-2.5 text-base text-gray-900 border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 rounded-md disabled:bg-gray-100 disabled:cursor-not-allowed"
                >
                    {trackedNutrientsList.length === 0 && !loadingGoals && (
                        <option value="" disabled>No goals set</option>
                    )}
                    {trackedNutrientsList.map(goal => (
                        <option key={goal.nutrient} value={goal.nutrient}>
                            {goal.nutrient.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                        </option>
                    ))}
                </select>
            </div>

            {loadingData && (
                <div className="flex items-center justify-center py-10"><p>Loading analytics data...</p></div>
            )}
            {error && !loadingData && (
                <div className="mb-6 p-3 bg-red-100 text-red-700 rounded-md border border-red-300">
                    Error: {error}
                </div>
            )}

            {!loadingData && !error && selectedNutrient && analyticsSummary && currentGoal && (
                <div className="space-y-8">
                    <section>
                        <h3 className="text-lg font-semibold text-gray-800 mb-3">Summary for {getNutrientName(selectedNutrient)}</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                                <h4 className="text-sm font-medium text-gray-500 mb-1">Today</h4>
                                <p className="text-xl font-semibold text-gray-900">{analyticsSummary.today.value.toFixed(1)} {getNutrientUnit(selectedNutrient)}</p>
                                <p className="text-sm text-gray-600">({analyticsSummary.today.percent.toFixed(0)}% of goal)</p>
                            </div>
                            <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                                <h4 className="text-sm font-medium text-gray-500 mb-1">Weekly Average</h4>
                                <p className="text-xl font-semibold text-gray-900">{analyticsSummary.weeklyAvg.value.toFixed(1)} {getNutrientUnit(selectedNutrient)}</p>
                                <p className="text-sm text-gray-600">({analyticsSummary.weeklyAvg.percent.toFixed(0)}% of goal)</p>
                            </div>
                            <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                                <h4 className="text-sm font-medium text-gray-500 mb-1">Monthly Average</h4>
                                <p className="text-xl font-semibold text-gray-900">{analyticsSummary.monthlyAvg.value.toFixed(1)} {getNutrientUnit(selectedNutrient)}</p>
                                <p className="text-sm text-gray-600">({analyticsSummary.monthlyAvg.percent.toFixed(0)}% of goal)</p>
                            </div>
                        </div>
                    </section>

                    <section>
                        <h3 className="text-lg font-semibold text-gray-800 mb-3">Trends</h3>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm min-h-[350px]">
                                <h4 className="text-md font-medium text-gray-600 mb-4">Last 7 Days Trend</h4>
                                {weeklyChartData && weeklyChartData.length > 0 ? (
                                    <ResponsiveContainer width="100%" height={300}>
                                        <LineChart data={weeklyChartData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                                            <XAxis dataKey="label" fontSize={12} />
                                            <YAxis
                                                fontSize={12}
                                                domain={calculateYAxisDomain(weeklyChartData, currentGoal?.target_value || 0, selectedNutrient)}
                                                allowDecimals={false}
                                                tickCount={6}
                                            />
                                            <Tooltip
                                                formatter={(value: number) => `${value.toFixed(1)} ${getNutrientUnit(selectedNutrient)}`}
                                                labelFormatter={(label) => `Day: ${label}`}
                                            />
                                            <Legend />
                                            <Line
                                                type="monotone"
                                                dataKey="Actual"
                                                stroke="#3b82f6"
                                                strokeWidth={2}
                                                dot={{ r: 4 }}
                                                activeDot={{ r: 6 }}
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="Goal"
                                                stroke="#ef4444"
                                                strokeWidth={1}
                                                strokeDasharray="5 5"
                                                dot={false}
                                                activeDot={false}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                ) : <p className="text-gray-500 text-sm text-center pt-10">No weekly data available to display chart.</p>}
                            </div>
                            <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm min-h-[350px]">
                                <h4 className="text-md font-medium text-gray-600 mb-4">Last 30 Days Trend</h4>
                                {monthlyChartData && monthlyChartData.length > 0 ? (
                                    <ResponsiveContainer width="100%" height={300}>
                                        <LineChart data={monthlyChartData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                                            <XAxis dataKey="label" fontSize={12} tickCount={6} />
                                            <YAxis
                                                fontSize={12}
                                                domain={calculateYAxisDomain(monthlyChartData, currentGoal?.target_value || 0, selectedNutrient)}
                                                allowDecimals={false}
                                                tickCount={6}
                                            />
                                            <Tooltip
                                                formatter={(value: number) => `${value.toFixed(1)} ${getNutrientUnit(selectedNutrient)}`}
                                                labelFormatter={(label) => `Date: ${label}`}
                                            />
                                            <Legend />
                                            <Line
                                                type="monotone"
                                                dataKey="Actual"
                                                stroke="#10b981"
                                                strokeWidth={2}
                                                dot={false}
                                                activeDot={{ r: 6 }}
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="Goal"
                                                stroke="#f97316"
                                                strokeWidth={1}
                                                strokeDasharray="5 5"
                                                dot={false}
                                                activeDot={false}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                ) : <p className="text-gray-500 text-sm text-center pt-10">No monthly data available to display chart.</p>}
                            </div>
                        </div>
                    </section>
                </div>
            )}

            {!selectedNutrient && !loadingGoals && !error && (
                <div className="text-center py-10">
                    <p className="text-gray-600">Please select a nutrient to view analytics.</p>
                </div>
            )}
        </DashboardShell>
    );
}