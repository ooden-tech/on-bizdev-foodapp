import React from 'react';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
    ReferenceLine
} from 'recharts';
import { NutrientAnalyticsData } from '@/utils/analytics-helpers';
import { formatNutrientName } from '@/utils/formatting';

interface NormalizedComparisonChartProps {
    analyticsData: Record<string, NutrientAnalyticsData>;
}

const COLORS = [
    '#3b82f6', // blue
    '#8b5cf6', // purple
    '#ef4444', // red
    '#f59e0b', // amber
    '#10b981', // emerald
    '#ec4899', // pink
    '#06b6d4', // cyan
    '#84cc16', // lime
];

export default function NormalizedComparisonChart({ analyticsData }: NormalizedComparisonChartProps) {
    // We need to transform the data so that X-axis is Day, and each Nutrient is a Line
    // But normalized exactly as a Percentage of Goal (0 to 100+).

    const nutrientKeys = Object.keys(analyticsData);
    if (nutrientKeys.length === 0) return null;

    // Get the array of days from the first nutrient (they should all mathematically have the same 7 days)
    const firstData = analyticsData[nutrientKeys[0]];
    const last7Days = firstData.dailyTotals.slice(-7);

    // Build standard chart data format for Recharts
    const chartData = last7Days.map(dayObj => {
        const point: any = {
            label: new Date(dayObj.day + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
            rawDate: dayObj.day
        };

        // For this day, find the percentage for every nutrient
        nutrientKeys.forEach(key => {
            const data = analyticsData[key];
            const matchingDay = data.dailyTotals.find(d => d.day === dayObj.day);
            const value = matchingDay?.total || 0;
            const target = data.goal.target_value;

            // Calculate percentage
            const percent = target > 0 ? (value / target) * 100 : 0;
            point[key] = percent;
        });

        return point;
    });

    // Custom tooltip to show percentages
    const CustomTooltip = ({ active, payload, label }: any) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-white p-3 border border-gray-200 shadow-lg rounded-lg text-sm">
                    <p className="font-semibold text-gray-700 mb-2">{label}</p>
                    {payload.map((entry: any, index: number) => (
                        <div key={`item-${index}`} className="flex items-center gap-2 mb-1">
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
                            <span className="text-gray-600 w-24 truncate">{formatNutrientName(entry.dataKey)}</span>
                            <span className="font-bold text-gray-900">{entry.value.toFixed(0)}%</span>
                        </div>
                    ))}
                </div>
            );
        }
        return null;
    };

    return (
        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm h-[400px]">
            <h3 className="text-md font-semibold text-gray-800 mb-1">Weekly Targets Overview</h3>
            <p className="text-xs text-gray-500 mb-6">Normalized view (% of daily goal/limit)</p>

            <ResponsiveContainer width="100%" height="80%">
                <LineChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                    <XAxis
                        dataKey="label"
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: '#6b7280', fontSize: 12 }}
                        dy={10}
                    />
                    <YAxis
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: '#6b7280', fontSize: 12 }}
                        tickFormatter={(val) => `${val}%`}
                        domain={[0, 'dataMax']}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend
                        iconType="circle"
                        wrapperStyle={{ paddingTop: '20px', fontSize: '12px' }}
                        formatter={(value) => formatNutrientName(value)}
                    />

                    {/* The 100% Target Reference Line */}
                    <ReferenceLine
                        y={100}
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        label={{ position: 'top', value: 'Target (100%)', fill: '#94a3b8', fontSize: 10 }}
                    />

                    {nutrientKeys.map((key, index) => (
                        <Line
                            key={key}
                            type="monotone"
                            dataKey={key}
                            stroke={COLORS[index % COLORS.length]}
                            strokeWidth={2}
                            dot={{ r: 3, strokeWidth: 2 }}
                            activeDot={{ r: 6, strokeWidth: 0 }}
                        />
                    ))}
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
