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
    ResponsiveContainer,
    ReferenceArea
} from 'recharts';
import DashboardShell from '@/components/DashboardShell';
import {
    UserGoal,
    FoodLogEntry,
    NutrientAnalyticsData,
    FocusItem,
    processAllNutrientsData,
    calculateFocusItem
} from '@/utils/analytics-helpers';
import NutrientSparklineCard from '@/components/analytics/NutrientSparklineCard';
import FocusItemBanner from '@/components/analytics/FocusItemBanner';
import NormalizedComparisonChart from '@/components/analytics/NormalizedComparisonChart';

interface ChartPoint {
    label: string;
    Actual: number | null;
    Goal: number | null;
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

    const [trackedNutrientsList, setTrackedNutrientsList] = useState<UserGoal[]>([]);

    // Tab and Data State
    const [activeTab, setActiveTab] = useState<'overview' | 'details'>('overview');
    const [selectedNutrient, setSelectedNutrient] = useState<string | null>(null);
    const [analyticsData, setAnalyticsData] = useState<Record<string, NutrientAnalyticsData> | null>(null);
    const [focusItem, setFocusItem] = useState<FocusItem | null>(null);

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
            const errorMessage = err instanceof Error ? err.message : String(err);
            setError(`Failed to load nutrient goals: ${errorMessage}`);
        } finally {
            setLoadingGoals(false);
        }
    }, [user, supabase]);

    const fetchAnalyticsData = useCallback(async () => {
        if (!user || !supabase || trackedNutrientsList.length === 0) {
            return;
        }
        setLoadingData(true);
        setError(null);

        const today = new Date();
        const thirtyDaysAgo = getPastDate(29);
        const startRange = thirtyDaysAgo.toISOString();
        const endRange = today.toISOString();

        try {
            const { data, error: logError } = await supabase
                .from('food_log')
                .select('*')
                .eq('user_id', user.id)
                .gte('log_time', startRange)
                .lte('log_time', endRange)
                .order('log_time', { ascending: true });

            if (logError) throw logError;

            const rawLogs: FoodLogEntry[] = (data || []) as any;
            const processedData = processAllNutrientsData(rawLogs, trackedNutrientsList);

            setAnalyticsData(processedData);
            setFocusItem(calculateFocusItem(processedData));

        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            setError(`Failed to load analytics: ${errorMessage}`);
            setAnalyticsData(null);
            setFocusItem(null);
        } finally {
            setLoadingData(false);
        }
    }, [user, supabase, trackedNutrientsList]);

    useEffect(() => {
        if (!authLoading && user) {
            loadTrackedNutrients();
        }
    }, [authLoading, user, loadTrackedNutrients]);

    useEffect(() => {
        if (!loadingGoals && trackedNutrientsList.length > 0) {
            fetchAnalyticsData();
        }
    }, [loadingGoals, fetchAnalyticsData, trackedNutrientsList.length]);

    if (authLoading || loadingGoals) {
        return <div className="flex h-screen items-center justify-center"><p className="text-gray-500">Loading Analytics Setup...</p></div>;
    }
    if (!user) {
        return <div className="flex h-screen items-center justify-center"><p className="text-gray-500">Please log in to view analytics.</p></div>;
    }

    const getNutrientName = (key: string | null): string => {
        return trackedNutrientsList.find(n => n.nutrient === key)?.nutrient.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Nutrient';
    };
    const getNutrientUnit = (key: string | null): string => {
        return trackedNutrientsList.find(n => n.nutrient === key)?.unit || '';
    };

    // Helper for generating chart data mapped for recharts specifically
    const getChartDataForNutrient = (nutrientKey: string, days: number): ChartPoint[] => {
        if (!analyticsData || !analyticsData[nutrientKey]) return [];
        const nData = analyticsData[nutrientKey];
        const subset = nData.dailyTotals.slice(-days);
        return subset.map(item => ({
            label: days === 7
                ? new Date(item.day + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })
                : new Date(item.day + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            Actual: item.total,
            Goal: nData.goal.target_value
        }));
    };

    const renderReferenceAreas = (goalType: string | undefined, targetValue: number, yDomainMax: number) => {
        const isLimit = goalType === 'limit';
        // Need extreme subtlety to avoid overwhelming UI. Use fillOpacity=0.03
        if (isLimit) {
            return (
                <React.Fragment>
                    <ReferenceArea y1={0} y2={targetValue * 0.75} fill="#10b981" fillOpacity={0.03} />
                    <ReferenceArea y1={targetValue * 0.75} y2={targetValue} fill="#f59e0b" fillOpacity={0.03} />
                    <ReferenceArea y1={targetValue} y2={yDomainMax} fill="#ef4444" fillOpacity={0.03} />
                </React.Fragment>
            );
        } else {
            return (
                <React.Fragment>
                    <ReferenceArea y1={0} y2={targetValue * 0.5} fill="#ef4444" fillOpacity={0.03} />
                    <ReferenceArea y1={targetValue * 0.5} y2={targetValue * 0.75} fill="#f59e0b" fillOpacity={0.03} />
                    <ReferenceArea y1={targetValue * 0.75} y2={yDomainMax} fill="#10b981" fillOpacity={0.03} />
                </React.Fragment>
            );
        }
    };

    return (
        <DashboardShell headerTitle="Nutrition Analytics">
            {/* TABS */}
            <div className="border-b border-gray-200 mb-6">
                <nav className="-mb-px flex space-x-8" aria-label="Tabs">
                    <button
                        onClick={() => setActiveTab('overview')}
                        className={`whitespace-nowrap pb-4 px-1 border-b-2 font-medium text-sm transition-colors ${activeTab === 'overview'
                                ? 'border-blue-500 text-blue-600'
                                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                            }`}
                    >
                        Overview
                    </button>
                    <button
                        onClick={() => setActiveTab('details')}
                        className={`whitespace-nowrap pb-4 px-1 border-b-2 font-medium text-sm transition-colors ${activeTab === 'details'
                                ? 'border-blue-500 text-blue-600'
                                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                            }`}
                    >
                        Detailed View
                    </button>
                </nav>
            </div>

            {loadingData && (
                <div className="flex flex-col items-center justify-center py-20">
                    <div className="relative w-10 h-10 mb-4">
                        <div className="absolute top-0 left-0 right-0 bottom-0 border-4 border-blue-100 rounded-full"></div>
                        <div className="absolute top-0 left-0 right-0 bottom-0 border-4 border-transparent border-t-blue-600 rounded-full animate-spin"></div>
                    </div>
                    <p className="text-gray-500">Compiling your nutritional data...</p>
                </div>
            )}

            {error && !loadingData && (
                <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-md border border-red-200 shadow-sm">
                    <strong>Error:</strong> {error}
                </div>
            )}

            {!loadingData && !error && analyticsData && Object.keys(analyticsData).length > 0 && (
                <div className="pb-10">
                    {/* OVERVIEW TAB */}
                    {activeTab === 'overview' && (
                        <div className="space-y-8 animate-in fade-in duration-300">
                            {/* Focus Banner */}
                            <FocusItemBanner
                                focusItem={focusItem}
                                onClick={focusItem ? () => {
                                    setSelectedNutrient(focusItem.nutrient);
                                    setActiveTab('details');
                                } : undefined}
                            />

                            {/* Normalized All-in-one Chart */}
                            <NormalizedComparisonChart analyticsData={analyticsData} />

                            {/* Sparkline Grid */}
                            <div>
                                <h3 className="text-lg font-semibold text-gray-800 mb-4">All Tracked Nutrients</h3>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                                    {Object.values(analyticsData).map(data => (
                                        <NutrientSparklineCard
                                            key={data.nutrient}
                                            data={data}
                                            onClick={(n) => {
                                                setSelectedNutrient(n);
                                                setActiveTab('details');
                                            }}
                                            isSelected={false}
                                        />
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* DETAILS TAB */}
                    {activeTab === 'details' && selectedNutrient && analyticsData[selectedNutrient] && (
                        <div className="space-y-6 animate-in fade-in duration-300">
                            {/* Nutrient Selector for Details View */}
                            <div className="p-4 bg-white rounded-lg border border-gray-200 shadow-sm max-w-sm">
                                <label htmlFor="nutrient-select" className="block text-sm font-medium text-gray-700 mb-2">Detailed view for:</label>
                                <select
                                    id="nutrient-select"
                                    value={selectedNutrient || ''}
                                    onChange={(e) => setSelectedNutrient(e.target.value)}
                                    className="block w-full pl-3 pr-10 py-2 text-base text-gray-900 border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 rounded-md bg-gray-50 cursor-pointer"
                                >
                                    {trackedNutrientsList.map(goal => (
                                        <option key={goal.nutrient} value={goal.nutrient}>
                                            {goal.nutrient.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Using variable to keep code cleaner */}
                            {(() => {
                                const activeData = analyticsData[selectedNutrient];
                                const currentGoal = activeData.goal;
                                const weeklyChartData = getChartDataForNutrient(selectedNutrient, 7);
                                const monthlyChartData = getChartDataForNutrient(selectedNutrient, 30);

                                const yDomainWeekly = calculateYAxisDomain(weeklyChartData, currentGoal.target_value, selectedNutrient);
                                const yDomainMonthly = calculateYAxisDomain(monthlyChartData, currentGoal.target_value, selectedNutrient);

                                return (
                                    <React.Fragment>
                                        {/* Summary Cards */}
                                        <section>
                                            <h3 className="text-lg font-semibold text-gray-800 mb-3">Summary for {getNutrientName(selectedNutrient)}</h3>
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                                                    <h4 className="text-sm font-medium text-gray-500 mb-1">Today</h4>
                                                    <p className="text-xl font-semibold text-gray-900">{activeData.today.value.toFixed(1)} {getNutrientUnit(selectedNutrient)}</p>
                                                    <p className="text-sm text-gray-600">({activeData.today.percent.toFixed(0)}% of goal)</p>
                                                </div>
                                                <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                                                    <h4 className="text-sm font-medium text-gray-500 mb-1">Weekly Average</h4>
                                                    <p className="text-xl font-semibold text-gray-900">{activeData.weeklyAvg.value.toFixed(1)} {getNutrientUnit(selectedNutrient)}</p>
                                                    <p className="text-sm text-gray-600">({activeData.weeklyAvg.percent.toFixed(0)}% of goal)</p>
                                                </div>
                                                <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                                                    <h4 className="text-sm font-medium text-gray-500 mb-1">Monthly Average</h4>
                                                    <p className="text-xl font-semibold text-gray-900">{activeData.monthlyAvg.value.toFixed(1)} {getNutrientUnit(selectedNutrient)}</p>
                                                    <p className="text-sm text-gray-600">({activeData.monthlyAvg.percent.toFixed(0)}% of goal)</p>
                                                </div>
                                            </div>
                                        </section>

                                        {/* Trends Charts */}
                                        <section>
                                            <h3 className="text-lg font-semibold text-gray-800 mb-3">Trends</h3>
                                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                                <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm min-h-[350px]">
                                                    <h4 className="text-md font-medium text-gray-600 mb-4">Last 7 Days Trend</h4>
                                                    {weeklyChartData.length > 0 ? (
                                                        <ResponsiveContainer width="100%" height={300}>
                                                            <LineChart data={weeklyChartData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                                                                {renderReferenceAreas(currentGoal.goal_type, currentGoal.target_value, yDomainWeekly[1] as number)}
                                                                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                                                                <XAxis dataKey="label" fontSize={12} />
                                                                <YAxis fontSize={12} domain={yDomainWeekly} allowDecimals={false} tickCount={6} />
                                                                <Tooltip formatter={(value: number) => `${value.toFixed(1)} ${getNutrientUnit(selectedNutrient)}`} labelFormatter={(label) => `Day: ${label}`} />
                                                                <Legend />
                                                                <Line type="monotone" dataKey="Actual" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                                                                <Line type="monotone" dataKey="Goal" stroke="#ef4444" strokeWidth={1} strokeDasharray="5 5" dot={false} activeDot={false} />
                                                            </LineChart>
                                                        </ResponsiveContainer>
                                                    ) : <p className="text-gray-500 text-sm text-center pt-10">No weekly data available to display chart.</p>}
                                                </div>

                                                <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm min-h-[350px]">
                                                    <h4 className="text-md font-medium text-gray-600 mb-4">Last 30 Days Trend</h4>
                                                    {monthlyChartData.length > 0 ? (
                                                        <ResponsiveContainer width="100%" height={300}>
                                                            <LineChart data={monthlyChartData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                                                                {renderReferenceAreas(currentGoal.goal_type, currentGoal.target_value, yDomainMonthly[1] as number)}
                                                                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                                                                <XAxis dataKey="label" fontSize={12} tickCount={6} />
                                                                <YAxis fontSize={12} domain={yDomainMonthly} allowDecimals={false} tickCount={6} />
                                                                <Tooltip formatter={(value: number) => `${value.toFixed(1)} ${getNutrientUnit(selectedNutrient)}`} labelFormatter={(label) => `Date: ${label}`} />
                                                                <Legend />
                                                                <Line type="monotone" dataKey="Actual" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 6 }} />
                                                                <Line type="monotone" dataKey="Goal" stroke="#f97316" strokeWidth={1} strokeDasharray="5 5" dot={false} activeDot={false} />
                                                            </LineChart>
                                                        </ResponsiveContainer>
                                                    ) : <p className="text-gray-500 text-sm text-center pt-10">No monthly data available to display chart.</p>}
                                                </div>
                                            </div>
                                        </section>
                                    </React.Fragment>
                                );
                            })()}
                        </div>
                    )}
                </div>
            )}

            {!selectedNutrient && !loadingGoals && !error && Object.keys(analyticsData || {}).length === 0 && (
                <div className="text-center py-20 fade-in duration-300">
                    <p className="text-gray-500">No tracked nutrients or food logs found.</p>
                    <p className="text-gray-400 text-sm mt-2">Set up some goals in Settings to see your analytics here.</p>
                </div>
            )}
        </DashboardShell>
    );
}