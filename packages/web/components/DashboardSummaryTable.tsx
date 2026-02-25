import React from 'react';
import { formatNutrientName, formatNutrientValue } from '@/utils/formatting';
import { MASTER_NUTRIENT_MAP } from 'shared';
import { Progress } from "@/components/ui/progress";
import { useProfile } from '@/context/ProfileContext';

interface UserGoal {
    nutrient: string;
    target_value: number;
    unit: string;
    goal_type?: string;
    yellow_min?: number;
    green_min?: number;
    red_min?: number;
}

interface DailyTotals {
    [nutrientKey: string]: number | undefined;
}

interface DashboardSummaryTableProps {
    userGoals: UserGoal[];
    dailyTotals: DailyTotals;
    dailyAdjustments?: Record<string, number | undefined>;
    loading: boolean;
    error: string | null;
    refreshing?: boolean;
    onRefresh?: () => void;
}

const DashboardSummaryTable: React.FC<DashboardSummaryTableProps> = ({
    userGoals,
    dailyTotals,
    dailyAdjustments = {},
    loading,
    error,
    refreshing = false,
    onRefresh
}) => {

    // --- DEBUG LOG --- 
    console.log("[DashboardSummaryTable] Received userGoals prop:", JSON.stringify(userGoals));
    // --- END DEBUG LOG ---

    const { displayUnits } = useProfile();

    return (
        <div className="relative flex flex-col h-full justify-center items-center">
            {/* Sticky refresh button in bottom right */}
            {onRefresh && (
                <button
                    onClick={onRefresh}
                    className={`fixed md:absolute bottom-4 right-4 z-20 p-2 rounded-full shadow bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors ${refreshing ? 'opacity-50 cursor-not-allowed' : ''}`}
                    disabled={refreshing}
                    title="Refresh Summary"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className={`h-6 w-6 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m-15.357-2a8.001 8.001 0 0015.357 2M15 15h-4.581" />
                    </svg>
                </button>
            )}
            {loading ? (
                <div className="flex flex-col items-center justify-center pt-10">
                    <div className="relative w-8 h-8">
                        <div className="absolute top-0 left-0 right-0 bottom-0 border-4 border-blue-100 rounded-full"></div>
                        <div className="absolute top-0 left-0 right-0 bottom-0 border-4 border-transparent border-t-blue-600 rounded-full animate-spin"></div>
                    </div>
                    <p className="mt-2 text-sm text-gray-500">Loading Summary...</p>
                </div>
            ) : error ? (
                <div className="p-3 bg-red-100 text-red-600 text-sm rounded border border-red-200">
                    Error: {error}
                </div>
            ) : userGoals.length === 0 && (!dailyTotals['calories'] || dailyTotals['calories'] === 0) ? (
                <div className="text-center text-gray-500 py-10">
                    <p>No goals set or data logged for today yet.</p>
                </div>
            ) : (
                <div className="bg-white border border-gray-300 rounded-lg overflow-hidden shadow-md mt-0 mb-0 flex justify-center items-center w-full">
                    <div className="overflow-x-auto w-full">
                        <table className="min-w-full table-auto divide-y divide-gray-200">
                            <thead className="bg-gray-100">
                                <tr>
                                    <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Nutrient</th>
                                    <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Target</th>
                                    <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Consumed</th>
                                    <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Progress %</th>
                                    <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider italic">Delta</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {(() => {
                                    const caloriesGoal = userGoals.find(g => g.nutrient === 'calories');
                                    const hasCalories = caloriesGoal || (dailyTotals['calories'] && dailyTotals['calories'] > 0);
                                    if (!hasCalories) return null;
                                    return (
                                        <SummaryTableRow
                                            key="calories"
                                            nutrient="calories"
                                            current={dailyTotals['calories'] || 0}
                                            target={caloriesGoal?.target_value}
                                            adjustment={dailyAdjustments['calories']}
                                            goalType={caloriesGoal?.goal_type}
                                            thresholds={{
                                                yellow_min: caloriesGoal?.yellow_min,
                                                green_min: caloriesGoal?.green_min,
                                                red_min: caloriesGoal?.red_min
                                            }}
                                            displayUnits={displayUnits}
                                        />
                                    );
                                })()}
                                {userGoals.filter(goal => goal.nutrient !== 'calories').map(goal => (
                                    <SummaryTableRow
                                        key={goal.nutrient}
                                        nutrient={goal.nutrient}
                                        current={dailyTotals[goal.nutrient] || 0}
                                        target={goal.target_value}
                                        adjustment={dailyAdjustments[goal.nutrient]}
                                        goalType={goal.goal_type}
                                        thresholds={{
                                            yellow_min: goal.yellow_min,
                                            green_min: goal.green_min,
                                            red_min: goal.red_min
                                        }}
                                        displayUnits={displayUnits}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
};

interface SummaryTableRowProps {
    nutrient: string;
    current: number;
    target?: number;
    adjustment?: number;
    goalType?: string;
    thresholds?: {
        yellow_min?: number;
        green_min?: number;
        red_min?: number;
    };
    displayUnits: any;
}

const SummaryTableRow: React.FC<SummaryTableRowProps> = ({ nutrient, current, target, adjustment = 0, goalType, thresholds = {}, displayUnits }) => {
    const nutrientInfo = MASTER_NUTRIENT_MAP[nutrient.toLowerCase()];
    const unit = nutrientInfo?.unit || (nutrient === 'calories' ? 'kcal' : '');
    const isLimit = goalType === 'limit';
    const finalTarget = target !== undefined ? target + adjustment : undefined;

    const displayCurrent = formatNutrientValue(nutrient, current, displayUnits);
    const displayBaseTarget = target !== undefined ? formatNutrientValue(nutrient, target, displayUnits) : '-';
    const displayAdjustment = adjustment !== 0 ? ` (+${formatNutrientValue(nutrient, adjustment, displayUnits)})` : '';
    const displayTarget = target !== undefined ? (
        <div className="flex flex-col">
            <span>{formatNutrientValue(nutrient, finalTarget!, displayUnits)}</span>
            {adjustment !== 0 && (
                <span className="text-[10px] text-blue-500 font-medium">Base: {displayBaseTarget} + Workout</span>
            )}
        </div>
    ) : '-';

    const percentage = (finalTarget && finalTarget > 0) ? Math.round((current / finalTarget) * 100) : 0;
    const fraction = (finalTarget && finalTarget > 0) ? (current / finalTarget) : 0;
    const barWidth = Math.min(percentage, 100);

    // Delta: Target - Consumed. If consumed > target, delta is negative (e.g. 2000 - 2100 = -100)
    const delta = finalTarget !== undefined ? finalTarget - current : null;
    const displayDelta = delta !== null ? formatNutrientValue(nutrient, Math.abs(delta), displayUnits) : '-';

    // For limits, being "over" (negative delta) is bad (red). For goals, it's usually good (emerald).
    const deltaColor = delta !== null
        ? (delta < 0
            ? (isLimit ? 'text-red-500 font-bold' : 'text-emerald-600 font-bold')
            : 'text-gray-400')
        : 'text-gray-400';

    // Color coding logic
    // For goals: Green ≥75%, Yellow 50-75%, Red <50% (defaults)
    // For limits: Green <75%, Yellow 75-90%, Red >90% (defaults)
    const yellowMin = thresholds.yellow_min ?? (isLimit ? 0.90 : 0.50);
    const greenMin = thresholds.green_min ?? 0.75;
    const redMin = thresholds.red_min ?? (isLimit ? 1.0 : 0.90); // Note: UI logic below uses these differently

    let textColorClass = 'text-gray-600';
    let progressBarClass = 'bg-gray-300';
    let rowBgClass = 'bg-white hover:bg-gray-50';

    if (finalTarget !== undefined) {
        if (isLimit) {
            // For limits: green if <75%, yellow if 75-90%, red if >90%
            if (fraction > redMin) {
                // RED: Over 90% of limit
                textColorClass = 'text-red-600 font-bold';
                progressBarClass = 'bg-red-500';
                rowBgClass = 'bg-red-50 hover:bg-red-100';
            } else if (fraction >= greenMin) {
                // YELLOW: 75-90% of limit
                textColorClass = 'text-amber-600 font-medium';
                progressBarClass = 'bg-amber-500';
                rowBgClass = 'bg-amber-50 hover:bg-amber-100';
            } else {
                // GREEN: Below 75% of limit
                textColorClass = 'text-emerald-700 font-medium';
                progressBarClass = 'bg-emerald-500';
                rowBgClass = 'bg-emerald-50 hover:bg-emerald-100';
            }
        } else {
            // For goals: green if ≥75%, yellow if 50-75%, red if <50%
            if (fraction >= greenMin) {
                // GREEN: ≥75% of goal
                textColorClass = 'text-emerald-700 font-bold';
                progressBarClass = 'bg-emerald-500';
                rowBgClass = 'bg-emerald-50 hover:bg-emerald-100';
            } else if (fraction >= yellowMin) {
                // YELLOW: 50-75% of goal
                textColorClass = 'text-amber-600 font-medium';
                progressBarClass = 'bg-amber-400';
                rowBgClass = 'bg-amber-50 hover:bg-amber-100';
            } else {
                // RED: <50% of goal
                textColorClass = 'text-red-600 font-medium';
                progressBarClass = 'bg-red-500';
                rowBgClass = 'bg-red-50 hover:bg-red-100';
            }

            // Special override for goal exceeded (100%+)
            if (fraction >= 1.0) {
                textColorClass = 'text-emerald-700 font-black';
                rowBgClass = 'bg-emerald-100 hover:bg-emerald-200';
            }
        }
    }

    return (
        <tr className={`${rowBgClass} transition-colors`}>
            <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
                <div className="flex flex-col">
                    <span>{formatNutrientName(nutrient)}</span>
                    <span className="text-[10px] text-gray-400 uppercase tracking-tighter">
                        {isLimit ? 'Limit' : 'Goal'}
                    </span>
                </div>
            </td>
            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-medium">{displayTarget}</td>
            <td className={`px-6 py-4 whitespace-nowrap text-sm ${textColorClass}`}>{displayCurrent}</td>
            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                <div className="flex items-center space-x-2">
                    {finalTarget !== undefined && (
                        <>
                            <div className="w-24 bg-gray-100 rounded-full h-2 overflow-hidden border border-gray-200">
                                <div
                                    className={`h-full transition-all duration-500 ${progressBarClass}`}
                                    style={{ width: `${barWidth}%` }}
                                />
                            </div>
                            <span className={`text-xs font-bold w-10 ${textColorClass}`}>{`${percentage}%`}</span>
                        </>
                    )}
                    {finalTarget === undefined && (
                        <span className="text-gray-400 italic">No Target</span>
                    )}
                </div>
            </td>
            <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${deltaColor}`}>
                {delta !== null ? (delta < 0 ? `+${displayDelta}` : displayDelta) : '-'}
            </td>
        </tr>
    );
};

export default DashboardSummaryTable; 