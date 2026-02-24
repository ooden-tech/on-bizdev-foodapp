import React from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { NutrientAnalyticsData } from '@/utils/analytics-helpers';
import { formatNutrientName, formatNutrientValue } from '@/utils/formatting';

interface NutrientSparklineCardProps {
    data: NutrientAnalyticsData;
    onClick: (nutrient: string) => void;
    isSelected: boolean;
}

export default function NutrientSparklineCard({ data, onClick, isSelected }: NutrientSparklineCardProps) {
    const { nutrient, goal, dailyTotals, today, streak } = data;
    const isLimit = goal.goal_type === 'limit';

    // For the 7-day sparkline
    const sparklineData = dailyTotals.slice(-7);

    // To make sparklines look decent, calculate a Y domain
    const maxVal = Math.max(...sparklineData.map(d => d.total), goal.target_value);
    const yDomain = [0, maxVal * 1.1];

    // Status colors based on today's value vs target
    const fraction = goal.target_value > 0 ? (today.value / goal.target_value) : 0;

    let ringColor = 'ring-gray-200 border-gray-200';
    let progressColor = 'bg-gray-400';
    let lineStroke = '#9ca3af';

    if (isLimit) {
        if (fraction > 0.9) {
            ringColor = 'ring-red-100 border-red-200';
            progressColor = 'bg-red-500';
            lineStroke = '#ef4444';
        } else if (fraction > 0.75) {
            ringColor = 'ring-amber-100 border-amber-200';
            progressColor = 'bg-amber-500';
            lineStroke = '#f59e0b';
        } else {
            ringColor = 'ring-emerald-100 border-emerald-200';
            progressColor = 'bg-emerald-500';
            lineStroke = '#10b981';
        }
    } else {
        if (fraction >= 0.75) {
            ringColor = 'ring-emerald-100 border-emerald-200';
            progressColor = 'bg-emerald-500';
            lineStroke = '#10b981';
        } else if (fraction >= 0.5) {
            ringColor = 'ring-amber-100 border-amber-200';
            progressColor = 'bg-amber-400';
            lineStroke = '#fbbf24';
        } else {
            ringColor = 'ring-red-100 border-red-200';
            progressColor = 'bg-red-500';
            lineStroke = '#ef4444';
        }
    }

    if (isSelected) {
        ringColor = 'ring-2 ring-blue-500 border-blue-500 shadow-md';
    }

    const barWidth = Math.min(today.percent, 100);

    return (
        <div
            onClick={() => onClick(nutrient)}
            className={`cursor-pointer bg-white rounded-xl border p-4 transition-all hover:shadow-md ${ringColor}`}
        >
            <div className="flex justify-between items-start mb-2">
                <div>
                    <h3 className="font-bold text-gray-800 text-sm">
                        {formatNutrientName(nutrient)}
                    </h3>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">
                        {isLimit ? 'Limit' : 'Goal'}
                    </p>
                </div>
                {streak > 2 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-800" title={`${streak} consecutive days hitting target`}>
                        🔥 {streak}
                    </span>
                )}
            </div>

            <div className="mt-3">
                <div className="flex items-baseline gap-1">
                    <span className="text-xl font-extrabold text-gray-900">
                        {formatNutrientValue(nutrient, today.value)}
                    </span>
                    <span className="text-sm text-gray-500">
                        / {formatNutrientValue(nutrient, goal.target_value)} {goal.unit}
                    </span>
                </div>

                {/* Tiny Progress Bar for Today */}
                <div className="w-full bg-gray-100 rounded-full h-1.5 mt-2 overflow-hidden">
                    <div
                        className={`h-full ${progressColor}`}
                        style={{ width: `${barWidth}%` }}
                    />
                </div>
            </div>

            {/* Sparkline */}
            <div className="h-12 mt-4 opacity-80">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sparklineData}>
                        <YAxis domain={yDomain} hide />
                        <Line
                            type="monotone"
                            dataKey="total"
                            stroke={lineStroke}
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                        />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="text-[10px] text-gray-400 text-center mt-1">
                7-day trend
            </div>
        </div>
    );
}
